import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HelpTip } from "./HelpTip";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CatalogItem {
  unique_name: string;
  name: string;
  category: string;
  image_name?: string;
  vaulted?: boolean | null;
  ducats?: number | null;
}

interface DropReward {
  itemName: string;
  chance: number;
  rarity: string; // "Common" | "Uncommon" | "Rare"
}

interface RelicDrop {
  tier: string;
  relicName: string;      // short: "A1 Relic"
  fullName: string;       // with tier: "Axi A1 Relic" — used for catalog lookup
  rewards: DropReward[];
}

interface Props {
  quantities: Record<string, number>;
  apiQuantities: Record<string, number>;
  masteryData: Record<string, number>;
  refreshKey: number;
  colorblindMode?: boolean;
}

// ─── Module-level constants ───────────────────────────────────────────────────


const RARITY_SORT: Record<string, number> = { Common: 0, Uncommon: 1, Rare: 2 };
const RARITY_CSS:  Record<string, string> = { Common: "bronze", Uncommon: "silver", Rare: "gold" };

// Derive rarity from drop chance — more reliable than the WFCD rarity string
function chanceToRarity(chance: number): string {
  if (chance >= 15) return "Common";
  if (chance >= 5)  return "Uncommon";
  return "Rare";
}

const DROP_URL       = "https://raw.githubusercontent.com/WFCD/warframe-drop-data/gh-pages/data/all.json";
const DROP_CACHE_KEY = "ff-drop-data-v7";
const DROP_CACHE_TTL = 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findCatalogItemGlobal(itemName: string, nameMap: Map<string, CatalogItem>): CatalogItem | undefined {
  const n = itemName.toLowerCase();
  return nameMap.get(n) ?? nameMap.get(n + " blueprint") ?? nameMap.get(n.replace(" blueprint", ""));
}

function extractPrimeName(name: string): string | null {
  const idx = name.indexOf(" Prime");
  return idx >= 0 ? name.slice(0, idx + " Prime".length) : null;
}

function parseDropData(raw: any): RelicDrop[] {
  const relicsArray: any[] = Array.isArray(raw?.relics) ? raw.relics : [];

  const map = new Map<string, RelicDrop>();
  for (const r of relicsArray) {
    if (!r || r.state !== "Intact") continue;
    const relicName: string = r.relicName ?? r.name ?? "";
    if (!relicName) continue;
    const tier: string = String(r.tier ?? "");
    // Drop data: tier="Meso", relicName="V13" → baseName "Meso V13"
    // Catalog stores per-refinement: "Meso V13 Intact", "Meso V13 Exceptional", etc.
    const fullName: string = tier ? `${tier} ${relicName}` : relicName;
    const rewards: DropReward[] = (Array.isArray(r.rewards) ? r.rewards : [])
      .map((x: any) => {
        const chance = Number(x.chance ?? 0);
        return {
          itemName: String(x.itemName ?? x.item_name ?? x.name ?? "Unknown"),
          chance,
          rarity: chanceToRarity(chance), // derived from chance, not the unreliable rarity string
        };
      })
      .filter((x: DropReward) => x.itemName !== "Unknown")
      .sort((a: DropReward, b: DropReward) =>
        (RARITY_SORT[a.rarity] ?? 0) - (RARITY_SORT[b.rarity] ?? 0)
      );
    map.set(fullName, { tier, relicName, fullName, rewards });
  }
  return Array.from(map.values());
}

// ─── Images ───────────────────────────────────────────────────────────────────

