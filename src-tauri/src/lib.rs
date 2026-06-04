use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

mod db;
mod memory_scanner;
mod ocr;
mod wfcd;

use db::{QuantityChange, Trade};
use wfcd::{RecipeComponent, WfcdItem};

pub struct AppState {
    pub db_path: PathBuf,
    pub items_cache_path: PathBuf,
    pub recipes_cache_path: PathBuf,
    pub relic_drops_cache_path: PathBuf,
    pub relic_rewards_cache_path: PathBuf,
    pub quantities_cache_path: PathBuf,
    pub settings_path: PathBuf,
    pub log_path: PathBuf,
    pub conn: Mutex<rusqlite::Connection>,
    pub wfcd_items: Mutex<Vec<WfcdItem>>,
    /// parent unique_name → recipe component tree
    pub recipes: Mutex<HashMap<String, Vec<RecipeComponent>>>,
    /// component unique_name → relic unique_names that drop it
    pub relic_drops: Mutex<HashMap<String, Vec<String>>>,
    /// relic unique_name → sorted reward list (Bronze×3, Silver×2, Gold×1)
    pub relic_rewards: Mutex<HashMap<String, Vec<wfcd::RelicReward>>>,
    /// blueprint_unique → (display_name, ducats). Used to enrich virtual catalog entries.
    pub blueprint_to_result: Mutex<HashMap<String, (String, Option<u32>)>>,
    /// Canonical relic reward display names from the Warframe Wiki (lower-cased).
    pub wiki_reward_names: Mutex<std::collections::HashSet<String>>,
    /// Last-known quantities from memory scans. Shared with monitor thread.
    pub current_quantities: Arc<Mutex<HashMap<String, i64>>>,
    /// Last-known crafting jobs from memory scans. Shared with monitor thread.
    pub current_crafting: Arc<Mutex<Vec<CraftingJob>>>,
    pub monitor_active: Arc<AtomicBool>,
    /// WFM slug → median sell price (None = item not listed on WFM). Shared across all windows.
    pub wfm_price_cache: Mutex<HashMap<String, Option<u32>>>,
    /// Active WFM session (JWT + username). Held in memory only, never written to disk.
    pub wfm_session: Arc<Mutex<Option<WfmSession>>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct WfmSession {
    pub access_token: String,
    pub refresh_token: String,
    pub client_id: String,
    pub device_id: String,
    pub username: String,
}

impl WfmSession {
    pub fn auth_header(&self) -> String {
        format!("Bearer {}", self.access_token)
    }
}

// ─── Item catalog ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct CatalogItem {
    pub unique_name: String,
    pub name: String,
    pub category: String,
    pub image_name: Option<String>,
    pub vaulted: Option<bool>,
    pub ducats: Option<u32>,
    pub mastery_req: Option<u32>,
}

/// Determine the correct display category for an item.
///
/// Rules (in order):
///   1. Name contains "Blueprint" → "Blueprints"
///   2. Name ends with a known weapon/warframe component suffix → "Parts"
///      (catches WFCD entries that are wrongly tagged as "Blueprints" or
///       assigned the parent weapon's category instead of their own)
///   3. WFCD says "Blueprints" but name has no "Blueprint" word → "Parts"
///      (defensive: WFCD sometimes mis-categorises direct-drop components)
///   4. Everything else → keep WFCD category as-is
fn fix_category(name: &str, wfcd_cat: &str) -> String {
    let lower = name.to_lowercase();

    // Mods and Arcanes are always themselves — check BEFORE the name-contains-
    // "blueprint" rule so that mods whose names include "Blueprint" (e.g.
    // "Ballistic Bullseye Blueprint", "Balefire Surge Blueprint") are never
    // reclassified as Blueprints.
    if wfcd_cat == "Mods" || wfcd_cat == "Arcanes" {
        return wfcd_cat.to_string();
    }

    if lower.contains("blueprint") {
        return "Blueprints".to_string();
    }

    // Warframe weapon / sentinel component name endings.
    // Warframe-frame components (Chassis, Neuroptics, Systems) always have
    // "Blueprint" in their name, so they are handled by rule 1 above.
    const PART_SUFFIXES: &[&str] = &[
        " receiver", " stock", " barrel", " blade", " handle", " guard",
        " hilt", " link", " gauntlet", " carapace", " cerebrum", " systems",
        " upper limb", " lower limb", " strike", " boot", " head",
    ];
    if PART_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return "Parts".to_string();
    }

    // WFCD mis-tags some direct-drop components as "Blueprints".
    if wfcd_cat == "Blueprints" {
        return "Parts".to_string();
    }

    wfcd_cat.to_string()
}

#[tauri::command]
fn get_all_items(state: State<AppState>) -> Vec<CatalogItem> {
    let items    = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
    let bp_names = state.blueprint_to_result.lock().unwrap_or_else(|e| e.into_inner());

    // ExportRecipes is the authoritative source for blueprint items — their paths
    // match what the Warframe API returns in data.Recipes.
    // WFCD is authoritative for everything else (main warframes, weapons, parts).
    //
    // Strategy:
    //  1. Add all non-blueprint WFCD items (category ≠ "Blueprints" and
    //     unique_name doesn't start with /Lotus/Types/Recipes/)
    //  2. Add ALL ExportRecipes blueprint entries (no dedup needed — the map
    //     is keyed by unique_name so each entry appears only once)
    //  3. Add WFCD-only blueprints not covered by ExportRecipes (older content)
    //
    // This eliminates the "Dante Blueprint" duplicate: WFCD's recipe-path entry
    // is replaced by ExportRecipes' entry which matches the API path exactly.

    // ── Rebuild to eliminate cross-source blueprint duplicates ───────────────
    //
    // Root cause: WFCD stores the same blueprint at MULTIPLE paths (recipe path
    // + non-recipe path), causing it to appear in every category.
    //
    // Fix: ExportRecipes blueprints go in FIRST (authoritative API-matching
    // paths). WFCD blueprint items are then skipped if ExportRecipes already
    // has them by display name. WFCD non-blueprint items always go in.
    // ─────────────────────────────────────────────────────────────────────────

    let mut result: Vec<CatalogItem> = Vec::new();

    // Items whose base names can never have a real blueprint (Mods, Arcanes).
    // ExportRecipes sometimes contains phantom entries like "Ballistic Bullseye
    // Blueprint" even though mods cannot be crafted — we skip those here so
    // the inventory never shows a mod under the wrong name or category.
    let non_craftable_names: std::collections::HashSet<String> = items.iter()
        .filter(|i| i.category == "Mods" || i.category == "Arcanes")
        .map(|i| i.name.to_lowercase())
        .collect();

    // Phase 1: ExportRecipes blueprints (correct API paths, 1 per name)
    // Build a name→vaulted map from WFCD so blueprints inherit the correct vaulted status.
    // ExportRecipes has no vaulted field; WFCD does.  We look up by bp_name first, then
    // fall back to the base name without " Blueprint" (covers weapon/warframe entries).
    let wfcd_vaulted: std::collections::HashMap<String, Option<bool>> = items.iter()
        .map(|i| (i.name.to_lowercase(), i.vaulted))
        .collect();

    let mut bp_names_added: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (bp_unique, (bp_name, bp_ducats)) in bp_names.iter() {
        // Skip phantom blueprint entries for mods/arcanes.
        // Strip the " Blueprint" suffix and check against the known mod names.
        let base = bp_name
            .strip_suffix(" Blueprint")
            .unwrap_or(bp_name)
            .to_lowercase();
        if non_craftable_names.contains(&base) { continue; }

        let n = bp_name.to_lowercase();
        if bp_names_added.insert(n.clone()) {
            // Inherit vaulted status from WFCD — try exact name first, then base name.
            let vaulted = wfcd_vaulted.get(&n).and_then(|v| *v)
                .or_else(|| wfcd_vaulted.get(&base).and_then(|v| *v));
            result.push(CatalogItem {
                unique_name: bp_unique.clone(),
                name:        bp_name.clone(),
                category:    "Blueprints".to_string(),
                image_name:  None,
                vaulted,
                ducats:      *bp_ducats,
                mastery_req: None,
            });
        }
    }

    // Phase 2: WFCD items — keep WFCD categories, only fix blueprint names.
    // Skip blueprints already covered by ExportRecipes or already added
    // (WFCD may store the same blueprint at multiple paths).
    for i in items.iter() {
        let cat = fix_category(&i.name, &i.category);
        let n = i.name.to_lowercase();
        if cat == "Blueprints" {
            if !bp_names_added.insert(n) { continue; } // skip if already seen
        }
        result.push(CatalogItem {
            unique_name: i.unique_name.clone(),
            name:        i.name.clone(),
            category:    cat,
            image_name:  i.image_name.clone(),
            vaulted:     i.vaulted,
            ducats:      i.ducats,
            mastery_req: i.mastery_req,
        });
    }

    // Phase 3: WFCD-only blueprints NOT covered by ExportRecipes.
    for item in items.iter() {
        if !item.unique_name.starts_with("/Lotus/Types/Recipes/") { continue; }
        let n = item.name.to_lowercase();
        if !bp_names_added.insert(n) { continue; }
        result.push(CatalogItem {
            unique_name: item.unique_name.clone(),
            name:        item.name.clone(),
            category:    "Blueprints".to_string(),
            image_name:  item.image_name.clone(),
            vaulted:     item.vaulted,
            ducats:      item.ducats,
            mastery_req: item.mastery_req,
        });
    }

    // Final safety dedup by unique_name
    let mut seen_unique: std::collections::HashSet<String> = std::collections::HashSet::new();
    result.retain(|i| seen_unique.insert(i.unique_name.clone()));

    result
}

#[tauri::command]
fn get_current_quantities(state: State<AppState>) -> HashMap<String, i64> {
    state.current_quantities.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn get_current_crafting(state: State<AppState>) -> Vec<CraftingJob> {
    state.current_crafting.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn get_item_list_status(state: State<AppState>) -> serde_json::Value {
    let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
    let recipes = state.recipes.lock().unwrap_or_else(|e| e.into_inner());
    // Sample a few recipe keys for diagnostics
    let sample: Vec<&String> = recipes.keys().take(3).collect();
    serde_json::json!({
        "count": items.len(),
        "recipe_count": recipes.len(),
        "recipe_sample": sample,
    })
}

#[tauri::command]
async fn fetch_item_list(state: State<'_, AppState>) -> Result<usize, String> {
    let result = tauri::async_runtime::spawn_blocking(wfcd::fetch_items)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?;

    let count = result.items.len();

    // Persist items cache
    if let Ok(json) = serde_json::to_string(&result.items.iter().map(|i| serde_json::json!({
        "unique_name": i.unique_name, "name": i.name, "category": i.category,
        "image_name": i.image_name, "vaulted": i.vaulted, "ducats": i.ducats,
        "mastery_req": i.mastery_req
    })).collect::<Vec<_>>()) {
        let _ = std::fs::write(&state.items_cache_path, json);
    }

    // Persist recipes cache
    if let Ok(json) = serde_json::to_string(&result.recipes) {
        let _ = std::fs::write(&state.recipes_cache_path, json);
    }

    let patched_items: Vec<WfcdItem> = result.items.into_iter().map(|mut i| {
        i.name = patch_item_name(&i.unique_name, &i.name);
        i.category = patch_item_category(&i.name, &i.category);
        i
    }).collect();
    if let Ok(json) = serde_json::to_string(&result.relic_drops) {
        let _ = std::fs::write(&state.relic_drops_cache_path, json);
    }
    if let Ok(json) = serde_json::to_string(&result.relic_rewards) {
        let _ = std::fs::write(&state.relic_rewards_cache_path, json);
    }
    *state.wfcd_items.lock().map_err(|e| e.to_string())? = patched_items;
    *state.recipes.lock().map_err(|e| e.to_string())? = result.recipes;
    *state.relic_drops.lock().map_err(|e| e.to_string())? = result.relic_drops;
    *state.relic_rewards.lock().map_err(|e| e.to_string())? = result.relic_rewards;
    *state.blueprint_to_result.lock().map_err(|e| e.to_string())? = result.blueprint_names;
    if !result.wiki_reward_names.is_empty() {
        *state.wiki_reward_names.lock().map_err(|e| e.to_string())? = result.wiki_reward_names;
    }
    Ok(count)
}

// ─── Foundry / Recipes ────────────────────────────────────────────────────────

/// Returns all items that have a crafting recipe (for the Foundry search list).
#[tauri::command]
fn get_craftable_items(state: State<AppState>) -> Vec<CatalogItem> {
    // Collect recipe keys first, drop the lock, then lock items separately
    // to avoid holding two locks simultaneously (prevents potential deadlock
    // with fetch_item_list which locks in the opposite order).
    let recipe_keys: std::collections::HashSet<String> = {
        let recipes = state.recipes.lock().unwrap_or_else(|e| e.into_inner());
        recipes.keys().cloned().collect()
    };
    let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
    items.iter()
        .filter(|i| recipe_keys.contains(&i.unique_name))
        .map(|i| CatalogItem {
            unique_name: i.unique_name.clone(),
            name: i.name.clone(),
            category: i.category.clone(),
            image_name: i.image_name.clone(),
            vaulted: i.vaulted,
            ducats: i.ducats,
            mastery_req: i.mastery_req,
        })
        .collect()
}

/// Returns the recipe component tree for a single item (empty vec = not found).
/// Returns Vec instead of Option to avoid Tauri serialization edge cases.
#[tauri::command]
fn get_recipe(state: State<AppState>, unique_name: String) -> Vec<RecipeComponent> {
    let recipes = state.recipes.lock().unwrap_or_else(|e| e.into_inner());
    recipes.get(&unique_name).cloned().unwrap_or_default()
}

/// Returns the relic drop map: component unique_name → relic unique_names.
#[tauri::command]
fn get_relic_drops(state: State<AppState>) -> HashMap<String, Vec<String>> {
    state.relic_drops.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Returns the relic rewards map: relic unique_name → sorted reward list.
#[tauri::command]
fn get_relic_rewards(state: State<AppState>) -> HashMap<String, Vec<wfcd::RelicReward>> {
    state.relic_rewards.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ─── Warframe companion API ───────────────────────────────────────────────────

/// Scan all Warframe memory regions for the session credentials (accountId + nonce).
/// These are placed in memory by the game itself after login — we never handle passwords.
#[tauri::command]
async fn scan_warframe_credentials() -> Result<(String, String, String), String> {
    tauri::async_runtime::spawn_blocking(scan_warframe_credentials_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn scan_warframe_credentials_sync() -> Result<(String, String, String), String> {
    #[cfg(not(target_os = "windows"))]
    { return Err("Only supported on Windows".into()); }
    #[cfg(target_os = "windows")]
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            Diagnostics::Debug::ReadProcessMemory,
            Memory::{VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS},
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
        },
    };
    use std::ffi::c_void;
    use std::mem;

    let pid = memory_scanner::find_warframe_pid_pub()
        .ok_or("Warframe is not running")?;

    unsafe {
        let process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
        if process == 0 { return Err("Cannot open Warframe process".into()); }

        let mut address: usize = 0x10000;
        let mbi_size = mem::size_of::<MEMORY_BASIC_INFORMATION>();

        loop {
            let mut mbi: MEMORY_BASIC_INFORMATION = mem::zeroed();
            if VirtualQueryEx(process, address as *const c_void, &mut mbi, mbi_size) == 0 { break; }
            let region_end = (mbi.BaseAddress as usize).saturating_add(mbi.RegionSize);
            if region_end <= address { break; }
            address = region_end;

            if mbi.State != MEM_COMMIT { continue; }
            let p = mbi.Protect;
            if p & PAGE_NOACCESS != 0 || p & PAGE_GUARD != 0 { continue; }
            if p == 0x10 || p == 0x20 { continue; }
            if mbi.RegionSize > 128 * 1024 * 1024 { continue; }

            let mut buffer = vec![0u8; mbi.RegionSize];
            let mut bytes_read: usize = 0;
            let ok = ReadProcessMemory(
                process, mbi.BaseAddress as *const c_void,
                buffer.as_mut_ptr() as *mut c_void, mbi.RegionSize, &mut bytes_read,
            );
            if ok == 0 || bytes_read == 0 { continue; }

            if let Some((id, nonce)) = memory_scanner::scan_auth_credentials(&buffer[..bytes_read]) {
                let steam_id = memory_scanner::scan_steam_id(&buffer[..bytes_read]).unwrap_or_default();
                CloseHandle(process);
                return Ok((id, nonce, steam_id));
            }
        }
        CloseHandle(process);
    }
    Err("Credentials not found in memory. Make sure you are in the orbiter (not loading screen) and Warframe has been running for a few minutes.".into())

}

/// Scan Warframe memory for API request URLs — reveals exact endpoints the game uses.
#[tauri::command]
async fn scan_warframe_api_urls() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{
                Diagnostics::Debug::ReadProcessMemory,
                Memory::{VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS},
                Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
            },
        };
        use std::ffi::c_void;
        use std::mem;

        let pid = memory_scanner::find_warframe_pid_pub()
            .ok_or("Warframe not running".to_string())?;

        let mut found = Vec::new();
        unsafe {
            let process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
            if process == 0 { return Err("Cannot open process".into()); }

            let mut address: usize = 0x10000;
            let mbi_size = mem::size_of::<MEMORY_BASIC_INFORMATION>();

            loop {
                let mut mbi: MEMORY_BASIC_INFORMATION = mem::zeroed();
                if VirtualQueryEx(process, address as *const c_void, &mut mbi, mbi_size) == 0 { break; }
                let region_end = (mbi.BaseAddress as usize).saturating_add(mbi.RegionSize);
                if region_end <= address { break; }
                address = region_end;

                if mbi.State != MEM_COMMIT { continue; }
                let p = mbi.Protect;
                if p & PAGE_NOACCESS != 0 || p & PAGE_GUARD != 0 { continue; }
                if p == 0x10 || p == 0x20 { continue; }
                if mbi.RegionSize > 64 * 1024 * 1024 { continue; }

                let mut buffer = vec![0u8; mbi.RegionSize];
                let mut bytes_read: usize = 0;
                let ok = ReadProcessMemory(
                    process, mbi.BaseAddress as *const c_void,
                    buffer.as_mut_ptr() as *mut c_void, mbi.RegionSize, &mut bytes_read,
                );
                if ok == 0 || bytes_read == 0 { continue; }

                let data = &buffer[..bytes_read];
                // Search for various Warframe API patterns
                let needles: &[&[u8]] = &[
                    b"/API/PHP/", b"inventory.php", b"login.php",
                    b"warframe.com/A", b"Nonce", b"accountId",
                ];
                for needle in needles {
                    let mut i = 0;
                    while i + needle.len() < data.len() {
                        if &data[i..i + needle.len()] == *needle {
                            let start = i.saturating_sub(30);
                            let end = (i + 100).min(data.len());
                            let ctx: String = data[start..end].iter()
                                .map(|&b| if b >= 0x20 && b < 0x7f { b as char } else { ' ' })
                                .collect();
                            let trimmed = ctx.split_whitespace().collect::<Vec<_>>().join(" ");
                            let label = format!("[{}] {}", std::str::from_utf8(needle).unwrap_or("?"), trimmed);
                            if !found.iter().any(|s: &String| s.contains(&trimmed[..trimmed.len().min(30)])) {
                                found.push(label);
                            }
                            if found.len() >= 40 { break; }
                        }
                        i += 1;
                    }
                }
                if found.len() >= 20 { break; }
            }
            CloseHandle(process);
        }
        Ok(found)
    }).await.map_err(|e| e.to_string())?
}

/// Login to Warframe API with email + password (same flow as mobile companion app).
/// Password is hashed with Whirlpool before sending — never sent in plaintext.
/// Returns (accountId, nonce) for subsequent API calls.
#[tauri::command]
async fn warframe_login(email: String, password: String) -> Result<(String, String), String> {
    use whirlpool::{Whirlpool, Digest};
    let hash = format!("{:x}", Whirlpool::digest(password.as_bytes()));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let body = format!(
        "email={}&password={}&time={}&type=pc&appVersion=live",
        urlencoding(&email), hash, now
    );
    let resp = ureq::post("https://api.warframe.com/API/PHP/login.php")
        .set("X-Titanium-Id", "9bbd1ddd-f7f2-402d-9777-873f458cb50c")
        .set("X-Requested-With", "XMLHttpRequest")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 8.1.0)")
        .send_string(&body)
        .map_err(|e| format!("Login failed: {}", e))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Login response invalid: {}", &text[..text.len().min(200)]))?;
    let id = json["id"].as_str().unwrap_or("").to_string();
    let nonce = json["Nonce"].to_string().trim_matches('"').to_string();
    if id.is_empty() || nonce == "null" {
        return Err(format!("Login rejected: {}", &text[..text.len().min(200)]));
    }
    Ok((id, nonce))
}

fn urlencoding(s: &str) -> String {
    s.chars().flat_map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => vec![c],
        '@' => vec!['%', '4', '0'],
        _ => format!("%{:02X}", c as u8).chars().collect(),
    }).collect()
}

/// Fetch the player's full inventory from the Warframe companion API.
#[tauri::command]
async fn fetch_warframe_inventory(account_id: String, nonce: String, steam_id: String) -> Result<serde_json::Value, String> {
    // Base URL uses lowercase /api/ (not /API/PHP/). ct=STM for Steam platform.
    let endpoints = [
        "https://api.warframe.com/api/inventory.php",
        "https://api.warframe.com/api/profile.php",
    ];
    let body = format!(
        "accountId={}&nonce={}&ct=STM{}&SteamOnly=1",
        account_id, nonce,
        if !steam_id.is_empty() { format!("&steamId={}", steam_id) } else { String::new() }
    );
    let headers = [
        ("Content-Type", "application/x-www-form-urlencoded"),
        ("User-Agent", "Mozilla/5.0"),
        ("Accept", "application/json"),
        ("Host", "api.warframe.com"),
    ];

    let mut last_err = String::new();
    for url in &endpoints {
        let mut req = ureq::post(url);
        for (k, v) in &headers { req = req.set(k, v); }
        match req.send_string(&body) {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.into_string().unwrap_or_default();
                if status == 200 {
                    return serde_json::from_str(&text)
                        .map_err(|e| format!("Parse failed: {} — body: {}", e, &text[..text.len().min(200)]));
                }
                last_err = format!("HTTP {} from {}: {}", status, url, &text[..text.len().min(100)]);
            }
            Err(e) => { last_err = format!("Request to {} failed: {}", url, e); }
        }
    }
    Err(last_err)
}

// ─── Warframe.market ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct WfmItem {
    pub id: String,
    pub item_name: String,
    pub url_name: String,
}

// ─── Warframe.market rate limiter ─────────────────────────────────────────────
// WFM allows ≤3 requests per second. Every WFM HTTP call must call wfm_wait()
// first. Uses a sliding-window algorithm: tracks timestamps of the last 3
// requests and sleeps until the oldest is >1 second old before allowing another.

struct WfmRateLimiter {
    times: std::collections::VecDeque<std::time::Instant>,
}

impl WfmRateLimiter {
    fn new() -> Self { Self { times: std::collections::VecDeque::new() } }

