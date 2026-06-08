import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./TimerHelper.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WsCycle   { expiry: string; }
interface WsCetus   extends WsCycle { isDay: boolean; }
interface WsVallis  extends WsCycle { isWarm: boolean; }
interface WsCambion extends WsCycle { active: string; }
interface WsZariman extends WsCycle { active: boolean; }

interface WsSortieVariant { missionType: string; modifier: string; node: string; }
interface WsSortie   { expiry: string; boss: string; faction: string; variants: WsSortieVariant[]; active: boolean; }
interface WsMission  { type: string; node: string; }
interface WsArchon   { expiry: string; boss: string; faction: string; missions: WsMission[]; active: boolean; }
interface WsManifestItem { name: string; uniqueName?: string; primePrice?: number; regularPrice?: number; ayaPrice?: number; regalAyaPrice?: number; }
interface WsTrader   { expiry: string; activation: string; character: string; location: string; active: boolean; manifest: WsManifestItem[]; }
interface WsPrimeResurgence { expiry: string; activation: string; active: boolean; manifest: WsManifestItem[]; }
interface WsNight    { expiry: string; season: number; active: boolean; }
export interface WsFissure  { id: string; expiry: string; node: string; missionType: string; enemy: string; tier: string; tierNum: number; isStorm: boolean; isHard: boolean; active: boolean; }
export interface WsStorm    { id: string; expiry: string; node: string; missionType: string; enemy: string; tier: string; tierNum: number; active: boolean; }
interface WsAlert    { id: string; expiry: string; missionType: string; faction: string; node: string; rewardItem?: string; rewardCredits: number; }
interface WsInvasion { id: string; node: string; attacker: string; defender: string; attReward: string; defReward: string; pct: number; }
interface WsDarvo    { expiry: string; item: string; discount: number; originalPrice: number; salePrice: number; amountTotal: number; amountSold: number; }
interface WsCircuit  { expiry: string; normalFrames: string[]; hardWeapons: string[]; }
interface WsSimple   { expiry: string; }
interface WsBounty   { expiry: string; jobCount: number; }
interface WsEvent    { expiry: string; label: string; }
interface WsNews     { message: string; link: string; date: string | number; stream: boolean; primeAccess: boolean; update: boolean; }

export interface FissureWatch {
  id: string;
  tier: string;        // "Any" | "Omnia" | "Lith" | "Meso" | "Neo" | "Axi" | "Requiem"
  missionType: string; // "Any" | "Rescue" | "Capture" | ...
  variant: "any" | "normal" | "hard" | "storm";
}

// actualVariant is passed explicitly from the caller who knows which array the fissure came from
export function matchesWatch(
  watch: FissureWatch,
  fissure: WsFissure | WsStorm,
  actualVariant: "normal" | "hard" | "storm",
): boolean {
  // Variant — checked first; quickest way to exit
  if (watch.variant !== "any" && watch.variant !== actualVariant) return false;

  // Tier — bidirectional Omnia:
  // • Watch "Omnia" matches any non-Requiem tier
  // • Fissure tier "Omnia" matches any watch except "Requiem"
  const fTier = fissure.tier;
  if (watch.tier !== "Any") {
    if (watch.tier === "Omnia") {
      if (fTier === "Requiem") return false;
    } else if (fTier === "Omnia") {
      if (watch.tier === "Requiem") return false;
    } else if (watch.tier !== fTier) {
      return false;
    }
  }

  // Mission type
  if (watch.missionType !== "Any" && fissure.missionType !== watch.missionType) return false;

  return true;
}

