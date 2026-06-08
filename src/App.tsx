import { useState, useEffect, useMemo, useCallback, useRef, Component, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

// ── Riven overlay — module-level window management ────────────────────────────
// Stored OUTSIDE React so StrictMode remounts don't destroy/recreate the window.
let _rivenWin: WebviewWindow | null = null;
let _rivenRollCount = 0;
let _rivenLastTriggerMs = 0;
let _rivenManualTrigger: (() => void) | null = null;
export function checkRivenNow() { _rivenManualTrigger?.(); }

function rivenWinHide(reason = "rivenWinHide") {
  const win = _rivenWin;
  if (!win) { return; }
  invoke("ocr_riven_log_error", { error: `[HIDE] ${reason}` }).catch(() => {});
  _rivenWin = null;
  win.close().catch(() => {});
}

async function ensureRivenWindow(wx: number, wy: number, wh: number): Promise<{ win: WebviewWindow; fresh: boolean } | null> {
  // 1. Existing valid handle
  if (_rivenWin) return { win: _rivenWin, fresh: false };

  // 2. Window exists but JS lost reference (HMR, page reload)
  const existing = await WebviewWindow.getByLabel("riven-overlay").catch(() => null);
  if (existing) {
    _rivenWin = existing;
    _rivenWin.once("tauri://destroyed", () => { _rivenWin = null; });
    return { win: _rivenWin, fresh: false };
  }

  // 3. Create fresh at correct position — shows immediately
  try {
    _rivenWin = new WebviewWindow("riven-overlay", {
      url: `index.html?rivenoverlay`,
      title: "FrameForge Riven",
      transparent: true, decorations: false,
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focus: false,
      x: wx + 10, y: wy + Math.round(wh * 0.20),
      width: 300, height: Math.round(wh * 0.60),
    });
    _rivenWin.once("tauri://destroyed", () => { _rivenWin = null; });
    return { win: _rivenWin, fresh: true };
  } catch {
    _rivenWin = null;
    return null;
  }
}
import { getCurrentWindow } from "@tauri-apps/api/window";

import Foundry from "./Foundry";
import MarketHelper from "./MarketHelper";
import RelicHelper from "./RelicHelper";
import RivenAnalyzer from "./RivenAnalyzer";
import RivenOverlayWindow from "./RivenOverlayWindow";
import TimerHelper, { FissureWatch } from "./TimerHelper";
import Statistics from "./Statistics";
import Overlay from "./Overlay";
import ModularWindow from "./ModularWindow";
import { HelpTip } from "./HelpTip";
import "./App.css";

const _params = new URLSearchParams(window.location.search);
// If the URL contains ?overlay, render the overlay instead of the main app
const IS_OVERLAY       = _params.has("overlay");
const IS_MODULAR       = _params.has("modular");
const IS_RIVEN_OVERLAY = _params.has("rivenoverlay");

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

type Module = "inventory" | "foundry" | "market" | "relics" | "rivens" | "timers" | "statistics";

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
  { id: "Parts",      label: "Parts" },
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

// ─── Standalone modular window page (runs in pop-out Tauri window) ────────────

function ModularWindowPage() {
  const [tracked, setTracked] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [timerFavorites, setTimerFavorites] = useState<string[]>([]);
  const [fissureWatches, setFissureWatches] = useState<FissureWatch[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [sectionOrder, setSectionOrder] = useState<string[]>(["tracking", "favorites", "timers", "fissures"]);

  useEffect(() => {
    invoke<string>("load_settings").then(json => {
      if (!json) return;
      try {
        const s = JSON.parse(json);
        if (Array.isArray(s.tracked)) setTracked(s.tracked);
        if (Array.isArray(s.favorites)) setFavorites(s.favorites);
        if (Array.isArray(s.timerFavorites)) setTimerFavorites(s.timerFavorites);
        if (Array.isArray(s.fissureWatches)) setFissureWatches(s.fissureWatches);
        if (Array.isArray(s.modularSectionOrder)) {
          const order: string[] = s.modularSectionOrder;
          if (!order.includes("timers"))   order.push("timers");
          if (!order.includes("fissures")) order.push("fissures");
          setSectionOrder(order);
        }
      } catch {}
    }).catch(() => {});
    invoke<CatalogItem[]>("get_all_items").then(setCatalog).catch(() => {});
    invoke<Record<string, number>>("get_current_quantities").then(setQuantities).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<InventoryUpdate>("inventory-update", e => {
      setQuantities(e.payload.quantities);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("settings-updated", () => {
      invoke<string>("load_settings").then(json => {
        if (!json) return;
        try {
          const s = JSON.parse(json);
          if (Array.isArray(s.tracked)) setTracked(s.tracked);
          if (Array.isArray(s.favorites)) setFavorites(s.favorites);
          if (Array.isArray(s.timerFavorites)) setTimerFavorites(s.timerFavorites);
          if (Array.isArray(s.fissureWatches)) setFissureWatches(s.fissureWatches);
          if (Array.isArray(s.modularSectionOrder)) setSectionOrder(s.modularSectionOrder);
        } catch {}
      }).catch(() => {});
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const saveModularSettings = useCallback((patch: object) => {
    invoke("save_settings", { json: JSON.stringify(patch) }).catch(() => {});
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let t: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        Promise.all([win.outerPosition(), win.outerSize()]).then(([pos, size]) => {
          saveModularSettings({
            modularWinX: pos.x, modularWinY: pos.y,
            modularWinWidth: size.width, modularWinHeight: size.height,
          });
        }).catch(() => {});
      }, 400);
    };
    const unlistenMove = win.onMoved(save);
    const unlistenResize = win.onResized(save);
    return () => {
      if (t) clearTimeout(t);
      unlistenMove.then(fn => fn());
      unlistenResize.then(fn => fn());
    };
  }, [saveModularSettings]);

  const handleTrackedChange = (next: string[]) => {
    setTracked(next);
    saveModularSettings({ tracked: next });
  };
  const handleUntrack = (id: string) => {
    const next = tracked.filter(i => i !== id);
    setTracked(next);
    saveModularSettings({ tracked: next });
  };
  const handleFavoritesChange = (next: string[]) => {
    setFavorites(next);
    saveModularSettings({ favorites: next });
  };
  const handleUnfavorite = (id: string) => {
    const next = favorites.filter(i => i !== id);
    setFavorites(next);
    saveModularSettings({ favorites: next });
  };
  const handleSectionOrderChange = (next: string[]) => {
    setSectionOrder(next);
    saveModularSettings({ modularSectionOrder: next });
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--surface)", overflow: "hidden" }}>
      <ModularWindow
        tracked={tracked}
        onTrackedChange={handleTrackedChange}
        onUntrack={handleUntrack}
        favorites={favorites}
        onFavoritesChange={handleFavoritesChange}
        onUnfavorite={handleUnfavorite}
        timerFavorites={timerFavorites}
        onTimerFavoritesChange={setTimerFavorites}
        onTimerUnfavorite={id => setTimerFavorites(prev => prev.filter(x => x !== id))}
        fissureWatches={fissureWatches}
        quantities={quantities}
        catalog={catalog}
        sectionOrder={sectionOrder}
        onSectionOrderChange={handleSectionOrderChange}
      />
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

// RelicAndRivenTab is kept but now just shows RelicHelper — Rivens moved to own tab

export default function App() {
  // If we're the overlay window, render only the overlay UI
  if (IS_OVERLAY) return <Overlay />;
  if (IS_RIVEN_OVERLAY) return <RivenOverlayWindow />;
  // If we're the pop-out modular window, render the standalone modular UI
  if (IS_MODULAR) return <ModularWindowPage />;

  const [activeModule, setActiveModule] = useState<Module>("inventory");

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [apiQuantities, setApiQuantities] = useState<Record<string, number>>({});
  const [apiModCopies, setApiModCopies] = useState<ModCopy[]>([]);
  const [crafting, setCrafting] = useState<CraftingJob[]>([]);
  const [masteryRank, setMasteryRank] = useState<number | null>(null);
  const [masteryData, setMasteryData] = useState<Record<string, number>>({});
  const [wfConnected, setWfConnected] = useState(false);
  const [companionApiEnabled, setCompanionApiEnabled] = useState(false);
  const [memoryScannerEnabled, setMemoryScannerEnabled] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState("");
  const [subsummedWarframes, setSubsummedWarframes] = useState<Set<string>>(new Set());
  const [archonShards, setArchonShards] = useState<Record<string, {type: string; tauforged: boolean; color: string; boost?: string}[]>>({});
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
  const [overlayEnabled, setOverlayEnabled] = useState<boolean>(
    () => localStorage.getItem("ff-overlay-enabled") !== "false"
  );
  const [overlayPriority, setOverlayPriority] = useState<string>(
    () => localStorage.getItem("ff-overlay-priority") ?? "completion"
  );
  const [clearMsg, setClearMsg] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [textScale, setTextScale] = useState(() => {
    const s = parseFloat(localStorage.getItem("ff-text-scale") ?? "1");
    document.documentElement.style.setProperty("--ff-scale", s.toString());
    return s;
  });
  const [colorblindMode, setColorblindMode] = useState(() =>
    localStorage.getItem("ff-colorblind") === "true"
  );
  const [manualId, setManualId] = useState("");
  const [manualNonce, setManualNonce] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [itemsRefreshKey, setItemsRefreshKey] = useState(0);

  // ── Modular Window state ───────────────────────────────────────────────────
  const [tracked, setTracked] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [timerFavorites, setTimerFavorites] = useState<string[]>([]);
  const [fissureWatches, setFissureWatches] = useState<FissureWatch[]>([]);
  const [modularWidth, setModularWidth] = useState(240);
  const [modularSectionOrder, setModularSectionOrder] = useState<string[]>(["tracking", "favorites", "timers", "fissures"]);
  const [modularPopout, setModularPopout] = useState(false);
  const modularWinRef = useRef<WebviewWindow | null>(null);
  const modularWinGeomRef = useRef<{ x?: number; y?: number; w?: number; h?: number }>({});

  // ── Settings helpers ──────────────────────────────────────────────────────
  // Refs so we can read the latest state in the save callback without stale closures
  const settingsLoadedRef = useRef(false);
  const settingsRef = useRef({
    overlayEnabled: true, overlayPriority: "completion", textScale: 1, colorblindMode: false, companionApiEnabled: false, memoryScannerEnabled: false,
    tracked: [] as string[], favorites: [] as string[], timerFavorites: [] as string[], fissureWatches: [] as FissureWatch[], modularWidth: 240,
    modularSectionOrder: ["tracking", "favorites", "timers"] as string[], modularPopout: false,
  });
  settingsRef.current = { overlayEnabled, overlayPriority, textScale, colorblindMode, companionApiEnabled, memoryScannerEnabled, tracked, favorites, timerFavorites, fissureWatches, modularWidth, modularSectionOrder, modularPopout };

  const saveAllSettings = useCallback(() => {
    invoke("save_settings", { json: JSON.stringify(settingsRef.current) }).catch(() => {});
  }, []); // eslint-disable-line

  // ── Memory scanner toggle ─────────────────────────────────────────────────
  useEffect(() => {
    if (memoryScannerEnabled) {
      invoke("start_monitor").then(() => setMonitoring(true)).catch(() => {});
    } else {
      invoke("stop_monitor").then(() => setMonitoring(false)).catch(() => {});
    }
  }, [memoryScannerEnabled]); // eslint-disable-line

  // ── Log watcher — always start regardless of memory scanner toggle ─────────
  // EE.log is plain file I/O (not memory reading) — handles riven detection,
  // trade completion, and WFM whisper detection unconditionally.
  useEffect(() => {
    invoke("start_log_watcher").catch(() => {});
  }, []); // eslint-disable-line

  // ── WFM auto-login at app start ───────────────────────────────────────────
  // Restores the session into Rust's AppState so the Trading tab is instantly
  // ready when the user opens it — no need to visit the tab first.
  // Also pre-warms the top-items cache in the background so the Statistics tab
  // loads instantly rather than running ~2 minutes of API calls on first open.
  useEffect(() => {
    (async () => {
      const creds = await invoke<[string, string] | null>("wfm_load_credentials").catch(() => null);
      if (creds) {
        invoke("wfm_set_jwt", { jwt: creds[1] }).catch(() => {}); // silent — failure just means re-login on tab open
      }
    })();
    // Fire-and-forget: populates WFM_TOP_CACHE so the Statistics tab is instant
    invoke("get_wfm_top_items").catch(() => {});
  }, []); // eslint-disable-line

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  useEffect(() => {
    // Restore cached API data so mods/arcanes survive restarts without Warframe running
    try {
      const savedQty = localStorage.getItem("ff-api-quantities");
      if (savedQty) setApiQuantities(JSON.parse(savedQty));
      const savedMods = localStorage.getItem("ff-api-mod-copies");
      if (savedMods) setApiModCopies(JSON.parse(savedMods));
    } catch {}

    // Load user settings from file — survives reinstalls unlike localStorage
    invoke<string>("load_settings").then(json => {
      if (!json) return;
      try {
        const s = JSON.parse(json);
        if (typeof s.companionApiEnabled === "boolean") setCompanionApiEnabled(s.companionApiEnabled);
        if (typeof s.memoryScannerEnabled === "boolean") setMemoryScannerEnabled(s.memoryScannerEnabled);
        if (typeof s.overlayEnabled === "boolean") {
          setOverlayEnabled(s.overlayEnabled);
          localStorage.setItem("ff-overlay-enabled", String(s.overlayEnabled));
        }
        if (typeof s.overlayPriority === "string") {
          setOverlayPriority(s.overlayPriority);
          localStorage.setItem("ff-overlay-priority", s.overlayPriority);
        }
        if (typeof s.textScale === "number") {
          setTextScale(s.textScale);
          document.documentElement.style.setProperty("--ff-scale", s.textScale.toString());
          localStorage.setItem("ff-text-scale", s.textScale.toString());
        }
        if (typeof s.colorblindMode === "boolean") {
          setColorblindMode(s.colorblindMode);
          localStorage.setItem("ff-colorblind", String(s.colorblindMode));
        }
        if (Array.isArray(s.tracked)) setTracked(s.tracked);
        if (Array.isArray(s.favorites)) setFavorites(s.favorites);
        if (Array.isArray(s.timerFavorites)) setTimerFavorites(s.timerFavorites);
        if (Array.isArray(s.fissureWatches)) setFissureWatches(s.fissureWatches);
        if (typeof s.modularWidth === "number") setModularWidth(s.modularWidth);
        if (Array.isArray(s.modularSectionOrder)) {
          const order: string[] = s.modularSectionOrder;
          if (!order.includes("timers"))   order.push("timers");
          if (!order.includes("fissures")) order.push("fissures");
          setModularSectionOrder(order);
        }
        if (typeof s.modularPopout === "boolean") setModularPopout(s.modularPopout);
        if (typeof s.modularWinX === "number") modularWinGeomRef.current.x = s.modularWinX;
        if (typeof s.modularWinY === "number") modularWinGeomRef.current.y = s.modularWinY;
        if (typeof s.modularWinWidth === "number") modularWinGeomRef.current.w = s.modularWinWidth;
        if (typeof s.modularWinHeight === "number") modularWinGeomRef.current.h = s.modularWinHeight;
        settingsLoadedRef.current = true;
      } catch {}
    }).catch(() => {});

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

    // Check for updates from GitHub
    getVersion().then(v => {
      setAppVersion(v);
      fetch("https://api.github.com/repos/Sikewyrm/FrameForge/releases/latest")
        .then(r => r.json())
        .then(d => {
          const latest = (d.tag_name ?? "").replace(/^v/, "");
          const semverGt = (a: string, b: string) => {
            const [ma, mi, pa] = a.split(".").map(Number);
            const [mb, mii, pb] = b.split(".").map(Number);
            if (ma !== mb) return ma > mb;
            if (mi !== mii) return mi > mii;
            return pa > pb;
          };
          if (latest && semverGt(latest, v)) setUpdateAvailable(latest);
        })
        .catch(() => {});
    }).catch(() => {});

    // Auto-start monitor on launch — only if memory scanner is explicitly enabled
    invoke<boolean>("get_monitor_status").then(active => {
      if (!active) {
        // memoryScannerEnabled not yet loaded from settings at this point;
        // the effect below handles delayed auto-start after settings load.
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
      // When Warframe restarts (was running → stopped → running again),
      // clear manual credentials so fresh ones are scanned from the new session
      if (!p.warframe_running && wfConnectedRef.current) {
        manualCredsRef.current = null;
      }
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

  // ── Sync modular state from pop-out window ────────────────────────────────
  // When the pop-out saves (unstar, reorder), Rust emits settings-updated.
  // Compare before setting to avoid a save → emit → re-read → save loop.
  useEffect(() => {
    const unlisten = listen("settings-updated", () => {
      invoke<string>("load_settings").then(json => {
        if (!json) return;
        try {
          const s = JSON.parse(json);
          const cur = settingsRef.current;
          if (Array.isArray(s.favorites) && JSON.stringify(s.favorites) !== JSON.stringify(cur.favorites))
            setFavorites(s.favorites);
          if (Array.isArray(s.tracked) && JSON.stringify(s.tracked) !== JSON.stringify(cur.tracked))
            setTracked(s.tracked);
          if (Array.isArray(s.modularSectionOrder) && JSON.stringify(s.modularSectionOrder) !== JSON.stringify(cur.modularSectionOrder))
            setModularSectionOrder(s.modularSectionOrder);
        } catch {}
      }).catch(() => {});
    });
    return () => { unlisten.then(fn => fn()); };
  }, []); // eslint-disable-line

  // ── Persist main window geometry on move/resize ───────────────────────────
  useEffect(() => {
    const win = getCurrentWindow();
    let t: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        Promise.all([win.outerPosition(), win.outerSize()]).then(([pos, size]) => {
          invoke("save_settings", { json: JSON.stringify({
            windowX: pos.x, windowY: pos.y,
            windowWidth: size.width, windowHeight: size.height,
          }) }).catch(() => {});
        }).catch(() => {});
      }, 400);
    };
    const unlistenMove = win.onMoved(save);
    const unlistenResize = win.onResized(save);
    return () => {
      if (t) clearTimeout(t);
      unlistenMove.then(fn => fn());
      unlistenResize.then(fn => fn());
    };
  }, []); // eslint-disable-line

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

  const toggleTracked = useCallback((id: string) => {
    setTracked(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);

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

  // Auto-refresh item database on every app start so the OCR catalog stays current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { handleFetch(); }, []);

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
    const masteryUpdate: Record<string, number> = {};
    for (const key of ownedArrayKeys) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const t: string = item.ItemType;
        if (!t) continue;
        apiQty[t] = (apiQty[t] ?? 0) + 1;
        // Extract mastery rank from XP field — 30,000 XP per rank, cap at 30
        if (item.XP != null) {
          masteryUpdate[t] = Math.min(30, Math.floor(item.XP / 30000));
        }
      }
    }
    if (Object.keys(masteryUpdate).length > 0)
      setMasteryData(prev => ({ ...prev, ...masteryUpdate }));
    for (const r of (Array.isArray(data.Recipes) ? data.Recipes : [])) {
      const t: string = r.ItemType;
      if (t) {
        apiQty[t] = (apiQty[t] ?? 0) + (r.ItemCount ?? 1);
      }
    }
    // MiscItems: pull everything (relics, resources like Carbides/Cubic Diodes, etc.)
    // so the API is authoritative and mission-pickup counts from the scanner don't override.
    for (const m of (Array.isArray(data.MiscItems) ? data.MiscItems : [])) {
      const t: string = m.ItemType;
      if (t) apiQty[t] = (apiQty[t] ?? 0) + (m.ItemCount ?? 1);
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

    // Extract Archon Shard data from Suits
    // API format: suit.ArchonCrystalUpgrades = [{Color: "ACC_YELLOW", UpgradeType: "/Lotus/.../ArchonCrystalUpgradeWarframeAbilityStrength"}, ...]
    const COLOR_MAP: Record<string, { type: string; color: string }> = {
      ACC_RED:     { type: "Crimson", color: "#ff3030" },
      ACC_ORANGE:  { type: "Amber",   color: "#ff8800" },
      ACC_BLUE:    { type: "Azure",   color: "#00aaff" },
      ACC_GREEN:   { type: "Emerald", color: "#00cc55" },
      ACC_YELLOW:  { type: "Topaz",   color: "#ffcc00" },
      ACC_VIOLET:  { type: "Violet",  color: "#9944ff" },
      ACC_PURPLE:  { type: "Violet",  color: "#9944ff" }, // fallback alias
    };
    const newShards: Record<string, { type: string; tauforged: boolean; color: string; boost: string }[]> = {};
    for (const suit of (Array.isArray(data.Suits) ? data.Suits : [])) {
      const upgrades = suit.ArchonCrystalUpgrades;
      if (!Array.isArray(upgrades) || upgrades.length === 0) continue;
      const uniqueName: string = suit.ItemType ?? "";
      if (!uniqueName) continue;
      newShards[uniqueName] = upgrades.map((u: any) => {
        const colorRaw: string = (u.Color ?? "").toUpperCase();
        const upgradeType: string = u.UpgradeType ?? "";
        const tauforged = colorRaw.includes("TAU") || upgradeType.toLowerCase().includes("tau");
        // Strip color prefix for map lookup (e.g. "ACC_YELLOW_TAUFORGED" → "ACC_YELLOW")
        const colorKey = Object.keys(COLOR_MAP).find(k => colorRaw.startsWith(k)) ?? "";
        const info = COLOR_MAP[colorKey] ?? { type: colorRaw || "Unknown", color: "#888" };
        // Extract boost name from UpgradeType path last segment
        const seg = upgradeType.split("/").pop() ?? "";
        const boost = seg
          .replace(/ArchonCrystalUpgrade(Warframe)?/g, "")
          .replace(/([A-Z])/g, " $1").trim();
        return { type: info.type, tauforged, color: info.color, boost };
      });
    }
    if (Object.keys(newShards).length > 0) setArchonShards(prev => ({ ...prev, ...newShards }));

    // Extract subsumed warframes from InfestedFoundry (Helminth)
    const consumed = data.InfestedFoundry?.ConsumedSuits;
    if (Array.isArray(consumed)) {
      const s = new Set<string>(
        consumed.map((e: any) => (typeof e === "string" ? e : e?.ItemType ?? "")).filter(Boolean)
      );
      setSubsummedWarframes(s);
    }

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

  useEffect(() => {
    if (settingsLoadedRef.current) saveAllSettings();
  }, [tracked, favorites, modularWidth, memoryScannerEnabled, companionApiEnabled, modularSectionOrder, modularPopout]); // eslint-disable-line

  // ── Modular pop-out window ─────────────────────────────────────────────────
  useEffect(() => {
    if (modularPopout) {
      if (modularWinRef.current) return;
      const g = modularWinGeomRef.current;
      const win = new WebviewWindow("modular-popout", {
        url: "index.html?modular",
        title: "FrameForge — Modular Window",
        width: g.w ?? modularWidth,
        height: g.h ?? 700,
        ...(g.x !== undefined ? { x: g.x } : {}),
        ...(g.y !== undefined ? { y: g.y } : {}),
        minWidth: 180,
        minHeight: 300,
        resizable: true,
        decorations: true,
        alwaysOnTop: false,
      });
      modularWinRef.current = win;
      win.once("tauri://destroyed", () => {
        modularWinRef.current = null;
        setModularPopout(false);
      });
    } else {
      modularWinRef.current?.close().catch(() => {});
      modularWinRef.current = null;
    }
  }, [modularPopout]); // eslint-disable-line

  // ── Auto-refresh API: 8 s while connecting, 30 s once connected ─────────

  useEffect(() => {
    if (!companionApiEnabled) {
      setWfConnected(false);
      wfConnectedRef.current = false;
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const doFetch = async () => {
      if (cancelled) return;
      let accountId = "", nonce = "", steamId = "";
      try {
        [accountId, nonce, steamId] = await invoke<[string, string, string]>("scan_warframe_credentials");
        // Cache successful auto-scan so fallback works if scan fails next time
        manualCredsRef.current = { accountId, nonce };
      } catch {
        // Scan failed — fall back to last known credentials (auto-scanned or manual)
        const mc = manualCredsRef.current;
        if (!mc) { schedule(); return; }
        accountId = mc.accountId; nonce = mc.nonce; steamId = "";
      }
      try {
        const data = await invoke<any>("fetch_warframe_inventory", { accountId, nonce, steamId });
        if (!cancelled) {
          applyInventoryData(data);
          setWfConnected(true);
          wfConnectedRef.current = true;
          setWarframeRunning(true);
        }
      } catch {
        // API rejected the credentials — clear cached creds so next scan starts fresh
        if (wfConnectedRef.current) {
          setWfConnected(false);
          wfConnectedRef.current = false;
          manualCredsRef.current = null;
        }
      }
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      timeoutId = setTimeout(doFetch, wfConnectedRef.current ? 30_000 : 8_000);
    };

    doFetch();
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [applyInventoryData, companionApiEnabled]); // eslint-disable-line

  // ── Riven overlay ─────────────────────────────────────────────────────────
  // Window state lives in module-level _rivenWin (above) — unaffected by StrictMode.
  // No pre-creation: show() silently fails on visible:false windows with this config.
  // Fresh window created on trigger (shows correctly); existing visible window reused for cycling.
  useEffect(() => {
    // Core OCR + overlay display. Called manually via button or (future) auto-detection.
    const runRivenCheck = async () => {
      _rivenLastTriggerMs = Date.now();
      _rivenRollCount++;
      const { emit } = await import("@tauri-apps/api/event");

      let rect: [number, number, number, number] = [0, 0, 0, 800];
      try { rect = await invoke<[number, number, number, number]>("get_warframe_window_rect"); } catch {}
      const [wx, wy, , wh] = rect;
      const result = await ensureRivenWindow(wx, wy, wh);
      let pendingPayload: object | null = null;
      let windowReady = false;

      if (result && !result.fresh) {
        // Existing window — reset overlay state
        await emit("riven-scanning-start", {}).catch(() => {});
        windowReady = true;
      } else if (result?.fresh) {
        // Fresh window — send data once its listener signals ready
        const unsubReady = await listen("riven-window-ready", async () => {
          unsubReady();
          windowReady = true;
          if (pendingPayload) { await emit("riven-analysis-update", pendingPayload).catch(() => {}); pendingPayload = null; }
        });
      }

      try {
        const ocrResult = await invoke<{ weapon: string; positives: string[]; negatives: string[]; rolled_stats: {name:string;value:string;positive:boolean}[]; is_comparison: boolean; original_rolled_stats: {name:string;value:string;positive:boolean}[]; raw: string }>("ocr_riven_screen");
        const analysis = (ocrResult.weapon || ocrResult.positives.length > 0)
          ? await invoke("analyze_riven", { weapon: ocrResult.weapon, positives: ocrResult.positives, negatives: ocrResult.negatives }).catch(() => null)
          : null;
        const payload = { analysis, ocrRaw: ocrResult.raw, weapon: ocrResult.weapon, positives: ocrResult.positives, negatives: ocrResult.negatives, rolledStats: ocrResult.rolled_stats, isComparison: ocrResult.is_comparison, originalStats: ocrResult.original_rolled_stats, rollCount: _rivenRollCount };
        if (windowReady) { await emit("riven-analysis-update", payload).catch(() => {}); }
        else              { pendingPayload = payload; }
      } catch (e) {
        await invoke("ocr_riven_log_error", { error: String(e) }).catch(() => {});
        const payload = { analysis: null, ocrRaw: `OCR ERROR: ${e}`, weapon: "", positives: [], negatives: [], rolledStats: [], isComparison: false, originalStats: [], rollCount: _rivenRollCount };
        if (windowReady) { await emit("riven-analysis-update", payload).catch(() => {}); }
        else              { pendingPayload = payload; }
      }
    };

    // Wire module-level trigger so "Check Riven" button and "Start Comparison" can call it
    _rivenManualTrigger = () => { runRivenCheck().catch(() => {}); };

    // overlay "Start Comparison" button emits this event
    const unsubManual = listen("riven-manual-check", () => runRivenCheck().catch(() => {}));

    // Open trigger: EE.log watcher fires "riven-screen-open" via FindFirstChangeNotificationW
    // (instant file-write notification — no polling delay).
    // 4 s cooldown prevents double-fires from the same log buffer flush.
    const triggerOpen = () => {
      const now = Date.now();
      if (now - _rivenLastTriggerMs < 4000) return;
      runRivenCheck().catch(() => {});
    };
    const unsubAutoDetect = listen("riven-screen-open", () => triggerOpen());

    // Close triggers: EE.log (DiegeticArtifactCards HudVis 0) + manual dismiss.
    const unsubClose   = listen("riven-screen-close",   () => rivenWinHide("screen-close"));
    const unsubHideReq = listen<{ reason?: string }>("riven-overlay-hide", e => rivenWinHide(e.payload?.reason ?? "overlay-hide"));

    return () => {
      unsubManual.then(fn => fn());
      unsubAutoDetect.then(fn => fn());
      unsubClose.then(fn => fn());
      unsubHideReq.then(fn => fn());
      _rivenManualTrigger = null;
    };
  }, []); // eslint-disable-line

  // ── Relic reward overlay ──────────────────────────────────────────────────
  useEffect(() => {
    let overlayWin: WebviewWindow | null = null;
    // Set to true when a dismiss arrives while the window is still being created.
    // Checked in tauri://created to close immediately instead of showing items.
    let dismissed   = false;
    // Pending items buffered if they arrive before tauri://created fires.
    let pendingItems: { items: string[]; positions: number[] } | null = null;

    const closeOverlay = () => {
      dismissed = true;
      pendingItems = null;
      if (overlayWin) {
        overlayWin.close().catch(() => {});
        overlayWin = null;
      }
    };

    const unsubStatus = listen<string>("ff-status", (e) => {
      setOverlayStatus(e.payload);
      setTimeout(() => setOverlayStatus(""), 4000);
    });

    // "relic-trigger" fires the moment EE.log detects the reward screen —
    // we pre-create the overlay window immediately so it's ready by the time
    // OCR finishes (window creation takes 1-2 s; OCR also takes ~700 ms).
    const unsubTrigger = listen<null>("relic-trigger", async () => {
      dismissed = false;
      pendingItems = null;
      const enabled = localStorage.getItem("ff-overlay-enabled") !== "false";
      if (overlayWin || !enabled) return;
      try {
        const rect = await invoke<[number, number, number, number]>("get_warframe_window_rect");
        const [wx, wy, ww, wh] = rect;
        const stripY = wy + Math.round(wh * 0.60);
        const stripH = Math.round(wh * 0.30);
        const pri    = localStorage.getItem("ff-overlay-priority") ?? "completion";
        overlayWin = new WebviewWindow("relic-overlay", {
          url: `index.html?overlay&ww=${ww}&wh=${wh}&priority=${pri}`,
          title: "FrameForge Overlay",
          transparent: true, decorations: false,
          alwaysOnTop: true, skipTaskbar: true,
          resizable: false, focus: false,
          x: wx, y: stripY, width: ww, height: stripH,
        });

        const _triggerWin = overlayWin;
        overlayWin.once("tauri://destroyed", () => { overlayWin = null; pendingItems = null; });
        overlayWin.once("tauri://created", async () => {
          await _triggerWin.setIgnoreCursorEvents(true).catch(() => {});
          if (dismissed) {
            // Dismiss arrived while window was being created — close immediately
            _triggerWin.close().catch(() => {});
            dismissed = false;
            overlayWin = null;
            return;
          }
          if (pendingItems) {
            // Items arrived before the window was ready — send them now
            const { emit } = await import("@tauri-apps/api/event");
            await emit("relic-rewards", pendingItems);
            pendingItems = null;
          }
        });
      } catch { /* Warframe not running */ }
    });

    const unsubRelic = listen<boolean>("relic-screen", () => { closeOverlay(); });

    const unsub = listen<{ items: string[]; positions: number[] } | null>("relic-rewards", async (e) => {
      const rewards = e.payload;

      if (rewards && rewards.items.length >= 1) {
        if (dismissed) return;
        const enabled = localStorage.getItem("ff-overlay-enabled") !== "false";
        if (!enabled) return;

        if (overlayWin) {
          // Window already exists (pre-created by relic-trigger or previous emit)
          const { emit } = await import("@tauri-apps/api/event");
          await emit("relic-rewards", rewards);
        } else {
          // relic-trigger didn't fire or window wasn't ready — create now as fallback
          pendingItems = rewards;
          try {
            const rect = await invoke<[number, number, number, number]>("get_warframe_window_rect");
            const [wx, wy, ww, wh] = rect;
            const stripY = wy + Math.round(wh * 0.54);
            const stripH = Math.round(wh * 0.28);
            const pri    = localStorage.getItem("ff-overlay-priority") ?? "completion";
            overlayWin = new WebviewWindow("relic-overlay", {
              url: `index.html?overlay&ww=${ww}&wh=${wh}&priority=${pri}`,
              title: "FrameForge Overlay",
              transparent: true, decorations: false,
              alwaysOnTop: true, skipTaskbar: true,
              resizable: false, focus: false,
              x: wx, y: stripY, width: ww, height: stripH,
            });
    
            const _fallbackWin = overlayWin;
            overlayWin.once("tauri://destroyed", () => { overlayWin = null; pendingItems = null; });
            overlayWin.once("tauri://created", async () => {
              await _fallbackWin.setIgnoreCursorEvents(true).catch(() => {});
              if (dismissed) { _fallbackWin.close().catch(() => {}); overlayWin = null; dismissed = false; return; }
              if (pendingItems) {
                const { emit } = await import("@tauri-apps/api/event");
                await emit("relic-rewards", pendingItems);
                pendingItems = null;
              }
            });
          } catch { /* Warframe not running */ }
        }
      } else {
        // Null = dismiss. Close overlay or set flag if window still being created.
        closeOverlay();
      }
    });

    return () => {
      unsub.then(fn => fn());
      unsubRelic.then(fn => fn());
      unsubTrigger.then(fn => fn());
      unsubStatus.then(fn => fn());
      if (overlayWin) { overlayWin.close(); overlayWin = null; }
    };
  }, []);

  // ── Derived data ───────────────────────────────────────────────────────────

  const mergedQty = useMemo(() => {
    // Strip blueprint paths from scanner data before merging.
    // /Lotus/Types/Recipes/ paths appear in mission memory when items drop —
    // they cannot be reliably distinguished from real inventory.
    // The Warframe API's Recipes field is the authoritative source for blueprints.
    const scannerFiltered = Object.fromEntries(
      Object.entries(quantities).filter(([k]) => !k.includes("/Types/Recipes/"))
    );
    return { ...scannerFiltered, ...apiQuantities };
  }, [quantities, apiQuantities]);

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

  // Total counts only depend on the catalog — stable until item list is refreshed.
  const categoryTotals = useMemo(() => {
    const total: Record<string, number> = { all: catalog.length };
    for (const item of catalog) total[item.category] = (total[item.category] ?? 0) + 1;
    return total;
  }, [catalog]);

  // Owned counts depend on quantities — recalculates every inventory scan.
  const categoryOwned = useMemo(() => {
    const owned: Record<string, number> = { all: 0 };
    for (const item of catalog) {
      if ((mergedQty[item.unique_name] ?? 0) > 0) {
        owned.all++;
        owned[item.category] = (owned[item.category] ?? 0) + 1;
      }
    }
    return owned;
  }, [catalog, mergedQty]);

  const categoryCounts = useMemo(
    () => ({ owned: categoryOwned, total: categoryTotals }),
    [categoryOwned, categoryTotals]
  );

  const visibleItems = useMemo(() => {
    const q = search.toLowerCase();
    const out: (CatalogItem & { qty: number })[] = [];
    for (const i of catalog) {
      if (i.name === "Blueprint") continue;
      if (category !== "all" && i.category !== category) continue;
      if (q && !i.name.toLowerCase().includes(q)) continue;
      const qty = mergedQty[i.unique_name] ?? 0;
      if (filterOwned    && qty === 0) continue;
      if (filterRecent   && lastChanged[i.unique_name] == null) continue;
      if (filterPrime    && !i.name.includes("Prime") && i.vaulted == null) continue;
      if (filterVaulted  && i.vaulted !== true) continue;
      if (filterUnvaulted && i.vaulted !== false) continue;
      if (filterRank !== null) {
        if (i.category === "Mods" || i.category === "Arcanes") {
          const copies = modCopiesMap[i.unique_name];
          if (!copies) continue;
          if (filterRank === "unranked") {
            if (!copies.some(c => c.rank === null || c.rank === 0)) continue;
          } else {
            if (!copies.some(c => c.rank === filterRank)) continue;
          }
        }
      }
      out.push({ ...i, qty });
    }
    out.sort((a, b) => {
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
    });
    return out.slice(0, 1000);
  }, [catalog, mergedQty, category, search, filterOwned, filterRecent, filterPrime, filterVaulted, filterUnvaulted, filterRank, sortMode, lastChanged, modCopiesMap]); // eslint-disable-line

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shell">

      {/* ── Header ── */}
      <header className="header">
        <span className="header-title">FrameForge</span>
          {updateAvailable && (
            <a
              className="update-badge"
              title={`v${updateAvailable} available — click to download`}
              onClick={() => invoke("plugin:opener|open_url", { url: "https://github.com/Sikewyrm/FrameForge/releases/latest" }).catch(() => {})}
            >⬆ v{updateAvailable}</a>
          )}
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
          {!memoryScannerEnabled && (
            <span style={{ fontSize: 10, color: "#f0c040", background: "rgba(240,192,64,.1)", border: "1px solid rgba(240,192,64,.3)", borderRadius: 3, padding: "1px 7px", cursor: "pointer" }}
              title="Memory Scanner is disabled. Enable it in Settings to track inventory."
              onClick={() => setShowSettings(true)}>
              Scanner off
            </span>
          )}
          {overlayStatus && (
            <span style={{ fontSize: 11, color: '#9ecaed', marginLeft: 6,
              background: 'rgba(100,160,220,0.12)', padding: '2px 6px',
              borderRadius: 3, fontFamily: 'monospace' }}>
              {overlayStatus}
            </span>
          )}
          {wfConnected && lastApiRefresh && (
            <span className="api-badge" title="Warframe API — auto-refreshes every 30s">⚡ API {timeStr(lastApiRefresh)}</span>
          )}
          {!wfConnected && warframeRunning && companionApiEnabled && (
            <span
              className="api-badge"
              style={{ color: "var(--muted)", cursor: "pointer" }}
              title="Click to retry credential scan now"
              onClick={async () => {
                try {
                  const [accountId, nonce, steamId] = await invoke<[string, string, string]>("scan_warframe_credentials");
                  const data = await invoke<any>("fetch_warframe_inventory", { accountId, nonce, steamId });
                  applyInventoryData(data);
                  setWfConnected(true);
                  wfConnectedRef.current = true;
                  manualCredsRef.current = { accountId, nonce };
                } catch (e) {
                  alert(`Credential scan failed:\n${e}\n\nMake sure you are in the Orbiter (not in a mission or loading screen).`);
                }
              }}
            >⚡ Connecting… (click to retry)</span>
          )}
          <button
            className={`btn-monitor ${monitoring ? "active" : ""}`}
            onClick={memoryScannerEnabled ? toggleMonitor : undefined}
            disabled={!memoryScannerEnabled}
            title={!memoryScannerEnabled ? "Enable Memory Scanner in Settings first" : undefined}
          >
            {monitoring ? "⏹ Stop" : "▶ Start monitor"}
          </button>
          <button
            className="btn-icon-brand btn-discord"
            title="Join our Discord"
            onClick={() => invoke("plugin:opener|open_url", { url: "https://discord.gg/7NMsN9J8vy" }).catch(() => {})}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
          </button>
          <button
            className="btn-icon-brand btn-kofi"
            title="Support on Ko-Fi"
            onClick={() => invoke("plugin:opener|open_url", { url: "https://ko-fi.com/sikewyrm" }).catch(() => {})}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 2.833.723 4.311zm6.173.478c-.928.116-1.218-.443-1.218-.443s.001-1.929 0-2.535c-.003-.434-.423-.782-.857-.782-.434 0-.836.348-.836.782v3.09c0 .434.402.782.836.782.434 0 .857-.026.857-.026s-.038.639.525.98c.562.341 1.423.231 1.423.231 1.302-.269 2.023-1.63 1.27-2.079z"/>
            </svg>
          </button>
          <button className="btn-settings" title="Settings" onClick={() => {
              setShowSettings(true); setClearMsg("");
              getVersion().then(v => setAppVersion(v)).catch(() => {});
            }}>⚙</button>
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

              {/* ── Relic Overlay ── */}
              <div className="settings-section">
                <div className="settings-section-title">Relic Overlay</div>
                {overlayStatus && (
                  <div style={{ fontSize: 12, padding: '4px 8px', marginBottom: 6,
                    background: 'rgba(255,255,255,0.05)', borderRadius: 4,
                    color: '#9ecaed', fontFamily: 'monospace' }}>
                    {overlayStatus}
                  </div>
                )}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Overlay</span>
                    <span className="settings-row-desc">Show the reward overlay when a Void Fissure reward screen is detected.</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ minWidth: 64, background: overlayEnabled ? "rgba(56,139,253,.15)" : undefined, borderColor: overlayEnabled ? "var(--accent)" : undefined }}
                    onClick={() => {
                      const next = !overlayEnabled;
                      setOverlayEnabled(next);
                      localStorage.setItem("ff-overlay-enabled", String(next));
                      settingsRef.current = { ...settingsRef.current, overlayEnabled: next };
                      saveAllSettings();
                      // If turning Off while overlay is open, close it immediately
                      if (!next) {
                        import("@tauri-apps/api/event").then(({ emit }) =>
                          emit("relic-screen", true).catch(() => {})
                        );
                      }
                    }}
                  >{overlayEnabled ? "On" : "Off"}</button>
                </div>
                <div className="settings-row" style={{ marginTop: 8 }}>
                  <div className="settings-row-info">
                    <span className="settings-row-label">Pick priority</span>
                    <span className="settings-row-desc">Which card the overlay arrow highlights as the best pick.</span>
                  </div>
                  <select
                    className="settings-select"
                    value={overlayPriority}
                    disabled={!overlayEnabled}
                    onChange={e => {
                      const next = e.target.value;
                      setOverlayPriority(next);
                      localStorage.setItem("ff-overlay-priority", next);
                      settingsRef.current = { ...settingsRef.current, overlayPriority: next };
                      saveAllSettings();
                    }}
                  >
                    <option value="completion">Item Completion</option>
                    <option value="setPlat">Most Set Value (plat)</option>
                    <option value="plat">Most Plat (item)</option>
                    <option value="ducat">Most Ducats</option>
                  </select>
                </div>
              </div>

              {/* ── Accessibility ── */}
              <div className="settings-section">
                <div className="settings-section-title">Accessibility</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Colorblind Mode</span>
                    <span className="settings-row-desc">Adds ✓ / ✓✓ checkmarks to colored reward boxes in Relics so status is clear without relying on color alone.</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ minWidth: 64, background: colorblindMode ? "rgba(56,139,253,.15)" : undefined, borderColor: colorblindMode ? "var(--accent)" : undefined }}
                    onClick={() => {
                      const next = !colorblindMode;
                      setColorblindMode(next);
                      localStorage.setItem("ff-colorblind", String(next));
                      settingsRef.current = { ...settingsRef.current, colorblindMode: next };
                      saveAllSettings();
                    }}
                  >{colorblindMode ? "On" : "Off"}</button>
                </div>
                <div className="settings-row" style={{ marginTop: 8 }}>
                  <div className="settings-row-info">
                    <span className="settings-row-label">Text Size</span>
                    <span className="settings-row-desc">{Math.round(textScale * 100)}%</span>
                  </div>
                  <input type="range" min="0.8" max="1.4" step="0.05" value={textScale}
                    style={{ width: 120 }}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      setTextScale(v);
                      document.documentElement.style.setProperty("--ff-scale", v.toString());
                      localStorage.setItem("ff-text-scale", v.toString());
                      settingsRef.current = { ...settingsRef.current, textScale: v };
                      saveAllSettings();
                    }} />
                </div>
              </div>

              {/* ── Memory scanner toggle ── */}
              <div className="settings-section" style={{ borderColor: memoryScannerEnabled ? "rgba(240,192,64,.3)" : undefined }}>
                <div className="settings-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  Memory Scanner
                  <span style={{ fontSize: 10, background: "rgba(240,192,64,.15)", color: "#f0c040", border: "1px solid rgba(240,192,64,.35)", borderRadius: 3, padding: "1px 6px", fontWeight: 700 }}>
                    EULA GREY AREA
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, lineHeight: 1.6 }}>
                  Uses the Windows <code style={{ fontSize: 10 }}>ReadProcessMemory</code> API to read your live inventory,
                  crafting jobs, and mod ranks directly from the Warframe process.
                  DE's EULA broadly prohibits <em>"automation programs that interact with the Services in any way"</em> —
                  this may technically fall under that clause. DE has historically tolerated read-only tools,
                  but has not given explicit permission.
                </div>
                <div style={{ background: "rgba(240,192,64,.07)", border: "1px solid rgba(240,192,64,.25)", borderRadius: 5, padding: "8px 10px", marginBottom: 10, fontSize: 11, color: "#f0c040", lineHeight: 1.5 }}>
                  ⚠ Enabling this is at your own risk. We are awaiting official clarification from Digital Extremes.
                  The app works without it — Foundry, Market Helper, Relic Helper, Timers, and Trading all function fully.
                </div>
                <div className="settings-row">
                  <div>
                    <span className="settings-row-label">Enable Memory Scanner</span>
                    <span className="settings-row-desc">Required for live inventory, quantity tracking, and mod ranks</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ minWidth: 64, background: memoryScannerEnabled ? "rgba(240,192,64,.15)" : undefined, borderColor: memoryScannerEnabled ? "#f0c040" : undefined, color: memoryScannerEnabled ? "#f0c040" : undefined }}
                    onClick={() => setMemoryScannerEnabled(v => !v)}
                  >
                    {memoryScannerEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>

              {/* ── Companion API toggle ── */}
              <div className="settings-section" style={{ borderColor: companionApiEnabled ? "rgba(240,192,64,.3)" : undefined }}>
                <div className="settings-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  Warframe Companion API
                  <span style={{ fontSize: 10, background: "rgba(240,192,64,.15)", color: "#f0c040", border: "1px solid rgba(240,192,64,.35)", borderRadius: 3, padding: "1px 6px", fontWeight: 700 }}>
                    UNOFFICIAL
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, lineHeight: 1.6 }}>
                  Connects to <code style={{ fontSize: 10 }}>api.warframe.com/api/inventory.php</code> to add mod ranks and extra inventory detail.
                  DE has not officially confirmed this is permitted for third-party tools.
                  The app works fully without it — memory scanning handles all core inventory.
                </div>
                <div style={{ background: "rgba(240,192,64,.07)", border: "1px solid rgba(240,192,64,.25)", borderRadius: 5, padding: "8px 10px", marginBottom: 10, fontSize: 11, color: "#f0c040", lineHeight: 1.5 }}>
                  ⚠ Enabling this is at your own risk. We are awaiting official clarification from Digital Extremes.
                </div>
                <div className="settings-row">
                  <div>
                    <span className="settings-row-label">Enable Companion API</span>
                    <span className="settings-row-desc">Adds mod ranks and detailed inventory data</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ minWidth: 64, background: companionApiEnabled ? "rgba(240,192,64,.15)" : undefined, borderColor: companionApiEnabled ? "#f0c040" : undefined, color: companionApiEnabled ? "#f0c040" : undefined }}
                    onClick={() => setCompanionApiEnabled(v => !v)}
                  >
                    {companionApiEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>

              {/* ── Account ── */}
              <div className="settings-section" style={{ opacity: companionApiEnabled ? 1 : 0.4, pointerEvents: companionApiEnabled ? "auto" : "none" }}>
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

              {/* ── Data ── */}
              <div className="settings-section">
                <div className="settings-section-title">Data</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Item Database</span>
                    <span className="settings-row-desc">{itemCount.toLocaleString()} items · {recipeCount.toLocaleString()} recipes cached</span>
                  </div>
                  <button className="btn-secondary" onClick={() => { setShowSettings(false); handleFetch(); }} disabled={fetching}>
                    {fetching ? "Fetching…" : "Refresh"}
                  </button>
                </div>
                {fetchMsg && <div className="settings-msg">{fetchMsg}</div>}
                <div className="settings-row" style={{ marginTop: 8 }}>
                  <div className="settings-row-info">
                    <span className="settings-row-label">Clear Cache</span>
                    <span className="settings-row-desc">Reset all scanned quantities and change log.</span>
                  </div>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      try {
                        await invoke("clear_cache");
                        setQuantities({});
                        setApiQuantities({});
                        setApiModCopies([]);
                        setChangeLog([]);
                        setLastChanged({});
                        setWfConnected(false);
                        wfConnectedRef.current = false;
                        localStorage.removeItem("ff-api-quantities");
                        localStorage.removeItem("ff-api-mod-copies");
                        setClearMsg("Cache cleared.");
                      } catch (e) { setClearMsg(`Error: ${e}`); }
                    }}
                  >Clear Cache</button>
                </div>
                {clearMsg && <div className="settings-msg">{clearMsg}</div>}
              </div>

              {/* ── Monitor ── */}
              <div className="settings-section">
                <div className="settings-section-title">Monitor</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Memory Scanner</span>
                    <span className="settings-row-desc">{monitoring ? "Running — scans every 10 seconds" : "Stopped"}</span>
                  </div>
                  <button className={`btn-secondary ${monitoring ? "btn-danger" : ""}`} onClick={toggleMonitor}>
                    {monitoring ? "Stop" : "Start"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                  {[
                    { label: "Memory Scanner",    ok: monitoring,      detail: monitoring ? `Running · last scan ${lastScan ? new Date(lastScan*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : "—"}` : "Stopped" },
                    { label: "Warframe API",       ok: wfConnected,     detail: wfConnected ? `Connected · ${lastApiRefresh ? new Date(lastApiRefresh*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : "—"}` : warframeRunning ? "Game detected — scanning credentials…" : "Not connected" },
                    { label: "Warframe detected", ok: warframeRunning, detail: warframeRunning ? "Game is running" : "Game not detected" },
                  ].map(s => (
                    <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.ok ? "var(--green)" : "var(--muted)", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "var(--text)", minWidth: 140 }}>{s.label}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{s.detail}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Modular Window ── */}
              <div className="settings-section">
                <div className="settings-section-title">Modular Window</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Pop-out</span>
                    <span className="settings-row-desc">Detach the Modular Window into its own floating window.</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ minWidth: 64, background: modularPopout ? "rgba(56,139,253,.15)" : undefined, borderColor: modularPopout ? "var(--accent)" : undefined }}
                    onClick={() => {
                      const next = !modularPopout;
                      setModularPopout(next);
                      settingsRef.current = { ...settingsRef.current, modularPopout: next };
                      saveAllSettings();
                    }}
                  >{modularPopout ? "On" : "Off"}</button>
                </div>
              </div>

              {/* ── Support ── */}
              <div className="settings-section">
                <div className="settings-section-title">Support</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">Session Log</span>
                    <span className="settings-row-desc">
                      Step-by-step log of the last overlay attempt. Share this when reporting overlay issues.
                      Written to <code>%TEMP%\frameforge_overlay_session.txt</code>.
                    </span>
                  </div>
                  <button className="btn-secondary" onClick={async () => {
                    try {
                      const text = await invoke<string>("get_overlay_session_log");
                      alert(text);
                    } catch (e) { alert(`Error: ${e}`); }
                  }}>View Log</button>
                </div>
              </div>

              {/* ── About (always last) ── */}
              <div className="settings-section">
                <div className="settings-section-title">About</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <span className="settings-row-label">FrameForge</span>
                    <span className="settings-row-desc">Version <strong>{appVersion}</strong></span>
                  </div>
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
            <img src="/market-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
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
          <button
            className={`module-btn ${activeModule === "timers" ? "module-active" : ""}`}
            onClick={() => setActiveModule("timers")}
            title="Timers"
          >
            <img src="/timers-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Timers</span>
          </button>
          <button
            className={`module-btn ${activeModule === "statistics" ? "module-active" : ""}`}
            onClick={() => setActiveModule("statistics")}
            title="Statistics"
          >
            <img src="/statistics-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Statistics</span>
          </button>
          <button
            className={`module-btn ${activeModule === "rivens" ? "module-active" : ""}`}
            onClick={() => setActiveModule("rivens")}
            title="Riven Analyzer"
          >
            <img src="/riven-icon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            <span className="module-label">Rivens</span>
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
                <button className={`fchip ${filterRecent?"fchip-on":""}`} onClick={()=>setFilterRecent(v=>!v)}>Changed recently</button>
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
                <span className="item-count-label" style={{marginLeft:"auto"}}>{visibleItems.length} item{visibleItems.length!==1?"s":""}{visibleItems.length===1000?" (capped)":""}</span>
                <HelpTip items={[
                  { icon: "★",  label: "★  Mastered",  desc: "Shown above image — item levelled to rank 30" },
                  { icon: "R5", label: "R{n}  Rank",   desc: "Shown above image — current rank, not yet mastered" },
                  { icon: "⚒",  label: "⚒  Building",  desc: "Shown on image — currently crafting in Foundry" },
                  { swatch: "rgba(63,185,80,.5)",  label: "Green border", desc: "Item recently gained" },
                  { swatch: "rgba(248,81,73,.5)",  label: "Red border",   desc: "Item recently lost or consumed" },
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
                        <button
                          className={`inv-fav-star ${favorites.includes(item.unique_name) ? "active" : ""}`}
                          title={favorites.includes(item.unique_name) ? "Remove from Modular Window" : "Add to Modular Window"}
                          onClick={e => { e.stopPropagation(); toggleFavorite(item.unique_name); }}
                        >{favorites.includes(item.unique_name) ? "★" : "☆"}</button>
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
                        {/* Name + category */}
                        <div className="inv-card-name">
                          {item.name}
                          {isRecent && secAgo !== null && (
                            <span className="item-updated">{Math.floor(secAgo / 60) === 0 ? "· now" : `· ${Math.floor(secAgo / 60)}m`}</span>
                          )}
                        </div>
                        <div className="inv-card-cat">{item.category}</div>
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
                    changeLog.map((c, i) => {
                      const logItem = catalogRef.current.find(ci => ci.unique_name === c.unique_name);
                      return (
                        <div key={c.id || i} className="log-row">
                          <span className="log-name">
                            {c.item_name}
                            {logItem && <span className="log-cat">{logItem.category}</span>}
                          </span>
                          <span className={`log-delta ${deltaClass(c.delta)}`}>{deltaText(c.delta)}</span>
                          <span className="log-range">{fmt(c.old_qty)} → {fmt(c.new_qty)}</span>
                          <span className="log-time">{timeStr(c.timestamp)}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Foundry module ── */}
        {activeModule === "foundry" && (
          <ErrorBoundary>
            <Foundry quantities={mergedQty} masteryData={masteryData} refreshKey={itemsRefreshKey} crafting={crafting} colorblindMode={colorblindMode} subsummedWarframes={subsummedWarframes} archonShards={archonShards} tracked={tracked} onTrackToggle={toggleTracked} />
          </ErrorBoundary>
        )}

        {/* ── Market Helper module ── */}
        {activeModule === "market" && (
          <MarketHelper quantities={mergedQty} apiQuantities={apiQuantities} refreshKey={itemsRefreshKey} crafting={crafting} />
        )}

        {/* ── Relics module ── */}
        {activeModule === "relics" && (
          <ErrorBoundary>
            <RelicHelper quantities={mergedQty} apiQuantities={apiQuantities} masteryData={masteryData} refreshKey={itemsRefreshKey} colorblindMode={colorblindMode} />
          </ErrorBoundary>
        )}

        {/* ── Rivens module ── */}
        {activeModule === "rivens" && (
          <ErrorBoundary>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
              <RivenAnalyzer />
            </div>
          </ErrorBoundary>
        )}

        {/* ── Timers module ── */}
        {activeModule === "timers" && (
          <ErrorBoundary>
            <TimerHelper
              favorites={timerFavorites}
              onFavoriteToggle={id => setTimerFavorites(prev =>
                prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
              )}
              fissureWatches={fissureWatches}
              onAddWatch={w => setFissureWatches(prev => [...prev, w])}
              onRemoveWatch={id => setFissureWatches(prev => prev.filter(w => w.id !== id))}
              quantities={mergedQty}
            />
          </ErrorBoundary>
        )}

        {/* ── Statistics module ── */}
        {activeModule === "statistics" && (
          <ErrorBoundary>
            <Statistics />
          </ErrorBoundary>
        )}


        {/* ── Modular Window — always visible unless popped out ── */}
        {!modularPopout && <ModularWindow
          tracked={tracked}
          onTrackedChange={setTracked}
          onUntrack={toggleTracked}
          favorites={favorites}
          onFavoritesChange={setFavorites}
          onUnfavorite={toggleFavorite}
          timerFavorites={timerFavorites}
          onTimerFavoritesChange={setTimerFavorites}
          onTimerUnfavorite={id => setTimerFavorites(prev => prev.filter(x => x !== id))}
          fissureWatches={fissureWatches}
          quantities={mergedQty}
          catalog={catalog}
          width={modularWidth}
          onWidthChange={setModularWidth}
          sectionOrder={modularSectionOrder}
          onSectionOrderChange={setModularSectionOrder}
        />}

      </div>
    </div>
  );
}