    fn acquire(&mut self) {
        const LIMIT: usize = 3;
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(1);
        loop {
            let now = std::time::Instant::now();
            // Evict timestamps outside the 1-second window
            while let Some(&front) = self.times.front() {
                if now.duration_since(front) >= WINDOW { self.times.pop_front(); } else { break; }
            }
            if self.times.len() < LIMIT {
                self.times.push_back(now);
                return;
            }
            // All 3 slots used — sleep until the oldest slot expires (+10ms buffer)
            let oldest = *self.times.front().unwrap();
            let wait = WINDOW.saturating_sub(now.duration_since(oldest))
                + std::time::Duration::from_millis(10);
            std::thread::sleep(wait);
        }
    }
}

static WFM_LIMITER: std::sync::OnceLock<std::sync::Mutex<WfmRateLimiter>> =
    std::sync::OnceLock::new();

/// Call this before every warframe.market HTTP request.
fn wfm_wait() {
    WFM_LIMITER
        .get_or_init(|| std::sync::Mutex::new(WfmRateLimiter::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .acquire();
}

// ─── Warframe.market trading ──────────────────────────────────────────────────

fn wfm_request(method: &str, path: &str, auth_header: &str) -> ureq::Request {
    let url = format!("https://api.warframe.market{}", path);
    let req = match method {
        "POST"   => ureq::post(&url),
        "PUT"    => ureq::put(&url),
        "PATCH"  => ureq::patch(&url),
        "DELETE" => ureq::delete(&url),
        _        => ureq::get(&url),
    };
    req.set("Authorization", auth_header)
       .set("Content-Type", "application/json")
       .set("Accept", "application/json")
       .set("language", "en")
       .set("platform", "pc")
       .set("User-Agent", "FrameForge/1.2.0")
}

/// Open warframe.market signin in an embedded WebView.
/// An initialization script intercepts WFM's own fetch/XHR calls to capture
/// the JWT, then invokes wfm_receive_jwt to store it and close the window.
#[tauri::command]
fn wfm_open_login_window(app: tauri::AppHandle) -> Result<(), String> {
    // Intercept WFM's own auth calls to capture access + refresh tokens.
    // Targets the signin *response* body (not outgoing headers) so we get both tokens.
    let script = r#"
(function() {
  var _clientId = '', _deviceId = '';
  function sendTokens(d) {
    if (!d || !d.accessToken || window.__wfmDone) return;
    window.__wfmDone = true;
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('wfm_receive_tokens', {
        accessToken:  d.accessToken,
        refreshToken: d.refreshToken || '',
        clientId:     _clientId,
        deviceId:     _deviceId,
      }).catch(function() {});
    }
  }
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // Capture clientId / deviceId from outgoing signin body
    if (url.includes('/auth/signin') && init && init.body) {
      try { var b = JSON.parse(init.body); _clientId = b.clientId||''; _deviceId = b.deviceId||''; } catch(e) {}
    }
    var p = origFetch.apply(this, arguments);
    // Capture tokens from auth response
    if (url.includes('/auth/signin') || url.includes('/auth/refresh')) {
      p.then(function(r) {
        r.clone().json().then(function(j) { if (j && j.data) sendTokens(j.data); }).catch(function(){});
      }).catch(function(){});
    }
    return p;
  };
  // XHR fallback
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var _xhrUrl = '';
  XMLHttpRequest.prototype.open = function(m, u) { _xhrUrl = u || ''; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body) {
    if (_xhrUrl.includes('/auth/')) {
      var self = this;
      self.addEventListener('load', function() {
        try { var j = JSON.parse(self.responseText); if (j && j.data) sendTokens(j.data); } catch(e) {}
      });
      if (body) { try { var b = JSON.parse(body); _clientId = b.clientId||_clientId; _deviceId = b.deviceId||_deviceId; } catch(e) {} }
    }
    return origSend.apply(this, arguments);
  };
})();
"#;

    tauri::WebviewWindowBuilder::new(
        &app,
        "wfm-login",
        tauri::WebviewUrl::External("https://warframe.market/signin".parse()
            .map_err(|e| format!("URL parse: {}", e))?),
    )
    .title("Log in to warframe.market")
    .inner_size(520.0, 760.0)
    .resizable(true)
    .initialization_script(script)
    .build()
    .map_err(|e| format!("Window create: {}", e))?;

    Ok(())
}

/// Legacy — the new injection script calls wfm_receive_tokens directly.
/// Kept so older injected scripts that only captured the JWT still work.
#[tauri::command]
fn wfm_receive_jwt(app: tauri::AppHandle, state: State<AppState>, jwt: String) -> Result<(), String> {
    wfm_receive_tokens(app, state, jwt, String::new(), String::new(), String::new())
}

/// Receive tokens captured by the WebView injection script.
/// Calls /v2/me to get the username, stores session, closes login window.
#[tauri::command]
fn wfm_receive_tokens(
    app: tauri::AppHandle, state: State<AppState>,
    access_token: String, refresh_token: String,
    client_id: String, device_id: String,
) -> Result<(), String> {
    wfm_wait();
    let json: serde_json::Value = ureq::get("https://api.warframe.market/v2/me")
        .set("Authorization", &format!("Bearer {}", access_token))
        .set("language", "en").set("platform", "pc")
        .set("User-Agent", "FrameForge/1.2.0")
        .call().map_err(|e| format!("Profile: {}", e))?
        .into_json().map_err(|e| format!("Parse: {}", e))?;
    let username = json["data"]["ingameName"].as_str().unwrap_or("Tenno").to_string();
    *state.wfm_session.lock().unwrap_or_else(|e| e.into_inner()) = Some(WfmSession {
        access_token, refresh_token, client_id, device_id, username: username.clone(),
    });
    if let Some(win) = app.get_webview_window("wfm-login") { let _ = win.close(); }
    let _ = app.emit("wfm-auth-complete", &username);
    Ok(())
}

/// Use the stored refresh token to silently get a new access token.
#[tauri::command]
fn wfm_refresh_token(state: State<AppState>) -> Result<(), String> {
    let (refresh_token, client_id, device_id) = {
        let lock = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner());
        let s = lock.as_ref().ok_or("Not logged in")?;
        (s.refresh_token.clone(), s.client_id.clone(), s.device_id.clone())
    };
    if refresh_token.is_empty() { return Err("No refresh token".into()); }
    let body = serde_json::json!({
        "grantType": "refresh_token",
        "clientId": client_id,
        "deviceId": device_id,
        "refreshToken": refresh_token,
    });
    wfm_wait();
    let json: serde_json::Value = ureq::post("https://api.warframe.market/auth/refresh")
        .set("Content-Type", "application/json")
        .set("User-Agent", "FrameForge/1.2.0")
        .send_string(&body.to_string())
        .map_err(|e| format!("Refresh: {}", e))?
        .into_json().map_err(|e| format!("Parse: {}", e))?;
    let new_access  = json["data"]["accessToken"].as_str().ok_or("No accessToken")?.to_string();
    let new_refresh = json["data"]["refreshToken"].as_str().unwrap_or(&refresh_token).to_string();
    let mut lock = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = lock.as_mut() { s.access_token = new_access; s.refresh_token = new_refresh; }
    Ok(())
}

/// Restore a session from saved token data (JSON string).
#[tauri::command]
fn wfm_set_jwt(state: State<AppState>, jwt: String) -> Result<String, String> {
    // `jwt` here is a JSON string saved by wfm_save_credentials: { accessToken, refreshToken, ... }
    let data: serde_json::Value = serde_json::from_str(&jwt)
        .unwrap_or_else(|_| serde_json::json!({ "accessToken": jwt })); // backward compat
    let access_token  = data["accessToken"].as_str().unwrap_or(&jwt).to_string();
    let refresh_token = data["refreshToken"].as_str().unwrap_or("").to_string();
    let client_id     = data["clientId"].as_str().unwrap_or("").to_string();
    let device_id     = data["deviceId"].as_str().unwrap_or("").to_string();
    // Validate by calling /v2/me
    wfm_wait();
    let json: serde_json::Value = ureq::get("https://api.warframe.market/v2/me")
        .set("Authorization", &format!("Bearer {}", access_token))
        .set("language", "en").set("platform", "pc")
        .set("User-Agent", "FrameForge/1.2.0")
        .call().map_err(|e| format!("401: {}", e))?
        .into_json().map_err(|e| format!("Parse: {}", e))?;
    let username = json["data"]["ingameName"].as_str().unwrap_or("Tenno").to_string();
    *state.wfm_session.lock().unwrap_or_else(|e| e.into_inner()) = Some(WfmSession {
        access_token, refresh_token, client_id, device_id, username: username.clone(),
    });
    Ok(username)
}

/// Log in via v1 signin (current recommended method per WFM Discord).
/// Token is returned in the set-cookie header: "JWT=eyJ...; Path=/; ..."
/// Use it as: Authorization: Bearer <token>
#[tauri::command]
fn wfm_login(state: State<AppState>, email: String, password: String) -> Result<String, String> {
    let body = serde_json::json!({ "email": email, "password": password });
    wfm_wait();
    let resp = ureq::post("https://api.warframe.market/v1/auth/signin")
        .set("Content-Type", "application/json")
        .set("Authorization", "JWT")
        .set("User-Agent", "FrameForge/1.2.0")
        .send_string(&body.to_string())
        .map_err(|e| format!("Login failed: {}", e))?;

    // Token lives in set-cookie: "JWT=eyJ...; Path=/; HttpOnly"
    let token = resp.header("set-cookie")
        .and_then(|h| h.split(';').next())
        .and_then(|s| s.strip_prefix("JWT="))
        .map(|s| s.to_string())
        .ok_or("No JWT token in response cookies")?;

    let json: serde_json::Value = resp.into_json()
        .map_err(|e| format!("Parse: {}", e))?;
    let username = json["payload"]["user"]["ingame_name"]
        .as_str().unwrap_or("Tenno").to_string();

    *state.wfm_session.lock().unwrap_or_else(|e| e.into_inner()) = Some(WfmSession {
        access_token: token,
        refresh_token: String::new(), // v1 has no refresh token
        client_id: String::new(),
        device_id: String::new(),
        username: username.clone(),
    });
    Ok(username)
}

/// Fetch current in-game buy and sell orders for an item, sorted by price.
#[tauri::command]
fn wfm_get_item_orders(state: State<AppState>, url_name: String) -> Result<serde_json::Value, String> {
    let auth = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| s.auth_header());
    wfm_wait();
    let mut req = ureq::get(&format!("https://api.warframe.market/v2/orders/item/{}", url_name))
        .set("language", "en").set("platform", "pc").set("User-Agent", "FrameForge/1.2.0");
    if let Some(ref h) = auth { req = req.set("Authorization", h); }
    let json: serde_json::Value = req.call().map_err(|e| format!("orders: {}", e))?
        .into_json().map_err(|e| format!("parse: {}", e))?;
    let orders = json["data"].as_array().cloned().unwrap_or_default();
    let mut sell: Vec<serde_json::Value> = orders.iter().filter(|o| o["type"] == "sell").cloned().collect();
    sell.sort_by_key(|o| o["platinum"].as_i64().unwrap_or(999_999));
    let mut buy: Vec<serde_json::Value> = orders.iter().filter(|o| o["type"] == "buy").cloned().collect();
    buy.sort_by_key(|o| -(o["platinum"].as_i64().unwrap_or(0)));
    Ok(serde_json::json!({ "sell": sell.into_iter().take(15).collect::<Vec<_>>(), "buy": buy.into_iter().take(15).collect::<Vec<_>>() }))
}

/// Fetch 90-day price statistics for an item (daily medians for the chart).
#[tauri::command]
fn wfm_get_item_statistics(state: State<AppState>, url_name: String) -> Result<serde_json::Value, String> {
    let auth = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| s.auth_header());
    wfm_wait();
    let mut req = ureq::get(&format!("https://api.warframe.market/v1/items/{}/statistics", url_name))
        .set("language", "en").set("platform", "pc").set("User-Agent", "FrameForge/1.2.0");
    if let Some(ref h) = auth { req = req.set("Authorization", h); }
    let json: serde_json::Value = req.call().map_err(|e| format!("stats: {}", e))?
        .into_json().map_err(|e| format!("parse: {}", e))?;
    Ok(json["payload"]["statistics_closed"]["90days"].clone())
}

/// Save the WFM access token to Windows Credential Manager (encrypted by the OS).
/// Stored under "FrameForge_WFM" — username field = "token", password = JWT value.
#[tauri::command]
#[cfg(target_os = "windows")]
fn wfm_save_credentials(email: String, password: String) -> Result<(), String> {
    let _ = email; // kept for API compatibility; we save the JWT passed as password
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE,
    };
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let target: Vec<u16> = OsStr::new("FrameForge_WFM").encode_wide().chain(Some(0)).collect();
    let user:   Vec<u16> = OsStr::new(&email).encode_wide().chain(Some(0)).collect();
    let pass_bytes = password.as_bytes();

    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_ptr() as *mut _,
        Comment: std::ptr::null_mut(),
        LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: pass_bytes.len() as u32,
        CredentialBlob: pass_bytes.as_ptr() as *mut _,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user.as_ptr() as *mut _,
    };
    let ok = unsafe { CredWriteW(&cred, 0) };
    if ok == 0 { Err("Failed to save to Windows Credential Manager".into()) } else { Ok(()) }
}

/// Load WFM credentials from Windows Credential Manager.
#[tauri::command]
#[cfg(target_os = "windows")]
fn wfm_load_credentials() -> Result<Option<(String, String)>, String> {
    use windows_sys::Win32::Security::Credentials::{
        CredReadW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::slice;

    let target: Vec<u16> = OsStr::new("FrameForge_WFM").encode_wide().chain(Some(0)).collect();
    let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) };
    if ok == 0 || cred_ptr.is_null() { return Ok(None); }

    let cred = unsafe { &*cred_ptr };
    let email = unsafe {
        let ptr = cred.UserName;
        if ptr.is_null() { String::new() } else {
            let len = (0..).take_while(|&i| *ptr.offset(i) != 0).count();
            String::from_utf16_lossy(slice::from_raw_parts(ptr, len))
        }
    };
    let password = unsafe {
        if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 { String::new() } else {
            String::from_utf8_lossy(slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)).to_string()
        }
    };
    unsafe { CredFree(cred_ptr as *mut _); }
    Ok(Some((email, password)))
}

/// Delete saved WFM credentials from Windows Credential Manager.
#[tauri::command]
#[cfg(target_os = "windows")]
fn wfm_delete_credentials() -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    let target: Vec<u16> = OsStr::new("FrameForge_WFM").encode_wide().chain(Some(0)).collect();
    unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0); }
    Ok(())
}

/// Clear the stored WFM session.
#[tauri::command]
fn wfm_logout(state: State<AppState>) {
    *state.wfm_session.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Return the current WFM session username (no JWT exposed to frontend).
#[tauri::command]
fn wfm_get_session(state: State<AppState>) -> Option<String> {
    state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| s.username.clone())
}

/// Return the current session token data as JSON for saving.
#[tauri::command]
fn wfm_get_jwt(state: State<AppState>) -> Option<String> {
    state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| serde_json::json!({
            "accessToken":  s.access_token,
            "refreshToken": s.refresh_token,
            "clientId":     s.client_id,
            "deviceId":     s.device_id,
        }).to_string())
}

fn session_auth(state: &State<AppState>) -> Result<String, String> {
    state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| s.auth_header()).ok_or("Not logged in to warframe.market".into())
}

/// Fetch the authenticated user's active buy + sell orders.
#[tauri::command]
fn wfm_get_orders(state: State<AppState>) -> Result<serde_json::Value, String> {
    let auth = session_auth(&state)?;
    wfm_wait();
    let json: serde_json::Value = wfm_request("GET", "/v2/orders/my", &auth)
        .call().map_err(|e| format!("Get orders: {}", e))?
        .into_json().map_err(|e| format!("Parse: {}", e))?;
    Ok(json["data"].clone())
}

/// Set WFM online status via WebSocket.
/// Connects, authenticates, sends status with 6-hour duration, then disconnects.
/// The duration means status persists even after the connection closes.
/// Values: "online" | "ingame" | "invisible"
#[tauri::command]
async fn wfm_set_status(state: State<'_, AppState>, status: String) -> Result<(), String> {
    if !["online", "ingame", "invisible"].contains(&status.as_str()) {
        return Err("Status must be: online, ingame, or invisible".into());
    }
    let token = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().ok_or("Not logged in")?.access_token.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use tungstenite::{connect, Message};

        let (mut ws, _) = connect("wss://ws.warframe.market/socket")
            .map_err(|e| format!("WS connect: {}", e))?;

        let send = |ws: &mut tungstenite::WebSocket<_>, route: &str, payload: serde_json::Value| {
            let msg = serde_json::json!({ "route": route, "payload": payload, "id": route }).to_string();
            ws.send(Message::Text(msg.into())).map_err(|e| format!("WS send: {}", e))
        };

        let wait_for = |ws: &mut tungstenite::WebSocket<_>, ok_route: &str, err_route: &str| -> Result<(), String> {
            for _ in 0..20 {
                match ws.read() {
                    Ok(Message::Text(text)) => {
                        let v: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
                        let route = v["route"].as_str().unwrap_or("");
                        if route == ok_route  { return Ok(()); }
                        if route == err_route { return Err(format!("WFM error: {}", v["payload"])); }
                    }
                    Err(e) => return Err(format!("WS read: {}", e)),
                    _ => {}
                }
            }
            Err("WS response timeout".into())
        };

        // 1. Authenticate
        send(&mut ws, "@wfm|cmd/auth/signIn", serde_json::json!({ "token": token }))?;
        wait_for(&mut ws, "@wfm|cmd/auth/signIn:ok", "@wfm|cmd/auth/signIn:error")?;

        // 2. Set status — 6-hour duration so it persists after disconnect
        send(&mut ws, "@wfm|cmd/status/set", serde_json::json!({
            "status": status,
            "duration": 21600   // max 6 hours
        }))?;
        wait_for(&mut ws, "@wfm|cmd/status/set:ok", "@wfm|cmd/status/set:error")?;

        let _ = ws.close(None);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task: {}", e))?
}

// ─── Riven database ───────────────────────────────────────────────────────────

static RIVEN_ABBREVIATIONS: &[(&str, &str)] = &[
    ("CD",    "Critical Damage"),
    ("CC",    "Critical Chance"),
    ("MS",    "Multishot"),
    ("DMG",   "Base Damage"),
    ("FR",    "Fire Rate"),
    ("SC",    "Status Chance"),
    ("TOX",   "Toxicity"),
    ("HEAT",  "Heat"),
    ("ELEC",  "Electricity"),
    ("COLD",  "Cold"),
    ("PT",    "Punch Through"),
    ("RLS",   "Reload Speed"),
    ("MAG",   "Magazine Size"),
    ("AMMO",  "Ammo Maximum"),
    ("ZOOM",  "Zoom"),
    ("REC",   "Recoil"),
    ("SLASH", "Slash"),
    ("PUNC",  "Puncture"),
    ("IMP",   "Impact"),
    ("PFS",   "Projectile Flight Speed"),
    ("SD",    "Status Duration"),
    ("DTI",   "Damage to Infested"),
    ("DTG",   "Damage to Grineer"),
    ("DTC",   "Damage to Corpus"),
    ("RLS",   "Reload Speed"),
    ("AS",    "Attack Speed"),
    ("RANGE", "Range"),
    ("IC",    "Initial Combo"),
    ("CC",    "Combo Count Chance"),
    ("EFF",   "Heavy Attack Efficiency"),
    ("SLIDE", "Slide Critical Chance"),
    ("FIN",   "Finisher Damage"),
    ("HA",    "Heavy Attack Damage"),
    ("SLAM",  "Slam Attack"),
];

/// Expand all-caps abbreviations in a notes string using the abbreviations table.
/// "PUNC gives 5%CC" → "Puncture gives 5% Critical Chance"
fn expand_abbrevs_in_notes(notes: &str) -> String {
    let bytes = notes.as_bytes();
    let mut result = String::with_capacity(notes.len() * 2);
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_uppercase() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_uppercase() {
                i += 1;
            }
            // Only expand if surrounded by non-alphabetic chars (word boundary)
            let prev_alpha = start > 0 && bytes[start - 1].is_ascii_alphabetic();
            let next_alpha = i < bytes.len() && bytes[i].is_ascii_alphabetic();
            if !prev_alpha && !next_alpha {
                let word = &notes[start..i];
                if let Some((_, full)) = RIVEN_ABBREVIATIONS.iter().find(|(a, _)| *a == word) {
                    result.push_str(&notes[last..start]);
                    result.push_str(full);
                    last = i;
                }
            }
        } else {
            i += 1;
        }
    }
    result.push_str(&notes[last..]);
    result
}

fn riven_abbrev_to_full(abbrev: &str) -> String {
    let up = abbrev.trim().to_uppercase();
    RIVEN_ABBREVIATIONS.iter()
        .find(|(a, _)| *a == up.as_str())
        .map(|(_, f)| f.to_string())
        .unwrap_or_else(|| abbrev.to_string())
}

/// Parse spreadsheet stat string into slot groups.
/// Space-separated tokens = each is its own required slot.
/// Slash-separated tokens = any one of these fills that slot.
/// "CD MS/TOX/DMG/FR/CC" → [[CD], [MS, TOX, DMG, FR, CC]]  (2 groups)
/// "CD AS RANGE"          → [[CD], [AS], [RANGE]]            (3 groups, all required)
/// "CC MS FR/CD/DMG/HEAT" → [[CC], [MS], [FR, CD, DMG, HEAT]] (3 groups)
/// Multiple "or" paths are merged: all unique groups across all alternatives.
fn parse_stat_groups(s: &str) -> Vec<Vec<String>> {
    let without_note = s.split('(').next().unwrap_or(s);
    let mut all_groups: Vec<Vec<String>> = Vec::new();
    for alt in without_note.split(" or ") {
        for token in alt.split_whitespace() {
            let options: Vec<String> = token.split('/')
                .filter_map(|t| { let t = t.trim(); if t.is_empty() { None } else { Some(riven_abbrev_to_full(t)) } })
                .collect();
            if !options.is_empty() {
                // Avoid duplicating groups that appear in multiple alternatives
                if !all_groups.iter().any(|g| g == &options) {
                    all_groups.push(options);
                }
            }
        }
    }
    all_groups
}

/// Flat dedup list of all stats across all groups — kept for backwards compat where needed.
fn parse_riven_stat_str(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    for group in parse_stat_groups(s) {
        for stat in group {
            if !result.contains(&stat) { result.push(stat); }
        }
    }
    result
}