export interface WorldState {
  cetus?:          WsCetus;
  vallis?:         WsVallis;
  cambion?:        WsCambion;
  zariman?:        WsZariman;
  bounties?:       Record<string, WsBounty>;
  sortie?:         WsSortie;
  archonHunt?:     WsArchon;
  voidTrader?:     WsTrader;
  nightwave?:        WsNight;
  primeResurgence?:  WsPrimeResurgence;
  circuit?:        WsCircuit;
  kahl?:           WsSimple;
  deepArchimedea?: WsSimple;
  events?:         WsEvent[];
  news?:           WsNews[];
  darvo?:          WsDarvo;
  alerts?:         WsAlert[];
  invasions?:      WsInvasion[];
  fissures?:       WsFissure[];
  spFissures?:     WsFissure[];
  voidStorms?:     WsStorm[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export function fmtExpiry(expiry: string, now: number): string {
  return fmtMs(new Date(expiry).getTime() - now);
}

function nextUtcMidnight(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)).toISOString();
}
function nextWeeklyReset(): string {
  const n = new Date();
  const d = n.getUTCDay();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + (d === 0 ? 1 : 8 - d))).toISOString();
}

const TIER_COLOR: Record<string, string> = {
  Lith: "#c8853a", Meso: "#a8a9ad", Neo: "#f0c040",
  Axi: "#e5c04a", Requiem: "#9b6dff", Omnia: "#e0e0e0",
};

export const TIMER_LABELS: Record<string, string> = {
  "cetus-cycle":    "Cetus",
  "vallis-cycle":   "Orb Vallis",
  "cambion-cycle":  "Cambion Drift",
  "zariman-cycle":  "Zariman",
  "bounty-cetus":   "Cetus Bounties",
  "bounty-vallis":  "Vallis Bounties",
  "bounty-cambion": "Cambion Bounties",
  "bounty-zariman": "Zariman Bounties",
  "bounty-hex":     "Hex Bounties",
  "sortie":         "Sortie",
  "archon-hunt":    "Archon Hunt",
  "daily-reset":    "Daily Reset",
  "weekly-reset":   "Weekly Reset",
  "void-trader":    "Void Trader",
  "nightwave":        "Nightwave",
  "prime-resurgence": "Prime Resurgence",
  "circuit":        "The Circuit",
  "kahl":           "Kahl / Break Narmer",
  "deep-archimedea":"Deep Archimedea",
};

