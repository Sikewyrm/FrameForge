use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone)]
pub struct FoundItem {
    pub unique_name: String,
    pub name: String,
    pub quantity: i64,
    pub explicit_count: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PendingRecipe {
    pub unique_name: String,
    /// Unix timestamp in milliseconds when the craft completes
    pub completion_ms: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanResult {
    pub warframe_running: bool,
    pub items_found: Vec<FoundItem>,
    pub pending_recipes: Vec<PendingRecipe>,
    pub mastery_rank: Option<u32>,
    /// unique_name → rank (0–30). Only populated for owned unique items.
    pub mastery_data: HashMap<String, u32>,
    pub regions_scanned: usize,
    pub error: Option<String>,
    pub log_lines: Vec<String>,
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

fn parse_int(data: &[u8], start: usize) -> Option<i64> {
    let mut n: i64 = 0;
    let mut found = false;
    for &b in data[start..].iter().take(12) {
        if b.is_ascii_digit() {
            n = n * 10 + (b - b'0') as i64;
            found = true;
        } else if found {
            break;
        }
    }
    if found { Some(n) } else { None }
}

fn valid_lotus_path(raw: &[u8]) -> Option<String> {
    if raw.len() < 8 || raw.len() > 511 { return None; }
    if !raw.iter().all(|&b| matches!(b, b'/' | b'_' | b'.' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9')) {
        return None;
    }
    let s = std::str::from_utf8(raw).ok()?;
    if s.starts_with("/Lotus/") { Some(s.to_string()) } else { None }
}

fn digits_end(data: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < data.len() && data[i].is_ascii_digit() { i += 1; }
    i
}

// ─── Scanner 1: Resources ─────────────────────────────────────────────────────
//
// Finds stackable items (resources, relics, blueprints) via:
//   "ItemCount":N,"ItemType":"/Lotus/<path>"
//
// Skips unique-item paths (warframes/weapons) — those have no ItemCount in the
// real inventory JSON and are handled by scanner 2.
// Takes the maximum quantity seen across all regions.

fn scan_inventory_resources(data: &[u8], unique_paths: &std::collections::HashSet<String>) -> Vec<(String, i64)> {
    let count_key  = b"\"ItemCount\":";
    let type_infix = b",\"ItemType\":\"/Lotus/";

    let mut results: HashMap<String, i64> = HashMap::new();
    let mut start = 0usize;

    loop {
        let next = match data[start..].iter().position(|&b| b == b'"') {
            Some(p) => start + p,
            None => break,
        };
        if next + count_key.len() > data.len() { break; }
        if data[next..next + count_key.len()] != *count_key {
            start = next + 1; continue;
        }
        let i = next;

        let num_start = i + count_key.len();
        let qty = match parse_int(data, num_start) {
            Some(n) if n > 0 => n,
            _ => { start = i + count_key.len(); continue; }
        };
        let num_end = digits_end(data, num_start);

        if num_end + type_infix.len() > data.len()
            || data[num_end..num_end + type_infix.len()] != *type_infix
        {
            start = i + count_key.len(); continue;
        }

        // type_infix ends with "/Lotus/" — path starts at the leading '/'
        let path_start = num_end + type_infix.len() - 7;
        if path_start >= data.len() { start = i + count_key.len(); continue; }
        let rest = &data[path_start..];
        if let Some(close) = rest.iter().position(|&b| b == b'"') {
            if let Some(path) = valid_lotus_path(&rest[..close]) {
                // Skip actual unique owned items (warframes/weapons/companions with ItemId)
                // but NOT their blueprints — blueprints have ItemCount and should be tracked.
                // We skip only paths that are in the unique scanner's exact path set.
                if unique_paths.contains(&path) || path.starts_with("/Lotus/Upgrades/") {
                    start = i + count_key.len(); continue;
                }
                let cap: i64 = if path.starts_with("/Lotus/Types/Recipes/") { 9_999 } else { 1_000_000 };
                if qty <= cap {
                    let e = results.entry(path).or_insert(qty);
                    if qty > *e { *e = qty; }
                }
            }
        }
        start = i + count_key.len();
    }

    results.into_iter().collect()
}

// ─── Scanner 2: Unique items (warframes / weapons / companions) ───────────────
//
// Finds owned warframes, weapons, companions and archwings via:
//   "ItemType":"/Lotus/<path>","ItemId":{"$oid":"..."},...,"Configs":[...]
//
// Uses Aho-Corasick for all catalogued paths. Validates:
//   - "ItemId": within ±200 bytes (owned item, not relay/market data)
//   - "Configs": within 2000 bytes after the match (full loadout present)
//
// `ac` must be built once before the per-region loop.

/// Returns (pattern_idx, rank) — rank is Some(N) if "Rank":N found near the item.
fn scan_inventory_unique(data: &[u8], ac: &aho_corasick::AhoCorasick) -> Vec<(usize, Option<u32>)> {
    let _rank_key = b"\"Rank\":";
    let mut hits: Vec<(usize, Option<u32>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for mat in ac.find_iter(data) {
        let idx = mat.pattern().as_usize();
        if !seen.insert(idx) { continue; }

        let start = mat.start();
        let end   = mat.end();

        let has_count_before = start >= 25 && {
            let w = &data[start.saturating_sub(25)..start];
            w.windows(12).any(|s| s == b"\"ItemCount\":")
        };
        if has_count_before { continue; }

        let pre  = start.saturating_sub(200);
        let post = (end + 200).min(data.len());
        if !data[pre..post].windows(9).any(|w| w == b"\"ItemId\":") { continue; }

        let configs_end = (end + 5000).min(data.len());
        if !data[end..configs_end].windows(10).any(|w| w == b"\"Configs\":") { continue; }

        hits.push((idx, None)); // rank filled in separately per-region
    }
    hits
}

// ─── Scanner 3: Pending foundry recipes ──────────────────────────────────────
//
// Warframe stores active crafting jobs in the inventory JSON as:
//   "PendingRecipes":[{"ItemType":"/Lotus/Types/Recipes/...","CompletionDate":{"$date":N},...}]
//
// "CompletionDate":{"$date":N} uses a Unix timestamp in milliseconds.
// Returns one PendingRecipe per active craft (may include long-running builds).

/// Diagnostic: find "CompletionDate" in any format and return a snippet of context.
#[allow(dead_code)]
pub fn scan_completion_date_context(data: &[u8]) -> Vec<String> {
    let key = b"\"CompletionDate\"";
    let mut results = Vec::new();
    let mut start = 0usize;
    loop {
        let next = match data[start..].iter().position(|&b| b == b'"') {
            Some(p) => start + p,
            None => break,
        };
        if next + key.len() > data.len() { break; }
        if data[next..next + key.len()] != *key {
            start = next + 1; continue;
        }
        // Capture 120 bytes of context starting 40 bytes before the key
        let ctx_start = next.saturating_sub(40);
        let ctx_end   = (next + 120).min(data.len());
        let ctx = &data[ctx_start..ctx_end];
        // Only include printable ASCII so the log is readable
        let s: String = ctx.iter()
            .map(|&b| if b >= 0x20 && b < 0x7f { b as char } else { '·' })
            .collect();
        results.push(s);
        start = next + key.len();
        if results.len() >= 3 { break; } // cap at 3 samples
    }
    results
}

fn scan_pending_recipes(data: &[u8]) -> Vec<PendingRecipe> {
    // Format in memory (unescaped JSON):
    //   "ItemType":"/Lotus/...","CompletionDate":{"$date":{"$numberLong":"1777056987000"}}
    //
    // The key was correct before; the bug was timestamp parsing expecting a bare number
    // but finding {"$numberLong":"..."} instead.
    let completion_key = b"\"CompletionDate\":{\"$date\":{\"$numberLong\":\"";
    let type_key       = b"\"ItemType\":\"";

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut results: Vec<PendingRecipe> = Vec::new();
    let mut search = 0usize;

    loop {
        let next = match data[search..].iter().position(|&b| b == b'"') {
            Some(p) => search + p,
            None => break,
        };
        if next + completion_key.len() > data.len() { break; }
        if data[next..next + completion_key.len()] != *completion_key {
            search = next + 1; continue;
        }
        let ts_start = next + completion_key.len();
        search = ts_start;

        // Timestamp digits end at the closing "
        let completion_ms = match parse_int(data, ts_start) {
            Some(n) if n > 1_000_000_000_000 => n,
            _ => continue,
        };

        // Only include crafts not yet finished
        if completion_ms <= now_ms { continue; }

        // Look backward up to 512 bytes for "ItemType":"/Lotus/..."
        let back_start = next.saturating_sub(512);
        let back_slice = &data[back_start..next];
        if let Some(rel) = back_slice.windows(type_key.len()).rposition(|w| w == *type_key) {
            let path_start = back_start + rel + type_key.len();
            if path_start < next {
                let path_slice = &data[path_start..next];
                if let Some(close) = path_slice.iter().position(|&b| b == b'"') {
                    if let Some(path) = valid_lotus_path(&path_slice[..close]) {
                        if !results.iter().any(|r| r.unique_name == path) {
                            results.push(PendingRecipe { unique_name: path, completion_ms });
                        }
                    }
                }
            }
        }
    }

    results
}

// ─── Auth credentials scan ───────────────────────────────────────────────────
//
// When Warframe is running and logged in, the game stores the session credentials
// in memory as URL-encoded strings: accountId=<id>&nonce=<nonce>
// We scan for these to authenticate with the Warframe companion API.

pub fn scan_auth_credentials(data: &[u8]) -> Option<(String, String)> {
    // The Warframe game receives a login response JSON from DE's servers containing:
    //   {"id":"<24-char-hex-accountId>","Nonce":<large-integer>,...}
    // We search for this pattern. The Nonce is typically 9-13 digits.
    // We also try URL-encoded form: accountId=<id>&nonce=<nonce>
    //
    // Key insight from devtools: accountId=594144e63ade7f2f2091c48e (24ch), nonce len=9
    // The 24-char hex accountId is a MongoDB ObjectId — correct format.
    // The 9-digit nonce IS valid — it's a server-issued integer session token.

    // Search for "id":"<24hexchars>" near "Nonce":<digits>
    let id_key = b"\"id\":\"";
    let nonce_key = b"\"Nonce\":";
    let mut search = 0usize;
    while search + id_key.len() < data.len() {
        let next = match data[search..].iter().position(|&b| b == b'"') {
            Some(p) => search + p, None => break,
        };
        if next + id_key.len() > data.len() { break; }
        if data[next..next + id_key.len()] != *id_key { search = next + 1; continue; }

        let id_start = next + id_key.len();
        // accountId is exactly 24 lowercase hex chars
        let id_slice = &data[id_start..id_start.saturating_add(26).min(data.len())];
        let close = id_slice.iter().position(|&b| b == b'"').unwrap_or(0);
        if close != 24 { search = next + 1; continue; }
        let id_bytes = &id_slice[..24];
        if !id_bytes.iter().all(|&b| b.is_ascii_hexdigit()) { search = next + 1; continue; }
        let account_id = std::str::from_utf8(id_bytes).unwrap_or("").to_string();

        // Look for Nonce within 1024 bytes
        let nonce_search_end = (id_start + 1024).min(data.len());
        if let Some(rel) = data[id_start..nonce_search_end].windows(nonce_key.len()).position(|w| w == *nonce_key) {
            let ns = id_start + rel + nonce_key.len();
            let ne = digits_end(data, ns);
            if ne > ns && ne - ns >= 5 {
                if let Ok(nonce) = std::str::from_utf8(&data[ns..ne]) {
                    return Some((account_id, nonce.to_string()));
                }
            }
        }
        search = next + 1;
    }

    // URL-encoded: accountId=<24hexchars>&nonce=<10digits>&ct=STM
    let ak = b"accountId=";
    let nk = b"nonce=";
    let mut search = 0usize;
    while search + ak.len() < data.len() {
        let next = match data[search..].iter().position(|&b| b == b'a') {
            Some(p) => search + p, None => break,
        };
        if next + ak.len() > data.len() { break; }
        if data[next..next + ak.len()] != *ak { search = next + 1; continue; }
        let id_start = next + ak.len();
        let id_end = data[id_start..].iter().position(|&b| !b.is_ascii_hexdigit()).map(|p| id_start + p).unwrap_or(data.len());
        if id_end - id_start != 24 { search = next + 1; continue; }
        let account_id = std::str::from_utf8(&data[id_start..id_end]).unwrap_or("").to_string();
        // Nonce must follow within 32 bytes and be 8+ digits
        let nonce_search_end = (id_end + 32).min(data.len());
        if let Some(rel) = data[id_end..nonce_search_end].windows(nk.len()).position(|w| w == *nk) {
            let ns = id_end + rel + nk.len();
            let ne = digits_end(data, ns);
            if ne > ns && ne - ns >= 8 {
                if let Ok(nonce) = std::str::from_utf8(&data[ns..ne]) {
                    return Some((account_id, nonce.to_string()));
                }
            }
        }
        search = next + 1;
    }
    None
}

/// Also extract steamId from memory (found near accountId/nonce in URL params).
pub fn scan_steam_id(data: &[u8]) -> Option<String> {
    let key = b"steamId=";
    let mut search = 0usize;
    loop {
        let next = match data[search..].iter().position(|&b| b == b's') {
            Some(p) => search + p, None => break,
        };
        if next + key.len() > data.len() { break; }
        if data[next..next + key.len()] != *key { search = next + 1; continue; }
        let id_start = next + key.len();
        let id_end = data[id_start..].iter().position(|&b| !b.is_ascii_digit()).map(|p| id_start + p).unwrap_or(data.len());
        if id_end - id_start >= 15 && id_end - id_start <= 20 {
            if let Ok(sid) = std::str::from_utf8(&data[id_start..id_end]) {
                return Some(sid.to_string());
            }
        }
        search = next + 1;
    }
    None
}

// ─── Mastery rank scan ────────────────────────────────────────────────────────
//
// Warframe stores the player's mastery rank in the inventory JSON as:
//   "PlayerLevel":N
// Returns the first plausible value found (0–30+).

fn scan_mastery_rank(data: &[u8]) -> Option<u32> {
    let key = b"\"PlayerLevel\":";
    let mut start = 0usize;
    loop {
        let next = match data[start..].iter().position(|&b| b == b'"') {
            Some(p) => start + p,
            None => break,
        };
        if next + key.len() > data.len() { break; }
        if data[next..next + key.len()] != *key {
            start = next + 1; continue;
        }
        let num_start = next + key.len();
        if let Some(rank) = parse_int(data, num_start) {
            if rank >= 0 && rank <= 60 {
                return Some(rank as u32);
            }
        }
        start = next + key.len();
    }
    None
}

// ─── Main scan entry point ────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn scan_warframe_memory(unique_names: &[String], display_names: &[String]) -> ScanResult {
    use std::ffi::c_void;
    use std::mem;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            Diagnostics::Debug::ReadProcessMemory,
            Memory::{VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS},
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
        },
    };

    if unique_names.is_empty() {
        return ScanResult {
            warframe_running: false, items_found: vec![], pending_recipes: vec![], mastery_rank: None, mastery_data: HashMap::new(), regions_scanned: 0,
            error: Some("No item paths loaded. Click 'Refresh item list' first.".to_string()),
            log_lines: vec![],
        };
    }

    let display_map: HashMap<String, String> = unique_names.iter()
        .zip(display_names.iter())
        .map(|(u, d)| (u.clone(), d.clone()))
        .collect();

    // Unique-item paths: owned via ItemId/Configs, never have ItemCount in inventory
    // Unique items: owned via ItemId+Configs, never have ItemCount in inventory.
    // NOTE: /Lotus/Types/Recipes/ is intentionally excluded — recipe blueprints
    // are stackable resources with ItemCount, handled by scanner 1, not here.
    let unique_item_paths: Vec<String> = unique_names.iter()
        .filter(|p| {
            p.starts_with("/Lotus/Powersuits/")
                || p.starts_with("/Lotus/Weapons/")
                || p.starts_with("/Lotus/Archwing/")
                || p.starts_with("/Lotus/Types/Sentinels/SentinelPowersuits/")
                || p.starts_with("/Lotus/Types/Sentinels/SentinelWeapons/")
                || p.starts_with("/Lotus/Types/Friendly/")
                || p.starts_with("/Lotus/Types/Game/CatbrowPet/")
                || p.starts_with("/Lotus/Types/Game/KubrowPet/")
        })
        .cloned()
        .collect();

    let unique_item_idx: Vec<usize> = unique_item_paths.iter()
        .map(|p| unique_names.iter().position(|u| u == p).unwrap())
        .collect();

    // Set of paths handled by the unique scanner — resource scanner skips exactly these
    let unique_path_set: std::collections::HashSet<String> =
        unique_item_paths.iter().cloned().collect();

    // Build Aho-Corasick once — never inside the per-region loop
    let unique_ac = {
        use aho_corasick::AhoCorasick;
        let patterns: Vec<Vec<u8>> = unique_item_paths.iter().map(|p| {
            let mut pat = b"\"ItemType\":\"".to_vec();
            pat.extend_from_slice(p.as_bytes());
            pat.push(b'"');
            pat
        }).collect();
        let refs: Vec<&[u8]> = patterns.iter().map(|p| p.as_slice()).collect();
        match AhoCorasick::new(&refs) {
            Ok(a) => a,
            Err(e) => return ScanResult {
                warframe_running: false, items_found: vec![], pending_recipes: vec![], mastery_rank: None, mastery_data: HashMap::new(), regions_scanned: 0,
                error: Some(format!("AC build error: {}", e)),
                log_lines: vec![],
            },
        }
    };

    let pid = match find_warframe_pid() {
        Some(p) => p,
        None => return ScanResult {
            warframe_running: false, items_found: vec![], pending_recipes: vec![], mastery_rank: None, mastery_data: HashMap::new(), regions_scanned: 0,
            error: Some("Warframe is not running. Launch the game first.".to_string()),
            log_lines: vec![],
        },
    };

    let mut resources:       HashMap<String, i64>          = HashMap::new();
    let mut unique:          HashMap<usize, usize>         = HashMap::new();
    // mastery_data: catalog_idx → max rank seen across all regions
    let mut mastery_data:    HashMap<usize, u32>           = HashMap::new();
    let mut pending_recipes: Vec<PendingRecipe>            = Vec::new();
    let mut mastery_rank:    Option<u32>                   = None;
    let mut regions_scanned = 0usize;
    let mut log_lines: Vec<String> = Vec::new();

    unsafe {
        let process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
        if process == 0 {
            return ScanResult {
                warframe_running: true, items_found: vec![], pending_recipes: vec![], mastery_rank: None, mastery_data: HashMap::new(), regions_scanned: 0,
                error: Some("Cannot open Warframe process. Run as Administrator.".to_string()),
                log_lines: vec![],
            };
        }

        let mut address: usize = 0x10000;
        let mbi_size = mem::size_of::<MEMORY_BASIC_INFORMATION>();
        let start_time = std::time::Instant::now();
        let mut total_read: usize = 0;

        loop {
            if start_time.elapsed().as_secs() > 90 || total_read > 2_000_000_000 { break; }

            let mut mbi: MEMORY_BASIC_INFORMATION = mem::zeroed();
            if VirtualQueryEx(process, address as *const c_void, &mut mbi, mbi_size) == 0 { break; }

            let region_end = (mbi.BaseAddress as usize).saturating_add(mbi.RegionSize);
            if region_end <= address { break; }
            address = region_end;

            if mbi.State != MEM_COMMIT { continue; }
            let p = mbi.Protect;
            if p & PAGE_NOACCESS != 0 || p & PAGE_GUARD != 0 { continue; }
            if p == 0x10 || p == 0x20 { continue; }
            if mbi.RegionSize < 4096 || mbi.RegionSize > 128 * 1024 * 1024 { continue; }

            let mut buffer = vec![0u8; mbi.RegionSize];
            let mut bytes_read: usize = 0;
            let ok = ReadProcessMemory(
                process, mbi.BaseAddress as *const c_void,
                buffer.as_mut_ptr() as *mut c_void, mbi.RegionSize, &mut bytes_read,
            );
            if ok == 0 || bytes_read <= 4 { continue; }

            let data = &buffer[..bytes_read];
            regions_scanned += 1;
            total_read += bytes_read;
            let base = mbi.BaseAddress as usize;

            // ── Scanner 1: Resources ──────────────────────────────────────────
            // Only run on small regions — inventory blobs are always ≤ 512 KB
            if bytes_read <= 512 * 1024 {
                let res_pairs = scan_inventory_resources(data, &unique_path_set);
                if !res_pairs.is_empty() {
                    let preview: String = res_pairs.iter().take(5)
                        .map(|(p, q)| format!("{}={}", p.split('/').last().unwrap_or("?"), q))
                        .collect::<Vec<_>>().join(", ");
                    log_lines.push(format!(
                        "  [resources] 0x{:010x} count={:>4}  {}{}",
                        base, res_pairs.len(), preview,
                        if res_pairs.len() > 5 { format!(" …+{}", res_pairs.len()-5) } else { String::new() }
                    ));
                    for (path, qty) in res_pairs {
                        // Take max across all regions in this scan — the real
                        // inventory stack is always the largest value seen.
                        let e = resources.entry(path).or_insert(qty);
                        if qty > *e { *e = qty; }
                    }
                }
            }

            // ── Mastery rank — only scan small regions ────────────────────────
            if mastery_rank.is_none() && bytes_read <= 512 * 1024 {
                mastery_rank = scan_mastery_rank(data);
            }

            // ── Scanner 3: Pending recipes (no size limit)
            {
                // Diagnostic: log any region containing "$numberLong" to verify data presence
                if data.windows(12).any(|w| w == b"$numberLong\"") {
                    let hits = scan_pending_recipes(data);
                    log_lines.push(format!(
                        "  [numlong]   0x{:010x} size={} crafting_hits={}",
                        base, bytes_read, hits.len()
                    ));
                    for h in hits { pending_recipes.push(h); }
                }
            }

            // ── Scanner 2: Unique items ───────────────────────────────────────
            let unique_hits = scan_inventory_unique(data, &unique_ac);
            if !unique_hits.is_empty() {
                let preview: String = unique_hits.iter().take(4)
                    .map(|(li, _)| unique_item_paths[*li].split('/').last().unwrap_or("?"))
                    .collect::<Vec<_>>().join(", ");
                log_lines.push(format!(
                    "  [unique]    0x{:010x} count={:>4}  {}{}",
                    base, unique_hits.len(), preview,
                    if unique_hits.len() > 4 { format!(" …+{}", unique_hits.len()-4) } else { String::new() }
                ));
                let n = unique_hits.len();
                for &(local_idx, rank) in &unique_hits {
                    let catalog_idx = unique_item_idx[local_idx];
                    let entry = unique.entry(catalog_idx).or_insert(n);
                    if n > *entry { *entry = n; }
                    if let Some(r) = rank {
                        let mr = mastery_data.entry(catalog_idx).or_insert(0);
                        if r > *mr { *mr = r; }
                    }
                }
            }
        }

        CloseHandle(process);
    }

    // ── Assemble results ──────────────────────────────────────────────────────

    let mut items_found: Vec<FoundItem> = Vec::new();

    for (path, qty) in &resources {
        if let Some(name) = display_map.get(path) {
            items_found.push(FoundItem {
                unique_name: path.clone(),
                name: name.clone(),
                quantity: *qty,
                explicit_count: true,
            });
        }
    }

    // Build mastery_data map: unique_name → rank
    let mastery_data_out: HashMap<String, u32> = mastery_data.iter()
        .map(|(idx, rank)| (unique_names[*idx].clone(), *rank))
        .collect();

    for (catalog_idx, _n) in &unique {
        let path = &unique_names[*catalog_idx];
        if resources.contains_key(path) { continue; }
        if let Some(name) = display_map.get(path) {
            items_found.push(FoundItem {
                unique_name: path.clone(),
                name: name.clone(),
                quantity: 1,
                explicit_count: false,
            });
        }
    }

    items_found.sort_by(|a, b| a.name.cmp(&b.name));

    log_lines.push(format!(
        "  TOTALS: resources={} unique={} total={}",
        resources.len(), unique.len(), items_found.len()
    ));

    // Deduplicate pending recipes by unique_name (keep latest completion time)
    pending_recipes.sort_by_key(|r| r.completion_ms);
    pending_recipes.dedup_by(|a, b| {
        if a.unique_name == b.unique_name { b.completion_ms = b.completion_ms.max(a.completion_ms); true }
        else { false }
    });

    ScanResult { warframe_running: true, items_found, pending_recipes, mastery_rank, mastery_data: mastery_data_out, regions_scanned, error: None, log_lines }
}

#[cfg(target_os = "windows")]
pub fn find_warframe_pid_pub() -> Option<u32> { find_warframe_pid() }

#[cfg(not(target_os = "windows"))]
pub fn find_warframe_pid_pub() -> Option<u32> { None }

#[cfg(target_os = "windows")]
fn find_warframe_pid() -> Option<u32> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{EnumProcesses, K32GetModuleBaseNameA},
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
        },
    };
    unsafe {
        let mut pids = vec![0u32; 2048];
        let mut needed = 0u32;
        if EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut needed) == 0 {
            return None;
        }
        let count = needed as usize / 4;
        for &pid in &pids[..count] {
            if pid == 0 { continue; }
            let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if handle == 0 { continue; }
            let mut name_buf = [0u8; 260];
            let len = K32GetModuleBaseNameA(handle, 0, name_buf.as_mut_ptr(), name_buf.len() as u32);
            CloseHandle(handle);
            if len > 0 {
                let name = std::str::from_utf8(&name_buf[..len as usize]).unwrap_or("").to_lowercase();
                if name.starts_with("warframe") && !name.contains("launcher") {
                    return Some(pid);
                }
            }
        }
        None
    }
}

#[cfg(not(target_os = "windows"))]
pub fn scan_warframe_memory(_unique_names: &[String], _display_names: &[String]) -> ScanResult {
    ScanResult {
        warframe_running: false, items_found: vec![], pending_recipes: vec![], mastery_rank: None, mastery_data: HashMap::new(), regions_scanned: 0,
        error: Some("Memory scanning is only supported on Windows.".to_string()),
        log_lines: vec![],
    }
}
