import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HelpTip } from "./HelpTip";
import WfmTrading from "./WfmTrading";
import ItemMarketPopup from "./ItemMarketPopup";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CatalogItem {
  unique_name: string;
  name: string;
  category: string;
  image_name?: string;
  vaulted?: boolean | null;
  ducats?: number | null;
}

interface WfmItem { id: string; item_name: string; url_name: string; }
interface WfmPrice { url_name: string; sell_median?: number; }

interface CraftingJob { unique_name: string; item_name: string; completion_ms: number; }

interface Props {
  quantities: Record<string, number>;
  /** API-only quantities — used for ownership checks (more reliable than scanner). */
  apiQuantities: Record<string, number>;
  refreshKey: number;
  crafting: CraftingJob[];
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PlatIcon({ size = 14 }: { size?: number }) {
  return <img src="/platinum.webp" alt="plat" width={size} height={size} style={{ objectFit: "contain", flexShrink: 0 }} />;
}
function DucatIcon({ size = 14 }: { size?: number }) {
  return <img src="/ducats.webp" alt="ducat" width={size} height={size} style={{ objectFit: "contain", flexShrink: 0 }} />;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString(); }
function fmtPt(n: number) { return Math.round(n).toString(); }

function setName(itemName: string): string {
  const words = itemName.split(" ");
  const primeIdx = words.lastIndexOf("Prime");
  if (primeIdx >= 0) return words.slice(0, primeIdx + 1).join(" ");
  return words.slice(0, 2).join(" ");
}

function partLabel(itemName: string, set: string): string {
  return itemName.startsWith(set) ? itemName.slice(set.length).trim() || itemName : itemName;
}

function normalizeForWfm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function ItemImg({ imageName, size = 32 }: { imageName?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const s = { width: size, height: size, objectFit: "contain" as const, flexShrink: 0, borderRadius: 4 };
  if (!imageName || failed)
    return <span style={{ ...s, background: "rgba(255,255,255,.06)", border: "1px solid #30363d", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * .3, color: "#8b949e" }}>P</span>;
  return <img style={s} src={`https://cdn.warframestat.us/img/${imageName}`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

// ─── Set card ─────────────────────────────────────────────────────────────────

interface SetPart { item: CatalogItem; qty: number; sellMedian?: number; loading: boolean; urlName: string; }

function SetCard({ setKey, parts, parentItem, setPrice, setPriceLoading, pricesFetched, crafting, onCardClick, onPartClick }: {
  setKey: string; parts: SetPart[]; parentItem?: CatalogItem;
  setPrice?: WfmPrice; setPriceLoading: boolean; pricesFetched: boolean;
  crafting: CraftingJob[]; onCardClick?: () => void;
  onPartClick?: (urlName: string, displayName: string, imageName?: string) => void;
}) {
  const totalDucats  = parts.reduce((s, p) => s + (p.item.ducats ?? 0) * p.qty, 0);
  const ownedCount   = parts.filter(p => p.qty > 0).length;
  const isComplete   = ownedCount === parts.length;
  const hasDupes     = parts.some(p => p.qty > 1);
  const isCrafting   = crafting.some(c =>
    c.unique_name === parentItem?.unique_name ||
    parts.some(p => p.item.unique_name === c.unique_name)
  );

  return (
    <div className={`market-card${isComplete ? " market-card-complete" : ""}`}>
      <div className={`market-card-left${onCardClick ? " market-card-clickable" : ""}`} onClick={onCardClick} title={onCardClick ? "View orders & prices" : undefined}>
        <div style={{ position: "relative", display: "inline-block" }}>
          <ItemImg imageName={parentItem?.image_name} size={64} />
          {isCrafting && (
            <span style={{ position: "absolute", top: -4, right: -6, fontSize: 13 }} title="Building in Foundry">⚒</span>
          )}
        </div>
        <div className="market-set-name">{setKey}</div>
        <div className="market-set-badges">
          {isComplete && <span className="mset-badge mset-complete">✓ Complete</span>}
          {!isComplete && <span className="mset-badge mset-parts">{ownedCount}/{parts.length}</span>}
          {hasDupes && <span className="mset-badge mset-dupes">+ Dupes</span>}
        </div>
        <div className="market-set-price-box">
          {setPriceLoading ? (
            <span className="market-price-spin">…</span>
          ) : setPrice?.sell_median ? (
            <div className="market-set-price">
              <PlatIcon size={16} />
              <span className="market-price-big">{fmtPt(setPrice.sell_median)}</span>
              <span className="market-price-lbl">set</span>
            </div>
          ) : pricesFetched ? (
            <span className="market-price-na">—</span>
          ) : null}
        </div>
      </div>

      <div className="market-card-right">
        {parts.map(part => {
          const qty      = part.qty;
          const qtyClass = qty === 0 ? "mqty-zero" : qty === 1 ? "mqty-one" : "mqty-dupe";
          const canClick = !!onPartClick;
          return (
            <div
              key={part.item.unique_name}
              className={`market-part-row${qty === 0 ? " part-missing" : ""}${canClick ? " market-part-clickable" : ""}`}
              onClick={canClick ? () => onPartClick(part.urlName, part.item.name, part.item.image_name ?? undefined) : undefined}
              title={canClick ? "View orders & prices" : undefined}
            >
              <DucatIcon size={12} />
              <span className="mpart-ducat-val">{part.item.ducats ?? "—"}</span>
              <span className="mpart-sep">/</span>
              <PlatIcon size={12} />
              <span className="mpart-plat-val">
                {part.loading ? "…" : part.sellMedian ? fmtPt(part.sellMedian) : "—"}
              </span>
              <span className="mpart-sep">/</span>
              <span className="mpart-name">{partLabel(part.item.name, setKey)}</span>
              <span className={`mpart-qty ${qtyClass}`}>{qty}</span>
            </div>
          );
        })}
        {totalDucats > 0 && (
          <div className="mpart-totals"><DucatIcon size={11} /> {fmt(totalDucats)} ducats total</div>
        )}
      </div>
    </div>
  );
}

// ─── Market Helper ────────────────────────────────────────────────────────────

type SortMode = "name" | "ducats-owned" | "ducats-all" | "completion";

export default function MarketHelper({ quantities, apiQuantities, refreshKey, crafting }: Props) {
  const [allItems, setAllItems]         = useState<CatalogItem[]>([]);
  const [wfmItems, setWfmItems]         = useState<WfmItem[]>([]);
  const [wfmLoading, setWfmLoading]     = useState(false);
  const [wfmError, setWfmError]         = useState(false);
  const [prices, setPrices]             = useState<Map<string, WfmPrice>>(new Map());
  const [priceAges, setPriceAges]       = useState<Map<string, number>>(new Map()); // urlName → fetchedAt ms
  const [loadingPrices, setLoadingPrices] = useState<Set<string>>(new Set());

  const PRICE_CACHE_KEY = "ff-wfm-prices-v1";
  const [activeMarketTab, setActiveMarketTab] = useState<"sets" | "trading">("sets");
  const [wfmBadge, setWfmBadge]               = useState(0);
  const [wfmUsername, setWfmUsername]         = useState<string | null>(null);
  const [popup, setPopup] = useState<{ urlName: string; displayName: string; imageName?: string } | null>(null);
  const [search, setSearch]             = useState("");
  const [sortMode, setSortMode]         = useState<SortMode>("ducats-owned");

  // Mix-and-match filters
  const [filterHasParts,  setFilterHasParts]  = useState(true);
  const [filterDupes,     setFilterDupes]     = useState(false);
  const [filterComplete,  setFilterComplete]  = useState(false);
  const [filterFullOwned, setFilterFullOwned] = useState(false);

  useEffect(() => {
    invoke<CatalogItem[]>("get_all_items").then(setAllItems).catch(() => {});
  }, [refreshKey]);

  // Reflect WFM login state immediately — App.tsx loads the JWT into Rust on startup,
  // so wfm_get_session succeeds even before the Trading tab has been opened.
  useEffect(() => {
    invoke<[string, string] | null>("wfm_get_session")
      .then(existing => { if (existing) setWfmUsername(existing[0]); })
      .catch(() => {});
  }, []); // eslint-disable-line

  // Load cached prices from localStorage on startup
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRICE_CACHE_KEY);
      if (!raw) return;
      const data: Record<string, { sell_median?: number; ts: number }> = JSON.parse(raw);
      const priceMap = new Map<string, WfmPrice>();
      const ageMap   = new Map<string, number>();
      for (const [urlName, entry] of Object.entries(data)) {
        priceMap.set(urlName, { url_name: urlName, sell_median: entry.sell_median });
        ageMap.set(urlName, entry.ts);
      }
      setPrices(priceMap);
      setPriceAges(ageMap);
    } catch {}
  }, []); // eslint-disable-line