export function getTimerInfo(id: string, ws: WorldState): { state: string; expiry: string } | null {
  switch (id) {
    case "cetus-cycle":    return ws.cetus    ? { state: ws.cetus.isDay ? "Day" : "Night",        expiry: ws.cetus.expiry }    : null;
    case "vallis-cycle":   return ws.vallis   ? { state: ws.vallis.isWarm ? "Warm" : "Cold",      expiry: ws.vallis.expiry }   : null;
    case "cambion-cycle":  return ws.cambion  ? { state: "Cycle",                                 expiry: ws.cambion.expiry }  : null;
    case "zariman-cycle":  return ws.zariman  ? { state: "Active",                                expiry: ws.zariman.expiry }  : null;
    case "bounty-cetus":   return ws.bounties?.cetus    ? { state: `${ws.bounties.cetus.jobCount} jobs`,    expiry: ws.bounties.cetus.expiry }    : null;
    case "bounty-vallis":  return ws.bounties?.vallis   ? { state: `${ws.bounties.vallis.jobCount} jobs`,   expiry: ws.bounties.vallis.expiry }   : null;
    case "bounty-cambion": return ws.bounties?.cambion  ? { state: `${ws.bounties.cambion.jobCount} jobs`,  expiry: ws.bounties.cambion.expiry }  : null;
    case "bounty-zariman": return ws.bounties?.zariman  ? { state: `${ws.bounties.zariman.jobCount} jobs`,  expiry: ws.bounties.zariman.expiry }  : null;
    case "bounty-hex":     return ws.bounties?.hex      ? { state: `${ws.bounties.hex.jobCount} jobs`,      expiry: ws.bounties.hex.expiry }      : null;
    case "sortie":         return ws.sortie      ? { state: ws.sortie.faction,     expiry: ws.sortie.expiry }     : null;
    case "archon-hunt":    return ws.archonHunt  ? { state: ws.archonHunt.boss,    expiry: ws.archonHunt.expiry } : null;
    case "daily-reset":    return { state: "UTC 00:00", expiry: nextUtcMidnight() };
    case "weekly-reset":   return { state: "Monday",    expiry: nextWeeklyReset() };
    case "void-trader":    return ws.voidTrader ? { state: ws.voidTrader.active ? "Here" : "Away", expiry: ws.voidTrader.active ? ws.voidTrader.expiry : ws.voidTrader.activation } : null;
    case "nightwave":         return ws.nightwave?.active ? { state: `S${ws.nightwave.season}`, expiry: ws.nightwave.expiry } : null;
    case "prime-resurgence":  return ws.primeResurgence?.active ? { state: "Active", expiry: ws.primeResurgence.expiry } : null;
    case "circuit":        return ws.circuit    ? { state: "Weekly",  expiry: ws.circuit.expiry }        : null;
    case "kahl":           return ws.kahl       ? { state: "Weekly",  expiry: ws.kahl.expiry }           : null;
    case "deep-archimedea":return ws.deepArchimedea ? { state: "Weekly", expiry: ws.deepArchimedea.expiry } : null;
    default: return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

const TIERS = ["Any","Omnia","Lith","Meso","Neo","Axi","Requiem"];
const VARIANTS: { key: FissureWatch["variant"]; label: string }[] = [
  { key: "any",    label: "Any" },
  { key: "normal", label: "Normal" },
  { key: "hard",   label: "Steel Path" },
  { key: "storm",  label: "Storm" },
];
// Mission types available per variant (storms are Railjack — different pool)
const MISSION_TYPES_BY_VARIANT: Record<FissureWatch["variant"], string[]> = {
  any:    ["Any","Rescue","Capture","Defense","Survival","Excavation","Interception","Disruption","Sabotage","Spy","Mobile Defense","Extermination","Assassination","Skirmish","Volatile"],
  normal: ["Any","Rescue","Capture","Defense","Survival","Excavation","Interception","Disruption","Sabotage","Spy","Mobile Defense","Extermination","Assassination"],
  hard:   ["Any","Rescue","Capture","Defense","Survival","Excavation","Interception","Disruption","Sabotage","Spy","Mobile Defense","Extermination","Assassination"],
  storm:  ["Any","Skirmish","Volatile","Defense","Extermination","Sabotage","Assassination"],
};

interface Props {
  favorites: string[];
  onFavoriteToggle: (id: string) => void;
  fissureWatches: FissureWatch[];
  onAddWatch: (w: FissureWatch) => void;
  onRemoveWatch: (id: string) => void;
  quantities: Record<string, number>;
}

type FissureTab = "normal" | "hard" | "storm";

export default function TimerHelper({ favorites, onFavoriteToggle, fissureWatches, onAddWatch, onRemoveWatch, quantities }: Props) {
  const [ws, setWs] = useState<WorldState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fissureTab, setFissureTab] = useState<FissureTab>("normal");
  const [showWatchForm, setShowWatchForm] = useState(false);
  const [openInventory, setOpenInventory] = useState<Set<string>>(new Set());
  const toggleInventory = (id: string) => setOpenInventory(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const [wTier, setWTier] = useState("Any");
  const [wMission, setWMission] = useState("Any");
  const [wVariant, setWVariant] = useState<FissureWatch["variant"]>("any");

  const setVariant = useCallback((v: FissureWatch["variant"]) => {
    setWVariant(v);
    // Reset mission if it's not available in the new variant's list
    setWMission(m => MISSION_TYPES_BY_VARIANT[v].includes(m) ? m : "Any");
  }, []);

  const fetchWS = useCallback(() => {
    invoke<WorldState>("fetch_worldstate")
      .then(data => { setWs(data); setLoading(false); setError(""); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  useEffect(() => { fetchWS(); const iv = setInterval(fetchWS, 60000); return () => clearInterval(iv); }, [fetchWS]);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv); }, []);

  const isFav = (id: string) => favorites.includes(id);
  const cd = (expiry: string) => fmtMs(new Date(expiry).getTime() - now);

  function StarBtn({ id }: { id: string }) {
    return (
      <button
        className={`timer-star${isFav(id) ? " fav" : ""}`}
        onClick={e => { e.stopPropagation(); onFavoriteToggle(id); }}
        title={isFav(id) ? "Unpin" : "Pin to Modular Window"}
      >
        {isFav(id) ? "★" : "☆"}
      </button>
    );
  }

  const Chevron = ({ open }: { open: boolean }) => (
    <svg className="exp-tile-chevron" viewBox="0 0 10 6" fill="none" style={{ transform: open ? "" : "rotate(-90deg)" }}>
      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  function ExpHeader({ id, name, state, sc, countdown, open, showChevron = true }: {
    id?: string; name: string; state: string; sc?: string; countdown: string; open: boolean; showChevron?: boolean;
  }) {
    return (
      <div className="exp-tile-header">
        <div className="exp-tile-name-row">
          <span className="exp-tile-name">{name}</span>
          {showChevron && <Chevron open={open} />}
        </div>
        <div className="exp-tile-meta-row">
          {id && <StarBtn id={id} />}
          <span className={`timer-tile-state ${sc ?? "st-neutral"}`}>{state}</span>
          <span className="exp-tile-cd">{countdown}</span>
        </div>
      </div>
    );
  }

  function SectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
    return <div className="timer-group-label">{label}{children}</div>;
  }

  // Compact tile for use inside a 2-column grid
  function TimerTile({ id, label, state, stateClass, expiry, until }: {
    id?: string; label: string; state: string; stateClass?: string; expiry: string; until?: string;
  }) {
    return (
      <div className="timer-tile">
        {id && <StarBtn id={id} />}
        <div className="timer-tile-inner">
          <div className="timer-tile-top">
            <span className="timer-tile-name">{label}</span>
            <span className={`timer-tile-cd`}>{fmtMs(new Date(expiry).getTime() - now)}</span>
          </div>
          <div className="timer-tile-bottom">
            <span className={`timer-tile-state ${stateClass ?? "st-neutral"}`}>{state}</span>
            {until && <span className="timer-tile-until">{until}</span>}
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <div className="timer-loading">Loading worldstate…</div>;

  return (
    <div className="timer-helper">
      {error && <div className="timer-error">{error} <button onClick={fetchWS}>Retry</button></div>}

      {/* ── World Cycles ──────────────────────────────────────────────────── */}
      <SectionHeader label="World Cycles" />
      <div className="timer-section-grid">
        {ws?.cetus    && <TimerTile id="cetus-cycle"   label="Cetus"         state={ws.cetus.isDay ? "Day" : "Night"}     stateClass={ws.cetus.isDay ? "st-day" : "st-night"}  expiry={ws.cetus.expiry}   until={`until ${ws.cetus.isDay ? "Night" : "Day"}`} />}
        {ws?.vallis   && <TimerTile id="vallis-cycle"  label="Orb Vallis"    state={ws.vallis.isWarm ? "Warm" : "Cold"}   stateClass={ws.vallis.isWarm ? "st-warm" : "st-cold"} expiry={ws.vallis.expiry}  until={`until ${ws.vallis.isWarm ? "Cold" : "Warm"}`} />}
        {ws?.cambion  && <TimerTile id="cambion-cycle" label="Cambion Drift" state="Active"                               stateClass="st-fass"                                 expiry={ws.cambion.expiry} until="next cycle" />}
        {ws?.zariman  && <TimerTile id="zariman-cycle" label="Zariman"       state="Active"                               stateClass="st-neutral"                              expiry={ws.zariman.expiry} until="reset" />}
      </div>

      {/* ── Bounties ──────────────────────────────────────────────────────── */}
      {ws?.bounties && Object.keys(ws.bounties).length > 0 && (
        <>
          <SectionHeader label="Bounties" />
          <div className="timer-section-grid">
            {([
              ["cetus",   "Cetus",          "bounty-cetus"],
              ["vallis",  "Orb Vallis",     "bounty-vallis"],
              ["cambion", "Cambion Drift",  "bounty-cambion"],
              ["zariman", "Zariman",        "bounty-zariman"],
              ["hex",     "Hex / Albrecht", "bounty-hex"],
            ] as [string, string, string][]).map(([key, label, favId]) => {
              const b = ws.bounties![key];
              if (!b) return null;
              return <TimerTile key={key} id={favId} label={label} state={`${b.jobCount} jobs`} stateClass="st-neutral" expiry={b.expiry} until="reset" />;
            })}
          </div>
        </>
      )}

      {/* ── Daily & Weekly ────────────────────────────────────────────────── */}
      <SectionHeader label="Daily &amp; Weekly" />
      <div className="timer-section-grid">
        <TimerTile id="daily-reset"  label="Daily Reset"  state="UTC 00:00" stateClass="st-neutral" expiry={nextUtcMidnight()} />
        <TimerTile id="weekly-reset" label="Weekly Reset" state="Monday"    stateClass="st-neutral" expiry={nextWeeklyReset()} />
        {ws?.kahl           && <TimerTile id="kahl"            label="Kahl / Break Narmer" state="Weekly" stateClass="st-neutral" expiry={ws.kahl.expiry} />}
        {ws?.deepArchimedea && <TimerTile id="deep-archimedea" label="Deep Archimedea"      state="Weekly" stateClass="st-neutral" expiry={ws.deepArchimedea.expiry} />}
      </div>

      {/* ── Daily & Weekly — expandable tiles ─────────────────────────────── */}
      <div className="timer-section-grid">
        {ws?.sortie && (() => {
          const open = openInventory.has("sortie");
          return (
            <div className={`exp-tile${open ? " open" : ""}`} onClick={() => toggleInventory("sortie")}>
              <ExpHeader id="sortie" name="Sortie" state={ws.sortie.faction} countdown={cd(ws.sortie.expiry)} open={open} />
              {open && <div className="exp-tile-body">
                {ws.sortie.variants?.map((v, i) => (
                  <div key={i} className="exp-tile-row">
                    <span className="exp-row-type">{v.missionType}</span>
                    {v.modifier && <span className="exp-row-mod">{v.modifier}</span>}
                    <span className="exp-row-node">{v.node}</span>
                  </div>
                ))}
              </div>}
            </div>
          );
        })()}

        {ws?.archonHunt && (() => {
          const open = openInventory.has("archon");
          return (
            <div className={`exp-tile${open ? " open" : ""}`} onClick={() => toggleInventory("archon")}>
              <ExpHeader id="archon-hunt" name="Archon Hunt" state={ws.archonHunt.boss} countdown={cd(ws.archonHunt.expiry)} open={open} />
              {open && <div className="exp-tile-body">
                {ws.archonHunt.missions?.map((m, i) => (
                  <div key={i} className="exp-tile-row">
                    <span className="exp-row-type">{m.type}</span>
                    <span className="exp-row-node">{m.node}</span>
                  </div>
                ))}
              </div>}
            </div>
          );
        })()}

        {ws?.circuit && (() => {
          const open = openInventory.has("circuit");
          return (
            <div className={`exp-tile${open ? " open" : ""}`} onClick={() => toggleInventory("circuit")}>
              <ExpHeader id="circuit" name="The Circuit" state="Duviri" sc="st-duviri" countdown={cd(ws.circuit.expiry)} open={open} />
              {open && <div className="exp-tile-body">
                {ws.circuit.normalFrames?.length > 0 && <div className="exp-tile-row"><span className="exp-row-mod">Normal</span><span className="exp-row-node">{ws.circuit.normalFrames.join(" · ")}</span></div>}
                {ws.circuit.hardWeapons?.length > 0  && <div className="exp-tile-row"><span className="exp-row-mod">Hard</span><span className="exp-row-node">{ws.circuit.hardWeapons.join(" · ")}</span></div>}
              </div>}
            </div>
          );
        })()}
      </div>

      {/* ── Events ────────────────────────────────────────────────────────── */}
      <SectionHeader label="Events" />
      <div className="timer-section-grid">
        {ws?.voidTrader && (() => {
          const open = openInventory.has("baro");
          const active = ws.voidTrader.active;
          return (
            <div className={`exp-tile${open ? " open" : ""}${active ? "" : " tile-away"}`} onClick={() => active && toggleInventory("baro")}>
              <ExpHeader id="void-trader" name={ws.voidTrader.character} state={active ? "Here" : "Away"} sc={active ? "st-active" : "st-away"} countdown={active ? cd(ws.voidTrader.expiry) : fmtMs(new Date(ws.voidTrader.activation).getTime() - now)} open={open} showChevron={active} />
              {active && !open && <div className="exp-tile-location">{ws.voidTrader.location}</div>}
              {active && open && <div className="exp-tile-body exp-tile-inventory" onClick={e => e.stopPropagation()}>
                {ws.voidTrader.manifest.map((item, i) => {
                  const owned = item.uniqueName ? (quantities[item.uniqueName] ?? 0) > 0 : false;
                  return (
                    <div key={i} className={`timer-inv-row${owned ? " inv-owned" : ""}`}>
                      <span className="timer-inv-name">{item.name}</span>
                      {owned && <span className="inv-owned-tag">Owned</span>}
                      {item.primePrice ? <span className="timer-inv-price aya">{item.primePrice} <span className="inv-currency">Ducats</span></span> : null}
                      {item.regularPrice ? <span className="timer-inv-price cr">{item.regularPrice?.toLocaleString()} <span className="inv-currency">cr</span></span> : null}
                    </div>
                  );
                })}
              </div>}
            </div>
          );
        })()}

        {ws?.primeResurgence?.active && (() => {
          const open = openInventory.has("prime-resurgence");
          return (
            <div className={`exp-tile${open ? " open" : ""}`} onClick={() => toggleInventory("prime-resurgence")}>
              <ExpHeader id="prime-resurgence" name="Prime Resurgence" state="Active" sc="st-active" countdown={cd(ws.primeResurgence!.expiry)} open={open} />
              {open && <div className="exp-tile-body exp-tile-inventory" onClick={e => e.stopPropagation()}>
                {ws.primeResurgence!.manifest.map((item, i) => {
                  const owned = item.uniqueName ? (quantities[item.uniqueName] ?? 0) > 0 : false;
                  return (
                    <div key={i} className={`timer-inv-row${owned ? " inv-owned" : ""}`}>
                      <span className="timer-inv-name">{item.name}</span>
                      {owned && <span className="inv-owned-tag">Owned</span>}
                      {item.regalAyaPrice ? <span className="timer-inv-price aya" style={{ color: "#c084fc" }}>{item.regalAyaPrice} <span className="inv-currency">Regal Aya</span></span> : null}
                      {item.ayaPrice ? <span className="timer-inv-price aya">{item.ayaPrice} <span className="inv-currency">Aya</span></span> : null}
                    </div>
                  );
                })}
              </div>}
            </div>
          );
        })()}

        {ws?.nightwave?.active && <TimerTile id="nightwave" label="Nightwave" state={`Season ${ws.nightwave.season}`} stateClass="st-neutral" expiry={ws.nightwave.expiry} />}
        {ws?.events?.map(ev => (
          <TimerTile key={ev.label} label={ev.label} state="Event" stateClass="st-active" expiry={ev.expiry} />
        ))}
        {ws?.darvo && <TimerTile label={`Darvo: ${ws.darvo.item}`} state={`-${ws.darvo.discount}%`} stateClass="st-neutral" expiry={ws.darvo.expiry} until={`${ws.darvo.salePrice}p`} />}
      </div>

      {/* ── News & Promotions ─────────────────────────────────────────────── */}
      {ws?.news && ws.news.length > 0 && (
        <>
          <SectionHeader label="News &amp; Promotions" />
          <div className="timer-section-grid">
            {ws.news.map((item, i) => (
              <div key={i} className="news-tile">
                <div className="news-tile-msg">{item.message}</div>
                <div className="news-tile-meta">
                  <span className="news-tile-date">
                    {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                  <div className="news-tile-tags">
                    {item.primeAccess && <span className="news-tag news-tag-prime">Prime</span>}
                    {item.stream      && <span className="news-tag news-tag-stream">Stream</span>}
                    {item.update      && <span className="news-tag news-tag-update">Update</span>}
                  </div>
                  <button className="news-open-btn" onClick={() => openUrl(item.link)}>Open →</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Alerts ────────────────────────────────────────────────────────── */}
      {ws?.alerts && ws.alerts.length > 0 && (
        <>
          <SectionHeader label={`Alerts (${ws.alerts.length})`} />
          <div className="timer-section-grid">
            {ws.alerts.map((a, i) => (
              <div key={i} className="alert-tile">
                <div className="alert-tile-top">
                  <span className="alert-tile-type">{a.missionType}</span>
                  <span className="alert-tile-cd">{cd(a.expiry)}</span>
                </div>
                <div className="alert-tile-bottom">
                  <span className="alert-faction">{a.faction}</span>
                  {a.rewardItem && <span className="alert-reward">{a.rewardItem}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Invasions ─────────────────────────────────────────────────────── */}
      {ws?.invasions && ws.invasions.length > 0 && (
        <>
          <SectionHeader label={`Invasions (${ws.invasions.length})`} />
          <div className="timer-section-grid">
            {ws.invasions.map((inv, i) => (
              <div key={i} className="invasion-tile">
                <div className="invasion-tile-node">{inv.node}</div>
                <div className="invasion-bar-wrap" style={{ margin: "3px 0" }}>
                  <div className="invasion-bar-inner" style={{ width: `${Math.min(100, inv.pct)}%` }} />
                </div>
                <div className="invasion-tile-factions">
                  <span className="invasion-att">{inv.attacker}</span>
                  <span className="invasion-tile-reward">{inv.attReward || "—"}</span>
                </div>
                <div className="invasion-tile-factions">
                  <span className="invasion-def">{inv.defender}</span>
                  <span className="invasion-tile-reward">{inv.defReward || "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Void Fissures ─────────────────────────────────────────────────── */}
      {(() => {
        // Rust already filters: started (activation ≤ now) and not expired (expiry > now).
        // Just sort — no extra client-side filtering so count always equals what renders.
        const normal = [...(ws?.fissures   ?? [])].sort((a, b) => a.tierNum - b.tierNum);
        const hard   = [...(ws?.spFissures ?? [])].sort((a, b) => a.tierNum - b.tierNum);
        const storms = [...(ws?.voidStorms ?? [])].sort((a, b) => a.tierNum - b.tierNum);
        const list   = fissureTab === "normal" ? normal : fissureTab === "hard" ? hard : storms;

        const FissureTile = ({ f, v }: { f: WsFissure | WsStorm; v: "normal" | "hard" | "storm" }) => (
          <div className={`fissure-tile${fissureWatches.some(w => matchesWatch(w, f, v)) ? " fissure-watched" : ""}`}>
            <div className="fissure-tile-top">
              <span className="fissure-tier" style={{ color: TIER_COLOR[f.tier] ?? "#ccc" }}>{f.tier}</span>
              <span className="fissure-tile-cd">{cd(f.expiry)}</span>
            </div>
            <div className="fissure-tile-mission">{f.missionType}</div>
            <div className="fissure-tile-bottom">
              {f.enemy && <span className="fissure-tile-enemy">{f.enemy}</span>}
              <span className="fissure-tile-node">{f.node}</span>
            </div>
          </div>
        );

        return (
          <>
            <div className="timer-group-label timer-group-label-fissures">
              <span>Void Fissures</span>
              <div className="fissure-tabs">
                <button className={fissureTab === "normal" ? "active" : ""} onClick={() => setFissureTab("normal")}>Normal</button>
                <button className={fissureTab === "hard"   ? "active" : ""} onClick={() => setFissureTab("hard")}>Steel Path</button>
                <button className={fissureTab === "storm"  ? "active" : ""} onClick={() => setFissureTab("storm")}>Storms</button>
              </div>
              <button className={`fissure-watch-btn${showWatchForm ? " active" : ""}`} onClick={() => setShowWatchForm(v => !v)} title="Manage fissure watches">
                <svg viewBox="0 0 16 16" fill="none"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>

            {showWatchForm && (
              <div className="watch-panel">
                {fissureWatches.length > 0 && (
                  <div className="watch-chips">
                    {fissureWatches.map(w => (
                      <div key={w.id} className="watch-chip">
                        <span className="watch-chip-tier" style={{ color: TIER_COLOR[w.tier] ?? "var(--text)" }}>{w.tier}</span>
                        {w.missionType !== "Any" && <span className="watch-chip-mt">{w.missionType}</span>}
                        {w.variant !== "any" && <span className="watch-chip-var">{VARIANTS.find(v => v.key === w.variant)?.label}</span>}
                        <button className="watch-chip-del" onClick={() => onRemoveWatch(w.id)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="watch-form">
                  <div className="watch-form-row">
                    <span className="watch-form-label">Mode</span>
                    <div className="watch-pill-group">
                      {VARIANTS.map(v => (
                        <button key={v.key} className={`watch-pill${wVariant === v.key ? " active" : ""}`} onClick={() => setVariant(v.key)}>{v.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="watch-form-row">
                    <span className="watch-form-label">Tier</span>
                    <div className="watch-pill-group watch-pill-group-wrap">
                      {TIERS.map(t => (
                        <button key={t} className={`watch-pill${wTier === t ? " active" : ""}`}
                          style={wTier === t && TIER_COLOR[t] ? { borderColor: TIER_COLOR[t], color: TIER_COLOR[t] } : undefined}
                          onClick={() => setWTier(t)}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div className="watch-form-row">
                    <span className="watch-form-label">Type</span>
                    <div className="watch-pill-group watch-pill-group-wrap">
                      {MISSION_TYPES_BY_VARIANT[wVariant].map(m => (
                        <button key={m} className={`watch-pill${wMission === m ? " active" : ""}`} onClick={() => setWMission(m)}>{m}</button>
                      ))}
                    </div>
                  </div>
                  <button className="watch-add-btn" onClick={() => {
                    onAddWatch({ id: `${Date.now()}`, tier: wTier, missionType: wMission, variant: wVariant });
                    setWTier("Any"); setWMission("Any"); setVariant("any");
                  }}>+ Add Watch</button>
                </div>
              </div>
            )}

            {list.length === 0
              ? <div className="timer-empty">No active fissures.</div>
              : <div className="fissure-grid">
                  {list.map((f, i) => <FissureTile key={i} f={f} v={fissureTab === "hard" ? "hard" : fissureTab === "storm" ? "storm" : "normal"} />)}
                </div>
            }
          </>
        );
      })()}
    </div>
  );
}
