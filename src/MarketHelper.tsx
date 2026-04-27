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

interface WfmItem { item_name: string; url_name: string; }
interface WfmPrice { url_name: string; sell_median?: number; }

interface CraftingJob { unique_name: string; item_name: string; completion_ms: number; }

interface Props {
  quantities: Record<string, number>;
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

interface SetPart { item: CatalogItem; qty: number; sellMedian?: number; loading: boolean; }

function SetCard({ setKey, parts, parentItem, setPrice, setPriceLoading, pricesFetched, crafting }: {
  setKey: string; parts: SetPart[]; parentItem?: CatalogItem;
  setPrice?: WfmPrice; setPriceLoading: boolean; pricesFetched: boolean;
  crafting: CraftingJob[];
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
      <div className="market-card-left">
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
          return (
            <div key={part.item.unique_name} className={`market-part-row${qty === 0 ? " part-missing" : ""}`}>
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

export default function MarketHelper({ quantities, refreshKey, crafting }: Props) {
  const [allItems, setAllItems]         = useState<CatalogItem[]>([]);
  const [wfmItems, setWfmItems]         = useState<WfmItem[]>([]);
  const [wfmLoading, setWfmLoading]     = useState(false);
  const [wfmError, setWfmError]         = useState(false);
  const [prices, setPrices]             = useState<Map<string, WfmPrice>>(new Map());
  const [loadingPrices, setLoadingPrices] = useState<Set<string>>(new Set());
  const [fetchedSets, setFetchedSets]   = useState<Set<string>>(new Set());
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

  useEffect(() => {
    setWfmLoading(true);
    setWfmError(false);
    fetch("https://api.warframe.market/v1/items", {
      headers: { "Accept": "application/json", "Platform": "pc" }
    })
      .then(r => r.json())
      .then(d => {
        const items: WfmItem[] = (d?.payload?.items ?? []).map((i: any) => ({
          item_name: i.item_name, url_name: i.url_name
        }));
        setWfmItems(items);
        if (!items.length) setWfmError(true);
      })
      .catch(() => setWfmError(true))
      .finally(() => setWfmLoading(false));
  }, []);

  const wfmLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of wfmItems) map.set(normalizeForWfm(w.item_name), w.url_name);
    return map;
  }, [wfmItems]);

  const primeItems = useMemo(() =>
    allItems.filter(i => i.name.includes("Prime") && i.ducats != null),
  [allItems]);

  const parentItems = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const i of allItems) {
      if (i.name.includes("Prime") && ["Warframes","Primary","Secondary","Melee","Companions","Archwing"].includes(i.category))
        map.set(i.name, i);
    }
    return map;
  }, [allItems]);

  const sets = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const item of primeItems) {
      const key = setName(item.name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [primeItems]);

  const totalDucats = useMemo(() =>
    primeItems.reduce((s, i) => s + (i.ducats ?? 0) * (quantities[i.unique_name] ?? 0), 0),
  [primeItems, quantities]);

  const dupeDucats = useMemo(() =>
    primeItems.reduce((s, i) => s + (i.ducats ?? 0) * Math.max(0, (quantities[i.unique_name] ?? 0) - 1), 0),
  [primeItems, quantities]);

  const fetchPricesForSet = useCallback(async (setKey: string, parts: CatalogItem[]) => {
    if (fetchedSets.has(setKey)) return;
    setFetchedSets(prev => new Set(prev).add(setKey));
    const urls: string[] = [];
    const setUrl = wfmLookup.get(normalizeForWfm(setKey + " Set"));
    if (setUrl) urls.push(setUrl);
    for (const p of parts) {
      const url = wfmLookup.get(normalizeForWfm(p.name));
      if (url && !urls.includes(url)) urls.push(url);
    }
    setLoadingPrices(prev => { const n = new Set(prev); urls.forEach(u => n.add(u)); return n; });
    await Promise.all(urls.map(async (urlName) => {
      try {
        const r = await fetch(
          `https://api.warframe.market/v1/items/${urlName}/statistics`,
          { headers: { "Accept": "application/json", "Platform": "pc" } }
        );
        const d = await r.json();
        const h48: any[] = d?.payload?.statistics_closed?.["48hours"] ?? [];
        const h90: any[] = d?.payload?.statistics_closed?.["90days"] ?? [];
        const last = h48.length ? h48[h48.length - 1] : h90.length ? h90[h90.length - 1] : null;
        const sell_median = last?.median ?? undefined;
        setPrices(prev => new Map(prev).set(urlName, { url_name: urlName, sell_median }));
      } catch {}
      setLoadingPrices(prev => { const n = new Set(prev); n.delete(urlName); return n; });
    }));
  }, [wfmLookup, fetchedSets]);

  const ownedSetCount = useMemo(() =>
    Array.from(sets.entries()).filter(([_, p]) => p.some(i => (quantities[i.unique_name] ?? 0) > 0)).length,
  [sets, quantities]);

  useEffect(() => {
    if (wfmLookup.size === 0 || ownedSetCount === 0) return;
    const ownedSets = Array.from(sets.entries())
      .filter(([_, parts]) => parts.some(p => (quantities[p.unique_name] ?? 0) > 0));
    let i = 0;
    const fetchBatch = async () => {
      const batch = ownedSets.slice(i, i + 5);
      if (batch.length === 0) return;
      i += 5;
      await Promise.all(batch.map(([key, parts]) => fetchPricesForSet(key, parts)));
      if (i < ownedSets.length) setTimeout(fetchBatch, 600);
    };
    fetchBatch();
  }, [wfmLookup.size, ownedSetCount]); // eslint-disable-line

  const visibleSets = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(sets.entries())
      .filter(([key]) => !q || key.toLowerCase().includes(q))
      .filter(([key, parts]) => {
        const ownedAny    = parts.some(p => (quantities[p.unique_name] ?? 0) > 0);
        const hasDupes    = parts.some(p => (quantities[p.unique_name] ?? 0) > 1);
        const isComplete  = parts.every(p => (quantities[p.unique_name] ?? 0) > 0);
        const parent      = parentItems.get(key);
        const isFullOwned = parent ? (quantities[parent.unique_name] ?? 0) > 0 : false;
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
            { swatch: "rgba(240,192,64,.4)",  label: "Gold card border",  desc: "All parts owned — complete set" },
            { icon: "✓",  label: "✓ Complete badge", desc: "All prime parts are in your inventory" },
            { icon: "+",  label: "+ Dupes badge",    desc: "You own extra copies of at least one part" },
            { icon: "⚒",  label: "⚒ Foundry badge",  desc: "The item is currently building" },
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
          const setUrl     = wfmLookup.get(normalizeForWfm(setKey + " Set"));
          const parent     = parentItems.get(setKey) ?? parts[0];
          const setPriceData = setUrl ? prices.get(setUrl) : undefined;
          const setParts: SetPart[] = [...parts]
            .sort((a, b) => {
              const qa = quantities[a.unique_name] ?? 0;
              const qb = quantities[b.unique_name] ?? 0;
              return qb - qa || a.name.localeCompare(b.name);
            })
            .map(p => {
              const url = wfmLookup.get(normalizeForWfm(p.name));
              const priceData = url ? prices.get(url) : undefined;
              return { item: p, qty: quantities[p.unique_name] ?? 0,
                sellMedian: priceData?.sell_median, loading: url ? loadingPrices.has(url) : false };
            });
          return (
            <SetCard key={setKey} setKey={setKey} parts={setParts} parentItem={parent}
              setPrice={setPriceData}
              setPriceLoading={setUrl ? loadingPrices.has(setUrl) : false}
              pricesFetched={fetchedSets.has(setKey)}
              crafting={crafting} />
          );
        })}
      </div>
    </div>
  );
}