  // Persist prices to localStorage whenever they change
  useEffect(() => {
    if (prices.size === 0) return;
    const now = Date.now();
    const data: Record<string, { sell_median?: number; ts: number }> = {};
    for (const [urlName, price] of prices) {
      data[urlName] = { sell_median: price.sell_median, ts: priceAges.get(urlName) ?? now };
    }
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(data)); } catch {}
  }, [prices]); // eslint-disable-line

  useEffect(() => {
    setWfmLoading(true);
    setWfmError(false);
    invoke<WfmItem[]>("fetch_wfm_items")
      .then(items => {
        setWfmItems(items);
        if (!items.length) setWfmError(true);
      })
      .catch(() => { setWfmError(true); })
      .finally(() => setWfmLoading(false));
  }, []);

  const wfmLookup = useMemo(() => {
    const map = new Map<string, string>();

    // Pass 1: exact matches — highest priority, never overwritten
    for (const w of wfmItems) {
      map.set(normalizeForWfm(w.item_name), w.url_name);
    }

    // Pass 2: fill gaps only — add Blueprint ↔ no-Blueprint aliases for keys
    // that don't already have an exact entry, so we handle WFM's inconsistency
    // (some items listed with "Blueprint" suffix, some without)
    for (const w of wfmItems) {
      const key = normalizeForWfm(w.item_name);
      if (key.endsWith("_blueprint")) {
        // WFM has "…Blueprint" → also expose without suffix for catalog names that omit it
        const stripped = key.slice(0, -"_blueprint".length);
        if (!map.has(stripped)) map.set(stripped, w.url_name);
      } else {
        // WFM has no "Blueprint" → also expose with suffix for catalog names that include it
        const withBp = key + "_blueprint";
        if (!map.has(withBp)) map.set(withBp, w.url_name);
      }
    }

    return map;
  }, [wfmItems]);

  const primeItems = useMemo(() =>
    allItems.filter(i =>
      i.name.includes("Prime") &&
      // Include items with known ducat value OR any blueprint (even if ducats not yet catalogued)
      (i.ducats != null || i.name.endsWith("Blueprint"))
    ),
  [allItems]);

  const parentItems = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const i of allItems) {
      if (i.name.includes("Prime") && ["Warframes","Primary","Secondary","Melee","Companions","Archwing"].includes(i.category))
        map.set(i.name, i);
    }
    return map;
  }, [allItems]);

  // ducats lookup by name for fallback (e.g. "Chassis" → 15 so "Chassis Blueprint" also gets 15)
  const ducatsByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of allItems) if (i.ducats != null) m.set(i.name, i.ducats);
    return m;
  }, [allItems]);

  const sets = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of primeItems) {
      const key = setName(item.name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }

    for (const [key, parts] of map) {
      // 1. Dedup by display label — keep the item with ducats; drop the bare version
      //    when a blueprint counterpart exists (e.g. remove "Chassis" when "Chassis Blueprint" exists)
      const byLabel = new Map<string, CatalogItem>();
      for (const part of parts) {
        const label = partLabel(part.name, key);
        const existing = byLabel.get(label);
        if (!existing || (part.ducats != null && existing.ducats == null)) {
          byLabel.set(label, part);
        }
      }
      // 2. Remove built component rows when a Blueprint variant exists in the set.
      //    Exclude the plain "Blueprint" label itself — that's the main warframe blueprint,
      //    not a "something Blueprint" compound — so it must never be removed.
      const bpBaseLabels = new Set(
        [...byLabel.keys()]
          .filter(l => l.endsWith("Blueprint") && l !== "Blueprint")
          .map(l => l.replace(/ Blueprint$/, ""))
      );
      const deduped = [...byLabel.values()].filter(p => !bpBaseLabels.has(partLabel(p.name, key)));

      // 3. Inherit ducats from base component when blueprint lacks them.
      //    "Chassis Blueprint" inherits from "Revenant Prime Chassis" (15 ducats).
      const augmented = deduped.map(p => {
        if (p.ducats != null) return p;
        if (p.name.endsWith("Blueprint")) {
          const baseName = p.name.replace(/ Blueprint$/, "");
          const d = ducatsByName.get(baseName) ?? ducatsByName.get(`${key} ${baseName.slice(key.length).trim()}`);
          if (d != null) return { ...p, ducats: d };
        }
        return p;
      });

      // 4. Drop parts that still have no ducat value after inheritance — these are
      //    exalted weapon blueprints (Talons, Artemis Bow…) that are not relic drops.
      const finalParts = augmented.filter(p => p.ducats != null);

      // 5. Remove sets that end up with 0 tradeable parts — these are exalted abilities
      //    (Artemis Bow Prime, Balefire Charger Prime…) or single-unit extractors that
      //    aren't obtainable from relics. An empty set trivially shows as "Complete".
      if (finalParts.length === 0) { map.delete(key); continue; }
      map.set(key, finalParts);
    }
    return map;
  }, [primeItems, allItems, ducatsByName]);

  const totalDucats = useMemo(() =>
    primeItems.reduce((s, i) => s + (i.ducats ?? 0) * (quantities[i.unique_name] ?? 0), 0),
  [primeItems, quantities]);

  const dupeDucats = useMemo(() =>
    primeItems.reduce((s, i) => s + (i.ducats ?? 0) * Math.max(0, (quantities[i.unique_name] ?? 0) - 1), 0),
  [primeItems, quantities]);

  // Fetch price for a single URL
  const fetchOnePrice = useCallback(async (urlName: string) => {
    try {
      const price = await invoke<{ url_name: string; sell_median?: number }>("fetch_wfm_price", { urlName });
      const now = Date.now();
      setPrices(prev => new Map(prev).set(urlName, { url_name: urlName, sell_median: price.sell_median }));
      setPriceAges(prev => new Map(prev).set(urlName, now));
    } catch {}
    setLoadingPrices(prev => { const n = new Set(prev); n.delete(urlName); return n; });
  }, []);

  // Refs so the continuous loop always reads current state without stale closures
  const pricesRef     = useRef(prices);
  const priceAgesRef  = useRef(priceAges);
  const quantitiesRef = useRef(quantities);
  const setsRef       = useRef(sets);
  const lookupRef     = useRef(wfmLookup);
  useEffect(() => { pricesRef.current     = prices;     }, [prices]);
  useEffect(() => { priceAgesRef.current  = priceAges;  }, [priceAges]);
  useEffect(() => { quantitiesRef.current = quantities; }, [quantities]);
  useEffect(() => { setsRef.current       = sets;       }, [sets]);
  useEffect(() => { lookupRef.current     = wfmLookup;  }, [wfmLookup]);

  // Continuous price refresh loop — runs forever, priority order each cycle:
  //   P0: owned sets with no price yet
  //   P1: any set still showing "—" (null price)
  //   P2: owned sets (oldest fetch first)
  //   P3: everything else (oldest fetch first)
  useEffect(() => {
    if (wfmLookup.size === 0) return;
    let cancelled = false;

    const getSetUrls = (setKey: string, parts: CatalogItem[]): string[] => {
      const lookup = lookupRef.current;
      const urls: string[] = [];
      const setUrl = lookup.get(normalizeForWfm(setKey + " Set"));
      if (setUrl) urls.push(setUrl);
      for (const p of parts) {
        const key = normalizeForWfm(p.name);
        const url = lookup.get(key) ?? key; // fall back to slug derived from name
        if (!urls.includes(url)) urls.push(url);
      }
      return urls;
    };

    const run = async () => {
      while (!cancelled) {
        const ages    = priceAgesRef.current;
        const px      = pricesRef.current;
        const qty     = quantitiesRef.current;
        const allSets = Array.from(setsRef.current.entries());

        type Job = { url: string; priority: number; age: number };
        const jobs: Job[] = [];
        const seen = new Set<string>();

        for (const [key, parts] of allSets) {
          const owned = parts.some(p => (qty[p.unique_name] ?? 0) > 0);
          for (const url of getSetUrls(key, parts)) {
            if (seen.has(url)) continue;
            seen.add(url);
            const hasPrice = px.get(url)?.sell_median != null;
            const age      = ages.get(url) ?? 0;
            const priority = !hasPrice ? (owned ? 0 : 1) : (owned ? 2 : 3);
            jobs.push({ url, priority, age });
          }
        }

        // Sort by priority, then oldest-fetched first within same priority
        jobs.sort((a, b) => a.priority - b.priority || a.age - b.age);

        for (const { url } of jobs) {
          if (cancelled) break;
          setLoadingPrices(prev => new Set(prev).add(url));
          await fetchOnePrice(url);
          await new Promise(r => setTimeout(r, 350));
        }

        // Pause between cycles before starting the next sweep
        if (!cancelled) await new Promise(r => setTimeout(r, 5_000));
      }
    };

    run();
    return () => { cancelled = true; };
  }, [wfmLookup.size, fetchOnePrice]); // eslint-disable-line

  const visibleSets = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(sets.entries())
      .filter(([key]) => !q || key.toLowerCase().includes(q))
      .filter(([key, parts]) => {
        const ownedAny    = parts.some(p => (quantities[p.unique_name] ?? 0) > 0);
        const hasDupes    = parts.some(p => (quantities[p.unique_name] ?? 0) > 1);
        const isComplete  = parts.every(p => (quantities[p.unique_name] ?? 0) > 0);
        const parent      = parentItems.get(key);
        // Use API-only quantities for ownership — the scanner can pick up warframe
        // paths from navigation/showcase screens and create false positives.
        const isFullOwned = parent ? (apiQuantities[parent.unique_name] ?? 0) > 0 : false;
        if (filterHasParts  && !ownedAny)    return false;
        if (filterDupes     && !hasDupes)    return false;
        if (filterComplete  && !isComplete)  return false;
        if (filterFullOwned && !isFullOwned) return false;
        return true;
      })
      .sort(([aKey, aParts], [bKey, bParts]) => {
        if (sortMode === "ducats-owned") {
          const ad = aParts.reduce((s, p) => s + (p.ducats ?? 0) * (quantities[p.unique_name] ?? 0), 0);
          const bd = bParts.reduce((s, p) => s + (p.ducats ?? 0) * (quantities[p.unique_name] ?? 0), 0);
          return bd - ad;
        }
        if (sortMode === "ducats-all") {
          const ad = aParts.reduce((s, p) => s + (p.ducats ?? 0), 0);
          const bd = bParts.reduce((s, p) => s + (p.ducats ?? 0), 0);
          return bd - ad;
        }
        if (sortMode === "completion") {
          const ar = aParts.filter(p => (quantities[p.unique_name] ?? 0) > 0).length / aParts.length;
          const br = bParts.filter(p => (quantities[p.unique_name] ?? 0) > 0).length / bParts.length;
          return br - ar || aKey.localeCompare(bKey);
        }
        return aKey.localeCompare(bKey);
      });
  }, [sets, quantities, filterHasParts, filterDupes, filterComplete, filterFullOwned, sortMode, search, parentItems]);

  return (
    <div className="market-helper">
      {/* ── Market tab strip ── */}
      <div className="market-tab-strip">
        <button className={activeMarketTab === "sets" ? "active" : ""} onClick={() => setActiveMarketTab("sets")}>
          Prime Sets
        </button>
        <button className={activeMarketTab === "trading" ? "active" : ""} onClick={() => { setActiveMarketTab("trading"); setWfmBadge(0); }}>
          Trading {wfmBadge > 0 && <span className="market-tab-badge">{wfmBadge}</span>}
        </button>
      </div>

      {activeMarketTab === "trading" && (
        <WfmTrading
          wfmLookup={wfmLookup}
          wfmItems={wfmItems}
          quantities={quantities}
          onNewWhisper={() => { if (activeMarketTab !== "trading") setWfmBadge(n => n + 1); }}
          onLoginChange={u => setWfmUsername(u)}
        />
      )}

      {activeMarketTab === "sets" && <>
      <div className="market-header">
        <input className="foundry-search" style={{ width: 200 }} placeholder="Search sets…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div className="filter-bar" style={{ border: "none", padding: 0, flex: 1 }}>
          <button className={`fchip ${filterHasParts  ? "fchip-on" : ""}`} onClick={() => setFilterHasParts(v => !v)}>Has parts</button>
          <button className={`fchip ${filterDupes     ? "fchip-on" : ""}`} onClick={() => setFilterDupes(v => !v)}>★ Dupes</button>
          <button className={`fchip ${filterComplete  ? "fchip-on" : ""}`} onClick={() => setFilterComplete(v => !v)}>✓ Complete set</button>
          <button className={`fchip ${filterFullOwned ? "fchip-on" : ""}`} onClick={() => setFilterFullOwned(v => !v)}>🗸 Item owned</button>
          <span className="fbar-sep"/>
          <span className="fbar-label">Sort:</span>
          <button className={`fchip ${sortMode === "name"        ? "fchip-on" : ""}`} onClick={() => setSortMode("name")}>A-Z</button>
          <button className={`fchip ${sortMode === "ducats-owned"? "fchip-on" : ""}`} onClick={() => setSortMode("ducats-owned")}>Ducats owned</button>
          <button className={`fchip ${sortMode === "ducats-all"  ? "fchip-on" : ""}`} onClick={() => setSortMode("ducats-all")}>Ducats potential</button>
          <button className={`fchip ${sortMode === "completion"  ? "fchip-on" : ""}`} onClick={() => setSortMode("completion")}>% Complete</button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>{visibleSets.length} sets</span>
          <HelpTip items={[
            { swatch: "rgba(240,192,64,.5)", icon: "✓", label: "Complete set", desc: "Gold border + ✓ — all parts in inventory" },
            { icon: "+",  label: "+ Dupes",    desc: "Extra copies of at least one part" },
            { icon: "⚒",  label: "⚒ Building", desc: "Item is currently crafting in Foundry" },
          ]} />
        </div>
      </div>

      <div className="market-summary">
        <DucatIcon size={13} />
        <span><strong>{fmt(totalDucats)}</strong> total ducats (owned parts)</span>
        <span className="fbar-sep"/>
        <DucatIcon size={13} />
        <span><strong style={{ color: "#f0c040" }}>{fmt(dupeDucats)}</strong> from dupes</span>
        {wfmLoading && <span style={{ color: "var(--muted)", fontSize: 11 }}>· Connecting to warframe.market…</span>}
        {wfmError && <span style={{ color: "var(--red)", fontSize: 11 }}>· warframe.market unavailable</span>}
        {!wfmLoading && !wfmError && wfmItems.length > 0 && <span style={{ color: "var(--green)", fontSize: 11 }}>· {wfmItems.length.toLocaleString()} items from warframe.market</span>}
      </div>

      <div className="market-grid">
        {visibleSets.length === 0 ? (
          <div className="empty-msg" style={{ gridColumn: "1/-1" }}>No sets match. Adjust filters or own some prime parts first.</div>
        ) : visibleSets.map(([setKey, parts]) => {
          const setNormalKey = normalizeForWfm(setKey + " Set");
          const setUrl       = wfmLookup.get(setNormalKey) ?? setNormalKey;
          const parent       = parentItems.get(setKey) ?? parts[0];
          const setPriceData = prices.get(setUrl);
          const setParts: SetPart[] = [...parts]
            .sort((a, b) => {
              const qa = quantities[a.unique_name] ?? 0;
              const qb = quantities[b.unique_name] ?? 0;
              return qb - qa || a.name.localeCompare(b.name);
            })
            .map(p => {
              const normalKey = normalizeForWfm(p.name);
              const url = wfmLookup.get(normalKey) ?? normalKey;
              const priceData = prices.get(url);
              return { item: p, qty: quantities[p.unique_name] ?? 0,
                sellMedian: priceData?.sell_median, loading: loadingPrices.has(url), urlName: url };
            });
          return (
            <SetCard key={setKey} setKey={setKey} parts={setParts} parentItem={parent}
              setPrice={setPriceData}
              setPriceLoading={loadingPrices.has(setUrl)}
              pricesFetched={priceAges.size > 0}
              crafting={crafting}
              onCardClick={() => setPopup({ urlName: setUrl, displayName: setKey + " Set", imageName: parent?.image_name ?? undefined })}
              onPartClick={(urlName, displayName, imageName) => setPopup({ urlName, displayName, imageName })} />
          );
        })}
      </div>
      </>}

      {popup && (
        <ItemMarketPopup
          urlName={popup.urlName}
          displayName={popup.displayName}
          imageName={popup.imageName}
          onClose={() => setPopup(null)}
          isLoggedIn={!!wfmUsername}
          myUsername={wfmUsername ?? undefined}
        />
      )}
    </div>
  );
}
