use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

mod db;
mod memory_scanner;
mod wfcd;

use db::QuantityChange;
use wfcd::{RecipeComponent, WfcdItem};

pub struct AppState {
    pub db_path: PathBuf,
    pub items_cache_path: PathBuf,
    pub recipes_cache_path: PathBuf,
    pub relic_drops_cache_path: PathBuf,
    pub relic_rewards_cache_path: PathBuf,
    pub quantities_cache_path: PathBuf,
    pub log_path: PathBuf,
    pub conn: Mutex<rusqlite::Connection>,
    pub wfcd_items: Mutex<Vec<WfcdItem>>,
    /// parent unique_name → recipe component tree
    pub recipes: Mutex<HashMap<String, Vec<RecipeComponent>>>,
    /// component unique_name → relic unique_names that drop it
    pub relic_drops: Mutex<HashMap<String, Vec<String>>>,
    /// relic unique_name → sorted reward list (Bronze×3, Silver×2, Gold×1)
    pub relic_rewards: Mutex<HashMap<String, Vec<wfcd::RelicReward>>>,
    /// Last-known quantities from memory scans. Shared with monitor thread.
    pub current_quantities: Arc<Mutex<HashMap<String, i64>>>,
    pub monitor_active: Arc<AtomicBool>,
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

#[tauri::command]
fn get_all_items(state: State<AppState>) -> Vec<CatalogItem> {
    let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner());
    items.iter().map(|i| CatalogItem {
        unique_name: i.unique_name.clone(),
        name: i.name.clone(),
        category: i.category.clone(),
        image_name: i.image_name.clone(),
        vaulted: i.vaulted,
        ducats: i.ducats,
        mastery_req: i.mastery_req,
    }).collect()
}

#[tauri::command]
fn get_current_quantities(state: State<AppState>) -> HashMap<String, i64> {
    state.current_quantities.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

#[tauri::command]
fn write_debug_file(state: State<AppState>, text: String) -> Result<(), String> {
    let path = state.log_path.parent().unwrap_or(&state.log_path).join("scan_debug.txt");
    std::fs::write(&path, &text).map_err(|e| e.to_string())?;
    Ok(())
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
    pub item_name: String,
    pub url_name: String,
}

/// Fetch warframe.market item list (url_names for price lookups).
#[tauri::command]
async fn fetch_wfm_items() -> Result<Vec<WfmItem>, String> {
    let json: serde_json::Value = ureq::get("https://api.warframe.market/v1/items")
        .set("User-Agent", "FrameForge/0.1")
        .set("Accept", "application/json")
        .set("Platform", "pc")
        .call()
        .map_err(|e| format!("wfm items fetch: {}", e))?
        .into_json()
        .map_err(|e| format!("wfm items parse: {}", e))?;

    let items = json["payload"]["items"]
        .as_array()
        .ok_or("no items array")?
        .iter()
        .filter_map(|v| Some(WfmItem {
            item_name: v["item_name"].as_str()?.to_string(),
            url_name:  v["url_name"].as_str()?.to_string(),
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

/// Fetch 48-hour median sell/buy price for a single item from warframe.market.
#[tauri::command]
async fn fetch_wfm_price(url_name: String) -> Result<WfmPrice, String> {
    let url = format!("https://api.warframe.market/v1/items/{}/statistics", url_name);
    let json: serde_json::Value = ureq::get(&url)
        .set("User-Agent", "FrameForge/0.1")
        .set("Accept", "application/json")
        .set("Platform", "pc")
        .call()
        .map_err(|e| format!("wfm price fetch: {}", e))?
        .into_json()
        .map_err(|e| format!("wfm price parse: {}", e))?;

    // Statistics are now sell-only — no order_type field, just take the last (most recent) entry
    let closed = &json["payload"]["statistics_closed"]["48hours"];
    let sell_median = closed.as_array()
        .and_then(|arr| arr.last())
        .and_then(|e| e["median"].as_f64());

    // Also try 90-day window if 48h has no data
    let sell_median = if sell_median.is_some() { sell_median } else {
        json["payload"]["statistics_closed"]["90days"].as_array()
            .and_then(|arr| arr.last())
            .and_then(|e| e["median"].as_f64())
    };

    Ok(WfmPrice { url_name, sell_median, buy_median: None })
}

// ─── Change log ───────────────────────────────────────────────────────────────

#[tauri::command]
fn get_change_log(state: State<AppState>, limit: i64) -> Result<Vec<QuantityChange>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_quantity_changes(&conn, limit).map_err(|e| e.to_string())
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
fn start_monitor(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    if state.monitor_active.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }

    let items = state.wfcd_items.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let unique_names: Vec<String> = items.iter().map(|i| i.unique_name.clone()).collect();
    let display_names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
    let flag = state.monitor_active.clone();
    let db_path = state.db_path.clone();
    let log_path = state.log_path.clone();
    let quantities_cache_path = state.quantities_cache_path.clone();
    let shared_quantities = state.current_quantities.clone();

    std::thread::spawn(move || {
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => { eprintln!("Monitor DB open failed: {}", e); return; }
        };
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");

        // Start from whatever quantities were last known (survives restarts).
        let mut known: HashMap<String, i64> =
            shared_quantities.lock().unwrap_or_else(|e| e.into_inner()).clone();

        while flag.load(Ordering::SeqCst) {
            let result = memory_scanner::scan_warframe_memory(&unique_names, &display_names);
            let now = chrono::Utc::now().timestamp();
            let now_str = chrono::DateTime::from_timestamp(now, 0)
                .map(|dt: chrono::DateTime<chrono::Utc>| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| now.to_string());

            let mut changes: Vec<QuantityChange> = Vec::new();

            for item in &result.items_found {
                let old_qty = *known.get(&item.unique_name).unwrap_or(&0);
                let new_qty = item.quantity;
                // Never decrease a quantity based on a non-explicit count (defaulted to 1).
                if !item.explicit_count && new_qty <= old_qty { continue; }
                if new_qty != old_qty {
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
            }


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

    Ok(())
}

#[tauri::command]
fn stop_monitor(state: State<AppState>) {
    state.monitor_active.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn get_monitor_status(state: State<AppState>) -> bool {
    state.monitor_active.load(Ordering::SeqCst)
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
            log_path,
            conn: Mutex::new(conn),
            wfcd_items: Mutex::new(initial_items),
            recipes: Mutex::new(initial_recipes),
            relic_drops: Mutex::new(initial_relic_drops),
            relic_rewards: Mutex::new(initial_relic_rewards),
            current_quantities: Arc::new(Mutex::new(initial_quantities)),
            monitor_active: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::image::Image::from_bytes(
                    include_bytes!("../icons/icon.png")
                ).map_err(|e| e.to_string())?;
                window.set_icon(icon).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_all_items,
            get_current_quantities,
            get_item_list_status,
            fetch_item_list,
            get_change_log,
            clear_cache,
            get_craftable_items,
            get_recipe,
            get_relic_drops,
            get_relic_rewards,
            write_debug_file,
            fetch_wfm_items,
            fetch_wfm_price,
            scan_warframe_credentials,
            scan_warframe_api_urls,
            warframe_login,
            fetch_warframe_inventory,
            start_monitor,
            stop_monitor,
            get_monitor_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