fn csv_split_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for ch in line.chars() {
        match ch {
            '"' => in_q = !in_q,
            ',' if !in_q => { fields.push(cur.trim().to_string()); cur = String::new(); }
            c => cur.push(c),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RivenEntry {
    pub weapon: String,
    /// Each inner Vec is one "slot group":
    ///   - [single stat]    = required (space-separated in spreadsheet)
    ///   - [A, B, C, ...]   = any one of these fills this slot (/-separated)
    /// "CD MS/TOX/DMG" → [[CD], [MS, TOX, DMG]]
    pub stat_groups: Vec<Vec<String>>,
    pub safe_negatives: Vec<String>,
    pub notes: String,
}

#[derive(serde::Serialize)]
pub struct RivenAnalysis {
    pub weapon: String,
    pub matched_positives: Vec<String>,
    pub missing_positives: Vec<String>,
    pub safe_negatives_present: Vec<String>,
    pub harmful_negatives: Vec<String>,
    pub total_wanted: usize,
    pub score: f32,
    pub verdict: String,
    pub notes: String,
}

static RIVEN_DB: std::sync::OnceLock<std::sync::Mutex<HashMap<String, RivenEntry>>> =
    std::sync::OnceLock::new();

fn get_riven_db() -> &'static std::sync::Mutex<HashMap<String, RivenEntry>> {
    RIVEN_DB.get_or_init(|| {
        std::sync::Mutex::new(load_riven_csv_from_url().unwrap_or_default())
    })
}

const RIVEN_SHEET_ID: &str = "1zbaeJBuBn44cbVKzJins_E3hTDpnmvOk8heYN-G8yy8";
// Tabs: 0=primary, 1505239276=secondary, 1413904270=melee, 289737427=archwing, 965095749=other
// 1687910063 is the legend/info page — skip it
const RIVEN_SHEET_GIDS: &[u64] = &[0, 1505239276, 1413904270, 289737427, 965095749];

fn load_riven_csv_from_url() -> Result<HashMap<String, RivenEntry>, String> {
    let mut combined = HashMap::new();
    for &gid in RIVEN_SHEET_GIDS {
        let url = format!(
            "https://docs.google.com/spreadsheets/d/{}/export?format=csv&gid={}",
            RIVEN_SHEET_ID, gid
        );
        match ureq::get(&url)
            .set("User-Agent", "FrameForge/1.4.2")
            .call().map_err(|e| e.to_string())
            .and_then(|r| r.into_string().map_err(|e| e.to_string()))
        {
            Ok(csv) => { combined.extend(parse_riven_csv(&csv)); }
            Err(e) => { eprintln!("[riven] Failed to load gid={}: {}", gid, e); }
        }
    }
    if combined.is_empty() {
        return Err("No riven data loaded from any sheet tab".into());
    }
    Ok(combined)
}

fn parse_riven_csv(csv: &str) -> HashMap<String, RivenEntry> {
    let mut map = HashMap::new();
    let mut lines = csv.lines();

    // Read header to find which column holds "NEGATIVE STATS:" — it varies by tab
    let header = match lines.next() { Some(h) => h, None => return map };
    let hf = csv_split_line(header);
    let neg_col = hf.iter().position(|c| c.trim().to_lowercase().contains("negative")).unwrap_or(5);
    let notes_col = hf.iter().position(|c| c.trim().to_lowercase().contains("note")).unwrap_or(8);

    for line in lines {
        let f = csv_split_line(line);
        if f.len() < neg_col + 1 { continue; }
        let weapon = f[0].trim().to_lowercase();
        if weapon.is_empty() { continue; }
        let stat_groups = parse_stat_groups(&f[1]);
        let safe_neg    = parse_riven_stat_str(&f[neg_col]);
        let raw_notes   = f.get(notes_col).map(|s| s.trim().trim_matches('"').to_string()).unwrap_or_default();
        let notes       = expand_abbrevs_in_notes(&raw_notes);
        map.insert(weapon.clone(), RivenEntry { weapon, stat_groups, safe_negatives: safe_neg, notes });
    }
    map
}

/// Like ocr_stat_to_full but first tries the full conditional name, then strips "for X" and retries.
/// "Critical Chance for Slide Attack" → "Slide Critical Chance" (full wins)
/// "Critical Damage for Slide Attack" → stripped → "Critical Damage" (full doesn't match, fallback)
fn ocr_stat_to_full_with_condition(ocr_name: &str) -> String {
    let full_try = ocr_stat_to_full(ocr_name);
    if full_try != ocr_name {
        return full_try; // matched on full name
    }
    // Strip "for <condition>" and try again
    let stripped = ocr_name.split(" for ").next().unwrap_or(ocr_name).trim();
    if stripped != ocr_name {
        let stripped_try = ocr_stat_to_full(stripped);
        if stripped_try != stripped {
            return stripped_try;
        }
    }
    full_try // return best effort even if unrecognized
}

/// In-game stat names → database full names (handles abbreviations and element icons stripped by OCR)
fn ocr_stat_to_full(ocr_name: &str) -> String {
    // Strip leading OCR artifacts from element icons (e.g. "61-leat" → "leat" from 🔥Heat,
    // "ld" from ❄Cold, etc.) before pattern matching.
    let stripped = ocr_name.trim().trim_start_matches(|c: char| !c.is_alphabetic());
    let n = stripped.to_lowercase();
    match n.as_str() {
        // Conditional melee stats — checked FIRST so "critical chance for slide attack" wins
        // over the generic "critical chance" pattern below
        s if s.contains("critical chance") && (s.contains("slide") || s.contains("slide attack")) => "Slide Critical Chance",
        s if s.contains("critical chance") && s.contains("aerial") => "Aerial Critical Chance",
        s if s.contains("critical chance") && s.contains("wall") => "Wall Critical Chance",
        s if s.contains("critical damage") || s.contains("crit. damage") || s.contains("crit damage") => "Critical Damage",
        s if s.contains("critical chance") || s.contains("crit. chance") || s.contains("crit chance") => "Critical Chance",
        s if s.contains("multishot") => "Multishot",
        s if s.contains("fire rate") => "Fire Rate",
        s if s.contains("status chance") => "Status Chance",
        s if s.contains("base damage") || (s.contains("damage") && !s.contains("critical") && !s.contains("infested") && !s.contains("grineer") && !s.contains("corpus")) => "Base Damage",
        // Toxin — icon may eat 'T', leaving "oxin" or "oxicity"
        s if s.contains("toxin") || s.contains("toxicity") || s.starts_with("oxin") => "Toxicity",
        // Heat — fire icon may eat 'H', leaving "eat" or "leat"
        s if s.contains("heat") || s.contains("fire damage")
            || s == "eat" || s == "leat" || (s.ends_with("eat") && s.len() <= 7) => "Heat",
        // Electricity — icon may eat 'E', leaving "lectricity" etc.
        s if s.contains("electricity") || s.contains("electric") || s.starts_with("lectr") => "Electricity",
        // Cold — ice icon may eat 'C', leaving "old"
        s if s.contains("cold") || s.contains("freeze") || s == "old" => "Cold",
        s if s.contains("punch through") => "Punch Through",
        s if s.contains("reload speed") || s.contains("reload") => "Reload Speed",
        s if s.contains("magazine size") || s.contains("magazine") || s.contains("mag size") => "Magazine Size",
        s if s.contains("ammo max") || s.contains("ammo maximum") => "Ammo Maximum",
        s if s.contains("zoom") => "Zoom",
        s if s.contains("recoil") => "Recoil",
        s if s.contains("slash") => "Slash",
        s if s.contains("puncture") => "Puncture",
        s if s.contains("impact") => "Impact",
        s if s.contains("flight speed") || s.contains("proj. flight") || s.contains("projectile") => "Projectile Flight Speed",
        s if s.contains("status duration") => "Status Duration",
        s if s.contains("infested") => "Damage to Infested",
        s if s.contains("grineer") => "Damage to Grineer",
        s if s.contains("corpus") => "Damage to Corpus",
        // Melee-specific stats
        s if s.contains("attack speed") || s.contains("attack spd") => "Attack Speed",
        s if s.contains("combo duration") => "Combo Duration",
        s if s.contains("combo count") => "Combo Count Chance",
        s if s.contains("heavy attack") && s.contains("efficiency") => "Heavy Attack Efficiency",
        s if s.contains("heavy attack") => "Heavy Attack Damage",
        s if s.contains("slam") => "Slam Attack",
        s if s.contains("slide") && s.contains("crit") => "Slide Critical Chance",
        s if s.contains("range") => "Range",
        _ => return ocr_name.to_string(),
    }.to_string()
}

/// Parse stat lines from a card's OCR text, returning rolled_stats JSON array.
fn parse_original_stats(text: Option<&str>) -> Vec<serde_json::Value> {
    let Some(text) = text else { return vec![]; };
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.to_lowercase().starts_with('x') && l.len() > 2 && l.chars().nth(1).map_or(false, |c| c.is_ascii_digit() || c == ' ') {
            let alpha_start = l.find(|c: char| c.is_alphabetic() && c != 'x').unwrap_or(l.len());
            let val = l[..alpha_start].split_whitespace().collect::<Vec<_>>().join("");
            let name_part = l[alpha_start..].trim().split(" (").next().unwrap_or("").trim();
            if !name_part.is_empty() {
                out.push(serde_json::json!({"name": ocr_stat_to_full_with_condition(name_part), "value": val, "positive": true}));
            }
            continue;
        }
        let fc = l.chars().next().unwrap_or(' ');
        let (is_pos, part) = if l.starts_with('+') { (true, l.trim_start_matches('+')) }
                             else if l.starts_with('-') { (false, l.trim_start_matches('-')) }
                             else if "•·○●◦".contains(fc) { (true, l.trim_start_matches(|c: char| "•·○●◦".contains(c))) }
                             else { continue; };
        let val = if part.contains('%') {
            let n = part.split('%').next().unwrap_or("").trim();
            format!("{}{}%", if is_pos { "+" } else { "-" }, n)
        } else {
            let e = part.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(part.len());
            format!("{}{}%", if is_pos { "+" } else { "-" }, &part[..e])
        };
        let sname: &str = if let Some(a) = part.splitn(2, '%').nth(1) { a.trim() }
                          else { let e = part.find(|c: char| c.is_alphabetic()).unwrap_or(0);
                                 part[e..].trim_start_matches(|c: char| !c.is_alphabetic()) };
        if sname.is_empty() { continue; }
        let sname = sname.trim_start_matches(|c: char| !c.is_alphabetic());
        let sname = sname.split(" (").next().unwrap_or(sname).trim();
        out.push(serde_json::json!({"name": ocr_stat_to_full_with_condition(sname), "value": val, "positive": is_pos}));
    }
    out
}

/// Capture the riven reroll screen and OCR the stats + weapon name.
/// Returns (weapon_name, positives, negatives).
#[tauri::command]
async fn ocr_riven_screen() -> Result<serde_json::Value, String> {
    let riven_log = std::env::temp_dir().join("frameforge_riven_session.txt");
    let ts1 = chrono::Local::now().format("%H:%M:%S%.3f").to_string();

    let _ = append_to_file(&riven_log, &format!(
        "[STEP 2] OCR STARTED — {}\n\
         ├─ Capture region : y 0%–75% (header + card + FITS IN panel)\n\
         └─ Validating: expects \"INVENTORY/MODS\" at top + \"FITS IN\" on right\n",
        ts1
    ));

    // Capture y 0–0.75: includes the "INVENTORY / MODS" header at the top and the
    // "FITS IN" weapon panel on the right. We retry until both markers are visible —
    // this filters out false EE.log triggers and handles slow screen transitions.
    const MAX_ATTEMPTS: u32 = 6;
    const RETRY_MS: u64 = 350;

    let mut text = String::new();
    let mut full_text_for_fallback = String::new();
    let mut confirmed = false;

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(RETRY_MS)).await;
        }

        let riven_log2 = riven_log.clone();
        // One PrintWindow capture; two OCR passes from the same pixels:
        //   • Full width (0–100%) for validation markers ("INVENTORY/MODS" + "FITS IN")
        //   • Card column only (20–65%) for stat parsing — excludes the right panel whose
        //     "FITS IN" / weapon label text can interfere with reading the card's bottom stats.
        let attempt_result = tokio::task::spawn_blocking(move || {
            let ts = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
            let px = ocr::capture_warframe_pixels().map_err(|e| format!("Capture: {}", e))?;
            let (pixels, w, h) = px;
            let full_text = ocr::ocr_pixels_rect(&pixels, w, h, 0.0, 1.0, 0.0, 0.82)
                .unwrap_or_default();
            let card_text = ocr::ocr_pixels_rect(&pixels, w, h, 0.20, 0.65, 0.28, 0.82)
                .unwrap_or_default();
            let _ = append_to_file(&riven_log2, &format!(
                "[STEP 2] OCR attempt {} — {}\n├─ Full text:\n{}\n└─ Card text:\n{}\n\n",
                attempt + 1, ts, full_text, card_text
            ));
            Ok::<_, String>((full_text, card_text))
        }).await.map_err(|e| format!("Task: {}", e))??;

        let (full_text, card_text) = attempt_result;
        let lower = full_text.to_lowercase();
        let has_header  = lower.contains("inventory") || lower.contains("mods");
        let has_fits_in = lower.contains("fits in");

        let _ = append_to_file(&riven_log, &format!(
            "[STEP 2] attempt {} — header={} fits_in={}\n",
            attempt + 1, has_header, has_fits_in
        ));

        // Count stat lines in card_text — 5+ means comparison mode (two cards visible).
        // In comparison mode the "FITS IN" panel shifts and may not OCR correctly.
        // Accept header-only confirmation when we already see enough stat lines.
        let stat_count = card_text.lines()
            .filter(|l| { let t = l.trim(); t.starts_with('+') || t.starts_with('-') })
            .count();
        let comparison_likely = stat_count >= 5;

        if (has_header && has_fits_in) || (has_header && comparison_likely) {
            text = card_text;
            full_text_for_fallback = full_text;
            confirmed = true;
            if comparison_likely && !has_fits_in {
                let _ = append_to_file(&riven_log, &format!(
                    "[STEP 2] Comparison mode early-confirm ({} stat lines, no FITS IN)\n", stat_count
                ));
            }
            break;
        }
        text = card_text;
        full_text_for_fallback = full_text;
    }

    if !confirmed {
        let _ = append_to_file(&riven_log, "[STEP 2] Screen markers not confirmed after all attempts — proceeding with last OCR result anyway\n\n");
    }

    // Detect comparison mode: >4 stat lines means two cards are visible (3–4 stats each).
    // A riven can have at most 4 stats (3 pos + 1 neg), so 5+ total implies 2 cards.
    let stat_line_count = text.lines()
        .filter(|l| { let t = l.trim(); t.starts_with('+') || t.starts_with('-') })
        .count();
    let is_comparison = stat_line_count > 4;

    if is_comparison {
        let _ = append_to_file(&riven_log, &format!(
            "[STEP 2] COMPARISON MODE detected ({} stat lines) — capturing card columns separately\n", stat_line_count
        ));
    }

    // In comparison mode: one PrintWindow capture, OCR left and right card columns.
    // Original card is ALWAYS on the left; new roll is always on the right.
    // Card area x 20–65% is split roughly in half: left=20–42%, right=42–65%.
    let (left_text, right_text) = if is_comparison {
        let riven_log3 = riven_log.clone();
        let cols = tokio::task::spawn_blocking(move || {
            match ocr::capture_warframe_pixels() {
                Ok((px, w, h)) => {
                    // Wider y range to catch element-icon stat lines near card bottom
                    let left  = ocr::ocr_pixels_rect(&px, w, h, 0.18, 0.44, 0.25, 0.84).unwrap_or_default();
                    let right = ocr::ocr_pixels_rect(&px, w, h, 0.44, 0.68, 0.25, 0.84).unwrap_or_default();
                    let _ = append_to_file(&riven_log3, &format!(
                        "[STEP 2] Original (left):\n{}\n\nNew roll (right):\n{}\n\n", left, right
                    ));
                    (left, right)
                }
                Err(e) => {
                    let _ = append_to_file(&riven_log3, &format!("[STEP 2] Column capture failed: {}\n", e));
                    (String::new(), String::new())
                }
            }
        }).await.map_err(|e| format!("Task: {}", e))?;
        cols
    } else {
        (String::new(), String::new())
    };

    // Which text to parse for the new roll:
    // - Comparison mode: right column = new roll, left column = original
    // - Single card mode: card column text; fall back to full text if card column had no stats
    let card_has_stats = text.lines().any(|l| { let t = l.trim(); t.starts_with('+') || t.starts_with('-') });
    let parse_text = if is_comparison && !right_text.is_empty() {
        &right_text
    } else if !card_has_stats && !full_text_for_fallback.is_empty() {
        // Card column empty — fall back to the full-width validated text
        let _ = append_to_file(&riven_log, "[STEP 2] Card column had no stats — using full-width text as fallback\n");
        &full_text_for_fallback
    } else {
        &text
    };
    let original_parse_text = if is_comparison && !left_text.is_empty() { Some(left_text.as_str()) } else { None };

    // Parse weapon name.
    // In the unveil screen "FITS IN" appears on its own line, weapon name on the next line.
    // In the reroll screen the mod name is "WeaponName RivenIdentifier" (e.g. "Hirudo Geli-plecinus").
    let lines: Vec<&str> = parse_text.lines().collect();

    // Helper: try to match a candidate string against the riven DB, trying word-prefix
    // substrings from longest to shortest (handles "Dual Cleavers Cronitron" → "dual cleavers").
    let find_in_db = |candidate: &str| -> Option<String> {
        let db = get_riven_db().lock().unwrap_or_else(|e| e.into_inner());
        let words: Vec<&str> = candidate.split_whitespace().collect();
        // Try 4-word prefix, then 3, 2, 1
        for len in (1..=words.len().min(4)).rev() {
            let prefix = words[..len].join(" ");
            if db.contains_key(&prefix) {
                return Some(prefix);
            }
        }
        None
    };

    let weapon = lines.iter().enumerate()
        .find(|(_, l)| l.to_lowercase().contains("fits in"))
        .and_then(|(i, _)| lines.get(i + 1))
        .and_then(|l| {
            let lc = l.trim().to_lowercase();
            find_in_db(&lc).or(Some(lc))
        })
        // Fallback: first non-stat, non-UI line is the mod name "WeaponName RivenId".
        // Only accept if it matches a weapon in the DB — avoids returning currency values
        // like "D '5,598" (Endo count) that pass the basic filter.
        .or_else(|| {
            lines.iter()
                .find_map(|l| {
                    let lt = l.trim().to_lowercase();
                    if lt.is_empty() { return None; }
                    // Skip obvious UI noise
                    if lt.contains("fits in") || lt.contains("cycle") || lt.contains("kuva")
                    || lt.contains("mr ") || lt.contains("inventory") || lt.contains("mods")
                    || lt.contains("remaining") || lt.contains("show ranked") || lt.contains("cancel")
                    || lt.starts_with('+') || lt.starts_with('-') || lt.starts_with('x')
                    || lt.chars().next().map_or(false, |c| c.is_ascii_digit())
                    // Skip lines that look like currency values (contain digit+comma or digit+apostrophe)
                    || (lt.contains(',') && lt.chars().any(|c| c.is_ascii_digit()))
                    || (lt.contains('\'') && lt.chars().any(|c| c.is_ascii_digit()))
                    {
                        return None;
                    }
                    find_in_db(&lt) // only return if it's actually in the DB
                })
        })
        .unwrap_or_default();

    // Pre-process: join continuation lines onto their stat.
    // Stat lines start with +, -, or x<digit>. Any other non-empty line that follows
    // a stat line is treated as a wrapped continuation of that stat's name.
    // Exception: UI text like "FITS IN", "MR N", "INVENTORY" is not a continuation.
    let mut joined: Vec<String> = Vec::new();
    {
        let mut pending: Option<String> = None;
        for line in parse_text.lines() {
            let l = line.trim();
            if l.is_empty() { continue; }
            let ll = l.to_lowercase();
            // OCR sometimes misreads '+' as '•', '·', or similar bullet chars
            let first_char = l.chars().next().unwrap_or(' ');
            let is_ocr_plus = "•·○●◦".contains(first_char)
                && l.len() > 1
                && l.chars().nth(1).map_or(false, |c| c.is_ascii_digit());
            let is_stat_start = l.starts_with('+') || l.starts_with('-')
                || (ll.starts_with('x') && l.len() > 2 && l.chars().nth(1).map_or(false, |c| c.is_ascii_digit()))
                || is_ocr_plus;
            // "Damage to Grineer/Corpus/Infested" can appear without prefix when OCR drops the
            // leading "x0.88" multiplier value — treat as standalone stat with unknown value.
            let is_orphan_stat = ll.starts_with("damage to grineer")
                || ll.starts_with("damage to corpus")
                || ll.starts_with("damage to infested");
            let is_ui_noise = ll.contains("fits in") || ll.starts_with("mr ")
                || ll.contains("inventory") || ll.contains("cycle")
                || ll.contains("kuva") || ll.contains("remaining")
                || ll.contains("show ranked") || ll.contains("cancel");
            if is_stat_start {
                if let Some(prev) = pending.take() { joined.push(prev); }
                pending = Some(l.to_string());
            } else if is_orphan_stat {
                // OCR dropped the x-multiplier prefix — synthesise a stat line with unknown value
                if let Some(prev) = pending.take() { joined.push(prev); }
                joined.push(format!("+?% {}", l)); // value unknown but stat name preserved
            } else if is_ui_noise {
                if let Some(prev) = pending.take() { joined.push(prev); }
            } else if let Some(ref mut prev) = pending {
                prev.push(' ');
                prev.push_str(l);
            }
        }
        if let Some(prev) = pending { joined.push(prev); }
    }

    // Parse stat lines and collect rolled_stats (name + formatted value for display).
    let mut positives: Vec<String> = Vec::new();
    let mut negatives: Vec<String> = Vec::new();
    // Each entry: { "name": "Combo Count Chance", "value": "+47.2%", "positive": true }
    let mut rolled_stats: Vec<serde_json::Value> = Vec::new();

    for line in &joined {
        let l = line.trim();

        // Handle multiplier format "x1.62 Damage to Corpus"
        // OCR may insert spaces inside the number ("x1 .62"), so collect everything
        // before the first alphabetic char and join to remove those spaces.
        if l.to_lowercase().starts_with('x') && l.len() > 2 && l.chars().nth(1).map_or(false, |c| c.is_ascii_digit() || c == ' ') {
            let alpha_start = l.find(|c: char| c.is_alphabetic() && c != 'x').unwrap_or(l.len());
            let val_str = l[..alpha_start].split_whitespace().collect::<Vec<_>>().join(""); // e.g. "x1.62"
            let stat_name = l[alpha_start..].trim();
            let stat_name = stat_name.split(" (").next().unwrap_or(stat_name).trim();
            if !stat_name.is_empty() {
                let full = ocr_stat_to_full_with_condition(stat_name);
                rolled_stats.push(serde_json::json!({"name": full, "value": val_str, "positive": true}));
                positives.push(full);
            }
            continue;
        }

        let first_l = l.chars().next().unwrap_or(' ');
        let (is_pos, stat_part) = if l.starts_with('+') {
            (true, l.trim_start_matches('+'))
        } else if l.starts_with('-') {
            (false, l.trim_start_matches('-'))
        } else if "•·○●◦".contains(first_l) {
            // OCR misread '+' as a bullet/dot character — treat as positive stat
            (true, l.trim_start_matches(|c: char| "•·○●◦".contains(c)))
        } else { continue; };

        // Extract the numeric value string.
        // Must explicitly check for '%' first — split('%').next() returns Some(whole_string)
        // even when no '%' is present, which would produce "+51 'Toxin%" for element stats.
        let pct_val = if stat_part.starts_with("?%") {
            // Synthesised from orphan stat — OCR dropped the x-multiplier value
            "x?".to_string()
        } else if stat_part.contains('%') {
            let n = stat_part.split('%').next().unwrap_or("").trim();
            format!("{}{}%", if is_pos { "+" } else { "-" }, n)
        } else {
            // No % sign (element stats, OCR dropped it) — extract leading digits only
            let num_end = stat_part.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(stat_part.len());
            format!("{}{}%", if is_pos { "+" } else { "-" }, &stat_part[..num_end])
        };

        // Extract stat name
        let stat_name: &str = if let Some(after_pct) = stat_part.splitn(2, '%').nth(1) {
            after_pct.trim()
        } else {
            let num_end = stat_part.find(|c: char| c.is_alphabetic()).unwrap_or(0);
            stat_part[num_end..].trim_start_matches(|c: char| !c.is_alphabetic())
        };
        if stat_name.is_empty() { continue; }

        // Strip leading OCR icon artifacts: "61-leat" → "leat", " 🔥Heat" → "Heat"
        let stat_name = stat_name.trim_start_matches(|c: char| !c.is_alphabetic());
        if stat_name.is_empty() { continue; }

        // Strip parenthetical qualifiers: "Critical Chance (x2 for Heavy Attacks)" → "Critical Chance"
        let stat_name = stat_name.split(" (").next().unwrap_or(stat_name).trim();

        // Try to match with the full conditional name first so "Critical Chance for Slide Attack"
        // maps to "Slide Critical Chance" (not just "Critical Chance"). Fall back to stripped form.
        let full = ocr_stat_to_full_with_condition(stat_name);
        rolled_stats.push(serde_json::json!({"name": full, "value": pct_val, "positive": is_pos}));
        if is_pos { positives.push(full); } else { negatives.push(full); }
    }

    let ts3 = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
    let _ = append_to_file(&riven_log, &format!(
        "[STEP 3] PARSE RESULT — {}\n\
         ├─ Weapon    : \"{}\"\n\
         ├─ Positives : {:?}\n\
         └─ Negatives : {:?}\n\n",
        ts3, weapon, positives, negatives
    ));

    Ok(serde_json::json!({
        "weapon": weapon,
        "positives": positives,
        "negatives": negatives,
        "rolled_stats": rolled_stats,
        "is_comparison": is_comparison,
        "original_rolled_stats": parse_original_stats(original_parse_text),
        "raw": text,
    }))
}