function RelicImg({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  const base = { width: 44, height: 44, borderRadius: 6, flexShrink: 0 } as const;
  if (!src || failed)
    return <div style={{ ...base, background: "rgba(255,255,255,.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#8b949e" }}>R</div>;
  return <img style={{ ...base, objectFit: "contain" }} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

const RARITY_BG: Record<string, string> = {
  Bronze: "rgba(205,127,50,.2)",
  Silver: "rgba(192,192,192,.15)",
  Gold:   "rgba(240,192,64,.2)",
};

function PartImg({ srcs, rarity }: { srcs: (string | undefined)[]; rarity?: string }) {
  // Deduplicate so the same failing URL isn't retried
  const valid = [...new Set(srcs.filter(Boolean) as string[])];
  const [idx, setIdx] = useState(0);
  const base = { width: 40, height: 40, borderRadius: 4 } as const;
  const src = valid[idx];
  if (!src) {
    const bg = rarity ? (RARITY_BG[rarity] ?? "rgba(255,255,255,.06)") : "rgba(255,255,255,.06)";
    return <div style={{ ...base, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "rgba(255,255,255,.3)" }}>?</div>;
  }
  // key={src} forces React to unmount/remount the img when src changes,
  // preventing the broken-image icon from persisting between attempts
  return <img key={src} style={{ ...base, objectFit: "contain", display: "block" }} src={src} alt=""
    onError={() => setIdx(i => i + 1)} />;
}

const CDN = (name?: string) => name ? `https://cdn.warframestat.us/img/${name}` : undefined;

// ─── Reward box ───────────────────────────────────────────────────────────────

function RewardBox({ reward, imageSrcs, isOwned, isComplete, isHighlighted, colorblindMode }: {
  reward: DropReward;
  imageSrcs: (string | undefined)[];
  isOwned: boolean;
  isComplete: boolean;
  isHighlighted: boolean;
  colorblindMode: boolean;
}) {
  const cls   = RARITY_CSS[reward.rarity] ?? "bronze";
  const state = isComplete ? "complete" : isOwned ? "owned" : "";
  const shortName = reward.itemName.replace(" Blueprint", "").replace("Prime", "P.").trim();
  return (
    <div
      className={["relic-rbox", `relic-rbox-${cls}`, state ? `relic-rbox-${state}` : "", isHighlighted ? "relic-rbox-highlight" : ""].join(" ").trim()}
      title={`${reward.itemName} — ${reward.rarity} (${reward.chance.toFixed(1)}%)`}
    >
      {/* Top-right corner: rarity label + optional colorblind checkmark stacked */}
      <span className="relic-corner-indicator">
        <span className={`relic-rarity-label relic-rl-${cls}`} title={reward.rarity}>
          {cls === "bronze" ? "C" : cls === "silver" ? "U" : "R"}
        </span>
        {colorblindMode && (isOwned || isComplete) && (
          <span className={`relic-cb-check relic-cb-${state}`}>{isComplete ? "✓✓" : "✓"}</span>
        )}
      </span>
      <PartImg srcs={imageSrcs} rarity={reward.rarity} />
      <span className="relic-rbox-name">{shortName}</span>
    </div>
  );
}

// ─── Relic card ───────────────────────────────────────────────────────────────

const REFINEMENT_SUFFIXES_CARD = ["intact", "exceptional", "flawless", "radiant"];
const REFINEMENT_LABELS_CARD   = ["Intact", "Except.", "Flawless", "Radiant"];

function RelicCard({ drop, catalogRelicByName, quantities, ownedPrimeNames, searchQ, nameMap, colorblindMode }: {
  drop: RelicDrop;
  catalogRelicByName: Map<string, CatalogItem>;
  quantities: Record<string, number>;
  ownedPrimeNames: Set<string>;
  searchQ: string;
  nameMap: Map<string, CatalogItem>;
  colorblindMode: boolean;
}) {
  const baseLower = drop.fullName.toLowerCase();

  // Per-refinement counts using catalog
  const refCounts = REFINEMENT_SUFFIXES_CARD.map((ref, i) => {
    const cat = catalogRelicByName.get(`${baseLower} ${ref}`);
    return { label: REFINEMENT_LABELS_CARD[i], count: cat ? (quantities[cat.unique_name] ?? 0) : 0 };
  });
  const total = refCounts.reduce((s, r) => s + r.count, 0);

  // Relic icon comes from the Intact catalog entry
  const intactCat = catalogRelicByName.get(`${baseLower} intact`);

  // Find catalog item by name — returns item with best available image_name
  const findCatalogItem = (itemName: string): CatalogItem | undefined => {
    const n = itemName.toLowerCase();

    // 1. Exact match
    let found = nameMap.get(n);
    // 2. Blueprint toggle
    if (!found) {
      found = n.endsWith(" blueprint")
        ? nameMap.get(n.slice(0, -" blueprint".length))
        : nameMap.get(n + " blueprint");
    }
    // 3. Fuzzy: all significant words must appear in catalog item name
    if (!found) {
      const words = n.replace(" blueprint", "").split(" ").filter(w => w.length > 2);
      if (words.length >= 2) {
        for (const [, item] of nameMap) {
          if (words.every(w => item.name.toLowerCase().includes(w))) { found = item; break; }
        }
      }
    }

    // 4. If found but no image, try parent prime item's image as fallback
    //    e.g. "Yareli Prime Blueprint" → look up "Yareli Prime" for its warframe image
    if (found && !found.image_name) {
      const parentName = extractPrimeName(itemName);
      if (parentName) {
        const parent = nameMap.get(parentName.toLowerCase());
        if (parent?.image_name) return { ...found, image_name: parent.image_name };
      }
    }

    return found;
  };

  const safeRewards = drop.rewards.filter(r => r?.itemName);
  const allComplete = safeRewards.length > 0 && safeRewards.every(r => {
    const cat = findCatalogItem(r.itemName);
    const isOwned = cat ? (quantities[cat.unique_name] ?? 0) > 0 : false;
    const p = extractPrimeName(r.itemName);
    const pItem = p ? nameMap.get(p.toLowerCase()) : undefined;
    const isComplete = pItem
      ? (quantities[pItem.unique_name] ?? 0) > 0
      : (p ? ownedPrimeNames.has(p.toLowerCase()) : false);
    return isOwned || isComplete;
  });

  const slots: (DropReward | null)[] = [
    ...drop.rewards,
    ...Array<null>(Math.max(0, 6 - drop.rewards.length)).fill(null),
  ];

  return (
    <div className={`relic-card${total === 0 ? " relic-card-unowned" : allComplete ? " relic-card-complete" : ""}`}>
      <div className="relic-card-left">
        <div className="relic-card-icon-row">
          <RelicImg src={CDN(intactCat?.image_name)} />
          <span className="relic-total">×{total}</span>
          {colorblindMode && allComplete && <span className="relic-cb-relic-check" title="All rewards obtained">✓✓</span>}
        </div>
        <div className="relic-card-name">{drop.fullName}</div>
        {intactCat?.vaulted && <span className="vault-badge vault-yes">🔒 Vaulted</span>}
        <div className="relic-refinements">
          {refCounts.some(r => r.count > 0)
            ? refCounts.map(r => (
              <span key={r.label} className={`relic-ref ${r.count > 0 ? "relic-ref-owned" : "relic-ref-zero"}`}>
                {r.count} {r.label}
              </span>
            ))
            : <span className="relic-ref relic-ref-owned">Total: {total}</span>
          }
        </div>
      </div>

      <div className="relic-rewards-grid">
        {slots.map((r, i) => {
          if (!r) return (
            <div key={i} className="relic-rbox relic-rbox-empty">
              <PartImg srcs={[]} rarity={undefined} />
              <span className="relic-rbox-name">—</span>
            </div>
          );
          // Ownership: unique_name lookup is exact and reliable (same as inventory)
          const catalogItem = findCatalogItem(r.itemName);
          const isOwned = catalogItem ? (quantities[catalogItem.unique_name] ?? 0) > 0 : false;
          // Build list of image URLs to try in order (PartImg tries each, moves to next on 404)
          const imageItem = catalogItem?.image_name ? catalogItem : findCatalogItem(r.itemName);
          const primeName = extractPrimeName(r.itemName); // e.g. "Yareli Prime"
          const primeImageItem = primeName ? nameMap.get(primeName.toLowerCase()) : undefined;

          const imageSrcs: (string | undefined)[] = [
            // 1. Catalog item image (direct or parent-prime fallback from findCatalogItem)
            CDN(imageItem?.image_name),
            // 2. Parent prime warframe/weapon image
            CDN(primeImageItem?.image_name),
            // 3. Construct from catalog unique_name: "YareliPrimeBlueprint" → "YareliPrime.png"
            (() => {
              const seg = (catalogItem?.unique_name ?? "").split("/").pop() ?? "";
              const file = seg.replace(/Blueprint$/, "");
              return file ? `https://cdn.warframestat.us/img/${file}.png` : undefined;
            })(),
            // 4. Construct from parent prime name: "Yareli Prime" → "YareliPrime.png"
            primeName ? `https://cdn.warframestat.us/img/${primeName.replace(/\s+/g, "")}.png` : undefined,
            // 5. Strip "Blueprint" from item name: "Forma Blueprint" → "Forma.png"
            `https://cdn.warframestat.us/img/${r.itemName.replace(" Blueprint", "").replace(/\s+/g, "")}.png`,
          ];
          // Gold: the complete parent prime item is built and in inventory
          // Gold: look up the parent prime item by name in the catalog, then check quantities
          // e.g. "Burston Prime Barrel" → find "Burston Prime" in nameMap → check quantities
          const parentName = extractPrimeName(r.itemName);
          const parentItem = parentName ? nameMap.get(parentName.toLowerCase()) : undefined;
          const isComplete = parentItem
            ? (quantities[parentItem.unique_name] ?? 0) > 0
            : (parentName ? ownedPrimeNames.has(parentName.toLowerCase()) : false);
          return (
            <RewardBox
              key={i}
              reward={r}
              imageSrcs={imageSrcs}
              isOwned={isOwned}
              isComplete={isComplete}
              isHighlighted={searchQ.length > 1 && r.itemName.toLowerCase().includes(searchQ)}
              colorblindMode={colorblindMode}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RelicHelper({ quantities, apiQuantities, refreshKey, colorblindMode = false }: Props) {
  const [allItems,     setAllItems]     = useState<CatalogItem[]>([]);
  const [drops,        setDrops]        = useState<RelicDrop[]>([]);
  const [dropLoading,  setDropLoading]  = useState(false);
  const [dropError,    setDropError]    = useState(false);
  const [search,       setSearch]       = useState("");
  const [filterOwned,  setFilterOwned]  = useState(false);
  const [page,         setPage]         = useState(0);
  const PAGE_SIZE = 30;
  const [filterVaulted,setFilterVaulted]= useState(false);
  const [sortMode,     setSortMode]     = useState<"count" | "name" | "ducats">("count");
  const [filterTier,   setFilterTier]   = useState<string | null>(null);
  const [filterUnvaulted, setFilterUnvaulted] = useState(false);
  const [filterComplete,  setFilterComplete]  = useState(false);
  const [filterMissing,   setFilterMissing]   = useState(false);
  const [showUnowned,     setShowUnowned]     = useState(false);

  const loadDrops = useCallback(() => {
    setDropLoading(true);
    setDropError(false);
    fetch(DROP_URL)
      .then(r => r.json())
      .then(d => {
        const result = parseDropData(d);
        setDrops(result);
        try { localStorage.setItem(DROP_CACHE_KEY, JSON.stringify({ data: result, ts: Date.now() })); } catch {}
      })
      .catch(() => setDropError(true))
      .finally(() => setDropLoading(false));
  }, []);

  useEffect(() => {
    invoke<CatalogItem[]>("get_all_items").then(setAllItems).catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    try {
      const cached = localStorage.getItem(DROP_CACHE_KEY);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (typeof ts === "number" && Date.now() - ts < DROP_CACHE_TTL && Array.isArray(data)) {
          setDrops(data);
          return;
        }
      }
    } catch {}
    loadDrops();
  }, [loadDrops]);

  const nameMap = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const i of allItems) m.set(i.name.toLowerCase(), i);
    return m;
  }, [allItems]);

  const catalogRelicByName = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const i of allItems) if (i.category === "Relics") m.set(i.name.toLowerCase(), i);
    return m;
  }, [allItems]);

  const catalogByUnique = useMemo(() =>
    new Map(allItems.map(i => [i.unique_name, i])),
  [allItems]);

  const ownedPrimeNames = useMemo(() => {
    const s = new Set<string>();
    for (const [u, qty] of Object.entries(apiQuantities)) {
      if (qty <= 0) continue;

      // Method 1: catalog lookup (most accurate when paths match)
      const item = catalogByUnique.get(u);
      if (item?.name?.includes("Prime")) {
        s.add(item.name.toLowerCase());
        continue;
      }

      // Method 2: derive from unique_name path segment using PascalCase splitting
      // e.g. "/Lotus/Weapons/.../BurstonPrime" → "burston prime"
      const seg = u.split("/").pop() ?? "";
      if (seg.includes("Prime")) {
        const spaced = seg.replace(/([A-Z])/g, " $1").trim().toLowerCase();
        const idx = spaced.indexOf("prime");
        if (idx >= 0) s.add(spaced.slice(0, idx + "prime".length).trim());
      }
    }
    return s;
  }, [apiQuantities, catalogByUnique]);

  // Catalog stores per-refinement: "Meso V13 Intact", "Meso V13 Exceptional", "Meso V13 Flawless", "Meso V13 Radiant"
  const REFINEMENT_SUFFIXES = ["intact", "exceptional", "flawless", "radiant"];

  const getTotal = useCallback((drop: RelicDrop): number => {
    if (!drop?.fullName) return 0;
    const base = drop.fullName.toLowerCase();
    return REFINEMENT_SUFFIXES.reduce((sum, ref) => {
      const cat = catalogRelicByName.get(`${base} ${ref}`);
      return sum + (cat ? (quantities[cat.unique_name] ?? 0) : 0);
    }, 0);
  }, [catalogRelicByName, quantities]);

  const searchQ = search.toLowerCase();

  const visibleDrops = useMemo(() => drops
    .filter(d => {
      if (!searchQ) return true;
      return (d.fullName ?? "").toLowerCase().includes(searchQ)
        || (d.relicName ?? "").toLowerCase().includes(searchQ)
        || d.rewards.some(r => (r.itemName ?? "").toLowerCase().includes(searchQ));
    })
    .filter(d => showUnowned || getTotal(d) > 0)
    .filter(d => !filterOwned || getTotal(d) > 0)
    .filter(d => !filterTier  || (d.tier ?? "").toLowerCase() === filterTier)
    .filter(d => {
      const cat = catalogRelicByName.get(`${d.fullName.toLowerCase()} intact`);
      if (filterVaulted  ) return cat?.vaulted === true;
      if (filterUnvaulted) return cat?.vaulted === false;
      return true;
    })
    .filter(d => {
      if (!filterComplete && !filterMissing) return true;
      const allDone = d.rewards.length > 0 && d.rewards.every(r => {
        const cat = findCatalogItemGlobal(r.itemName, nameMap);
        const p = extractPrimeName(r.itemName);
        return (cat ? (quantities[cat.unique_name] ?? 0) > 0 : false)
          || (p ? ownedPrimeNames.has(p.toLowerCase()) : false);
      });
      return filterComplete ? allDone : !allDone;
    })
    .filter(d => d?.relicName)
    .sort((a, b) => {
      if (sortMode === "count") return getTotal(b) - getTotal(a) || (a.relicName ?? "").localeCompare(b.relicName ?? "");
      if (sortMode === "ducats") {
        const CHANCES: Record<string, number> = { Common: 0.2533, Uncommon: 0.11, Rare: 0.02 };
        const avg = (d: RelicDrop) => d.rewards.reduce((s, r) => {
          const cat = findCatalogItemGlobal(r.itemName, nameMap);
          return s + (cat?.ducats ?? 0) * (CHANCES[r.rarity] ?? 0);
        }, 0);
        return avg(b) - avg(a) || (a.relicName ?? "").localeCompare(b.relicName ?? "");
      }
      return (a.fullName ?? "").localeCompare(b.fullName ?? "");
    }),
  [drops, searchQ, filterOwned, showUnowned, filterTier, filterVaulted, filterUnvaulted, filterComplete, filterMissing, sortMode, getTotal, catalogRelicByName, nameMap, quantities, ownedPrimeNames]);

  const ownedCount = useMemo(() =>
    drops.filter(d => getTotal(d) > 0).length,
  [drops, getTotal]);

  // Reset to first page whenever filters change
  useEffect(() => { setPage(0); }, [searchQ, filterOwned, showUnowned, filterTier, filterVaulted, filterUnvaulted, filterComplete, filterMissing, sortMode]);

  const pagedDrops = visibleDrops.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(visibleDrops.length / PAGE_SIZE);

  const searchMatchesReward = searchQ.length > 1
    && drops.some(d => d.rewards.some(r => (r.itemName ?? "").toLowerCase().includes(searchQ)));

  return (
    <div className="relic-helper">
      <div className="market-header">
        <input
          className="foundry-search" style={{ width: 220 }}
          placeholder="Relic name or item name…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <div className="filter-bar" style={{ border: "none", padding: 0, flex: 1, flexWrap: "wrap" }}>
          {/* Tier quick filters */}
          {["Lith","Meso","Neo","Axi","Requiem"].map(t => (
            <button key={t} className={`fchip ${filterTier === t.toLowerCase() ? "fchip-on" : ""}`}
              onClick={() => setFilterTier(v => v === t.toLowerCase() ? null : t.toLowerCase())}>{t}</button>
          ))}
          <span className="fbar-sep"/>
          <button className={`fchip ${filterOwned     ? "fchip-on" : ""}`} onClick={() => { const n = !filterOwned;   setFilterOwned(n);   if (n) setShowUnowned(false); }}>Owned</button>
          <button className={`fchip ${showUnowned    ? "fchip-on" : ""}`} onClick={() => { const n = !showUnowned;   setShowUnowned(n);   if (n) setFilterOwned(false); }}>Not owned</button>
          <button className={`fchip ${filterVaulted   ? "fchip-on" : ""}`} onClick={() => { const n = !filterVaulted;  setFilterVaulted(n); if (n) setFilterUnvaulted(false); }}>🔒 Vaulted</button>
          <button className={`fchip ${filterUnvaulted ? "fchip-on" : ""}`} onClick={() => { const n = !filterUnvaulted; setFilterUnvaulted(n); if (n) setFilterVaulted(false); }}>🔓 Unvaulted</button>
          <button className={`fchip ${filterComplete  ? "fchip-on" : ""}`} onClick={() => { const n = !filterComplete; setFilterComplete(n); if (n) setFilterMissing(false); }}>✓ All obtained</button>
          <button className={`fchip ${filterMissing   ? "fchip-on" : ""}`} onClick={() => { const n = !filterMissing;  setFilterMissing(n);  if (n) setFilterComplete(false); }}>✕ Missing items</button>
          <span className="fbar-sep"/>
          <span className="fbar-label">Sort:</span>
          <button className={`fchip ${sortMode === "count"  ? "fchip-on" : ""}`} onClick={() => setSortMode("count")}>Most owned</button>
          <button className={`fchip ${sortMode === "ducats" ? "fchip-on" : ""}`} onClick={() => setSortMode("ducats")}>Avg ducats</button>
          <button className={`fchip ${sortMode === "name"   ? "fchip-on" : ""}`} onClick={() => setSortMode("name")}>A-Z</button>
          {dropError && <button className="btn-secondary" style={{ marginLeft: 8 }} onClick={loadDrops}>↺ Retry</button>}
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>
            {dropLoading ? "Loading…" : `${visibleDrops.length} relics · ${ownedCount} owned`}
          </span>
          <HelpTip items={[
            { border: "#e8923a", icon: "C", label: "Common",   desc: "Bronze border — ~25% chance per run" },
            { border: "#c0c0c0", icon: "U", label: "Uncommon", desc: "Silver border — ~11% chance per run" },
            { border: "#f0c040", icon: "R", label: "Rare",     desc: "Gold border — ~2% chance per run" },
            { swatch: "rgba(63,185,80,.5)",  icon: "✓",  label: "Part owned",     desc: "Green box — blueprint or part in inventory" },
            { swatch: "rgba(240,192,64,.5)", icon: "✓✓", label: "Item complete",  desc: "Gold box — built warframe/weapon owned" },
          ]} />
        </div>
      </div>

      {searchMatchesReward && (
        <div style={{ padding: "4px 14px", fontSize: 11, color: "var(--accent)" }}>
          Showing relics that drop "<strong>{search}</strong>" — highlighted in blue
        </div>
      )}

      {visibleDrops.length > PAGE_SIZE && (
        <div className="relic-pagination">
          <button className="btn-secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {page + 1} / {totalPages} &nbsp;({visibleDrops.length} relics)
          </span>
          <button className="btn-secondary" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      <div className="relic-list">
        {visibleDrops.length === 0 ? (
          <div className="empty-msg">{dropLoading ? "Fetching drop data…" : "No relics match."}</div>
        ) : pagedDrops.map(drop => (
          <RelicCard
            key={drop.fullName}
            drop={drop}
            catalogRelicByName={catalogRelicByName}
            quantities={quantities}
            ownedPrimeNames={ownedPrimeNames}
            searchQ={searchQ}
            nameMap={nameMap}
            colorblindMode={colorblindMode}
          />
        ))}
      </div>
    </div>
  );
}
