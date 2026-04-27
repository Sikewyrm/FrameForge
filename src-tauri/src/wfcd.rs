use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

#[derive(Clone, Debug)]
pub struct WfcdItem {
    pub name: String,
    pub unique_name: String,
    pub category: String,
    pub image_name: Option<String>,
    /// Some(true) = vaulted, Some(false) = unvaulted, None = no vault status (non-prime)
    pub vaulted: Option<bool>,
    pub ducats: Option<u32>,
    pub mastery_req: Option<u32>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RecipeComponent {
    pub unique_name: String,
    pub name: String,
    pub count: u32,
    /// How many of this item you receive when crafted (usually 1, but some recipes produce multiple)
    #[serde(default = "default_one")]
    pub result_count: u32,
    pub components: Vec<RecipeComponent>,
}

fn default_one() -> u32 { 1 }

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RelicReward {
    pub unique_name: String,
    pub name: String,
    /// "Bronze" = Common, "Silver" = Uncommon, "Gold" = Rare
    pub rarity: String,
    pub image_name: Option<String>,
}

pub struct FetchResult {
    pub items: Vec<WfcdItem>,
    /// parent unique_name → list of components needed to craft it
    pub recipes: HashMap<String, Vec<RecipeComponent>>,
    /// component unique_name → list of relic unique_names that can drop it
    pub relic_drops: HashMap<String, Vec<String>>,
    /// relic unique_name → 6 rewards sorted Bronze×3, Silver×2, Gold×1
    pub relic_rewards: HashMap<String, Vec<RelicReward>>,
}

pub fn fetch_items() -> Result<FetchResult, String> {
    fetch_from_wfcd()
}

fn strip_tags(s: &str) -> &str {
    if s.starts_with('<') {
        s.find('>').map(|i| s[i + 1..].trim()).unwrap_or(s.trim())
    } else {
        s.trim()
    }
}

/// Fetch the LZMA-compressed Warframe public export index and return a map of
/// endpoint filename → full URL (e.g. "ExportRecipes_en.json!HASH" → full URL).
#[allow(dead_code)]
fn fetch_export_index() -> Result<Vec<String>, String> {
    let index_url = "https://origin.warframe.com/PublicExport/index_en.txt.lzma";
    let resp = ureq::get(index_url)
        .set("User-Agent", "WarframeCompanion/0.1")
        .call()
        .map_err(|e| format!("index fetch: {}", e))?;

    let mut compressed = Vec::new();
    resp.into_reader()
        .read_to_end(&mut compressed)
        .map_err(|e| format!("index read: {}", e))?;

    // Decompress LZMA1 "alone" format (13-byte header + raw stream)
    let mut decompressed = Vec::new();
    lzma_rs::lzma_decompress(&mut Cursor::new(&compressed), &mut decompressed)
        .map_err(|e| format!("lzma decompress: {}", e))?;

    let text = String::from_utf8_lossy(&decompressed);
    Ok(text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect())
}

/// One entry from the recipe data: the blueprint consumed + raw ingredients + result count.
struct ExportRecipe {
    blueprint_unique: String,
    ingredients: Vec<(String, u32)>,
    result_count: u32,
}

/// Fetch ExportRecipes from warframe-public-export-plus (stable URL, pre-processed, always current).
/// Returns a map from resultType (= what gets crafted) → ExportRecipe.
fn fetch_export_recipes() -> Result<HashMap<String, ExportRecipe>, String> {
    let url = "https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/HEAD/ExportRecipes.json";

    let json: serde_json::Value = ureq::get(url)
        .set("User-Agent", "FrameForge/0.1")
        .call()
        .map_err(|e| format!("ExportRecipes fetch: {}", e))?
        .into_json()
        .map_err(|e| format!("ExportRecipes parse: {}", e))?;

    let mut map: HashMap<String, ExportRecipe> = HashMap::new();

    // warframe-public-export-plus format:
    //   { "/Lotus/Types/Recipes/...Blueprint": { "resultType": "...", "num": 1, "ingredients": [...] } }
    if let Some(obj) = json.as_object() {
        for (blueprint_unique, entry) in obj {
            let result_type = match entry["resultType"].as_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let result_count = entry["num"].as_u64().unwrap_or(1) as u32;
            let ingredients: Vec<(String, u32)> = entry["ingredients"]
                .as_array()
                .map(|arr| {
                    arr.iter().filter_map(|ing| {
                        let item_type = ing["ItemType"].as_str()?.to_string();
                        let count = ing["ItemCount"].as_u64().unwrap_or(1) as u32;
                        Some((item_type, count))
                    }).collect()
                })
                .unwrap_or_default();
            if !ingredients.is_empty() {
                map.insert(result_type, ExportRecipe {
                    blueprint_unique: blueprint_unique.clone(),
                    ingredients,
                    result_count,
                });
            }
        }
    }
    Ok(map)
}

/// Build a recipe node. Prefers DE's ExportRecipes for sub-ingredients;
/// falls back to WFCD nested `components` for items not in ExportRecipes.
fn build_recipe_node(
    unique_name: String,
    name: String,
    count: u32,
    wfcd_json: Option<&serde_json::Value>,
    display_names: &HashMap<String, String>,
    export_recipes: &HashMap<String, ExportRecipe>,
    depth: u32,
) -> RecipeComponent {
    if depth > 6 {
        return RecipeComponent { unique_name, name, count, result_count: 1, components: vec![] };
    }

    let (result_count, components) = if let Some(recipe) = export_recipes.get(&unique_name) {
        let blueprint_name = display_names
            .get(&recipe.blueprint_unique)
            .cloned()
            .unwrap_or_else(|| format!("{} Blueprint", name));

        let mut components = vec![RecipeComponent {
            unique_name: recipe.blueprint_unique.clone(),
            name: blueprint_name,
            count: 1,
            result_count: 1,
            components: vec![],
        }];

        for (item_type, item_count) in &recipe.ingredients {
            let item_name = display_names
                .get(item_type)
                .cloned()
                .unwrap_or_else(|| item_type.split('/').last().unwrap_or("Unknown").to_string());
            components.push(build_recipe_node(
                item_type.clone(), item_name, *item_count,
                None, display_names, export_recipes, depth + 1,
            ));
        }
        (recipe.result_count, components)
    } else if let Some(json) = wfcd_json {
        let comps = json.get("components")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|c| {
                let cu = c["uniqueName"].as_str()?.trim().to_string();
                let raw = c["name"].as_str().unwrap_or("Unknown");
                let cn = display_names.get(&cu).cloned()
                    .unwrap_or_else(|| strip_tags(raw).to_string());
                let cc = c["itemCount"].as_u64().unwrap_or(1) as u32;
                Some(build_recipe_node(cu, cn, cc, Some(c), display_names, export_recipes, depth + 1))
            }).collect())
            .unwrap_or_default();
        (1, comps)
    } else {
        (1, vec![])
    };

    RecipeComponent { unique_name, name, count, result_count, components }
}