/// Start a lightweight EE.log watcher for features that don't need the memory scanner:
/// riven reroll detection, trade completion detection, WFM whisper detection.
/// Called unconditionally at app startup — EE.log is plain file I/O, not memory reading.
#[tauri::command]
fn start_log_watcher(app: tauri::AppHandle) -> Result<(), String> {
    let log_path = dirs::data_local_dir()
        .map(|d| d.join("Warframe").join("EE.log"))
        .ok_or("Cannot find LocalAppData")?;

    std::thread::spawn(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut file_pos: u64 = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        let mut pending_trade: Option<String> = None;
        // Cooldown: don't fire riven-screen-open again within 4 seconds of the last fire.
        // Guards against the same EE.log buffer being processed twice by React StrictMode listeners.
        let mut last_riven_fire: Option<std::time::Instant> = None;

        // Use FindFirstChangeNotificationW so we wake up the instant EE.log is written,
        // instead of sleeping and polling. This is how Overwolf achieves low latency.
        let change_handle: isize = {
            use windows_sys::Win32::Storage::FileSystem::{
                FindFirstChangeNotificationW, FILE_NOTIFY_CHANGE_LAST_WRITE,
            };
            let dir = log_path.parent().unwrap_or(std::path::Path::new("."));
            let dir_wide: Vec<u16> = dir.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
            unsafe { FindFirstChangeNotificationW(dir_wide.as_ptr(), 0, FILE_NOTIFY_CHANGE_LAST_WRITE) }
        };
        let use_notify = change_handle != -1; // -1 = INVALID_HANDLE_VALUE

        loop {
            if use_notify {
                use windows_sys::Win32::System::Threading::WaitForSingleObject;
                use windows_sys::Win32::Storage::FileSystem::FindNextChangeNotification;
                // Block until EE.log directory has a write — then process immediately
                unsafe { WaitForSingleObject(change_handle, 500); } // 500ms safety timeout
                unsafe { FindNextChangeNotification(change_handle); }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let Ok(mut f) = std::fs::File::open(&log_path) else { continue };
            let len = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
            if len < file_pos { file_pos = 0; }
            if len == file_pos { continue; } // nothing new since last read
            if f.seek(SeekFrom::Start(file_pos)).is_err() { continue; }
            let mut buf = String::new();
            if f.read_to_string(&mut buf).is_err() { continue; }
            file_pos = len;
            if buf.is_empty() { continue; }
            let lower = buf.to_lowercase();

            // ── Riven reroll / unveil ─────────────────────────────────────────
            let riven_trigger =
                lower.contains("omegarerollselection.swf") ||
                lower.contains("samodeusdioramaloaded");

            let cooldown_ok = last_riven_fire
                .map_or(true, |t| t.elapsed().as_secs() >= 4);

            // Auto-trigger disabled — user triggers manually via "Check Riven" button.
            // Keeping last_riven_fire updated so VolumetricFog close still works.
            if riven_trigger && cooldown_ok {
                last_riven_fire = Some(std::time::Instant::now());
                let _ = app.emit("ff-status", "🎲 Riven screen open — click Check Riven to analyse");
            }

            // ── Riven screen close ────────────────────────────────────────────
            // WM_ACTIVATEAPP 0 fires when Warframe loses focus — but it also fires
            // momentarily when we open the overlay window. Apply a 5-second grace period
            // after the last trigger so that false-closes from the overlay opening are ignored.
            // ── Riven screen close — orbiter scene reload ─────────────────────
            // When the player exits the riven screen, the game reloads the orbiter
            // scene which creates VolumetricFog render targets. This is far more
            // reliable than WM_ACTIVATEAPP 0 (which fires on alt-tab too).
            // Guard: only fire if riven screen was recently active (< 10 min).
            if lower.contains("creating render target: /ee/materials/volumetricfog") {
                let riven_active = last_riven_fire.map_or(false, |t| {
                    let e = t.elapsed().as_secs();
                    e >= 3 && e < 600 // at least 3s after trigger (not a false-fire on open)
                });
                if riven_active {
                    // Reset so this doesn't fire again for the same session
                    last_riven_fire = None;
                    let riven_log = std::env::temp_dir().join("frameforge_riven_session.txt");
                    let ts = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
                    let _ = append_to_file(&riven_log, &format!(
                        "[STEP 4] CLOSE (VolumetricFog render target = orbiter loaded) — {}\n\n", ts
                    ));
                    let _ = app.emit("riven-screen-close", ());
                }
            }

            // ── WFM trade whisper ─────────────────────────────────────────────
            if lower.contains("(warframe.market)") {
                let raw = buf.as_str();
                let from = raw.find("@From ").map(|i| &raw[i+6..])
                    .and_then(|s| s.split(" :").next())
                    .map(|s| s.trim().to_string()).unwrap_or_else(|| "Unknown".to_string());
                let item = { let p="want to buy "; let s=" for ";
                    raw.find(p).and_then(|i| { let r=&raw[i+p.len()..]; r.find(s).map(|j| r[..j].to_string()) })
                };
                let price: Option<u64> = raw.find(" for ").and_then(|i| {
                    let r=&raw[i+5..]; r.find(" platinum").and_then(|j| r[..j].trim().parse().ok())
                });
                let _ = app.emit("wfm-whisper", serde_json::json!({
                    "from": from, "message": raw.trim(), "item": item, "price": price,
                    "timestamp": chrono::Local::now().format("%H:%M:%S").to_string(),
                }));
            }

            // ── In-game trade completion ──────────────────────────────────────
            if lower.contains("dialog::createokcancel") && lower.contains("you are offering") {
                pending_trade = Some(buf.clone());
            }
            if lower.contains("the trade was successful") {
                if let Some(ref trade_raw) = pending_trade.clone() {
                    // (same parsing logic as in start_monitor)
                    let r = trade_raw.as_str();
                    let with_player = r.find("will receive from ").and_then(|i| {
                        let a = &r[i+18..]; a.find(" the following").map(|j| a[..j].trim().to_string())
                    }).unwrap_or_default();
                    let offered = r.find("You are offering:").and_then(|i| {
                        let a=&r[i+17..]; a.find("and will receive from").map(|j| a[..j].trim().to_string())
                    }).unwrap_or_default();
                    let received = r.find("the following:").and_then(|i| {
                        let a=&r[i+14..]; a.find(", title=").map(|j| a[..j].trim().to_string())
                    }).unwrap_or_default();
                    let parse_plat = |s: &str| -> i64 { s.find("Platinum x ").and_then(|i| s[i+11..].split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok()).unwrap_or(0) };
                    let plat_off = parse_plat(&offered);
                    let plat_rec = parse_plat(&received);
                    let (direction, item_name, platinum) = if plat_off > 0 {
                        ("bought", received.lines().find(|l| !l.trim().is_empty() && !l.to_lowercase().contains("platinum")).map(|l| l.trim().to_string()).unwrap_or_default(), plat_off)
                    } else {
                        ("sold", offered.lines().find(|l| !l.trim().is_empty() && !l.to_lowercase().contains("platinum")).map(|l| l.trim().to_string()).unwrap_or_default(), plat_rec)
                    };
                    let _ = app.emit("trade-completed", serde_json::json!({
                        "withPlayer": with_player, "direction": direction,
                        "itemName": item_name, "quantity": 1, "platinum": platinum,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }));
                }
                pending_trade = None;
            }
        }
    });
    Ok(())
}

/// 3-state riven screen status:
///  "open"    = inventory header visible + "FITS IN" on right panel
///  "closed"  = inventory header visible + "FITS IN" gone (user exited riven screen)
///  "unknown" = inventory header not visible (alt-tabbed, or left inventory entirely)
#[tauri::command]
fn riven_screen_status() -> String {
    let riven_log = std::env::temp_dir().join("frameforge_riven_session.txt");
    let ts = chrono::Local::now().format("%H:%M:%S%.3f").to_string();

    let Ok((pixels, w, h)) = ocr::capture_warframe_pixels() else {
        let _ = append_to_file(&riven_log, &format!("[POLL {}] capture failed → unknown\n", ts));
        return "unknown".into();
    };

    let header = ocr::ocr_pixels_rect_raw(&pixels, w, h, 0.0, 0.55, 0.0, 0.10)
        .unwrap_or_default();
    let in_inventory = header.to_lowercase().contains("inventory");

    if !in_inventory {
        let _ = append_to_file(&riven_log, &format!("[POLL {}] no inventory header → unknown\n", ts));
        return "unknown".into();
    }

    let right = ocr::ocr_pixels_rect_raw(&pixels, w, h, 0.73, 1.0, 0.30, 0.80)
        .unwrap_or_default();
    let rl = right.to_lowercase();
    // In comparison mode "FITS IN" may be partially cut off, reading as "SIN", "IN", "TS IN" etc.
    // Accept any fragment that is a suffix of "FITS IN".
    let fits_in = rl.contains("fits in") || rl.contains("fits") || rl.contains("ts in")
        || rl.contains("its in") || (rl.trim() == "in") || (rl.trim() == "sin");
    let preview = right.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" | ");

    let status = if fits_in { "open" } else { "closed" };
    let _ = append_to_file(&riven_log, &format!(
        "[POLL {}] inventory=true fits_in={} ocr=\"{}\" → {}\n",
        ts, fits_in, &preview[..preview.len().min(80)], status
    ));
    status.into()
}

/// Is the riven reroll screen still open?
/// Checks for "FITS IN" text on the right panel using RAW OCR (no preprocessing).
/// "FITS IN" is white text on dark — readable without grayscale conversion.
/// Only closes the overlay when Warframe is still focused (INVENTORY/MODS header present)
/// AND "FITS IN" is gone — so alt-tabbing away doesn't trigger a false close.
#[tauri::command]
fn riven_screen_visible() -> bool {
    let riven_log = std::env::temp_dir().join("frameforge_riven_session.txt");
    let ts = chrono::Local::now().format("%H:%M:%S%.3f").to_string();

    let Ok((pixels, w, h)) = ocr::capture_warframe_pixels() else {
        let _ = append_to_file(&riven_log, &format!("[POLL {}] capture failed → true (assume open)\n", ts));
        return true; // can't capture = can't confirm closed
    };

    // Check header (x 0–55%, y 0–10%) for "INVENTORY" — confirms Warframe is focused
    // and we're in the mods screen. If header is absent, user alt-tabbed; keep overlay.
    let header = ocr::ocr_pixels_rect_raw(&pixels, w, h, 0.0, 0.55, 0.0, 0.10)
        .unwrap_or_default();
    let in_inventory = header.to_lowercase().contains("inventory");

    if !in_inventory {
        let _ = append_to_file(&riven_log, &format!(
            "[POLL {}] no inventory header → true (alt-tabbed or different screen)\n", ts
        ));
        return true; // Warframe not in focus or wrong screen — don't close
    }

    // Check right panel (x 73–100%, y 30–80%) for "FITS IN"
    let right = ocr::ocr_pixels_rect_raw(&pixels, w, h, 0.73, 1.0, 0.30, 0.80)
        .unwrap_or_default();
    let fits_in_visible = right.to_lowercase().contains("fits");
    let right_preview = right.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" | ");

    let _ = append_to_file(&riven_log, &format!(
        "[POLL {}] inventory=true fits_in={} ocr=\"{}\"\n",
        ts, fits_in_visible, &right_preview[..right_preview.len().min(120)]
    ));

    fits_in_visible
}

/// Write an error into the riven session log (called from TypeScript when OCR command fails).
#[tauri::command]
fn ocr_riven_log_error(error: String) {
    let path = std::env::temp_dir().join("frameforge_riven_session.txt");
    let ts = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
    let _ = append_to_file(&path, &format!(
        "[STEP 2] OCR COMMAND FAILED — {}\n└─ Error: {}\n\n", ts, error
    ));
}

/// Return all weapon names that have riven data.
#[tauri::command]
fn get_riven_weapons() -> Vec<String> {
    let db = get_riven_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut weapons: Vec<String> = db.keys().cloned().collect();
    weapons.sort();
    weapons
}

/// Reload the riven database from the Google Sheet.
#[tauri::command]
fn reload_riven_database() -> Result<usize, String> {
    let fresh = load_riven_csv_from_url()?;
    let count = fresh.len();
    *get_riven_db().lock().unwrap_or_else(|e| e.into_inner()) = fresh;
    Ok(count)
}

/// Analyse a riven roll for a given weapon.
/// positives / negatives are full stat names (e.g. "Critical Damage", "Zoom").
#[tauri::command]
fn analyze_riven(weapon: String, positives: Vec<String>, negatives: Vec<String>) -> Option<RivenAnalysis> {
    let db = get_riven_db().lock().unwrap_or_else(|e| e.into_inner());
    let key = weapon.to_lowercase();
    let entry = db.get(&key)?;

    let normalize = |s: &str| s.to_lowercase();

    // Score per group: space-separated = each is its own slot; slash-separated = any one fills a slot.
    // "CD MS/TOX/DMG" has 2 groups. Rolling CD+MS = 2/2 = 100%, not 2/7.
    let mut matched: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new(); // one formatted string per unmatched group

    for group in &entry.stat_groups {
        let hit = positives.iter().find(|p| group.iter().any(|g| normalize(g) == normalize(p)));
        if let Some(stat) = hit {
            matched.push(stat.clone());
        } else {
            // Format: "Critical Damage" for single, "Multishot / Toxicity / Fire Rate" for group
            missing.push(group.join(" / "));
        }
    }

    let mut safe_present: Vec<String> = Vec::new();
    let mut harmful: Vec<String> = Vec::new();
    for neg in &negatives {
        if entry.safe_negatives.iter().any(|s| normalize(s) == normalize(neg)) {
            safe_present.push(neg.clone());
        } else {
            harmful.push(neg.clone());
        }
    }

    let total = entry.stat_groups.len().max(1);
    let score = matched.len() as f32 / total as f32;
    let neg_ok = harmful.is_empty();

    let verdict = match (score, neg_ok) {
        (s, true)  if s >= 0.80 => "GREAT ROLL — Consider keeping".to_string(),
        (s, true)  if s >= 0.60 => "GOOD ROLL — Decent for selling".to_string(),
        (s, _)     if s >= 0.40 => "MEDIOCRE — Keep rolling".to_string(),
        _                        => "BAD ROLL — Keep rolling".to_string(),
    };

    Some(RivenAnalysis {
        weapon: entry.weapon.clone(),
        matched_positives: matched,
        missing_positives: missing,
        safe_negatives_present: safe_present,
        harmful_negatives: harmful,
        total_wanted: total,
        score,
        verdict,
        notes: entry.notes.clone(),
    })
}

/// Debug: return the raw JSON from any authenticated WFM endpoint.
#[tauri::command]
fn wfm_debug_dump(state: State<AppState>, path: String) -> Result<String, String> {
    let auth = session_auth(&state)?;
    wfm_wait();
    let json: serde_json::Value = wfm_request("GET", &path, &auth)
        .call().map_err(|e| format!("Dump: {}", e))?
        .into_json().map_err(|e| format!("Parse: {}", e))?;
    serde_json::to_string_pretty(&json).map_err(|e| e.to_string())
}

/// Get the internal WFM item ID for a URL slug (needed to create orders).
#[tauri::command]
fn wfm_get_item_info(state: State<AppState>, url_name: String) -> Result<serde_json::Value, String> {
    let auth = state.wfm_session.lock().unwrap_or_else(|e| e.into_inner())
        .as_ref().map(|s| s.auth_header()).unwrap_or_default();
    wfm_wait();
    wfm_request("GET", &format!("/v2/items/{}", url_name), &auth)
        .call().map_err(|e| format!("Item info: {}", e))?
        .into_json::<serde_json::Value>().map_err(|e| format!("Parse: {}", e))
        .map(|j| j["data"].clone())
}

/// Create a new buy or sell order.
#[tauri::command]
fn wfm_create_order(state: State<AppState>, item_id: String, order_type: String, platinum: u32, quantity: u32) -> Result<serde_json::Value, String> {
    let auth = session_auth(&state)?;
    let body = serde_json::json!({ "itemId": item_id, "type": order_type, "platinum": platinum, "quantity": quantity, "visible": true });
    wfm_wait();
    wfm_request("POST", "/v2/order", &auth)
        .send_string(&body.to_string()).map_err(|e| format!("Create order: {}", e))?
        .into_json::<serde_json::Value>().map_err(|e| format!("Parse: {}", e))
        .map(|j| j["data"].clone())
}

/// Update an existing order's price, quantity, or visibility.
#[tauri::command]
fn wfm_update_order(state: State<AppState>, order_id: String, platinum: u32, quantity: u32, visible: bool) -> Result<serde_json::Value, String> {
    let auth = session_auth(&state)?;
    let body = serde_json::json!({ "platinum": platinum, "quantity": quantity, "visible": visible });
    wfm_wait();
    wfm_request("PATCH", &format!("/v2/order/{}", order_id), &auth)
        .send_string(&body.to_string()).map_err(|e| format!("Update order: {}", e))?
        .into_json::<serde_json::Value>().map_err(|e| format!("Parse: {}", e))
        .map(|j| j["data"].clone())
}

/// Delete an order.
#[tauri::command]
fn wfm_delete_order(state: State<AppState>, order_id: String) -> Result<(), String> {
    let auth = session_auth(&state)?;
    wfm_wait();
    wfm_request("DELETE", &format!("/v2/order/{}", order_id), &auth)
        .call().map_err(|e| format!("Delete order: {}", e))?;
    Ok(())
}

/// Fetch warframe.market item list using v2 API (v1 /items returns 404).
#[tauri::command]
fn fetch_wfm_items() -> Result<Vec<WfmItem>, String> {
    wfm_wait();
    let json: serde_json::Value = ureq::get("https://api.warframe.market/v2/items")
        .call()
        .map_err(|e| format!("wfm items: {}", e))?
        .into_json()
        .map_err(|e| format!("wfm items parse: {}", e))?;

    // v2 format: { "data": [{ "slug": "rhino_prime_set", "i18n": { "en": { "name": "Rhino Prime Set" } } }] }
    let items = json["data"]
        .as_array()
        .ok_or("no data array in v2 response")?
        .iter()
        .filter_map(|v| Some(WfmItem {
            id:        v["id"].as_str().unwrap_or("").to_string(),
            item_name: v["i18n"]["en"]["name"].as_str()?.to_string(),
            url_name:  v["slug"].as_str()?.to_string(),
        }))
        .collect();
    Ok(items)
}

#[derive(serde::Serialize)]
pub struct WfmPrice {
    pub url_name: String,
    pub sell_median: Option<f64>,
    pub buy_median: Option<f64>,
}

/// Fetch 48-hour median sell price for a single item from warframe.market.
/// Tries the slug as-is first, then retries with the Blueprint suffix added or
/// removed — WFM is inconsistent about whether component blueprints include it.
#[tauri::command]
fn fetch_wfm_price(url_name: String) -> Result<WfmPrice, String> {
    let sell_median = wfm_price_for_slug(&url_name).map_err(|e| e)?
        .or_else(|| {
            if url_name.ends_with("_blueprint") {
                let stripped = &url_name[..url_name.len() - "_blueprint".len()];
                wfm_price_for_slug(stripped).unwrap_or(None)
            } else {
                let with_bp = format!("{}_blueprint", url_name);
                wfm_price_for_slug(&with_bp).unwrap_or(None)
            }
        })
        .map(|p| p as f64);

    Ok(WfmPrice { url_name, sell_median, buy_median: None })
}

/// Convert a display name to a warframe.market URL slug.
/// E.g. "Ash Prime Neuroptics Blueprint" → "ash_prime_neuroptics_blueprint"
fn to_wfm_slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c == ' ' { '_' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

/// Fetch the 48-hour median sell price for an item by display name.
/// Results are cached in AppState so the overlay and main window share them.
/// Returns None when the item is not listed on warframe.market.
#[tauri::command]
fn get_item_price(item_name: String, state: State<AppState>) -> Result<Option<u32>, String> {
    let slug = to_wfm_slug(&item_name);

    {
        let cache = state.wfm_price_cache.lock().map_err(|e| e.to_string())?;
        if let Some(&cached) = cache.get(&slug) {
            return Ok(cached);
        }
    }

    let price = wfm_price_for_slug(&slug).map_err(|e| e)?
        .or_else(|| {
            // WFM lists prime component blueprints WITHOUT the "_blueprint" suffix.
            // e.g. "nautilus_prime_systems_blueprint" → "nautilus_prime_systems"
            if slug.ends_with("_blueprint") {
                let stripped = &slug[..slug.len() - "_blueprint".len()];
                wfm_price_for_slug(stripped).unwrap_or(None)
            } else {
                None
            }
        });

    {
        let mut cache = state.wfm_price_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(slug, price);
    }

    Ok(price)
}

fn wfm_price_for_slug(slug: &str) -> Result<Option<u32>, String> {
    wfm_wait();
    let url = format!("https://api.warframe.market/v1/items/{}/statistics", slug);
    match ureq::get(&url).call() {
        Ok(resp) => {
            let json: serde_json::Value = resp.into_json()
                .map_err(|e| format!("wfm price parse: {}", e))?;
            let closed = &json["payload"]["statistics_closed"]["48hours"];
            let p = closed.as_array()
                .and_then(|arr| arr.last())
                .and_then(|e| e["median"].as_f64())
                .map(|f| f.round() as u32);
            Ok(p.or_else(|| {
                json["payload"]["statistics_closed"]["90days"].as_array()
                    .and_then(|arr| arr.last())
                    .and_then(|e| e["median"].as_f64())
                    .map(|f| f.round() as u32)
            }))
        }
        Err(_) => Ok(None),
    }
}

// ─── Change log ───────────────────────────────────────────────────────────────

#[tauri::command]
fn get_change_log(state: State<AppState>, limit: i64) -> Result<Vec<QuantityChange>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_quantity_changes(&conn, limit).map_err(|e| e.to_string())
}

