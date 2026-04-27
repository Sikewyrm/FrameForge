import { useState, useEffect, useMemo, useCallback, useRef, Component, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Foundry from "./Foundry";
import MarketHelper from "./MarketHelper";
import RelicHelper from "./RelicHelper";
import { HelpTip } from "./HelpTip";
import "./App.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  constructor(props: any) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(e: Error) { return { err: e.message }; }
  render() {
    if (this.state.err)
      return <div style={{ padding: 24, color: "#f85149", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
        <strong>Render error:</strong>{"\n"}{this.state.err}
      </div>;
    return this.props.children;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CatalogItem {
  unique_name: string;
  name: string;
  category: string;
  image_name?: string;
  vaulted?: boolean | null;
  mastery_req?: number | null;
}

interface QuantityChange {
  id: number;
  unique_name: string;
  item_name: string;
  old_qty: number;
  new_qty: number;
  delta: number;
  timestamp: number;
}

interface CraftingJob {
  unique_name: string;
  item_name: string;
  completion_ms: number;
}

interface ModCopy {
  uniqueName: string;
  rank: number | null; // null = raw (RawUpgrades), number = from Upgrades (0 = installed-unranked)
  count: number;
}

interface InventoryUpdate {
  quantities: Record<string, number>;
  crafting: CraftingJob[];
  mastery_rank?: number;
  mastery_data?: Record<string, number>;
  changes: QuantityChange[];
  warframe_running: boolean;
  scanned_at: number;
}

type Module = "inventory" | "foundry" | "market" | "relics";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "all",        label: "All Owned" },
  { id: "Resources",  label: "Resources" },
  { id: "Mods",       label: "Mods" },
  { id: "Relics",     label: "Relics" },
  { id: "Arcanes",    label: "Arcanes" },
  { id: "Warframes",  label: "Warframes" },
  { id: "Primary",    label: "Primary" },
  { id: "Secondary",  label: "Secondary" },
  { id: "Melee",      label: "Melee" },
  { id: "Companions", label: "Companions" },
  { id: "Archwing",   label: "Archwing" },
  { id: "Blueprints", label: "Blueprints" },
  { id: "Misc",       label: "Miscellaneous" },
];

function BlueprintIcon() {
  return (
    <svg className="item-img-fallback" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="2" width="17" height="22" rx="1.5" fill="#0d1f33" stroke="#388bfd" strokeWidth="1.2"/>
      <path d="M18 2 L22 6 L18 6 Z" fill="#388bfd" opacity="0.5"/>
      <line x1="8" y1="11" x2="19" y2="11" stroke="#388bfd" strokeWidth="1" opacity="0.9"/>
      <line x1="8" y1="14" x2="19" y2="14" stroke="#388bfd" strokeWidth="1" opacity="0.9"/>
      <line x1="8" y1="17" x2="14" y2="17" stroke="#388bfd" strokeWidth="1" opacity="0.9"/>
      <circle cx="23" cy="23" r="6" fill="#0d1117" stroke="#388bfd" strokeWidth="1.2"/>
      <line x1="23" y1="20" x2="23" y2="26" stroke="#388bfd" strokeWidth="1.2"/>
      <line x1="20" y1="23" x2="26" y2="23" stroke="#388bfd" strokeWidth="1.2"/>
    </svg>
  );
}

function ItemImg({ imageName, category, size = 32 }: { imageName?: string; category: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, flexShrink: 0 as const };
  if (!imageName || failed) {
    if (category === "Blueprints") return <BlueprintIcon />;
    return <span className="item-img-fallback" style={{ ...style, fontSize: size * 0.35 }}>{category[0].toUpperCase()}</span>;
  }
  return (
    <img
      className="item-img"
      style={style}
      src={`https://cdn.warframestat.us/img/${imageName}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}


function fmt(n: number) { return n.toLocaleString(); }
function deltaClass(d: number) { return d > 0 ? "delta-pos" : "delta-neg"; }
function deltaText(d: number) { return d > 0 ? `+${fmt(d)}` : fmt(d); }
function timeStr(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeModule, setActiveModule] = useState<Module>("inventory");

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [apiQuantities, setApiQuantities] = useState<Record<string, number>>({});
  const [apiModCopies, setApiModCopies] = useState<ModCopy[]>([]);
  const [crafting, setCrafting] = useState<CraftingJob[]>([]);
  const [masteryRank, setMasteryRank] = useState<number | null>(null);
  const [masteryData, setMasteryData] = useState<Record<string, number>>({});
  const [wfConnected, setWfConnected] = useState(false);
  const [lastApiRefresh, setLastApiRefresh] = useState<number | null>(null);
  const wfConnectedRef = useRef(false);
  const catalogRef = useRef<CatalogItem[]>([]);
  const prevApiQtyRef = useRef<Record<string, number>>({});
  const manualCredsRef = useRef<{ accountId: string; nonce: string } | null>(null);
  const [changeLog, setChangeLog] = useState<QuantityChange[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [filterOwned,    setFilterOwned]    = useState(false);
  const [filterRecent,   setFilterRecent]   = useState(false);
  const [filterPrime,    setFilterPrime]    = useState(false);
  const [filterVaulted,  setFilterVaulted]  = useState(false);
  const [filterUnvaulted,setFilterUnvaulted]= useState(false);
  const [sortMode, setSortMode] = useState<"qty-desc" | "qty-asc" | "name-asc" | "name-desc" | "recent">("qty-desc");
  const [filterRank, setFilterRank] = useState<number | "unranked" | null>(null);
  const [lastChanged, setLastChanged] = useState<Record<string, number>>({});
  const [monitoring, setMonitoring] = useState(false);
  const [warframeRunning, setWarframeRunning] = useState(false);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [itemCount, setItemCount] = useState(0);
  const [recipeCount, setRecipeCount] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [clearMsg, setClearMsg] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualNonce, setManualNonce] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [itemsRefreshKey, setItemsRefreshKey] = useState(0);

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  useEffect(() => {
    // Restore cached API data so mods/arcanes survive restarts without Warframe running
    try {
      const savedQty = localStorage.getItem("ff-api-quantities");
      if (savedQty) setApiQuantities(JSON.parse(savedQty));
      const savedMods = localStorage.getItem("ff-api-mod-copies");
      if (savedMods) setApiModCopies(JSON.parse(savedMods));
    } catch {}

    invoke<CatalogItem[]>("get_all_items").then(items => { setCatalog(items); catalogRef.current = items; });
    invoke<Record<string, number>>("get_current_quantities").then(setQuantities);
    invoke<QuantityChange[]>("get_change_log", { limit: 200 }).then(log => {
      setChangeLog(log);
      const lc: Record<string, number> = {};
      for (const c of log) lc[c.unique_name] = Math.max(lc[c.unique_name] ?? 0, c.timestamp);
      setLastChanged(lc);
    });
    invoke<{ count: number; recipe_count: number }>("get_item_list_status").then(s => {
      setItemCount(s.count);
      setRecipeCount(s.recipe_count);
    });

    // Auto-start monitor on launch so scanning begins immediately
    invoke<boolean>("get_monitor_status").then(active => {
      if (!active) {
        invoke("start_monitor").then(() => setMonitoring(true)).catch(() => {});
      } else {
        setMonitoring(true);
      }
    });
  }, []);

  // ── Inventory update events ────────────────────────────────────────────────

  useEffect(() => {
    const unlisten = listen<InventoryUpdate>("inventory-update", (e) => {
      const p = e.payload;
      setQuantities(p.quantities);
      if (p.crafting) setCrafting(p.crafting);
      if (p.mastery_rank != null) setMasteryRank(p.mastery_rank);
      if (p.mastery_data && Object.keys(p.mastery_data).length > 0)
        setMasteryData(prev => ({ ...prev, ...p.mastery_data }));
      setWarframeRunning(p.warframe_running);
      setLastScan(p.scanned_at);
      if (p.changes.length > 0) {
        setChangeLog(prev => [...p.changes, ...prev].slice(0, 200));
        setLastChanged(prev => {
          const next = { ...prev };
          for (const c of p.changes) next[c.unique_name] = c.timestamp;
          return next;
        });
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // ── Monitor toggle ─────────────────────────────────────────────────────────

  const toggleMonitor = useCallback(async () => {
    if (monitoring) {
      await invoke("stop_monitor");
      setMonitoring(false);
    } else {
      await invoke("start_monitor");
      setMonitoring(true);
    }
  }, [monitoring]);

  // ── Fetch item list ────────────────────────────────────────────────────────

  const handleFetch = async () => {
    setFetching(true);
    setFetchMsg("Fetching…");
    // Stop monitor during refresh so it restarts with the new item list
    const wasMonitoring = monitoring;
    if (wasMonitoring) {
      await invoke("stop_monitor");
      setMonitoring(false);
    }
    try {
      const count = await invoke<number>("fetch_item_list");
      setItemCount(count);
      const items = await invoke<CatalogItem[]>("get_all_items");
      setCatalog(items);
      catalogRef.current = items;
      const status = await invoke<{ count: number; recipe_count: number }>("get_item_list_status");
      setRecipeCount(status.recipe_count);
      setFetchMsg(`Loaded ${count.toLocaleString()} items, ${status.recipe_count.toLocaleString()} recipes`);
      setItemsRefreshKey(k => k + 1);
    } catch (e) {
      setFetchMsg(`Error: ${e}`);
    } finally {
      setFetching(false);
      if (wasMonitoring) {
        await invoke("start_monitor");
        setMonitoring(true);
      }
    }
  };

  // ── Warframe API: process inventory response ──────────────────────────────

  const applyInventoryData = useCallback((data: any) => {
    const apiQty: Record<string, number> = {};
    const ownedArrayKeys = [
      "Suits", "LongGuns", "Pistols", "Melee",
      "Sentinels", "SentinelWeapons",
      "SpaceSuits", "SpaceGuns", "SpaceMelee",
      "MechSuits", "KubrowPets",
      "CrewShipWeapons", "OperatorAmps", "OperatorSuits",
    ];
    for (const key of ownedArrayKeys) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const t: string = item.ItemType;
        if (t) apiQty[t] = (apiQty[t] ?? 0) + 1;
      }
    }
    for (const r of (Array.isArray(data.Recipes) ? data.Recipes : [])) {
      const t: string = r.ItemType;
      if (t) apiQty[t] = (apiQty[t] ?? 0) + (r.ItemCount ?? 1);
    }
    // MiscItems: only pull relics (refinement-specific paths like /Relics/O/LithO7Bronze)
    for (const m of (Array.isArray(data.MiscItems) ? data.MiscItems : [])) {
      const t: string = m.ItemType;
      if (t && t.includes("/Relics/")) apiQty[t] = (apiQty[t] ?? 0) + (m.ItemCount ?? 1);
    }
    const rawModMap: Record<string, number> = {};
    for (const r of (Array.isArray(data.RawUpgrades) ? data.RawUpgrades : [])) {
      if (r.ItemType) rawModMap[r.ItemType] = (rawModMap[r.ItemType] ?? 0) + (r.ItemCount ?? 1);
    }
    const rankedModMap: Record<string, Record<number, number>> = {};
    for (const u of (Array.isArray(data.Upgrades) ? data.Upgrades : [])) {
      if (!u.ItemType) continue;
      let rank = 0;
      try { if (u.UpgradeFingerprint) rank = JSON.parse(u.UpgradeFingerprint)?.lvl ?? 0; } catch { rank = 0; }
      if (!rankedModMap[u.ItemType]) rankedModMap[u.ItemType] = {};
      rankedModMap[u.ItemType][rank] = (rankedModMap[u.ItemType][rank] ?? 0) + 1;
    }
    const copies: ModCopy[] = [];
    for (const [t, cnt] of Object.entries(rawModMap)) {
      copies.push({ uniqueName: t, rank: null, count: cnt });
      apiQty[t] = (apiQty[t] ?? 0) + cnt;
    }
    for (const [t, ranks] of Object.entries(rankedModMap)) {
      apiQty[t] = (apiQty[t] ?? 0) + Object.values(ranks).reduce((a, b) => a + b, 0);
      for (const [r, cnt] of Object.entries(ranks)) {
        copies.push({ uniqueName: t, rank: Number(r), count: cnt });
      }
    }
    setApiModCopies(copies);
    setApiQuantities(apiQty);
    if (data.PlayerLevel != null) setMasteryRank(data.PlayerLevel);

    // XPInfo from API → fill mastery data for items no longer owned (memory scanner can't see these)
    if (Array.isArray(data.XPInfo)) {
      const xpMastery: Record<string, number> = {};
      for (const x of data.XPInfo) {
        if (!x.ItemType || x.XP == null) continue;
        // ~30 000 XP per rank; cap at 30
        xpMastery[x.ItemType] = Math.min(30, Math.floor(x.XP / 30_000));
      }
      // Memory-scanner values win (they read actual rank); XP fills the gaps
      setMasteryData(prev => ({ ...xpMastery, ...prev }));
    }

    // PendingRecipes from API → update crafting state (authoritative, covers cases memory scanner misses)
    if (Array.isArray(data.PendingRecipes) && data.PendingRecipes.length > 0) {
      const apiJobs: CraftingJob[] = data.PendingRecipes
        .filter((r: any) => r.ItemType)
        .map((r: any) => {
          const completionMs = r.CompletionDate?.$date?.$numberLong
            ? Number(r.CompletionDate.$date.$numberLong)
            : 0;
          const item = catalogRef.current.find(i => i.unique_name === r.ItemType);
          const name = item?.name ?? r.ItemType.split("/").pop() ?? r.ItemType;
          return { unique_name: r.ItemType, item_name: name, completion_ms: completionMs };
        });
      setCrafting(prev => {
        const merged = [...apiJobs];
        for (const job of prev) {
          if (!merged.some(c => c.unique_name === job.unique_name)) merged.push(job);
        }
        return merged;
      });
    }
    const now = Math.floor(Date.now() / 1000);
    setLastApiRefresh(now);

    // Diff against previous API quantities to generate change log entries
    const prev = prevApiQtyRef.current;
    if (Object.keys(prev).length > 0) {
      const allKeys = new Set([...Object.keys(prev), ...Object.keys(apiQty)]);
      const changes: QuantityChange[] = [];
      for (const key of allKeys) {
        const oldQty = prev[key] ?? 0;
        const newQty = apiQty[key] ?? 0;
        if (oldQty !== newQty) {
          const item = catalogRef.current.find(i => i.unique_name === key);
          const name = item?.name ?? key.split("/").pop() ?? key;
          changes.push({ id: 0, unique_name: key, item_name: name, old_qty: oldQty, new_qty: newQty, delta: newQty - oldQty, timestamp: now });
        }
      }
      if (changes.length > 0) {
        setChangeLog(prev => [...changes, ...prev].slice(0, 200));
        setLastChanged(prev => {
          const next = { ...prev };
          for (const c of changes) next[c.unique_name] = c.timestamp;
          return next;
        });
      }
    }
    prevApiQtyRef.current = { ...apiQty };
  }, []); // eslint-disable-line

  // ── Persist API data to localStorage so it survives restarts ────────────

  useEffect(() => {
    if (Object.keys(apiQuantities).length > 0)
      localStorage.setItem("ff-api-quantities", JSON.stringify(apiQuantities));
  }, [apiQuantities]);

  useEffect(() => {
    if (apiModCopies.length > 0)
      localStorage.setItem("ff-api-mod-copies", JSON.stringify(apiModCopies));
  }, [apiModCopies]);

  // ── Auto-refresh API every 30 s (starts immediately on mount) ────────────

  useEffect(() => {
    const doFetch = async () => {
      let accountId = "", nonce = "", steamId = "";
      try {
        [accountId, nonce, steamId] = await invoke<[string, string, string]>("scan_warframe_credentials");
      } catch {
        // Memory scan failed — fall back to manually entered credentials if available
        const mc = manualCredsRef.current;
        if (!mc) return;
        accountId = mc.accountId; nonce = mc.nonce; steamId = "";
      }
      try {
        const data = await invoke<any>("fetch_warframe_inventory", { accountId, nonce, steamId });
        applyInventoryData(data);
        setWfConnected(true);
        wfConnectedRef.current = true;
      } catch { /* API call failed — retry next tick */ }
    };
    doFetch();
    const id = setInterval(doFetch, 30_000);
    return () => clearInterval(id);
  }, [applyInventoryData]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const mergedQty = useMemo(
    () => ({ ...quantities, ...apiQuantities }),
    [quantities, apiQuantities]
  );

  const modCopiesMap = useMemo(() => {
    const map: Record<string, ModCopy[]> = {};
    for (const c of apiModCopies) {
      if (!map[c.uniqueName]) map[c.uniqueName] = [];
      map[c.uniqueName].push(c);
    }
    // Sort each entry: highest rank first, then rank-0, then raw (null)
    for (const copies of Object.values(map)) {
      copies.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));
    }
    return map;
  }, [apiModCopies]);

  const inventorySynced = Object.keys(mergedQty).length > 0;

  const availableRanks = useMemo(() => {
    const set = new Set<number>();
    for (const c of apiModCopies) if (c.rank !== null && c.rank > 0) set.add(c.rank);
    return [...set].sort((a, b) => a - b);
  }, [apiModCopies]);

  const categoryCounts = useMemo(() => {
    const owned: Record<string, number> = { all: 0 };
    const total: Record<string, number> = { all: catalog.length };
    for (const item of catalog) {
      total[item.category] = (total[item.category] ?? 0) + 1;
      if ((mergedQty[item.unique_name] ?? 0) > 0) {
        owned.all = (owned.all ?? 0) + 1;
        owned[item.category] = (owned[item.category] ?? 0) + 1;
      }
    }
    return { owned, total };
  }, [catalog, mergedQty]);

  const visibleItems = useMemo(() => {
    const q = search.toLowerCase();
    return catalog
      .filter(i => category === "all" || i.category === category)
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .filter(i => !filterOwned    || (mergedQty[i.unique_name] ?? 0) > 0)
      .filter(i => !filterRecent   || lastChanged[i.unique_name] != null)
      .filter(i => !filterPrime    || i.name.includes("Prime") || i.vaulted != null)
      .filter(i => !filterVaulted  || i.vaulted === true)
      .filter(i => !filterUnvaulted|| i.vaulted === false)
      .filter(i => {
        if (filterRank === null) return true;
        const isMod = i.category === "Mods" || i.category === "Arcanes";
        if (!isMod) return true;
        const copies = modCopiesMap[i.unique_name];
        if (!copies) return false;
        if (filterRank === "unranked") return copies.some(c => c.rank === null || c.rank === 0);
        return copies.some(c => c.rank === filterRank);
      })
      .map(i => ({ ...i, qty: mergedQty[i.unique_name] ?? 0 }))
      .sort((a, b) => {
        if (sortMode === "recent") {
          const at = lastChanged[a.unique_name] ?? 0;
          const bt = lastChanged[b.unique_name] ?? 0;
          return bt - at || a.name.localeCompare(b.name);
        }
        const aOwned = a.qty > 0 ? 1 : 0;
        const bOwned = b.qty > 0 ? 1 : 0;
        if (bOwned !== aOwned) return bOwned - aOwned;
        if (sortMode === "name-asc")  return a.name.localeCompare(b.name);
        if (sortMode === "name-desc") return b.name.localeCompare(a.name);
        if (sortMode === "qty-asc")   return a.qty - b.qty || a.name.localeCompare(b.name);
        return b.qty - a.qty || a.name.localeCompare(b.name);
      })
      .slice(0, 1000);
  }, [catalog, mergedQty, category, search, filterOwned, filterRecent, filterPrime, filterVaulted, filterUnvaulted, filterRank, sortMode, lastChanged, modCopiesMap]); // eslint-disable-line

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shell">

      {/* ── Header ── */}
      <header className="header">
        <span className="header-title">FrameForge</span>
        {masteryRank !== null && (
          <span className="mastery-badge" title="Mastery Rank">MR {masteryRank}</span>
        )}
        <div className="header-right">
          {lastScan && (
            <span className="scan-time">Last scan {timeStr(lastScan)}</span>
          )}
          <span
            className={`wf-dot ${warframeRunning ? "wf-on" : "wf-off"}`}
            title={warframeRunning ? "Warframe detected" : "Warframe not running"}
          />
          {wfConnected && lastApiRefresh && (
            <span className="api-badge" title="Warframe API — auto-refreshes every 30s">⚡ API {timeStr(lastApiRefresh)}</span>
          )}
          <button
            className={`btn-monitor ${monitoring ? "active" : ""}`}
            onClick={toggleMonitor}
          >
            {monitoring ? "⏹ Stop" : "▶ Start monitor"}
          </button>
          <button
            className="btn-discord"
            title="Join our Discord"
            onClick={() => invoke("plugin:opener|open_url", { url: "https://discord.gg/7NMsN9J8vy" }).catch(() => {})}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            Discord
          </button>
          <button className="btn-settings" title="Settings" onClick={() => { setShowSettings(true); setClearMsg(""); }}>⚙</button>
        </div>
      </header>

      {/* ── Settings modal ── */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-header">
              <span className="settings-title">Settings</span>
              <button className="craft-detail-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <div className="settings-body">

              <div className="settings-section">
                <div className="settings-section-title">Data</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Clear Cache</span>
                    <span className="settings-row-desc">Reset all scanned quantities and change log. Does not remove the item database.</span>
                  </div>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      try {
                        await invoke("clear_cache");
                        setQuantities({});
                        setChangeLog([]);
                        setLastChanged({});
                        setClearMsg("Cache cleared.");
                      } catch (e) {
                        setClearMsg(`Error: ${e}`);
                      }
                    }}
                  >
                    Clear Cache
                  </button>
                </div>
                {clearMsg && <div className="settings-msg">{clearMsg}</div>}
              </div>

              <div className="settings-section">
                <div className="settings-section-title">Item Database</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Refresh Item List</span>
                    <span className="settings-row-desc">{itemCount.toLocaleString()} items · {recipeCount.toLocaleString()} recipes cached</span>
                  </div>
                  <button className="btn-secondary" onClick={() => { setShowSettings(false); handleFetch(); }} disabled={fetching}>
                    {fetching ? "Fetching…" : "Refresh"}
                  </button>
                </div>
                {fetchMsg && <div className="settings-msg">{fetchMsg}</div>}
              </div>

              <div className="settings-section">
                <div className="settings-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  Manual Account Connection
                  <HelpTip items={[
                    { icon: "1.", label: "Find your Account ID", desc: 'Open warframe.com → Log in → open browser DevTools (F12) → Network tab → filter for "api.warframe.com" → look for a request with accountId= in the URL or body. It is a 24-character hex string.' },
                    { icon: "2.", label: "Find your Nonce", desc: 'Same request — look for Nonce= (a 10-digit number). It changes every login session, so re-enter it when it stops working.' },
                    { icon: "⚠", label: "Security", desc: "Credentials are stored only in memory for this session and never written to disk. They are sent only to api.warframe.com over HTTPS." },
                    { icon: "🔄", label: "Auto-refresh", desc: "Once connected, data refreshes every 30 seconds using your saved credentials — no need to re-enter each time (until the Nonce expires)." },
                  ]} />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, lineHeight: 1.5 }}>
                  For Xbox / PlayStation players whose credentials can't be read from PC memory.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input className="foundry-search" placeholder="Account ID (24-char hex)" value={manualId}
                    onChange={e => setManualId(e.target.value)} style={{ width: "100%", fontSize: 12 }} />
                  <input className="foundry-search" type="password" placeholder="Nonce (10-digit number)" value={manualNonce}
                    onChange={e => setManualNonce(e.target.value)} style={{ width: "100%", fontSize: 12 }} />
                  <button className="btn-secondary" style={{ alignSelf: "flex-start" }}
                    disabled={manualId.length < 10 || manualNonce.length < 4}
                    onClick={async () => {
                      setManualMsg("Connecting…");
                      try {
                        const id = manualId.trim();
                        const nc = manualNonce.trim();
                        const data = await invoke<any>("fetch_warframe_inventory", {
                          accountId: id, nonce: nc, steamId: ""
                        });
                        // Store in memory-only ref for auto-refresh — never written to disk
                        manualCredsRef.current = { accountId: id, nonce: nc };
                        applyInventoryData(data);
                        setWfConnected(true);
                        wfConnectedRef.current = true;
                        setManualMsg("Connected. Auto-refresh active every 30 s.");
                      } catch (e) { setManualMsg(`Failed: ${e}`); }
                    }}>Connect manually</button>
                </div>
                {manualMsg && <div className="settings-msg" style={{ color: manualMsg.startsWith("F") ? "var(--red)" : "var(--green)" }}>{manualMsg}</div>}
              </div>

              <div className="settings-section">
                <div className="settings-section-title">Monitor</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Memory Scanner</span>
                    <span className="settings-row-desc">{monitoring ? "Running — scans every 10 seconds" : "Stopped"}</span>
                  </div>
                  <button className={`btn-secondary ${monitoring ? "btn-danger" : ""}`} onClick={() => { toggleMonitor(); }}>
                    {monitoring ? "Stop" : "Start"}
                  </button>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      <div className="body">

        {/* ── Module navigation ── */}
        <nav className="module-nav">
          <button
            className={`module-btn ${activeModule === "inventory" ? "module-active" : ""}`}
            onClick={() => setActiveModule("inventory")}
            title="Inventory"
          >
            <img src="/inventory-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Inventory</span>
          </button>
          <button
            className={`module-btn ${activeModule === "foundry" ? "module-active" : ""}`}
            onClick={() => setActiveModule("foundry")}
            title="Foundry"
          >
            <img src="/foundry-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Foundry</span>
          </button>
          <button
            className={`module-btn ${activeModule === "market" ? "module-active" : ""}`}
            onClick={() => setActiveModule("market")}
            title="Market Helper"
          >
            <span className="module-icon">💰</span>
            <span className="module-label">Market</span>
          </button>
          <button
            className={`module-btn ${activeModule === "relics" ? "module-active" : ""}`}
            onClick={() => setActiveModule("relics")}
            title="Relic Helper"
          >
            <img src="/relic-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Relics</span>
          </button>
        </nav>

        {/* ── Inventory module ── */}
        {activeModule === "inventory" && (
          <>
            <aside className="sidebar">
              <div className="sidebar-section-label">Categories</div>
              {CATEGORIES.map(cat => {
                const owned = categoryCounts.owned[cat.id] ?? 0;
                const total = categoryCounts.total[cat.id] ?? 0;
                return (
                  <button
                    key={cat.id}
                    className={`cat-btn ${category === cat.id ? "cat-active" : ""}`}
                    onClick={() => setCategory(cat.id)}
                  >
                    <span className="cat-label">{cat.label}</span>
                    <span className="cat-count">
                      {owned > 0 ? <span className="cat-owned">{owned}</span> : null}
                      {owned > 0 && <span className="cat-sep">/</span>}
                      <span className="cat-total">{total}</span>
                    </span>
                  </button>
                );
              })}
              <div className="sidebar-divider" />
              <div className="sidebar-section-label">Item Database</div>
              <div className="db-count">{itemCount.toLocaleString()} items · {recipeCount.toLocaleString()} recipes</div>
              <button className="btn-fetch" onClick={handleFetch} disabled={fetching}>
                {fetching ? "Fetching…" : "Refresh item list"}
              </button>
              {fetchMsg && <div className="fetch-msg">{fetchMsg}</div>}
            </aside>

            <div className="main">
              {monitoring && warframeRunning && !inventorySynced && (
                <div className="sync-banner">
                  Inventory not synced yet — complete a mission or visit a relay to load your inventory
                </div>
              )}

              <div className="toolbar">
                <input
                  className="search-box"
                  placeholder="Search items…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="filter-bar">
                <button className={`fchip ${filterOwned?"fchip-on":""}`} onClick={()=>setFilterOwned(v=>!v)}>Owned</button>
                <button className={`fchip ${filterRecent?"fchip-on":""}`} onClick={()=>setFilterRecent(v=>!v)}>Recent</button>
                <button className={`fchip ${filterPrime?"fchip-on":""}`} onClick={()=>setFilterPrime(v=>!v)}>Prime</button>
                <button className={`fchip ${filterVaulted?"fchip-on":""}`} onClick={()=>setFilterVaulted(v=>!v)}>🔒 Vaulted</button>
                <button className={`fchip ${filterUnvaulted?"fchip-on":""}`} onClick={()=>setFilterUnvaulted(v=>!v)}>🔓 Unvaulted</button>
                {apiModCopies.length > 0 && (<>
                  <span className="fbar-sep"/>
                  <span className="fbar-label">Rank:</span>
                  <button className={`fchip ${filterRank==="unranked"?"fchip-on":""}`} onClick={()=>setFilterRank(v=>v==="unranked"?null:"unranked")}>Unranked</button>
                  {availableRanks.map(r=>(
                    <button key={r} className={`fchip ${filterRank===r?"fchip-on":""}`} onClick={()=>setFilterRank(v=>v===r?null:r)}>R{r}</button>
                  ))}
                </>)}
                <span className="fbar-sep"/>
                <span className="fbar-label">Sort:</span>
                <button className={`fchip ${sortMode==="qty-desc"?"fchip-on":""}`} onClick={()=>setSortMode("qty-desc")}>Qty ↓</button>
                <button className={`fchip ${sortMode==="qty-asc"?"fchip-on":""}`} onClick={()=>setSortMode("qty-asc")}>Qty ↑</button>
                <button className={`fchip ${sortMode==="name-asc"?"fchip-on":""}`} onClick={()=>setSortMode("name-asc")}>A-Z</button>
                <button className={`fchip ${sortMode==="name-desc"?"fchip-on":""}`} onClick={()=>setSortMode("name-desc")}>Z-A</button>
                <button className={`fchip ${sortMode==="recent"?"fchip-on":""}`} onClick={()=>setSortMode("recent")}>Recent</button>
                <span className="item-count-label" style={{marginLeft:"auto"}}>{visibleItems.length} item{visibleItems.length!==1?"s":""}{visibleItems.length===1000?" (capped)":""}</span>
                <HelpTip items={[
                  { icon: "★",  label: "★ above image",  desc: "Mastered — item levelled to rank 30" },
                  { icon: "R5", label: "R{n} above image", desc: "Current rank, not yet mastered" },
                  { icon: "⚒",  label: "⚒ on image",      desc: "Currently building in Foundry" },
                  { swatch: "rgba(63,185,80,.35)",  label: "Green left border", desc: "Recently gained" },
                  { swatch: "rgba(248,81,73,.35)",  label: "Red left border",   desc: "Recently lost / used" },
                ]} />
              </div>

              <div className="item-grid">
                {visibleItems.length === 0 ? (
                  <div className="empty-msg" style={{gridColumn:"1/-1"}}>
                    {monitoring
                      ? "No items found. Complete a mission or visit a relay to sync inventory."
                      : "Start the monitor to begin tracking your inventory."}
                  </div>
                ) : (
                  visibleItems.flatMap(item => {
                    // Mods & Arcanes: expand into per-rank cards when API data available
                    if ((item.category === "Mods" || item.category === "Arcanes") && modCopiesMap[item.unique_name]) {
                      let copies = modCopiesMap[item.unique_name];
                      if (filterRank !== null) {
                        copies = copies.filter(c =>
                          filterRank === "unranked" ? (c.rank === null || c.rank === 0) : c.rank === filterRank
                        );
                      }
                      if (copies.length === 0) return [];
                      return copies.map(copy => {
                        const rankLabel = (copy.rank === null || copy.rank === 0) ? "Unranked" : `R${copy.rank}`;
                        return (
                          <div key={`${item.unique_name}|${copy.rank ?? "raw"}`} className="inv-card">
                            <div className="inv-mastery-row">
                              <span className="rank-badge">{rankLabel}</span>
                            </div>
                            <div className="inv-card-img-wrap">
                              <ItemImg imageName={item.image_name} category={item.category} size={48} />
                            </div>
                            <div className="inv-card-name">{item.name}</div>
                            <div className={`inv-card-qty`}>{fmt(copy.count)}</div>
                          </div>
                        );
                      });
                    }

                    // Normal item card
                    const nowSec = Date.now() / 1000;
                    const changedAt = lastChanged[item.unique_name];
                    const secAgo = changedAt ? nowSec - changedAt : null;
                    const isRecent = secAgo !== null && secAgo < 300;
                    const recentChange = isRecent ? changeLog.find(c => c.unique_name === item.unique_name) : null;
                    const craftJob = crafting.find(c => c.unique_name === item.unique_name);
                    const isZero = item.qty === 0 && !craftJob;
                    const itemRank = masteryData[item.unique_name];
                    const isMastered = itemRank != null && itemRank >= 30;
                    const showRank = itemRank != null && itemRank > 0;
                    return [(
                      <div key={item.unique_name}
                        className={`inv-card ${isZero ? "inv-card-zero" : ""} ${isRecent ? (recentChange && recentChange.delta > 0 ? "inv-card-gained" : "inv-card-lost") : ""}`}>
                        {/* Fixed-height mastery slot — always present so image stays at same vertical position */}
                        <div className="inv-mastery-row">
                          {isMastered
                            ? <span className="inv-mastery-star" title="Mastered">★</span>
                            : showRank
                              ? <span className="inv-mastery-rank" title={`Rank ${itemRank}`}>R{itemRank}</span>
                              : null}
                        </div>
                        {/* Image with overlaid foundry badge */}
                        <div className="inv-card-img-wrap">
                          <ItemImg imageName={item.image_name} category={item.category} size={48} />
                          {craftJob && <span className="inv-foundry-icon" title={`Building — ${craftJob.item_name}`}>⚒</span>}
                        </div>
                        {/* Name */}
                        <div className="inv-card-name">
                          {item.name}
                          {isRecent && secAgo !== null && (
                            <span className="item-updated">{Math.floor(secAgo / 60) === 0 ? "· now" : `· ${Math.floor(secAgo / 60)}m`}</span>
                          )}
                        </div>
                        {/* Quantity + recent delta */}
                        <div className={`inv-card-qty ${isZero ? "inv-card-qty-zero" : ""}`}>
                          {fmt(item.qty)}
                          {isRecent && recentChange && (
                            <span className={`item-delta ${deltaClass(recentChange.delta)}`}>{deltaText(recentChange.delta)}</span>
                          )}
                        </div>
                      </div>
                    )];
                  })
                )}
              </div>

              <div className="log-panel">
                <div className="log-header">Change log</div>
                <div className="log-list">
                  {changeLog.length === 0 ? (
                    <span className="log-empty">No changes recorded yet.</span>
                  ) : (
                    changeLog.map((c, i) => (
                      <div key={c.id || i} className="log-row">
                        <span className="log-name">{c.item_name}</span>
                        <span className={`log-delta ${deltaClass(c.delta)}`}>{deltaText(c.delta)}</span>
                        <span className="log-range">{fmt(c.old_qty)} → {fmt(c.new_qty)}</span>
                        <span className="log-time">{timeStr(c.timestamp)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Foundry module ── */}
        {activeModule === "foundry" && (
          <Foundry quantities={mergedQty} masteryData={masteryData} refreshKey={itemsRefreshKey} crafting={crafting} />
        )}

        {/* ── Market Helper module ── */}
        {activeModule === "market" && (
          <MarketHelper quantities={mergedQty} refreshKey={itemsRefreshKey} crafting={crafting} />
        )}

        {/* ── Relic Helper module ── */}
        {activeModule === "relics" && (
          <ErrorBoundary>
            <RelicHelper quantities={mergedQty} apiQuantities={apiQuantities} masteryData={masteryData} refreshKey={itemsRefreshKey} />
          </ErrorBoundary>
        )}

      </div>
    </div>
  );
}