fn fetch_from_wfcd() -> Result<FetchResult, String> {
    let categories: &[(&str, &str)] = &[
        ("Misc",           "Resources"),
        ("Resources",      "Resources"),
        ("Mods",           "Mods"),
        ("Relics",         "Relics"),
        ("Warframes",      "Warframes"),
        ("Primary",        "Primary"),
        ("Secondary",      "Secondary"),
        ("Melee",          "Melee"),
        ("Arcanes",        "Arcanes"),
        ("Sentinels",      "Companions"),
        ("SentinelWeapons","Companions"),
        ("Pets",           "Companions"),
        ("Archwing",       "Archwing"),
        ("Arch-Gun",       "Archwing"),
        ("Arch-Melee",     "Archwing"),
        ("Gear",           "Misc"),
        ("Fish",           "Misc"),
    ];

    let mut items: Vec<WfcdItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut errors: Vec<String> = Vec::new();
    let mut raw_craftable: Vec<(String, serde_json::Value)> = Vec::new();
    // Relics stored separately: (relic_unique_name, rewards_array)
    let mut raw_relics: Vec<(String, serde_json::Value)> = Vec::new();

    for (file, category) in categories {
        let url = format!(
            "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/{}.json",
            file
        );
        match ureq::get(&url).set("User-Agent", "WarframeCompanion/0.1").call() {
            Ok(resp) => {
                let json: serde_json::Value = match resp.into_json() {
                    Ok(j) => j,
                    Err(e) => { errors.push(format!("{}: {}", file, e)); continue; }
                };
                if let Some(arr) = json.as_array() {
                    for item in arr {
                        let name = match item.get("name").and_then(|v| v.as_str()) {
                            Some(n) => {
                                let s = strip_tags(n);
                                if s.len() < 2 { continue; }
                                s.to_string()
                            }
                            _ => continue,
                        };
                        let unique_name = match item.get("uniqueName").and_then(|v| v.as_str()) {
                            Some(u) => u.trim().to_string(),
                            None => continue,
                        };

                        let image_name = item.get("imageName")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let vaulted = item.get("vaulted").and_then(|v| v.as_bool());

                        let ducats = item.get("ducats").and_then(|v| v.as_u64()).map(|n| n as u32);
                        let mastery_req = item.get("masteryReq").and_then(|v| v.as_u64()).map(|n| n as u32);

                        if seen.insert(unique_name.clone()) {
                            items.push(WfcdItem {
                                name: name.clone(),
                                unique_name: unique_name.clone(),
                                category: category.to_string(),
                                image_name: image_name.clone(),
                                vaulted,
                                ducats,
                                mastery_req,
                            });
                        }

                        if let Some(comps) = item.get("components").and_then(|v| v.as_array()) {
                            if !comps.is_empty() {
                                raw_craftable.push((unique_name.clone(), item.clone()));
                            }
                        }

                        // Collect relic reward data.
                        // WFCD uses either a flat array or an object keyed by refinement tier.
                        if let Some(rewards_val) = item.get("rewards") {
                            let flat: Vec<serde_json::Value> = if let Some(arr) = rewards_val.as_array() {
                                arr.clone()
                            } else if let Some(obj) = rewards_val.as_object() {
                                // {"Intact":[...], "Exceptional":[...], "Flawless":[...], "Radiant":[...]}
                                // Use Intact tier only (all tiers drop the same items)
                                obj.get("Intact")
                                    .or_else(|| obj.values().next())
                                    .and_then(|v| v.as_array())
                                    .cloned()
                                    .unwrap_or_default()
                            } else {
                                vec![]
                            };
                            if !flat.is_empty() {
                                raw_relics.push((unique_name.clone(), serde_json::Value::Array(flat)));
                            }
                        }

                        // Add component parts to catalog
                        if let Some(comps) = item.get("components").and_then(|v| v.as_array()) {
                            for comp in comps {
                                let cname = match comp.get("name").and_then(|v| v.as_str()) {
                                    Some(n) => n.trim(),
                                    None => continue,
                                };
                                let cunique = match comp.get("uniqueName").and_then(|v| v.as_str()) {
                                    Some(u) => u.trim().to_string(),
                                    None => continue,
                                };
                                let is_part = cunique.starts_with("/Lotus/Types/Recipes/")
                                    || cunique.starts_with("/Lotus/Powersuits/")
                                    || cunique.starts_with("/Lotus/Weapons/")
                                    || cunique.starts_with("/Lotus/Companions/")
                                    || cunique.starts_with("/Lotus/Sentinels/")
                                    || cunique.starts_with("/Lotus/Archwing/")
                                    || cname.contains("Blueprint");
                                if !is_part { continue; }

                                let comp_cat = if cunique.starts_with("/Lotus/Types/Recipes/") {
                                    "Blueprints"
                                } else {
                                    category
                                };
                                let comp_image = comp.get("imageName")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| image_name.clone());

                                if seen.insert(cunique.clone()) {
                                    let comp_name = if cunique.starts_with("/Lotus/Weapons/")
                                        || cunique.starts_with("/Lotus/Powersuits/")
                                        || cunique.starts_with("/Lotus/Companions/")
                                        || cunique.starts_with("/Lotus/Sentinels/")
                                        || cunique.starts_with("/Lotus/Archwing/")
                                    {
                                        cname.to_string()
                                    } else {
                                        format!("{} {}", name, cname)
                                    };
                                    items.push(WfcdItem {
                                        name: comp_name,
                                        unique_name: cunique,
                                        category: comp_cat.to_string(),
                                        image_name: comp_image,
                                        vaulted: None,
                                        ducats: comp.get("ducats").and_then(|v| v.as_u64()).map(|n| n as u32),
                                        mastery_req: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => errors.push(format!("{}: {}", file, e)),
        }
    }

    if items.is_empty() {
        return Err(format!("All sources failed: {}", errors.join("; ")));
    }

    let display_names: HashMap<String, String> = items
        .iter()
        .map(|i| (i.unique_name.clone(), i.name.clone()))
        .collect();

    // Fetch DE's authoritative recipe data (best-effort; fall back to WFCD-only if it fails)
    let export_recipes = fetch_export_recipes().unwrap_or_default();

    // Build recipe trees
    let mut recipes: HashMap<String, Vec<RecipeComponent>> = HashMap::new();
    for (parent_unique, item_json) in &raw_craftable {
        if let Some(comps) = item_json.get("components").and_then(|v| v.as_array()) {
            let tree: Vec<RecipeComponent> = comps.iter().filter_map(|c| {
                let cu = c["uniqueName"].as_str()?.trim().to_string();
                let raw = c["name"].as_str().unwrap_or("Unknown");
                let cn = display_names.get(&cu).cloned()
                    .unwrap_or_else(|| strip_tags(raw).to_string());
                let cc = c["itemCount"].as_u64().unwrap_or(1) as u32;
                Some(build_recipe_node(
                    cu, cn, cc, Some(c), &display_names, &export_recipes, 0,
                ))
            }).collect();
            if !tree.is_empty() {
                recipes.insert(parent_unique.clone(), tree);
            }
        }
    }

    // Build relic drop map: component unique_name → [relic unique_names that drop it]
    // WFCD relic rewards list items by "itemName" (display name).
    // We match against our catalog names to get unique_names.
    let name_to_unique: HashMap<String, String> = items.iter()
        .map(|i| (i.name.clone(), i.unique_name.clone()))
        .collect();

    let mut relic_drops: HashMap<String, Vec<String>> = HashMap::new();
    for (relic_unique, rewards_val) in &raw_relics {
        if let Some(rewards) = rewards_val.as_array() {
            for reward in rewards {
                // WFCD structure: reward.item.name  (not reward.itemName)
                let item_name = reward
                    .get("item").and_then(|v| v.get("name")).and_then(|v| v.as_str())
                    .or_else(|| reward.get("itemName").and_then(|v| v.as_str()));
                if let Some(name) = item_name {
                    if let Some(comp_unique) = name_to_unique.get(name) {
                        relic_drops.entry(comp_unique.clone()).or_default().push(relic_unique.clone());
                    }
                }
            }
        }
    }

    // Image lookup maps for relic rewards
    let image_by_unique: HashMap<String, String> = items.iter()
        .filter_map(|i| i.image_name.as_ref().map(|img| (i.unique_name.clone(), img.clone())))
        .collect();
    // Name-based lookup (lowercase) for when unique_names differ between data sources
    let image_by_name: HashMap<String, String> = items.iter()
        .filter_map(|i| i.image_name.as_ref().map(|img| (i.name.to_lowercase(), img.clone())))
        .collect();

    // Build relic rewards map: relic unique_name → rewards sorted Bronze/Silver/Gold
    let mut relic_rewards: HashMap<String, Vec<RelicReward>> = HashMap::new();
    for (relic_unique, rewards_val) in &raw_relics {
        if let Some(rewards) = rewards_val.as_array() {
            let mut list: Vec<RelicReward> = rewards.iter().filter_map(|r| {
                let item_unique = r.get("item")
                    .and_then(|v| v.get("uniqueName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("").trim().to_string();
                if item_unique.is_empty() { return None; }
                let item_name = r.get("item").and_then(|v| v.get("name")).and_then(|v| v.as_str())
                    .or_else(|| r.get("itemName").and_then(|v| v.as_str()))
                    .unwrap_or("Unknown").to_string();
                let rarity_raw = r.get("rarity").and_then(|v| v.as_str()).unwrap_or("common").to_lowercase();
                let rarity = match rarity_raw.as_str() {
                    "uncommon" => "Silver",
                    "rare"     => "Gold",
                    _          => "Bronze",
                }.to_string();
                let image_name = r.get("item")
                    .and_then(|v| v.get("imageName"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    // Try unique_name lookup in catalog
                    .or_else(|| image_by_unique.get(&item_unique).cloned())
                    // Try name lookup (lowercase) — handles path mismatches between data sources
                    .or_else(|| image_by_name.get(&item_name.to_lowercase()).cloned())
                    // Try name without "Blueprint" suffix
                    .or_else(|| {
                        let no_bp = item_name.to_lowercase().replace(" blueprint", "");
                        image_by_name.get(&no_bp).cloned()
                    })
                    // For prime parts: fall back to parent prime item's image
                    // e.g. "Yareli Prime Blueprint" → look up "Yareli Prime"
                    .or_else(|| {
                        if let Some(idx) = item_name.find(" Prime") {
                            let prime_name = item_name[..idx + " Prime".len()].to_lowercase();
                            image_by_name.get(&prime_name).cloned()
                        } else {
                            None
                        }
                    });
                Some(RelicReward { unique_name: item_unique, name: item_name, rarity, image_name })
            }).collect();
            list.sort_by_key(|r| match r.rarity.as_str() { "Silver" => 1u8, "Gold" => 2, _ => 0 });
            if !list.is_empty() {
                relic_rewards.insert(relic_unique.clone(), list);
            }
        }
    }

    Ok(FetchResult { items, recipes, relic_drops, relic_rewards })
}

pub fn fallback_items() -> Vec<WfcdItem> {
    vec![
        ("/Lotus/Types/Items/MiscItems/OrokinCell",    "Orokin Cell",    "Resources"),
        ("/Lotus/Types/Items/MiscItems/Neurodes",      "Neurodes",       "Resources"),
        ("/Lotus/Types/Items/MiscItems/NeuralSensors", "Neural Sensors", "Resources"),
        ("/Lotus/Types/Items/MiscItems/Morphics",      "Morphics",       "Resources"),
        ("/Lotus/Types/Items/MiscItems/Tellurium",     "Tellurium",      "Resources"),
        ("/Lotus/Types/Items/MiscItems/ArgonCrystal",  "Argon Crystal",  "Resources"),
        ("/Lotus/Types/Items/MiscItems/ControlModule", "Control Module", "Resources"),
        ("/Lotus/Types/Items/MiscItems/Gallium",       "Gallium",        "Resources"),
        ("/Lotus/Types/Items/MiscItems/Oxium",         "Oxium",          "Resources"),
        ("/Lotus/Types/Items/MiscItems/Rubedo",        "Rubedo",         "Resources"),
        ("/Lotus/Types/Items/MiscItems/Ferrite",       "Ferrite",        "Resources"),
        ("/Lotus/Types/Items/MiscItems/AlloyPlate",    "Alloy Plate",    "Resources"),
        ("/Lotus/Types/Items/MiscItems/Circuits",      "Circuits",       "Resources"),
        ("/Lotus/Types/Items/MiscItems/Salvage",       "Salvage",        "Resources"),
        ("/Lotus/Types/Items/MiscItems/NanoSpores",    "Nano Spores",    "Resources"),
    ]
    .into_iter()
    .map(|(u, n, c)| WfcdItem {
        unique_name: u.to_string(),
        name: n.to_string(),
        category: c.to_string(),
        image_name: None, vaulted: None, ducats: None, mastery_req: None,
    })
    .collect()
}