// ─── Trade log ────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_trades(state: State<AppState>) -> Result<Vec<Trade>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_trades(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_trade(
    state: State<AppState>,
    with_player: String,
    direction: String,
    item_name: String,
    item_url: String,
    quantity: i64,
    platinum: i64,
    source: String,
    notes: String,
) -> Result<i64, String> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let trade = Trade {
        id: 0,
        timestamp,
        with_player,
        direction,
        item_name,
        item_url,
        quantity,
        platinum,
        source,
        notes,
    };
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_trade(&conn, &trade).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_trade(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_trade(&conn, id).map_err(|e| e.to_string())
}

fn update_version_in_file(path: &std::path::Path, version: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    // Replace first occurrence of "version": "x.y.z"
    let marker = "\"version\": \"";
    if let Some(start) = content.find(marker) {
        let after = start + marker.len();
        if let Some(end) = content[after..].find('"') {
            let mut updated = content.clone();
            updated.replace_range(after..after + end, version);
            std::fs::write(path, updated).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err(format!("Version field not found in {}", path.display()))
}

#[tauri::command]
fn get_app_version() -> String {
    // In dev mode the source tauri.conf.json is in the current directory
    let config = std::path::Path::new("src-tauri/tauri.conf.json");
    if config.exists() {
        if let Ok(text) = std::fs::read_to_string(config) {
            let marker = "\"version\": \"";
            if let Some(start) = text.find(marker) {
                let after = start + marker.len();
                if let Some(end) = text[after..].find('"') {
                    return text[after..after + end].to_string();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn set_app_version(version: String) -> Result<(), String> {
    let tauri_conf = std::path::Path::new("src-tauri/tauri.conf.json");
    let package_json = std::path::Path::new("package.json");
    if tauri_conf.exists() { update_version_in_file(tauri_conf, &version)?; }
    if package_json.exists() { update_version_in_file(package_json, &version)?; }
    Ok(())
}

#[tauri::command]
fn load_settings(state: State<AppState>) -> String {
    std::fs::read_to_string(&state.settings_path).unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, state: State<AppState>, json: String) -> Result<(), String> {
    // Merge over existing file so geometry fields written by save_window_state are never erased
    let new_vals: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut existing: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&state.settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| if let serde_json::Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();
    if let serde_json::Value::Object(new_map) = new_vals {
        for (k, v) in new_map { existing.insert(k, v); }
    }
    std::fs::write(&state.settings_path, serde_json::Value::Object(existing).to_string())
        .map_err(|e| e.to_string())?;
    app.emit("settings-updated", ()).ok();
    Ok(())
}

#[tauri::command]
fn read_scan_log(state: State<AppState>) -> Result<String, String> {
    std::fs::read_to_string(&state.log_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_cache(state: State<AppState>) -> Result<(), String> {
    // Clear change log from DB
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM quantity_changes", []).map_err(|e| e.to_string())?;
    drop(conn);

    // Reset in-memory quantities
    let mut q = state.current_quantities.lock().map_err(|e| e.to_string())?;
    q.clear();
    drop(q);

    // Delete quantities cache file so it doesn't reload on next start
    let _ = std::fs::remove_file(&state.quantities_cache_path);

    Ok(())
}

// ─── Live monitor ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct CraftingJob {
    pub unique_name: String,
    pub item_name: String,
    pub completion_ms: i64,
}

#[derive(serde::Serialize, Clone)]
pub struct InventoryUpdate {
    pub quantities: HashMap<String, i64>,
    pub crafting: Vec<CraftingJob>,
    pub mastery_rank: Option<u32>,
    pub mastery_data: HashMap<String, u32>,
    pub changes: Vec<QuantityChange>,
    pub warframe_running: bool,
    pub scanned_at: i64,
}

#[tauri::command]
async fn start_monitor(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.monitor_active.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }
    // Capture the Tokio runtime handle while we're in the async context.
    // The monitoring thread (std::thread::spawn) has no COM/WinRT, so all OCR
    // calls are routed through spawn_blocking which runs on Tokio's thread pool
    // (which DOES have COM initialized, same as the Capture debug button).
    let _rt = tokio::runtime::Handle::current();

    let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let unique_names: Vec<String> = items.iter().map(|i| i.unique_name.clone()).collect();
    let display_names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
    let flag = state.monitor_active.clone();
    let db_path = state.db_path.clone();
    let log_path = state.log_path.clone();
    let quantities_cache_path = state.quantities_cache_path.clone();
    let shared_quantities = state.current_quantities.clone();
    let shared_crafting   = state.current_crafting.clone();
    let reward_app = app.clone();  // clone before app is moved into the inventory thread

    std::thread::spawn(move || {
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => { eprintln!("Monitor DB open failed: {}", e); return; }
        };
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");

        // Start from whatever quantities were last known (survives restarts).
        let mut known: HashMap<String, i64> =
            shared_quantities.lock().unwrap_or_else(|e| e.into_inner()).clone();

        // Stability buffer: (unique_name → (candidate_qty, consecutive_count))
        // A new quantity must appear in 2 consecutive scans before being committed.
        // This filters out transient reads: mission reward screens, clan showcases,
        // open-world drop popups — all appear for only 1 scan cycle.
        let mut pending: HashMap<String, (i64, u8)> = HashMap::new();

        while flag.load(Ordering::SeqCst) {
            let result = memory_scanner::scan_warframe_memory(&unique_names, &display_names);
            let now = chrono::Utc::now().timestamp();
            let now_str = chrono::DateTime::from_timestamp(now, 0)
                .map(|dt: chrono::DateTime<chrono::Utc>| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| now.to_string());

            let mut changes: Vec<QuantityChange> = Vec::new();

            // If Warframe is not running, skip all quantity updates.
            // Windows keeps recently-closed process memory accessible, which means
            // the scanner would find stale data and re-populate a cleared cache.
            if !result.warframe_running {
                pending.clear(); // also clear pending so stale candidates don't commit when game reopens
                let _ = app.emit("inventory-update", InventoryUpdate {
                    quantities: known.clone(),
                    crafting: vec![],
                    mastery_rank: None,
                    mastery_data: HashMap::new(),
                    changes: vec![],
                    warframe_running: false,
                    scanned_at: now,
                });
                std::thread::sleep(std::time::Duration::from_secs(10));
                continue;
            }

            // Build a set of unique_names seen this scan (to reset pending for missing items)
            let mut seen_this_scan: HashMap<String, i64> = HashMap::new();
            for item in &result.items_found {
                seen_this_scan.insert(item.unique_name.clone(), item.quantity);
            }

            for item in &result.items_found {
                let old_qty = *known.get(&item.unique_name).unwrap_or(&0);
                let new_qty = item.quantity;

                // Only track items where an actual count was read from memory.
                // Implicit count (no number found near path) = path appeared in
                // relic tables, codex, market data etc. — NOT real inventory.
                // Blueprints/warframes/weapons without explicit counts are
                // handled reliably by the Warframe companion API instead.
                if !item.explicit_count { continue; }
                if new_qty == old_qty {
                    pending.remove(&item.unique_name);
                    continue;
                }

                // Stability check: require the same new value for 2 consecutive scans
                let entry = pending.entry(item.unique_name.clone()).or_insert((new_qty, 0));
                if entry.0 != new_qty {
                    // Value changed mid-pending — reset the counter
                    *entry = (new_qty, 1);
                    continue;
                }
                entry.1 += 1;
                if entry.1 < 2 {
                    // Require 2 consecutive scans before committing explicit counts
                    continue;
                }
                // Confirmed — commit the change
                pending.remove(&item.unique_name);
                let change = QuantityChange {
                    id: 0,
                    unique_name: item.unique_name.clone(),
                    item_name: item.name.clone(),
                    old_qty,
                    new_qty,
                    delta: new_qty - old_qty,
                    timestamp: now,
                };
                let _ = db::add_quantity_change(
                    &conn, &item.unique_name, &item.name, old_qty, new_qty,
                );
                known.insert(item.unique_name.clone(), new_qty);
                changes.push(change);
            }

            // Clear pending entries for items no longer visible in memory
            pending.retain(|k, _| seen_this_scan.contains_key(k));


            // Persist running quantities so restarts pick up where we left off.
            if let Ok(mut q) = shared_quantities.lock() {
                *q = known.clone();
            }
            if let Ok(json) = serde_json::to_string(&known) {
                let _ = std::fs::write(&quantities_cache_path, json);
            }

            // Overwrite log AFTER scan completes so it's always readable between cycles
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true).write(true).truncate(true).open(&log_path)
            {
                let _ = writeln!(f, "=== Scan at {} ===", now_str);
                if let Some(ref err) = result.error {
                    let _ = writeln!(f, "  ERROR: {}", err);
                }
                let _ = writeln!(f,
                    "  warframe_running={} regions_scanned={} items_found={}",
                    result.warframe_running, result.regions_scanned, result.items_found.len()
                );
                for line in &result.log_lines {
                    let _ = writeln!(f, "{}", line);
                }
                if !result.items_found.is_empty() {
                    let _ = writeln!(f, "  --- Final inventory ---");
                    for item in &result.items_found {
                        let _ = writeln!(f,
                            "  {:>7} {}  {}  [{}]",
                            item.quantity,
                            if item.explicit_count { "E" } else { "I" },
                            item.name,
                            item.unique_name,
                        );
                    }
                }
                if !changes.is_empty() {
                    let _ = writeln!(f, "  --- Changes this scan ---");
                    for c in &changes {
                        let _ = writeln!(f, "  {} -> {}  ({:+})  {}",
                            c.old_qty, c.new_qty, c.delta, c.item_name);
                    }
                }
            }

            let crafting: Vec<CraftingJob> = result.pending_recipes.iter().map(|r| {
                let name = display_names.iter().zip(unique_names.iter())
                    .find(|(_, u)| *u == &r.unique_name)
                    .map(|(d, _)| d.clone())
                    .unwrap_or_else(|| r.unique_name.split('/').last().unwrap_or("?").to_string());
                CraftingJob { unique_name: r.unique_name.clone(), item_name: name, completion_ms: r.completion_ms }
            }).collect();

            *shared_crafting.lock().unwrap_or_else(|e| e.into_inner()) = crafting.clone();

            let _ = app.emit("inventory-update", InventoryUpdate {
                quantities: known.clone(),
                crafting,
                mastery_rank: result.mastery_rank,
                mastery_data: result.mastery_data,
                changes,
                warframe_running: result.warframe_running,
                scanned_at: now,
            });

            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    });

    // ── Dedicated relic reward thread — OCR poll every 500 ms ───────────────
    // Takes a screenshot of the Warframe window, runs Windows OCR on the
    // reward area, matches names against the catalog. Emits "relic-rewards"
    // only when the result changes (screen opens/closes or items change).
    let reward_flag   = state.monitor_active.clone();
    let reward_items  = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let bp_items      = state.blueprint_to_result.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let relic_rewards_map = state.relic_rewards.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let wiki_names    = state.wiki_reward_names.lock().unwrap_or_else(|e| e.into_inner()).clone();

    // ── Catalog: build by display-name match, not by path ────────────────────
    //
    // The root cause of path-based matching failures:
    //   WFCD relic drops store reward unique_names as /Lotus/StoreItems/Types/...
    //   WFCD items catalog stores items as /Lotus/Types/... (no StoreItems prefix)
    //   ExportRecipes also uses /Lotus/Types/... paths
    //   → filter(valid_relic_rewards.contains(&i.unique_name)) finds nothing,
    //     and the catalog ends up populated with relics instead of reward items.
    //
    // Name-based matching bypasses this entirely:
    //   1. Wiki reward names  — canonical, lowercase, from Warframe Wiki (most accurate)
    //   2. WFCD reward names  — display names from relic drops table (fallback)
    //   3. Content filter      — all "prime" / "forma" items (last resort)

    // Source 1: wiki canonical reward names (lowercase display names)
    let mut reward_display_names: std::collections::HashSet<String> = wiki_names;

    // Source 2: WFCD relic drop display names — always merged (not just fallback).
    // Wiki parsing may miss recently-added primes; WFCD covers them.
    for rewards in relic_rewards_map.values() {
        for r in rewards {
            reward_display_names.insert(r.name.to_lowercase());
        }
    }

    let have_reward_names = !reward_display_names.is_empty();

    // Filter reward_items by display name (case-insensitive).
    // Uses filter_map so we can return a corrected display name when WFCD's name
    // differs from the in-game reward text (e.g. "Lavos Prime Chassis" in WFCD
    // vs "Lavos Prime Chassis Blueprint" shown on the fissure reward screen).
    let mut catalog_pairs: Vec<(String, String)> = reward_items.iter()
        .filter_map(|i| {
            let lower = i.name.to_lowercase();
            // Skip assembled warframes/weapons and relics — only parts+blueprints
            let is_relic = lower.ends_with("intact") || lower.ends_with("exceptional")
                || lower.ends_with("flawless") || lower.ends_with("radiant");
            if is_relic { return None; }
            // Built warframes/weapons are never fissure rewards (you always get parts/blueprints).
            // Excluding them prevents "Oberon Prime" (Warframes) from beating "Oberon Prime
            // Blueprint" when OCR misses the word "Blueprint".
            let is_built_item = matches!(i.category.as_str(),
                "Warframes" | "Primary" | "Secondary" | "Melee" | "Companion" |
                "Sentinels" | "Archwing" | "Arch-Gun" | "Arch-Melee" | "Pets" | "Robotic");
            if is_built_item { return None; }
            // Warframe prime component blueprints (Chassis/Neuroptics/Systems Blueprint)
            // are exclusively relic rewards. Always include them even when missing from
            // the wiki/WFCD reward name list (newly-added primes lag behind the wiki).
            let is_prime_wf_component = lower.contains("prime") && (
                lower.ends_with("chassis blueprint")
                || lower.ends_with("neuroptics blueprint")
                || lower.ends_with("systems blueprint")
            );
            if is_prime_wf_component { return Some((i.unique_name.clone(), i.name.clone())); }
            if have_reward_names {
                if reward_display_names.contains(&lower) {
                    return Some((i.unique_name.clone(), i.name.clone()));
                }
                // WFCD omits "Blueprint" from some component names that the in-game reward
                // screen includes (e.g. WFCD "Lavos Prime Chassis" vs in-game
                // "Lavos Prime Chassis Blueprint").  If appending " blueprint" hits a
                // known relic reward, include the item with the corrected display name
                // so OCR scoring works against the actual card text.
                let lower_bp = format!("{} blueprint", lower);
                if reward_display_names.contains(&lower_bp) {
                    return Some((i.unique_name.clone(), format!("{} Blueprint", i.name)));
                }
                None
            } else {
                // Last resort: everything that looks like a relic reward
                if lower.contains("prime") || lower.starts_with("forma") {
                    Some((i.unique_name.clone(), i.name.clone()))
                } else {
                    None
                }
            }
        })
        .collect();

    // Also pull blueprints from ExportRecipes that match reward names
    for (bp_unique, (bp_name, _)) in bp_items.iter() {
        let lower = bp_name.to_lowercase();
        // Check for exact match OR for the case where the catalog already has this
        // item with a " Blueprint" suffix appended (from the WFCD name-correction above).
        let already = catalog_pairs.iter().any(|(_, n)| {
            let nl = n.to_lowercase();
            nl == lower || nl == format!("{} blueprint", lower) || format!("{} blueprint", nl) == lower
        });
        if already { continue; }
        let is_prime_wf_component = lower.contains("prime") && (
            lower.ends_with("chassis blueprint")
            || lower.ends_with("neuroptics blueprint")
            || lower.ends_with("systems blueprint")
        );
        let (include, display_name) = if is_prime_wf_component {
            (true, bp_name.clone())
        } else if have_reward_names {
            if reward_display_names.contains(&lower) {
                (true, bp_name.clone())
            } else {
                let lower_bp = format!("{} blueprint", lower);
                if reward_display_names.contains(&lower_bp) {
                    (true, format!("{} Blueprint", bp_name))
                } else {
                    (false, bp_name.clone())
                }
            }
        } else {
            (lower.contains("prime") || lower.starts_with("forma"), bp_name.clone())
        };
        if include {
            catalog_pairs.push((bp_unique.clone(), display_name));
        }
    }

    // Deduplicate by unique_name
    catalog_pairs.sort_by(|a, b| a.0.cmp(&b.0));
    catalog_pairs.dedup_by(|a, b| a.0 == b.0);

    // Wrap catalog in Arc so it can be cheaply shared with spawn_blocking closures
    let catalog_pairs = std::sync::Arc::new(catalog_pairs);

    // Build a name-lookup map from catalog_pairs for the debug file.
    let _catalog_name_map: std::collections::HashMap<String, String> = catalog_pairs
        .iter()
        .map(|(u, n)| (u.clone(), n.clone()))
        .collect();

    let debug_path      = std::env::temp_dir().join("frameforge_reward_debug.txt");
    let last_found_path = std::env::temp_dir().join("frameforge_last_reward.txt");

    // ── EE.log watcher ────────────────────────────────────────────────────────
    // Warframe writes "Script [Info]: Got rewards" to EE.log the moment the
    // Void Fissure reward selection screen becomes active.  All open-source
    // tools (WFInfo, warframeocr, Sentinel) use this string as their trigger.
    // We tail the log file instead of relying on fragile OCR gate heuristics.
    let ee_log_path = dirs::data_local_dir()
        .map(|d| d.join("Warframe").join("EE.log"))
        .filter(|p| p.exists());

    // Shared flag: true while the reward screen is active according to EE.log
    let reward_screen_active = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reward_screen_active2 = reward_screen_active.clone();

    // Shared squad size: updated by EE.log watcher when VoidProjections sequence
    // completes, read by OCR loop for each attempt. This lets late-arriving squad
    // data (VoidProjections often arrives 1-2 s after the screen opens) inform
    // subsequent OCR retries so the card count is always correct.
    let shared_squad_size: std::sync::Arc<std::sync::Mutex<Option<usize>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let shared_squad_size2 = std::sync::Arc::clone(&shared_squad_size);

    // ── EE.log watcher → AlecaFrame-style OCR trigger ────────────────────────
    //
    // When Warframe writes "Got rewards" to EE.log, the reward screen is active.
    // We immediately schedule an OCR capture (same path as the working Capture
    // button) and emit the result as a "relic-rewards" event.
    // No polling needed — this is exactly how AlecaFrame works.

    let ee_ocr_app   = reward_app.clone();
    let ee_catalog   = std::sync::Arc::clone(&catalog_pairs);
    let ee_last_path = last_found_path.clone();
    let session_log_path = std::env::temp_dir().join("frameforge_overlay_session.txt");

    if let Some(log_path) = ee_log_path {
        let flag = reward_flag.clone();
        std::thread::spawn(move || {
            let mut file_pos: u64 = std::fs::metadata(&log_path)
                .map(|m| m.len()).unwrap_or(0);
            let mut active_since: Option<std::time::Instant> = None;
            use std::io::{Read, Seek, SeekFrom};

            // ── VoidProjections reward sequence state ─────────────────────────
            // The game logs squad reward info BEFORE the screen trigger fires.
            // We accumulate it across poll iterations so it's ready when OCR starts.
            let mut vp_in_seq        = false;
            let mut vp_seq_completed = false; // set when sequence finishes; used as fallback trigger
            let mut pending_trade: Option<String> = None; // last seen trade confirmation dialog
            let mut vp_other_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut vp_own_item = String::new(); // local player's reward path from EE.log
            let mut ee_squad_size: Option<usize> = None; // committed when sequence completes
            // Cooldown: after any dismiss, block new triggers for 60 s.
            // Prevents the overlay from re-firing on the Last Mission Results screen,
            // which replays some EE.log events from the same mission.
            let mut last_dismiss_at: Option<std::time::Instant> = None;

            loop {
                if !flag.load(Ordering::SeqCst) { break; }
                std::thread::sleep(std::time::Duration::from_millis(200));
                let Ok(mut f) = std::fs::File::open(&log_path) else { continue };
                let len = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
                if len < file_pos { file_pos = 0; }
                if f.seek(SeekFrom::Start(file_pos)).is_err() { continue; }
                let mut buf = String::new();
                if f.read_to_string(&mut buf).is_err() { continue; }
                file_pos = len;
                if buf.is_empty() { continue; }

                let lower = buf.to_lowercase();

                // ── VoidProjections squad parsing ─────────────────────────────
                // Parse the reward-handshake sequence that fires before the screen opens:
                //   "VoidProjections: GetVoidProjectionRewards"   → sequence start
                //   "[id] gets reward /Lotus/..."                  → local player's item
                //   "Still waiting on response from [id]"          → one other player
                //   "Client has reward info for all players now"   → sequence complete
                //
                // squad_size = 1 (local) + count("Still waiting") lines.
                // Logging only for now; item path matching is a future improvement.
                for line in buf.lines() {
                    let ll = line.to_lowercase();
                    if ll.contains("voidprojections: getvoidprojectionrewards") {
                        vp_in_seq  = true;
                        vp_other_ids.clear();
                        vp_own_item.clear();
                        ee_squad_size = None;
                    }
                    if vp_in_seq {
                        if ll.contains("gets reward /lotus/") {
                            if let Some(i) = line.find("/Lotus/") {
                                vp_own_item = line[i..].trim().to_string();
                            }
                        } else if ll.contains("still waiting on response from") {
                            // Extract the player ID (last whitespace-separated token)
                            if let Some(id) = ll.split_whitespace().last() {
                                vp_other_ids.insert(id.to_string());
                            }
                        } else if ll.contains("has reward info for all players now") {
                            // squad = local player (1) + unique other IDs seen
                            let squad = (1 + vp_other_ids.len()).clamp(1, 4);
                            ee_squad_size = Some(squad);
                            // Share with OCR loop so any pending retry uses the correct count.
                            if let Ok(mut g) = shared_squad_size2.lock() { *g = Some(squad); }
                            vp_in_seq = false;
                            vp_seq_completed = true; // fallback trigger signal
                            let _ = append_to_file(&session_log_path, &format!(
                                "[EE.log] VoidProjections squad\n\
                                 ├─ Local item : {}\n\
                                 ├─ Other players (unique IDs) : {}\n\
                                 └─ Squad size : {} total\n\n",
                                if vp_own_item.is_empty() { "(not found)" } else { &vp_own_item },
                                vp_other_ids.len(),
                                squad,
                            ));
                        }
                    }
                }

                // ── WFM trade whisper detection ──────────────────────────────────
                if lower.contains("(warframe.market)") {
                    // EE.log whisper format: "@From Username : Hi! I want to buy Item for N platinum. (warframe.market)"
                    let raw = buf.as_str();
                    let from = raw.find("@From ")
                        .map(|i| &raw[i+6..])
                        .and_then(|s| s.split(" :").next())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_else(|| "Unknown".to_string());
                    let item = {
                        let prefix = "want to buy ";
                        let suffix = " for ";
                        raw.find(prefix).and_then(|i| {
                            let rest = &raw[i+prefix.len()..];
                            rest.find(suffix).map(|j| rest[..j].to_string())
                        })
                    };
                    let price: Option<u64> = raw.find(" for ").and_then(|i| {
                        let rest = &raw[i+5..];
                        rest.find(" platinum").and_then(|j| rest[..j].trim().parse().ok())
                    });
                    let _ = ee_ocr_app.emit("wfm-whisper", serde_json::json!({
                        "from": from,
                        "message": raw.trim(),
                        "item": item,
                        "price": price,
                        "timestamp": chrono::Local::now().format("%H:%M:%S").to_string(),
                    }));
                }

                // Riven trigger and close events are handled exclusively by start_log_watcher
                // (always-on) — do not duplicate them here.

                // Unveil: riven challenge completion
                if lower.contains("modreveal") || (lower.contains("riven") && lower.contains("unveiled")) {
                    let _ = ee_ocr_app.emit("riven-unveiled", ());
                }

                // ── In-game trade detection ──────────────────────────────────────
                // Warframe writes a confirmation dialog to EE.log when the trade
                // window is accepted, then a success dialog when it completes.
                //
                // Confirmation: Dialog::CreateOkCancel(description=Are you sure you
                //   want to accept this trade? You are offering:\nPlatinum x N\n
                //   and will receive from PLAYER the following:\nITEM, title=...)
                //
                // Success: Dialog::CreateOk(description=The trade was successful!...)
                if lower.contains("dialog::createokcancel") && lower.contains("you are offering") {
                    pending_trade = Some(buf.clone());
                }

                if lower.contains("the trade was successful") {
                    if let Some(ref trade_raw) = pending_trade.clone() {
                        let r = trade_raw.as_str();

                        // Extract trading partner
                        let with_player = r.find("will receive from ")
                            .and_then(|i| {
                                let after = &r[i + 18..];
                                after.find(" the following").map(|j| after[..j].trim().to_string())
                            })
                            .unwrap_or_default();

                        // Extract what YOU offered (between "You are offering:" and "and will receive from")
                        let offered = r.find("You are offering:")
                            .and_then(|i| {
                                let after = &r[i + 17..];
                                after.find("and will receive from").map(|j| after[..j].trim().to_string())
                            })
                            .unwrap_or_default();

                        // Extract what you RECEIVED (between "the following:" and ", title=")
                        let received = r.find("the following:")
                            .and_then(|i| {
                                let after = &r[i + 14..];
                                after.find(", title=").map(|j| after[..j].trim().to_string())
                            })
                            .unwrap_or_default();

                        // Parse platinum amounts
                        let parse_plat = |s: &str| -> i64 {
                            s.find("Platinum x ")
                                .and_then(|i| s[i + 11..].split(|c: char| !c.is_ascii_digit()).next())
                                .and_then(|n| n.parse().ok())
                                .unwrap_or(0)
                        };
                        let plat_offered  = parse_plat(&offered);
                        let plat_received = parse_plat(&received);

                        // Warframe encodes item ranks as Unicode Private Use Area dots:
                        //   U+E114 (bytes EE 84 94) = filled dot = one acquired rank level
                        //   U+E112 (bytes EE 84 92) = empty dot  = unacquired rank level
                        // Count filled dots to get actual rank.
                        // Mods use text suffix " (COMMON RANK N)" instead.
                        let clean_item_line = |l: &str| -> String {
                            let l = l.trim();
                            // Check for Warframe PUA rank dots (arcanes, some items)
                            let filled = l.chars().filter(|&c| c == '\u{E114}').count();
                            let total  = l.chars().filter(|&c| c == '\u{E114}' || c == '\u{E112}').count();
                            if total > 0 {
                                // Strip the PUA characters to get the base name
                                let base: String = l.chars()
                                    .take_while(|&c| c != '\u{E114}' && c != '\u{E112}')
                                    .collect::<String>();
                                let base = base.trim();
                                return if filled == 0 && total > 0 {
                                    // All empty dots = rank 0 — omit rank suffix for cleanliness
                                    // OR include it for completeness. We include it so R0 is explicit.
                                    format!("{} (R0)", base)
                                } else {
                                    format!("{} (R{})", base, filled)
                                };
                            }
                            // Check for mod text rank suffix " (RARITY RANK N)"
                            if let Some(p) = l.find(" (") {
                                let inside = &l[p+2..];
                                if let Some(r) = inside.to_lowercase().find("rank ") {
                                    let rank_n = inside[r+5..].trim_end_matches(')').trim();
                                    return format!("{} (R{})", &l[..p], rank_n);
                                }
                                return l[..p].trim().to_string();
                            }
                            l.to_string()
                        };

                        let extract_item_and_qty = |section: &str| -> (String, i64) {
                            let items: Vec<String> = section.lines()
                                .filter(|l| {
                                    let t = l.trim();
                                    !t.is_empty() && !t.to_lowercase().contains("platinum")
                                })
                                .map(|l| clean_item_line(l))
                                .filter(|s| !s.is_empty())
                                .collect();

                            if items.is_empty() { return (String::new(), 1); }

                            let qty = items.len() as i64;
                            let first = &items[0];
                            let all_same = items.iter().all(|i| i == first);

                            if all_same {
                                // 6× same item → "Neo R1 Relic", qty 6
                                (first.clone(), qty)
                            } else {
                                // Mixed items → join them, qty = total count
                                (items.join(", "), qty)
                            }
                        };

                        // Determine direction, item, quantity, platinum
                        let (direction, item_name, quantity, platinum) = if plat_offered > 0 {
                            // Paid platinum → bought something
                            let (item, qty) = extract_item_and_qty(&received);
                            ("bought", item, qty, plat_offered)
                        } else {
                            // Received platinum → sold something
                            let (item, qty) = extract_item_and_qty(&offered);
                            ("sold", item, qty, plat_received)
                        };

                        let _ = ee_ocr_app.emit("trade-completed", serde_json::json!({
                            "withPlayer": with_player,
                            "direction":  direction,
                            "itemName":   item_name,
                            "quantity":   quantity,
                            "platinum":   platinum,
                            "timestamp":  chrono::Local::now().to_rfc3339(),
                        }));
                    }
                    pending_trade = None;
                }

                // Trigger: "ProjectionRewardChoice.lua: Relic rewards initialized" fires
                // when the selection screen first becomes visible — specific to this Lua
                // script so it won't fire for login/mission rewards.
                // "openvoidprojectionrewardscreen" and vp_seq_completed kept as fallbacks
                // since they appear in some configurations.
                let has_trigger = lower.contains("projectionrewardchoice.lua: relic rewards initialized")
                    || lower.contains("openvoidprojectionrewardscreen")
                    || vp_seq_completed;
                vp_seq_completed = false; // consume the flag

                // Dismiss: "Relic reward screen shut down" fires when the player selects
                // a reward (or the countdown expires). DO NOT use "relic timer closed" —
                // that fires at 874.265 when the screen OPENS, not when it closes, causing
                // triggers and dismisses to appear in the same 200ms EE.log flush.
                // "CloseVoidProjectionRewardScreen" fires at the same moment as shut down.
                // "EndSession" is the final fallback for abrupt disconnects/exits.
                // Host migration is NOT a dismiss — the mission continues with a new host.
                let has_dismiss = lower.contains("relic reward screen shut down")
                    || lower.contains("closevoidprojectionrewardscreen")
                    || lower.contains("matchingservice::endsession");

                // ── Dismiss — always processed first (even if same batch as trigger) ──
                if has_dismiss {
                    let dismiss_line = buf.lines()
                        .find(|l| {
                            let ll = l.to_lowercase();
                            ll.contains("relic reward screen shut down")
                                || ll.contains("closevoidprojectionrewardscreen")
                                || ll.contains("matchingservice::endsession")
                        })
                        .unwrap_or("<unknown dismiss line>")
                        .trim()
                        .to_string();
                    let ts_d = chrono::Local::now().format("%H:%M:%S%.3f");
                    let _ = append_to_file(&session_log_path, &format!(
                        "[STEP 4] DISMISS\n\
                         ├─ Time     : {}\n\
                         └─ Line     : \"{}\"\n\n",
                        ts_d, dismiss_line
                    ));
                    reward_screen_active2.store(false, Ordering::SeqCst);
                    active_since = None;
                    last_dismiss_at = Some(std::time::Instant::now());
                    if let Some(win) = ee_ocr_app.get_webview_window("relic-overlay") {
                        let _ = win.close();
                    }
                    let _ = ee_ocr_app.emit("relic-rewards", serde_json::Value::Null);
                }

                // ── Trigger: skip if dismiss in same batch, screen already active, or
                //    within 60 s of last dismiss ───────────────────────────────────────
                // active_since.is_some() guards against duplicate triggers: EE.log is
                // polled every 200 ms, and multiple matching lines (e.g. "Client has
                // reward info" + "relic rewards initialized" 250 ms later) can fire in
                // consecutive polls while the same reward screen is still open.  Without
                // this guard, a second OCR task would spawn, emit different card
                // positions, and make the overlay stutter.
                let trigger_allowed = !has_dismiss
                    && active_since.is_none()
                    && last_dismiss_at.map_or(true, |t| t.elapsed().as_secs() >= 60);
                if has_trigger && trigger_allowed {
                    reward_screen_active2.store(true, Ordering::SeqCst);
                    active_since = Some(std::time::Instant::now());

                    // Find the exact EE.log line that matched so we can log it
                    let trigger_line = buf.lines()
                        .find(|l| {
                            let ll = l.to_lowercase();
                            ll.contains("relic rewards initialized")
                                || ll.contains("openvoidprojectionrewardscreen")
                                || ll.contains("has reward info for all players now")
                        })
                        .unwrap_or("<unknown trigger line>")
                        .trim()
                        .to_string();

                    let ts0 = chrono::Local::now().format("%H:%M:%S%.3f");

                    // Start a fresh session log for this reward screen
                    let write_err = std::fs::write(&session_log_path, format!(
                        "══════════════════════════════════════════════\n\
                         RELIC OVERLAY SESSION — {}\n\
                         ══════════════════════════════════════════════\n\
                         Log path  : {}\n\n\
                         [STEP 1] EE.log TRIGGER\n\
                         ├─ Time     : {}\n\
                         ├─ Line     : \"{}\"\n\
                         └─ Catalog  : {} items\n\n",
                        ts0, session_log_path.display(), ts0, trigger_line, ee_catalog.len()
                    ));
                    if let Err(e) = write_err {
                        eprintln!("[FrameForge] session log write failed: {e}");
                    }
                    let _ = std::fs::write(&ee_last_path, format!(
                        "=== {} ===\nEE.log trigger fired\n{}\n", ts0, trigger_line
                    ));

                    let _ = ee_ocr_app.emit("ff-status", "🔍 Relic reward screen detected");
                    // Tell App.tsx to pre-create the overlay window NOW, before OCR finishes.
                    // Window creation takes 1-2 s; pre-creating shaves that off the visible delay.
                    let _ = ee_ocr_app.emit("relic-trigger", ());

                    let app        = ee_ocr_app.clone();
                    let cat        = std::sync::Arc::clone(&ee_catalog);
                    let cat_len    = cat.len();
                    let lpath      = ee_last_path.clone();
                    let slog       = session_log_path.clone();
                    let active     = reward_screen_active2.clone();
                    let squad_arc  = std::sync::Arc::clone(&shared_squad_size);
                    // Also reset the shared squad size so stale data from a previous
                    // fissure doesn't bleed into this new screen's OCR loop.
                    if let Ok(mut g) = squad_arc.lock() { *g = ee_squad_size; }

                    tauri::async_runtime::spawn(async move {
                        let deadline = std::time::Instant::now()
                            + std::time::Duration::from_secs(45);
                        // 500ms initial delay — gives cards time to finish fading in and
                        // allows the VoidProjections EE.log sequence to arrive before the
                        // first OCR attempt reads hint_squad (race-condition fix).
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                        // Allow the catalog to be rebuilt inside the loop — it may be empty
                        // when start_monitor fired before WFCD data finished loading.
                        let mut cat = cat;
                        let mut attempt = 0u32;
                        let mut best_item_count = 0usize;
                        let mut best_payload: Option<serde_json::Value> = None; // locked when complete
                        // When no EE squad hint is available, the first "complete" result may
                        // undercount cards (e.g. dark text hides a 2-line item name).
                        // soft_complete_at tracks the first attempt that returned complete-without-hint
                        // so we do one extra retry before locking.
                        let mut soft_complete_at: Option<usize> = None;
                        // Item count at the time soft_complete_at was set.
                        // If the follow-up attempt finds no more items, emit best_payload even if
                        // a newly-arrived EE hint raised estimated_cards above the count we saw.
                        // (Warframe can show fewer unique cards than squad size when players share
                        // the same relic reward — one player lacking reactant is another example.)
                        let mut soft_complete_count: usize = 0;
                        loop {
                            attempt += 1;
                            // Rebuild catalog if WFCD hadn't loaded when this OCR session started.
                            // Runs only while cat is empty — once populated it stays populated.
                            if cat.is_empty() {
                                let s = app.state::<AppState>();
                                let items_lock = s.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
                                if !items_lock.is_empty() {
                                    let bp_lock = s.blueprint_to_result.lock().unwrap_or_else(|e| e.into_inner());
                                    let bad = ["Warframes","Primary","Secondary","Melee","Companion",
                                               "Sentinels","Archwing","Arch-Gun","Arch-Melee","Pets","Robotic"];
                                    let mut fresh: Vec<(String,String)> = items_lock.iter()
                                        .filter(|i| {
                                            let lo = i.name.to_lowercase();
                                            !bad.contains(&i.category.as_str())
                                            && !lo.ends_with("intact") && !lo.ends_with("exceptional")
                                            && !lo.ends_with("flawless") && !lo.ends_with("radiant")
                                            && (lo.contains("prime") || lo.starts_with("forma"))
                                        })
                                        .map(|i| (i.unique_name.clone(), i.name.clone()))
                                        .collect();
                                    for (u, (n, _)) in bp_lock.iter() {
                                        let lo = n.to_lowercase();
                                        if lo.contains("prime") || lo.starts_with("forma") {
                                            fresh.push((u.clone(), n.clone()));
                                        }
                                    }
                                    fresh.sort_by(|a, b| a.0.cmp(&b.0));
                                    fresh.dedup_by(|a, b| a.0 == b.0);
                                    if !fresh.is_empty() {
                                        cat = std::sync::Arc::new(fresh);
                                    }
                                }
                            }
                            let _ = app.emit("ff-status", "📷 OCR scanning...");
                            let cat2 = std::sync::Arc::clone(&cat);
                            // Read squad size fresh for each attempt — it may arrive after
                            // the first attempt if VoidProjections sequence completes late.
                            let hint_squad = squad_arc.lock().ok().and_then(|g| *g);
                            let result = tauri::async_runtime::spawn_blocking(move || {
                                let (pixels, w, cap_h, full_h, cap_info) =
                                    ocr::capture_warframe_reward_area()?;
                                Some(ocr::extract_reward_items_twophase(
                                    &pixels, w, cap_h, full_h, &cat2, &cap_info, hint_squad,
                                ))
                            }).await.ok().flatten();

                            let ts = chrono::Local::now().format("%H:%M:%S%.3f");
                            let sleep_ms = match &result {
                                // ✅ 1+ items found (solo=1, duo=2, trio=3, full squad=4)
                                Some((complete, _, ref items, ref positions, ref dbg)) if !items.is_empty() => {
                                    let payload = Some(serde_json::json!({
                                        "items": items, "positions": positions
                                    }));

                                    // Determine whether this complete result should be locked now.
                                    // If we have an EE squad hint the count is authoritative.
                                    // If we don't (hint arrived late or solo/friend group),
                                    // do one extra retry first — a dark/fading card may have been
                                    // missed and the prime/forma word count underestimates 2-line names.
                                    let confirm_ready = hint_squad.is_some() || soft_complete_at.is_some();

                                    // Save best result; only emit to overlay when confirmed (LOCK).
                                    // Partial updates are intentionally suppressed — emitting
                                    // partial data while the user is still hovering cards causes
                                    // the overlay to flicker with wrong items between attempts.
                                    if items.len() > best_item_count {
                                        best_item_count = items.len();
                                        best_payload = payload.clone();
                                        let label = if *complete && confirm_ready { "✅" } else { "⚡" };
                                        let status_label = if *complete && confirm_ready { "locked" }
                                            else if *complete { "soft-complete, confirming" }
                                            else { "waiting" };
                                        let _ = app.emit("ff-status",
                                            format!("{} {} items ({})", label, items.len(), status_label));
                                        let result_label = if *complete && confirm_ready { "LOCKED & emitting" }
                                            else if *complete { "soft-complete, retrying once" }
                                            else { "saved, retrying" };
                                        let session_entry = format!(
                                            "[STEP 2] OCR ATTEMPT #{}\n\
                                             ├─ Time     : {}\n\
                                             {}\n\
                                             └─ RESULT   : {} items found → {}\n\
                                             └─ Items    : {:?}\n\n{}",
                                            attempt, ts, dbg, items.len(),
                                            result_label,
                                            items,
                                            if *complete && confirm_ready { "[STEP 3] OVERLAY OPENED\n\n" } else { "" }
                                        );
                                        let _ = append_to_file(&slog, &session_entry);
                                        let _ = std::fs::write(&lpath, format!(
                                            "=== {} ===\nItems: {:?}\n{}\n", ts, items, dbg));
                                    }

                                    // Stop retrying and emit ONLY when all expected cards found AND confirmed.
                                    if *complete {
                                        if confirm_ready {
                                            // Hard cutoff: if dismiss arrived while OCR was running, drop the result.
                                            if !active.load(Ordering::SeqCst) { break; }
                                            // Log the confirming attempt when item count didn't improve
                                            // (the logging block above only fires when items.len() > best_item_count).
                                            if items.len() <= best_item_count {
                                                let _ = append_to_file(&slog, &format!(
                                                    "[STEP 2] OCR ATTEMPT #{} (confirm)\n\
                                                     ├─ Time     : {}\n\
                                                     └─ {} items — same as before, confirmed\n\n\
                                                     [STEP 3] OVERLAY OPENED\n\n",
                                                    attempt, ts, items.len()
                                                ));
                                            }
                                            let _ = app.emit("relic-rewards", &payload);
                                            let app2 = app.clone();
                                            let slog2 = slog.clone();
                                            tauri::async_runtime::spawn(async move {
                                                // 20s safety fallback — normally the overlay closes
                                                // when EE.log fires "relic timer closed" (player picks).
                                                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                                                let _ = app2.emit("relic-rewards", serde_json::Value::Null);
                                                if let Some(w) = app2.get_webview_window("relic-overlay") {
                                                    let _ = w.close();
                                                }
                                                let _ = append_to_file(&slog2,
                                                    "[STEP 4] AUTO-DISMISS (20s safety fallback)\n\n");
                                            });
                                            break;
                                        } else {
                                            // First complete without an EE hint — mark and retry once.
                                            soft_complete_at = Some(attempt as usize);
                                            soft_complete_count = best_item_count;
                                        }
                                    } else if soft_complete_at.is_some() && items.len() <= soft_complete_count {
                                        // Soft-complete confirmation retry found no more items.
                                        // A late EE hint may have raised estimated_cards above what
                                        // the screen actually shows (e.g. squad=4 but only 3 unique
                                        // cards because one player lacked reactant or shared a reward).
                                        // Emit best_payload now rather than retrying until timeout.
                                        if !active.load(Ordering::SeqCst) { break; }
                                        let emit_val = best_payload.clone().unwrap_or(serde_json::Value::Null);
                                        let _ = app.emit("relic-rewards", &emit_val);
                                        let _ = append_to_file(&slog,
                                            "[STEP 3] OVERLAY OPENED (soft-complete confirmed — no improvement)\n\n");
                                        let app2 = app.clone();
                                        let slog2 = slog.clone();
                                        tauri::async_runtime::spawn(async move {
                                            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                                            let _ = app2.emit("relic-rewards", serde_json::Value::Null);
                                            if let Some(w) = app2.get_webview_window("relic-overlay") {
                                                let _ = w.close();
                                            }
                                            let _ = append_to_file(&slog2,
                                                "[STEP 4] AUTO-DISMISS (20s safety fallback)\n\n");
                                        });
                                        break;
                                    }
                                    // Partial result (or soft-complete pending confirmation) — retry
                                    400u64
                                }
                                // ⬛ Dark/blank frame — PrintWindow returned nearly-black
                                Some((_, _, _, _, ref dbg)) if dbg.starts_with("dark-frame") => {
                                    let entry = format!(
                                        "[STEP 2] OCR ATTEMPT #{}\n\
                                         ├─ Time     : {}\n\
                                         └─ RESULT   : {} → PrintWindow returned dark image\n\
                                            Check %TEMP%\\frameforge_capture_debug.bmp\n\
                                            Fix: switch Warframe to Borderless Windowed mode\n\
                                            Retrying in 100ms…\n\n",
                                        attempt, ts, dbg);
                                    let _ = append_to_file(&slog, &entry);
                                    let _ = std::fs::write(&lpath,
                                        format!("=== {} ===\n{} — retrying\n", ts, dbg));
                                    let _ = app.emit("ff-status", format!("⬛ {}", dbg));
                                    100u64
                                }
                                // ⬜ OCR ran but returned no text
                                Some((_, _, _, _, ref dbg)) if dbg.starts_with("ocr-empty") => {
                                    let entry = format!(
                                        "[STEP 2] OCR ATTEMPT #{}\n\
                                         ├─ Time     : {}\n\
                                         └─ RESULT   : {} → image has content but OCR found no text\n\
                                            Check %TEMP%\\frameforge_capture_debug.bmp\n\
                                            Retrying in 300ms…\n\n",
                                        attempt, ts, dbg);
                                    let _ = append_to_file(&slog, &entry);
                                    let _ = std::fs::write(&lpath,
                                        format!("=== {} ===\n{} — retrying\n", ts, dbg));
                                    let _ = app.emit("ff-status", format!("⬜ {}", dbg));
                                    300u64
                                }
                                // ❌ Text found but no catalog match
                                Some((_, _, ref items, _, ref dbg)) => {
                                    let entry = format!(
                                        "[STEP 2] OCR ATTEMPT #{}\n\
                                         ├─ Time     : {}\n\
                                         {}\n\
                                         └─ RESULT   : no catalog match (catalog={}) → retrying in 700ms\n\n",
                                        attempt, ts, dbg, cat_len);
                                    let _ = append_to_file(&slog, &entry);
                                    let _ = std::fs::write(&lpath, format!(
                                        "=== {} ===\nno match (catalog={}): {:?}\n{}\n",
                                        ts, cat_len, items, dbg));
                                    let _ = app.emit("ff-status", "❌ No catalog match, retrying...");
                                    700u64
                                }
                                // ⚠️ Warframe window not found
                                None => {
                                    let entry = format!(
                                        "[STEP 2] OCR ATTEMPT #{}\n\
                                         ├─ Time     : {}\n\
                                         └─ RESULT   : capture failed — Warframe window not found\n\
                                            Retrying in 500ms…\n\n",
                                        attempt, ts);
                                    let _ = append_to_file(&slog, &entry);
                                    let _ = std::fs::write(&lpath,
                                        format!("=== {} ===\nCapture failed (window not found?)\n", ts));
                                    let _ = app.emit("ff-status", "⚠️ Capture failed");
                                    500u64
                                }
                            };

                            if std::time::Instant::now() >= deadline {
                                // Emit best partial result if we found anything, otherwise null.
                                // This means even a timeout shows something rather than nothing
                                // when OCR found cards but couldn't reach the expected count.
                                let emit_val = if active.load(Ordering::SeqCst) {
                                    best_payload.unwrap_or(serde_json::Value::Null)
                                } else {
                                    serde_json::Value::Null
                                };
                                let _ = app.emit("relic-rewards", &emit_val);
                                let _ = append_to_file(&slog,
                                    "[STEP 2] OCR TIMEOUT — 45 seconds elapsed, emitting best result\n\n");
                                if let Some(win) = app.get_webview_window("relic-overlay") {
                                    let _ = win.close();
                                }
                                active.store(false, Ordering::SeqCst);
                                break;
                            }
                            if !active.load(Ordering::SeqCst) {
                                let _ = append_to_file(&slog,
                                    "[STEP 2] OCR STOPPED — dismiss signal received\n\n");
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                        }
                    });

                } // end trigger block

                // Auto-dismiss after 20 s — safety net only.
                // Normal close path is EE.log "relic timer closed" above.
                if let Some(since) = active_since {
                    if since.elapsed().as_secs() >= 20 {
                        let ts_a = chrono::Local::now().format("%H:%M:%S%.3f");
                        let _ = append_to_file(&session_log_path, &format!(
                            "[STEP 4] AUTO-DISMISS (20s timeout)\n\
                             └─ Time : {}\n\n",
                            ts_a
                        ));
                        reward_screen_active2.store(false, Ordering::SeqCst);
                        active_since = None;
                        last_dismiss_at = Some(std::time::Instant::now());
                        if let Some(win) = ee_ocr_app.get_webview_window("relic-overlay") {
                            let _ = win.close();
                        }
                        let _ = ee_ocr_app.emit("relic-rewards", serde_json::Value::Null);
                    }
                }
            }
        });
    }

    // OCR polling fallback removed — it ran every second with no EE.log context
    // guard, causing false overlays on Mission Complete, orbiter, Last Mission
    // Results, and any screen with Prime item names visible.
    // The EE.log watcher already retries OCR for 45 seconds after the trigger,
    // so the fallback is both redundant and harmful.

    std::thread::spawn(move || {
        // Initialize COM (required for Windows OCR / WinRT APIs).
        // std::thread::spawn creates a raw OS thread with no COM apartment;
        // WinRT calls silently fail without this, returning empty strings.
        #[cfg(target_os = "windows")]
        unsafe {
            windows_sys::Win32::System::Com::CoInitializeEx(
                std::ptr::null(),
                windows_sys::Win32::System::Com::COINIT_MULTITHREADED.try_into().unwrap(),
            );
        }

        while reward_flag.load(Ordering::SeqCst) {
            let _relic_screen = false;
            let mut debug = String::new();
            let ts = chrono::Local::now().format("%H:%M:%S%.3f");
            debug.push_str(&format!("=== {} ===\n", ts));

            // OCR is now triggered by the EE.log watcher (AlecaFrame-style),
            // not by this polling loop. This loop only handles inventory scanning.
            let rewards: Option<serde_json::Value> = None;

            let _ = std::fs::write(&debug_path, &debug);
            if rewards.is_some() {
                let _ = std::fs::write(&last_found_path, &debug);
            }

            // Overlay is controlled entirely by the EE.log watcher — do NOT emit here.
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });

    Ok(())
}

/// Append a string to a file, creating the file if it doesn't exist.
fn append_to_file(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(text.as_bytes())
}

// ─── Localisation lookup ──────────────────────────────────────────────────────

static LANG: std::sync::OnceLock<std::collections::HashMap<String, String>> = std::sync::OnceLock::new();

fn get_lang() -> &'static std::collections::HashMap<String, String> {
    LANG.get_or_init(|| {
        ureq::get("https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data/languages.json")
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .and_then(|v| v.as_object().map(|obj| {
                obj.iter().filter_map(|(k, val)| {
                    let text = val.get("value")?.as_str()?;
                    Some((k.clone(), text.to_string()))
                }).collect()
            }))
            .unwrap_or_default()
    })
}

/// Resolve a /Lotus/Language/... path to its English display name.
fn loc(path: &str) -> String {
    if let Some(name) = get_lang().get(path) {
        return name.clone();
    }
    // Fallback: strip the path prefix and convert the last component from PascalCase
    path_display_name(path)
}

// ─── Node name lookup ─────────────────────────────────────────────────────────

#[derive(Clone)]
struct SolNode {
    display: String,
    enemy: String,
    mission_type: String,
}

static SOL_NODES: std::sync::OnceLock<std::collections::HashMap<String, SolNode>> = std::sync::OnceLock::new();

fn get_sol_nodes() -> &'static std::collections::HashMap<String, SolNode> {
    SOL_NODES.get_or_init(|| {
        ureq::get("https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data/solNodes.json")
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .and_then(|v| v.as_object().map(|obj| {
                obj.iter().filter_map(|(k, val)| {
                    let display = val.get("value")?.as_str()?.to_string();
                    let enemy = val.get("enemy").and_then(|e| e.as_str()).unwrap_or("").to_string();
                    let mission_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    Some((k.clone(), SolNode { display, enemy, mission_type }))
                }).collect()
            }))
            .unwrap_or_default()
    })
}

fn resolve_node(id: &str) -> String {
    if let Some(n) = get_sol_nodes().get(id) { return n.display.clone(); }
    if id.ends_with("HUB") { return format!("{} Relay", &id[..id.len()-3]); }
    if id.starts_with("CrewBattleNode") { return format!("Railjack {}", &id[14..]); }
    id.to_string()
}

fn node_enemy(id: &str) -> String {
    get_sol_nodes().get(id).map(|n| n.enemy.clone()).unwrap_or_default()
}

fn node_mission_type(id: &str) -> String {
    get_sol_nodes().get(id).map(|n| n.mission_type.clone()).unwrap_or_default()
}

/// Convert a Unix millisecond timestamp to an ISO-8601 string without external crates.
fn ms_to_iso(ms: i64) -> String {
    let millis = ms.rem_euclid(1000);
    let total_secs = ms / 1000;
    let s_in_day = total_secs.rem_euclid(86400) as u32;
    let days = total_secs.div_euclid(86400);
    let hour = s_in_day / 3600;
    let min = (s_in_day % 3600) / 60;
    let sec = s_in_day % 60;
    // Howard Hinnant civil_from_days
    let z = days + 719468_i64;
    let era = z.div_euclid(146097_i64);
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2) / 153;
    let d = doy - (153*mp + 2)/5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, m, d, hour, min, sec, millis)
}

/// Extract milliseconds from a MongoDB Extended JSON date: {"$date":{"$numberLong":"..."}}
fn ws_ms(v: &serde_json::Value) -> i64 {
    v.get("$date")
        .and_then(|d| d.get("$numberLong"))
        .and_then(|n| n.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
}

fn ws_mission_type(mt: &str) -> String {
    let known = match mt {
        "MT_ASSASSINATION"    => "Assassination",
        "MT_CAPTURE"          => "Capture",
        "MT_DEFENSE"          => "Defense",
        "MT_EVACUATION"       => "Defection",
        "MT_EXCAVATE"         => "Excavation",
        "MT_EXTERMINATION"    => "Extermination",
        "MT_HIVE"             => "Hive",
        "MT_HIVE_SABOTAGE"    => "Hive Sabotage",
        "MT_INFECTION"        => "Infested Salvage",
        "MT_INTEL"            => "Spy",
        "MT_MOBILE_DEFENSE"   => "Mobile Defense",
        "MT_RESCUE"           => "Rescue",
        "MT_RETRIEVAL"        => "Retrieval",
        "MT_SABOTAGE"         => "Sabotage",
        "MT_SPY"              => "Spy",
        "MT_SURVIVAL"         => "Survival",
        "MT_TERRITORY"        => "Interception",
        "MT_PURIFY"           => "Onslaught",
        "MT_ARTIFACT"         => "Disruption",
        "MT_RAILJACK"         => "Railjack",
        "MT_SKIRMISH"         => "Skirmish",
        "MT_JUNCTION"         => "Junction",
        "MT_LANDSCAPE"        => "Open World",
        "MT_FREE_ROAM"        => "Free Roam",
        "MT_ARENA"            => "Arena",
        "MT_ASSAULT"          => "Assault",
        "MT_ORPHIX"           => "Orphix",
        "MT_VOID_CASCADE"     => "Void Cascade",
        "MT_VOID_FLOOD"       => "Void Flood",
        "MT_VOID_ARMAGEDDON"  => "Void Armageddon",
        "MT_MIRROR_DEFENSE"   => "Mirror Defense",
        "MT_CAMP"             => "Volatile",
        "MT_BOUNTY"           => "Bounty",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    // Strip MT_ prefix and convert SCREAMING_SNAKE_CASE to Title Case
    let stripped = mt.strip_prefix("MT_").unwrap_or(mt);
    stripped.split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().to_string() + &c.as_str().to_lowercase(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn ws_sortie_boss(boss: &str) -> (&'static str, &'static str) {
    // Returns (display_name, faction)
    match boss {
        "SORTIE_BOSS_RAPTOR"       => ("Raptor",              "Corpus"),
        "SORTIE_BOSS_ALAD_V"       => ("Alad V",              "Corpus"),
        "SORTIE_BOSS_HYENA"        => ("Hyena Pack",          "Corpus"),
        "SORTIE_BOSS_AMBULAS"      => ("Ambulas",             "Corpus"),
        "SORTIE_BOSS_SERGEANT"     => ("The Sergeant",        "Corpus"),
        "SORTIE_BOSS_JACKAL"       => ("Jackal",              "Corpus"),
        "SORTIE_BOSS_ROPALOLYST"   => ("Ropalolyst",          "Corpus"),
        "SORTIE_BOSS_KELA"         => ("Kela De Thaym",       "Grineer"),
        "SORTIE_BOSS_VOR"          => ("Captain Vor",         "Grineer"),
        "SORTIE_BOSS_RUK"          => ("General Sargas Ruk",  "Grineer"),
        "SORTIE_BOSS_THW"          => ("Tyl Regor",           "Grineer"),
        "SORTIE_BOSS_LECH_KRIL"    => ("Lt. Lech Kril",       "Grineer"),
        "SORTIE_BOSS_KRIL_AND_VOR" => ("Vor & Kril",          "Grineer"),
        "SORTIE_BOSS_CORRUPTED_VOR"=> ("Corrupted Vor",       "Orokin"),
        _                          => ("Unknown Boss",        "Unknown"),
    }
}

fn ws_sortie_modifier(m: &str) -> &'static str {
    match m {
        "SORTIE_MODIFIER_RADIATION"          => "Radiation Hazard",
        "SORTIE_MODIFIER_MAGNETIC"           => "Magnetic Anomaly",
        "SORTIE_MODIFIER_BOW_ONLY"           => "Bow Only",
        "SORTIE_MODIFIER_SHOTGUN_ONLY"       => "Shotgun Only",
        "SORTIE_MODIFIER_SNIPER_ONLY"        => "Sniper Rifle Only",
        "SORTIE_MODIFIER_MELEE_ONLY"         => "Melee Only",
        "SORTIE_MODIFIER_LOW_ENERGY"         => "Low Energy",
        "SORTIE_MODIFIER_EXIMUS"             => "Eximus Stronghold",
        "SORTIE_MODIFIER_SECONDARY_ONLY"     => "Secondary Only",
        "SORTIE_MODIFIER_ASSAULT_RIFLE_ONLY" => "Assault Rifle Only",
        "SORTIE_MODIFIER_IMPACT"             => "Augmented Enemy Armor",
        "SORTIE_MODIFIER_ELEMENTAL_ENHANCEMENT" => "Elemental Enhancement",
        _                                    => "Modifier",
    }
}

fn ws_faction(f: &str) -> String {
    match f {
        "FC_GRINEER"    => "Grineer",
        "FC_CORPUS"     => "Corpus",
        "FC_INFESTATION"=> "Infested",
        "FC_OROKIN"     => "Orokin",
        "FC_CORRUPTED"  => "Corrupted",
        "FC_TENNO"      => "Tenno",
        "FC_MITW"       => "Murmur",
        _               => f.trim_start_matches("FC_"),
    }.to_string()
}

/// Extract a display name from a /Lotus/ asset path.
fn path_display_name(path: &str) -> String {
    let last = path.split('/').last().unwrap_or(path);
    // Strip known internal prefixes that are never part of the display name
    let stripped = last
        .strip_prefix("MPV")   // MegaPrimeVault bundles, e.g. MPVRhinoPrimeSinglePack
        .unwrap_or(last);
    // Convert PascalCase → "Pascal Case"
    let mut out = String::with_capacity(stripped.len() + 8);
    let mut prev_was_upper = false;
    for (i, ch) in stripped.chars().enumerate() {
        if ch.is_uppercase() && i > 0 && !prev_was_upper {
            out.push(' ');
        }
        out.push(ch);
        prev_was_upper = ch.is_uppercase();
    }
    // Strip common suffixes that add no value
    for suffix in &[" Item", " Resource Item", " Reward"] {
        if out.ends_with(suffix) {
            out.truncate(out.len() - suffix.len());
            break;
        }
    }
    out
}

/// Map store item paths to catalog unique_names where possible.
/// /Lotus/StoreItems/X   → /Lotus/X        (direct catalog items like mods, primes)
/// /Lotus/Types/StoreItems/... → unchanged  (bundle packages — no catalog entry)
fn store_to_unique(path: &str) -> String {
    path.replacen("/Lotus/StoreItems/", "/Lotus/", 1)
}

/// Resolve a store item path to a display name using the catalog, falling back to path parsing.
fn item_display_name(path: &str, catalog: &std::collections::HashMap<String, String>) -> String {
    // Try /Lotus/StoreItems/X → /Lotus/X mapping
    let unique = store_to_unique(path);
    if let Some(name) = catalog.get(&unique) {
        return name.clone();
    }
    // Try /Lotus/Types/StoreItems/... → /Lotus/Types/... (cosmetics, song items, etc.)
    if let Some(rest) = path.strip_prefix("/Lotus/Types/StoreItems/") {
        let alt = format!("/Lotus/Types/{}", rest);
        if let Some(name) = catalog.get(&alt) {
            return name.clone();
        }
    }
    path_display_name(path)
}

/// Parse DE raw worldstate JSON into the shape TimerHelper.tsx expects.
fn parse_worldstate_value(raw: &serde_json::Value, now_ms: i64, catalog: &std::collections::HashMap<String, String>) -> serde_json::Value {
    use serde_json::{json, Value};

    // ── World cycles ──────────────────────────────────────────────────────
    let mut cetus   = Value::Null;
    let mut vallis  = Value::Null;
    let mut cambion = Value::Null;

    if let Some(missions) = raw["SyndicateMissions"].as_array() {
        for m in missions {
            let tag = m["Tag"].as_str().unwrap_or("");
            let expiry_ms     = ws_ms(&m["Expiry"]);
            let activation_ms = ws_ms(&m["Activation"]);
            let duration_ms   = expiry_ms - activation_ms;
            match tag {
                "CetusSyndicate" => {
                    // Day ~6000 s, Night ~3000 s; threshold 4500 s
                    cetus = json!({ "expiry": ms_to_iso(expiry_ms), "isDay": duration_ms > 4_500_000_i64 });
                }
                "SolarisSyndicate" => {
                    // Cold ~1600 s, Warm ~400 s; threshold 1000 s
                    vallis = json!({ "expiry": ms_to_iso(expiry_ms), "isWarm": duration_ms < 1_000_000_i64 });
                }
                "EntatiSyndicate" => {
                    // Cambion Drift — Fass/Vome have equal duration; show countdown only
                    cambion = json!({ "expiry": ms_to_iso(expiry_ms), "active": "cycle" });
                }
                _ => {}
            }
        }
    }

    // ── Sortie ────────────────────────────────────────────────────────────
    let sortie = raw["Sorties"].as_array()
        .and_then(|a| a.first())
        .map(|s| {
            let expiry_ms = ws_ms(&s["Expiry"]);
            let boss_key  = s["Boss"].as_str().unwrap_or("");
            let (boss, faction) = ws_sortie_boss(boss_key);
            let variants: Vec<Value> = s["Variants"].as_array()
                .map(|arr| arr.iter().map(|v| json!({
                    "missionType": ws_mission_type(v["missionType"].as_str().unwrap_or("")),
                    "modifier":    ws_sortie_modifier(v["modifierType"].as_str().unwrap_or("")),
                    "node":        v["node"].as_str().unwrap_or(""),
                })).collect())
                .unwrap_or_default();
            json!({ "expiry": ms_to_iso(expiry_ms), "boss": boss, "faction": faction,
                    "variants": variants, "active": now_ms < expiry_ms })
        })
        .unwrap_or(Value::Null);

    // ── Archon Hunt (LiteSorties) ─────────────────────────────────────────
    let archon_hunt = raw["LiteSorties"].as_array()
        .and_then(|a| a.first())
        .map(|s| {
            let expiry_ms = ws_ms(&s["Expiry"]);
            let boss_raw  = s["Boss"].as_str().unwrap_or("");
            // Boss might be a /Lotus/ path; extract the last component
            let boss = boss_raw.split('/').last().unwrap_or(boss_raw)
                .trim_start_matches("Archon");
            let missions: Vec<Value> = s["Variants"].as_array()
                .map(|arr| arr.iter().map(|v| json!({
                    "type": ws_mission_type(v["missionType"].as_str().unwrap_or("")),
                    "node": v["node"].as_str().unwrap_or(""),
                })).collect())
                .unwrap_or_default();
            json!({ "expiry": ms_to_iso(expiry_ms), "boss": boss, "faction": "Infested",
                    "missions": missions, "active": now_ms < expiry_ms })
        })
        .unwrap_or(Value::Null);

    // ── Void Trader ───────────────────────────────────────────────────────
    let void_trader = raw["VoidTraders"].as_array()
        .and_then(|a| a.first())
        .map(|t| {
            let activation_ms = ws_ms(&t["Activation"]);
            let expiry_ms     = ws_ms(&t["Expiry"]);
            let node          = t["Node"].as_str().unwrap_or("");
            let active = now_ms >= activation_ms && now_ms < expiry_ms;
            let manifest: Vec<Value> = if active {
                t["Manifest"].as_array().map(|arr| arr.iter().map(|item| {
                    let raw_path = item["ItemType"].as_str().unwrap_or("");
                    let name = item_display_name(raw_path, catalog);
                    json!({
                        "name": name,
                        "uniqueName": store_to_unique(raw_path),
                        "primePrice": item["PrimePrice"].as_i64().unwrap_or(0),
                        "regularPrice": item["RegularPrice"].as_i64().unwrap_or(0),
                    })
                }).collect()).unwrap_or_default()
            } else { vec![] };
            json!({
                "activation": ms_to_iso(activation_ms),
                "expiry":     ms_to_iso(expiry_ms),
                "character":  "Baro Ki'Teer",
                "location":   resolve_node(node),
                "active":     active,
                "manifest":   manifest,
            })
        })
        .unwrap_or(Value::Null);

    // ── Prime Resurgence (PrimeVaultTraders) ──────────────────────────────
    let prime_resurgence = raw["PrimeVaultTraders"].as_array()
        .and_then(|a| a.first())
        .map(|t| {
            let activation_ms = ws_ms(&t["Activation"]);
            let expiry_ms     = ws_ms(&t["Expiry"]);
            let active = now_ms >= activation_ms && now_ms < expiry_ms;
            let manifest: Vec<Value> = t["Manifest"].as_array().map(|arr| arr.iter().map(|item| {
                let raw_path = item["ItemType"].as_str().unwrap_or("");
                let name = item_display_name(raw_path, catalog);
                let price = item["PrimePrice"].as_i64().unwrap_or(0);
                // Regal Aya = bundle packs under MegaPrimeVault/; Aya = direct item paths
                let is_regal = raw_path.contains("/MegaPrimeVault/");
                let mut obj = serde_json::Map::new();
                obj.insert("name".into(), json!(name));
                obj.insert("uniqueName".into(), json!(store_to_unique(raw_path)));
                if is_regal {
                    obj.insert("regalAyaPrice".into(), json!(price));
                } else {
                    obj.insert("ayaPrice".into(), json!(price));
                }
                serde_json::Value::Object(obj)
            }).collect()).unwrap_or_default();
            json!({
                "activation": ms_to_iso(activation_ms),
                "expiry":     ms_to_iso(expiry_ms),
                "active":     active,
                "manifest":   manifest,
            })
        })
        .unwrap_or(Value::Null);

    // ── Nightwave (SeasonInfo) ────────────────────────────────────────────
    let nightwave = raw.get("SeasonInfo")
        .filter(|s| !s.is_null())
        .map(|s| {
            let expiry_ms = ws_ms(&s["Expiry"]);
            let season    = s["Season"].as_i64().unwrap_or(0);
            json!({ "expiry": ms_to_iso(expiry_ms), "season": season, "active": now_ms < expiry_ms })
        })
        .unwrap_or(Value::Null);

    // ── Fissures (ActiveMissions) ─────────────────────────────────────────
    let fissures: Vec<Value> = raw["ActiveMissions"].as_array()
        .map(|arr| arr.iter().filter_map(|f| {
            let modifier = f["Modifier"].as_str()?;
            if !modifier.starts_with("VoidT") { return None; }
            if f["Hard"].as_bool().unwrap_or(false) { return None; }
            let activation_ms = ws_ms(&f["Activation"]);
            let expiry_ms     = ws_ms(&f["Expiry"]);
            if activation_ms > now_ms { return None; } // not started yet
            if expiry_ms <= now_ms    { return None; }
            let (tier, tier_num) = match modifier {
                "VoidT1" => ("Lith",    1u32),
                "VoidT2" => ("Meso",    2),
                "VoidT3" => ("Neo",     3),
                "VoidT4" => ("Axi",     4),
                "VoidT5" => ("Requiem", 5),
                "VoidT6" => ("Omnia",   6),
                _        => return None,
            };
            let id   = f["_id"]["$oid"].as_str().unwrap_or("").to_string();
            let node = f["Node"].as_str().unwrap_or("");
            let mt   = ws_mission_type(f["MissionType"].as_str().unwrap_or(""));
            let enemy = node_enemy(node);
            Some(json!({
                "id": id, "expiry": ms_to_iso(expiry_ms),
                "node": resolve_node(node), "missionType": mt,
                "tier": tier, "tierNum": tier_num,
                "enemy": enemy, "isStorm": false, "isHard": false, "active": true,
            }))
        }).collect())
        .unwrap_or_default();

    // ── Bounties (all open worlds) ────────────────────────────────────────
    let mut bounties = serde_json::Map::new();
    for m in raw["SyndicateMissions"].as_array().iter().flat_map(|a| a.iter()) {
        let tag = m["Tag"].as_str().unwrap_or("");
        let expiry_ms = ws_ms(&m["Expiry"]);
        let job_count = m["Jobs"].as_array().map(|j| j.len()).unwrap_or(0);
        let label = match tag {
            "CetusSyndicate"     => "cetus",
            "SolarisSyndicate"   => "vallis",
            "EntratiSyndicate"   => "cambion",
            "ZarimanSyndicate"   => "zariman",
            "HexSyndicate"       => "hex",
            "EntratiLabSyndicate"=> "entrati-lab",
            _                    => continue,
        };
        bounties.insert(label.to_string(), json!({
            "expiry": ms_to_iso(expiry_ms),
            "jobCount": job_count,
        }));
        // Also set cycle state for Zariman
        if tag == "ZarimanSyndicate" {
            // Zariman cycle is tied to bounty rotation
        }
    }

    // ── Zariman cycle (same expiry as bounties) ───────────────────────────
    let zariman = bounties.get("zariman")
        .map(|b| json!({ "expiry": b["expiry"], "active": true }))
        .unwrap_or(Value::Null);

    // ── Alerts ────────────────────────────────────────────────────────────
    let alerts: Vec<Value> = raw["Alerts"].as_array()
        .map(|arr| arr.iter().filter_map(|a| {
            let expiry_ms = ws_ms(&a["Expiry"]);
            if expiry_ms <= now_ms { return None; }
            let mi = &a["MissionInfo"];
            let reward = mi["missionReward"].as_object();
            let reward_item = reward
                .and_then(|r| r.get("countedItems"))
                .and_then(|ci| ci.as_array())
                .and_then(|arr| arr.first())
                .and_then(|item| item["ItemType"].as_str())
                .map(path_display_name);
            let reward_credits = reward
                .and_then(|r| r.get("credits"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            let id = a["_id"]["$oid"].as_str().unwrap_or("").to_string();
            Some(json!({
                "id": id,
                "expiry": ms_to_iso(expiry_ms),
                "missionType": ws_mission_type(mi["missionType"].as_str().unwrap_or("")),
                "faction": ws_faction(mi["faction"].as_str().unwrap_or("")),
                "node": mi["location"].as_str().unwrap_or(""),
                "rewardItem": reward_item,
                "rewardCredits": reward_credits,
            }))
        }).collect())
        .unwrap_or_default();

    // ── Invasions (active only) ────────────────────────────────────────────
    let invasions: Vec<Value> = raw["Invasions"].as_array()
        .map(|arr| arr.iter().filter_map(|inv| {
            if inv["Completed"].as_bool().unwrap_or(false) { return None; }
            let id   = inv["_id"]["$oid"].as_str().unwrap_or("").to_string();
            let node = resolve_node(inv["Node"].as_str().unwrap_or(""));
            let attacker = ws_faction(inv["Faction"].as_str().unwrap_or(""));
            let defender = ws_faction(inv["DefenderFaction"].as_str().unwrap_or(""));
            let count = inv["Count"].as_i64().unwrap_or(0);
            let goal  = inv["Goal"].as_i64().unwrap_or(1);
            let pct   = (count.abs() as f64 / goal.abs().max(1) as f64 * 100.0) as i64;
            let att_reward = inv["AttackerReward"]["countedItems"].as_array()
                .and_then(|a| a.first()).and_then(|i| i["ItemType"].as_str())
                .map(path_display_name).unwrap_or_default();
            let def_reward = inv["DefenderReward"]["countedItems"].as_array()
                .and_then(|a| a.first()).and_then(|i| i["ItemType"].as_str())
                .map(path_display_name).unwrap_or_default();
            Some(json!({
                "id": id, "node": node,
                "attacker": attacker, "defender": defender,
                "attReward": att_reward, "defReward": def_reward,
                "pct": pct,
            }))
        }).collect())
        .unwrap_or_default();

    // ── Steel Path fissures ────────────────────────────────────────────────
    let sp_fissures: Vec<Value> = raw["ActiveMissions"].as_array()
        .map(|arr| arr.iter().filter_map(|f| {
            if !f["Hard"].as_bool().unwrap_or(false) { return None; }
            let modifier      = f["Modifier"].as_str()?;
            if !modifier.starts_with("VoidT") { return None; }
            let activation_ms = ws_ms(&f["Activation"]);
            let expiry_ms     = ws_ms(&f["Expiry"]);
            if activation_ms > now_ms { return None; }
            if expiry_ms <= now_ms    { return None; }
            let (tier, tier_num) = match modifier {
                "VoidT1" => ("Lith", 1u32), "VoidT2" => ("Meso", 2),
                "VoidT3" => ("Neo", 3),     "VoidT4" => ("Axi", 4),
                "VoidT5" => ("Requiem", 5), "VoidT6" => ("Omnia", 6),
                _ => return None,
            };
            let id    = f["_id"]["$oid"].as_str().unwrap_or("").to_string();
            let node  = f["Node"].as_str().unwrap_or("");
            let enemy = node_enemy(node);
            Some(json!({
                "id": id, "expiry": ms_to_iso(expiry_ms),
                "node": resolve_node(node),
                "missionType": ws_mission_type(f["MissionType"].as_str().unwrap_or("")),
                "tier": tier, "tierNum": tier_num,
                "enemy": enemy, "isStorm": false, "isHard": true, "active": true,
            }))
        }).collect())
        .unwrap_or_default();

    // ── Void Storms ────────────────────────────────────────────────────────
    let void_storms: Vec<Value> = raw["VoidStorms"].as_array()
        .map(|arr| arr.iter().filter_map(|s| {
            let activation_ms = ws_ms(&s["Activation"]);
            let expiry_ms     = ws_ms(&s["Expiry"]);
            if activation_ms > now_ms { return None; }
            if expiry_ms <= now_ms    { return None; }
            let modifier = s["ActiveMissionTier"].as_str().unwrap_or("");
            let (tier, tier_num) = match modifier {
                "VoidT1" => ("Lith", 1u32), "VoidT2" => ("Meso", 2),
                "VoidT3" => ("Neo", 3),     "VoidT4" => ("Axi", 4),
                "VoidT5" => ("Requiem", 5), "VoidT6" => ("Omnia", 6),
                _ => return None,
            };
            let id       = s["_id"]["$oid"].as_str().unwrap_or("").to_string();
            let node_id  = s["Node"].as_str().unwrap_or("");
            let mt       = node_mission_type(node_id);
            let enemy    = node_enemy(node_id);
            Some(json!({
                "id": id, "expiry": ms_to_iso(expiry_ms),
                "node": resolve_node(node_id),
                "missionType": if mt.is_empty() { "Railjack".to_string() } else { mt },
                "enemy": enemy,
                "tier": tier, "tierNum": tier_num,
                "active": true,
            }))
        }).collect())
        .unwrap_or_default();

    // ── Darvo Daily Deal ──────────────────────────────────────────────────
    let darvo = raw["DailyDeals"].as_array()
        .and_then(|a| a.first())
        .map(|d| {
            let expiry_ms = ws_ms(&d["Expiry"]);
            let item_path = d["StoreItem"].as_str().unwrap_or("");
            json!({
                "expiry": ms_to_iso(expiry_ms),
                "item": path_display_name(item_path),
                "discount": d["Discount"].as_i64().unwrap_or(0),
                "originalPrice": d["OriginalPrice"].as_i64().unwrap_or(0),
                "salePrice": d["SalePrice"].as_i64().unwrap_or(0),
                "amountTotal": d["AmountTotal"].as_i64().unwrap_or(0),
                "amountSold": d["AmountSold"].as_i64().unwrap_or(0),
            })
        })
        .unwrap_or(Value::Null);

    // ── The Circuit (Duviri weekly) ───────────────────────────────────────
    let circuit = raw["EndlessXpSchedule"].as_array()
        .and_then(|a| a.first())
        .map(|s| {
            let expiry_ms = ws_ms(&s["Expiry"]);
            let choices = s["CategoryChoices"].as_array();
            let normal: Vec<&str> = choices.iter().flat_map(|a| a.iter())
                .find(|c| c["Category"].as_str() == Some("EXC_NORMAL"))
                .and_then(|c| c["Choices"].as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let hard: Vec<&str> = choices.iter().flat_map(|a| a.iter())
                .find(|c| c["Category"].as_str() == Some("EXC_HARD"))
                .and_then(|c| c["Choices"].as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            json!({
                "expiry": ms_to_iso(expiry_ms),
                "normalFrames": normal,
                "hardWeapons": hard,
            })
        })
        .unwrap_or(Value::Null);

    // ── Kahl / Break Narmer ───────────────────────────────────────────────
    let kahl = raw["SyndicateMissions"].as_array()
        .and_then(|a| a.iter().find(|m| m["Tag"].as_str() == Some("KahlSyndicate")))
        .map(|m| {
            let expiry_ms = ws_ms(&m["Expiry"]);
            json!({ "expiry": ms_to_iso(expiry_ms) })
        })
        .unwrap_or(Value::Null);

    // ── Deep Archimedea (Descents) ────────────────────────────────────────
    let deep_archimedea = raw["Descents"].as_array()
        .and_then(|a| a.first())
        .map(|d| {
            let expiry_ms = ws_ms(&d["Expiry"]);
            json!({ "expiry": ms_to_iso(expiry_ms) })
        })
        .unwrap_or(Value::Null);

    // ── Active Goal / Community Event ─────────────────────────────────────
    let active_event = raw["Goals"].as_array()
        .and_then(|a| a.iter().find(|g| {
            ws_ms(&g["Expiry"]) > now_ms
        }))
        .map(|g| {
            let expiry_ms = ws_ms(&g["Expiry"]);
            let desc = g["Desc"].as_str().unwrap_or("");
            let label = loc(desc);
            json!({ "expiry": ms_to_iso(expiry_ms), "label": label })
        })
        .unwrap_or(Value::Null);

    json!({
        "cetus": cetus, "vallis": vallis, "cambion": cambion, "zariman": zariman,
        "bounties": bounties,
        "sortie": sortie, "archonHunt": archon_hunt,
        "voidTrader": void_trader, "primeResurgence": prime_resurgence, "nightwave": nightwave,
        "circuit": circuit, "kahl": kahl, "deepArchimedea": deep_archimedea,
        "activeEvent": active_event,
        "darvo": darvo,
        "alerts": alerts,
        "invasions": invasions,
        "fissures": fissures,
        "spFissures": sp_fissures,
        "voidStorms": void_storms,
    })
}

/// Fetch and parse the DE official Warframe worldstate.
/// Runs on a blocking thread so the async runtime is never stalled.
#[tauri::command]
async fn fetch_worldstate(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Snapshot catalog for name lookups — do this before entering spawn_blocking
    let catalog: std::collections::HashMap<String, String> = {
        let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
        items.iter().map(|i| (i.unique_name.clone(), i.name.clone())).collect()
    };
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let raw = ureq::get("https://api.warframe.com/cdn/worldState.php")
            .set("User-Agent", "FrameForge/1.0")
            .call()
            .map_err(|e| format!("worldstate fetch failed: {}", e))?
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("worldstate parse failed: {}", e))?;
        Ok(parse_worldstate_value(&raw, now_ms, &catalog))
    })
    .await
    .map_err(|e| format!("task error: {}", e))?
}

/// Read the riven overlay session log.
#[tauri::command]
fn get_riven_session_log() -> String {
    let path = std::env::temp_dir().join("frameforge_riven_session.txt");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| "(no riven session log yet — open the riven reroll screen first)".into())
}

/// Read the current overlay session log.
#[tauri::command]
fn get_overlay_session_log() -> String {
    let path = std::env::temp_dir().join("frameforge_overlay_session.txt");
    std::fs::read_to_string(&path).unwrap_or_else(|_| "(no session log yet — trigger a Void Fissure first)".into())
}

/// Returns the Warframe game CLIENT AREA as [x, y, width, height] in screen pixels.
/// Uses GetClientRect + ClientToScreen so the rect matches what the OCR captures —
/// both exclude the window title bar and borders in windowed mode.
#[tauri::command]
fn get_warframe_window_rect() -> Result<[i32; 4], String> {
    #[cfg(not(target_os = "windows"))]
    { return Err("Windows only".into()); }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{POINT, RECT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetClientRect};
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;

        let title: Vec<u16> = "Warframe\0".encode_utf16().collect();
        let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if hwnd == 0 { return Err("Warframe window not found".into()); }

        // Client rect is always (0,0,w,h) — convert origin to screen coords
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetClientRect(hwnd, &mut r) };
        let mut origin = POINT { x: 0, y: 0 };
        unsafe { ClientToScreen(hwnd, &mut origin) };

        Ok([origin.x, origin.y, r.right - r.left, r.bottom - r.top])
    }
}

#[tauri::command]
fn stop_monitor(state: State<AppState>) {
    state.monitor_active.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn get_monitor_status(state: State<AppState>) -> bool {
    state.monitor_active.load(Ordering::SeqCst)
}

/// Returns blueprint_path → display_name map (names only, for compatibility).
#[tauri::command]
fn get_blueprint_names(state: State<AppState>) -> HashMap<String, String> {
    state.blueprint_to_result.lock().unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(k, (name, _))| (k.clone(), name.clone()))
        .collect()
}

// ─── App entry point ──────────────────────────────────────────────────────────

/// WFCD has a recurring bug where dual-pistol component weapons get the parent's
/// name prepended. These overrides replace the bad names with the correct ones.
fn patch_item_name(unique_name: &str, name: &str) -> String {
    match unique_name {
        "/Lotus/Weapons/Tenno/Pistols/Magnum/Magnum"                    => "Magnus".into(),
        "/Lotus/Weapons/Tenno/Pistols/PrimeMagnus/PrimeMagnusWeapon"    => "Magnus Prime".into(),
        "/Lotus/Weapons/Tenno/Pistol/BroncoPrime"                       => "Bronco Prime".into(),
        "/Lotus/Weapons/Tenno/Pistols/PrimeLex/PrimeLex"                => "Lex Prime".into(),
        "/Lotus/Weapons/Tenno/Pistols/PrimeVasto/PrimeVastoPistol"      => "Vasto Prime".into(),
        "/Lotus/Weapons/Tenno/Melee/Swords/KatanaAndWakizashi/Katana"   => "Dragon Nikana".into(),
        "/Lotus/Types/Recipes/Weapons/WeaponParts/WarBlade"             => "Broken War Blade".into(),
        "/Lotus/Types/Recipes/Weapons/WeaponParts/WarHilt"              => "Broken War Hilt".into(),
        "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchHeavyPistolsBarrel"    => "Dual Decurion Barrel".into(),
        "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchHeavyPistolsReceiver"  => "Dual Decurion Receiver".into(),
        _ => name.to_string(),
    }
}

fn patch_item_category(name: &str, category: &str) -> String {
    if name.contains("Blueprint") { "Blueprints".to_string() } else { category.to_string() }
}

fn load_items_cache(path: &PathBuf) -> Option<Vec<WfcdItem>> {
    let s = std::fs::read_to_string(path).ok()?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&s).ok()?;
    let items: Vec<WfcdItem> = arr.into_iter().filter_map(|v| {
        let unique_name = v["unique_name"].as_str()?.to_string();
        let raw_name = v["name"].as_str()?.to_string();
        let name = patch_item_name(&unique_name, &raw_name);
        let image_name = v["image_name"].as_str().map(|s| s.to_string());
        let vaulted = v["vaulted"].as_bool();
        let ducats = v["ducats"].as_u64().map(|n| n as u32);
        let raw_cat = v["category"].as_str()?.to_string();
        let category = patch_item_category(&name, &raw_cat);
        let mastery_req = v["mastery_req"].as_u64().map(|n| n as u32);
        Some(WfcdItem { unique_name, name, category, image_name, vaulted, ducats, mastery_req })
    }).collect();
    if items.is_empty() { None } else { Some(items) }
}

fn load_quantities_cache(path: &PathBuf) -> HashMap<String, i64> {
    std::fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn load_recipes_cache(path: &PathBuf) -> HashMap<String, Vec<RecipeComponent>> {
    std::fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_window_state(window: &tauri::WebviewWindow, settings_path: &std::path::Path, prefix: &str) {
    // Skip saving if minimized — minimized windows have junk coordinates on Windows
    if window.is_minimized().unwrap_or(false) { return; }

    let maximized = window.is_maximized().unwrap_or(false);
    let pos  = window.outer_position().ok();
    let size = window.outer_size().ok();

    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| if let serde_json::Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default();

    map.insert(format!("{}Maximized", prefix), maximized.into());
    // Only overwrite position/size when not maximised — maximised coords are the full screen
    if !maximized {
        if let Some(p) = pos {
            map.insert(format!("{}X", prefix), p.x.into());
            map.insert(format!("{}Y", prefix), p.y.into());
        }
        if let Some(s) = size {
            map.insert(format!("{}Width",  prefix), (s.width  as i64).into());
            map.insert(format!("{}Height", prefix), (s.height as i64).into());
        }
    }

    let _ = std::fs::write(settings_path, serde_json::Value::Object(map).to_string());
}

fn restore_window_state(window: &tauri::WebviewWindow, settings_path: &std::path::Path, prefix: &str, min_w: u32, min_h: u32) {
    let json = match std::fs::read_to_string(settings_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let map = match serde_json::from_str::<serde_json::Value>(&json) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => return,
    };

    let maximized = map.get(&format!("{}Maximized", prefix)).and_then(|v| v.as_bool()).unwrap_or(false);
    if maximized {
        let _ = window.maximize();
        return;
    }

    let x = map.get(&format!("{}X", prefix)).and_then(|v| v.as_i64());
    let y = map.get(&format!("{}Y", prefix)).and_then(|v| v.as_i64());
    let w = map.get(&format!("{}Width",  prefix)).and_then(|v| v.as_i64()).map(|v| v as u32);
    let h = map.get(&format!("{}Height", prefix)).and_then(|v| v.as_i64()).map(|v| v as u32);

    if let (Some(x), Some(y)) = (x, y) {
        // Guard against Windows' minimized-window sentinel coordinates (-32000, -32000)
        if x > -10_000 && y > -10_000 {
            let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        }
    }
    if let (Some(w), Some(h)) = (w, h) {
        if w >= min_w && h >= min_h {
            let _ = window.set_size(tauri::PhysicalSize::new(w, h));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("warframe-companion");

    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let db_path = data_dir.join("data.db");
    let items_cache_path = data_dir.join("items_cache.json");
    let recipes_cache_path = data_dir.join("recipes_cache.json");
    let relic_drops_cache_path = data_dir.join("relic_drops_cache.json");
    let relic_rewards_cache_path = data_dir.join("relic_rewards_cache.json");
    let quantities_cache_path = data_dir.join("quantities_cache.json");
    let settings_path = data_dir.join("settings.json");
    let log_path = data_dir.join("scan_log.txt");

    let conn = db::init_db(&db_path).expect("Failed to initialize database");

    let initial_items = load_items_cache(&items_cache_path)
        .unwrap_or_else(wfcd::fallback_items);
    let initial_recipes = load_recipes_cache(&recipes_cache_path);
    let initial_relic_drops: HashMap<String, Vec<String>> = std::fs::read_to_string(&relic_drops_cache_path)
        .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let initial_relic_rewards: HashMap<String, Vec<wfcd::RelicReward>> = std::fs::read_to_string(&relic_rewards_cache_path)
        .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let initial_quantities = load_quantities_cache(&quantities_cache_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db_path,
            items_cache_path,
            recipes_cache_path,
            relic_drops_cache_path,
            relic_rewards_cache_path,
            quantities_cache_path,
            settings_path,
            log_path,
            conn: Mutex::new(conn),
            wfcd_items: Mutex::new(initial_items),
            recipes: Mutex::new(initial_recipes),
            relic_drops: Mutex::new(initial_relic_drops),
            relic_rewards: Mutex::new(initial_relic_rewards),
            blueprint_to_result: Mutex::new(HashMap::new()),
            wiki_reward_names: Mutex::new(std::collections::HashSet::new()),
            current_quantities: Arc::new(Mutex::new(initial_quantities)),
            current_crafting: Arc::new(Mutex::new(vec![])),
            monitor_active: Arc::new(AtomicBool::new(false)),
            wfm_price_cache: Mutex::new(HashMap::new()),
            wfm_session: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::image::Image::from_bytes(
                    include_bytes!("../icons/icon.png")
                ).map_err(|e| e.to_string())?;
                window.set_icon(icon).map_err(|e| e.to_string())?;

                // Restore saved window geometry before the window is shown
                let state = app.state::<AppState>();
                restore_window_state(&window, &state.settings_path, "window", 400, 300);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_all_items,
            get_current_quantities,
            get_item_list_status,
            fetch_item_list,
            get_change_log,
            get_trades,
            add_trade,
            delete_trade,
            clear_cache,
            load_settings,
            save_settings,
            read_scan_log,
            get_app_version,
            set_app_version,
            get_craftable_items,
            get_recipe,
            get_relic_drops,
            get_relic_rewards,
            fetch_wfm_items,
            fetch_wfm_price,
            get_item_price,
            wfm_set_status,
            start_log_watcher,
            ocr_riven_log_error,
            riven_screen_visible,
            riven_screen_status,
            get_riven_weapons,
            reload_riven_database,
            analyze_riven,
            ocr_riven_screen,
            get_riven_session_log,
            wfm_debug_dump,
            wfm_get_item_orders,
            wfm_get_item_statistics,
            wfm_open_login_window,
            wfm_receive_jwt,
            wfm_receive_tokens,
            wfm_refresh_token,
            wfm_set_jwt,
            wfm_get_jwt,
            wfm_save_credentials,
            wfm_load_credentials,
            wfm_delete_credentials,
            wfm_login,
            wfm_logout,
            wfm_get_session,
            wfm_get_orders,
            wfm_get_item_info,
            wfm_create_order,
            wfm_update_order,
            wfm_delete_order,
            scan_warframe_credentials,
            scan_warframe_api_urls,
            warframe_login,
            fetch_warframe_inventory,
            fetch_worldstate,
            get_warframe_window_rect,
            get_overlay_session_log,
            start_monitor,
            stop_monitor,
            get_monitor_status,
            get_blueprint_names,
            get_current_crafting,
        ])
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if label == "main" || label == "modular-popout" {
                let prefix = if label == "main" { "window" } else { "modularWin" };
                match event {
                    tauri::WindowEvent::CloseRequested { .. } => {
                        // Save window geometry before the window is destroyed
                        let app = window.app_handle();
                        if let Some(wv) = app.get_webview_window(&label) {
                            let state = app.state::<AppState>();
                            save_window_state(&wv, &state.settings_path, prefix);
                        }
                    }
                    tauri::WindowEvent::Destroyed => {
                        // Kill the process only when the main window is destroyed
                        // (prevents orphaned overlay/modular windows)
                        if label == "main" {
                            std::process::exit(0);
                        }
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
