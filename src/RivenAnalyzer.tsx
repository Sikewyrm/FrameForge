import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkRivenNow } from "./App";
import "./RivenAnalyzer.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RivenAnalysis {
  weapon: string;
  matched_positives: string[];
  missing_positives: string[];
  safe_negatives_present: string[];
  harmful_negatives: string[];
  total_wanted: number;
  score: number;
  verdict: string;
  notes: string;
}

// All known riven positive stats (for the picker)
const ALL_POSITIVES = [
  "Critical Damage", "Critical Chance", "Multishot", "Base Damage",
  "Fire Rate", "Status Chance", "Toxicity", "Heat", "Electricity",
  "Cold", "Punch Through", "Reload Speed", "Magazine Size",
  "Projectile Flight Speed", "Status Duration",
  "Damage to Infested", "Damage to Grineer", "Damage to Corpus",
];

const ALL_NEGATIVES = [
  "Zoom", "Recoil", "Puncture", "Impact", "Slash",
  "Ammo Maximum", "Magazine Size", "Projectile Flight Speed",
];

// ── Verdict colour helper ─────────────────────────────────────────────────────

function verdictColor(verdict: string): string {
  if (verdict.startsWith("GREAT"))    return "var(--green)";
  if (verdict.startsWith("GOOD"))     return "#a8d8a8";
  if (verdict.startsWith("MEDIOCRE")) return "#f0c040";
  return "var(--red)";
}

// ── Stat score bar ────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.8 ? "var(--green)" : score >= 0.6 ? "#a8d8a8" : score >= 0.4 ? "#f0c040" : "var(--red)";
  return (
    <div className="riven-score-bar-wrap">
      <div className="riven-score-bar" style={{ width: `${pct}%`, background: color }} />
      <span className="riven-score-pct" style={{ color }}>{pct}%</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RivenAnalyzer() {
  const [weapons, setWeapons]         = useState<string[]>([]);
  const [weaponInput, setWeaponInput] = useState("");
  const [filtered, setFiltered]       = useState<string[]>([]);
  const [selectedWeapon, setSelectedWeapon] = useState("");
  const [positives, setPositives]     = useState<string[]>([]);
  const [negative, setNegative]       = useState("");
  const [analysis, setAnalysis]       = useState<RivenAnalysis | null>(null);
  const [rollCount, setRollCount]     = useState(0);

  const [dbStatus, setDbStatus]       = useState("");
  const [showLog, setShowLog]         = useState(false);
  const [sessionLog, setSessionLog]   = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Load weapons list on mount
  useEffect(() => {
    invoke<string[]>("get_riven_weapons")
      .then(w => { setWeapons(w); setDbStatus(`${w.length} weapons loaded`); })
      .catch(() => setDbStatus("Failed to load database — click Refresh"));
  }, []);

  // Filter weapon suggestions
  useEffect(() => {
    if (!weaponInput.trim()) { setFiltered([]); return; }
    const q = weaponInput.toLowerCase();
    setFiltered(weapons.filter(w => w.includes(q)).slice(0, 8));
  }, [weaponInput, weapons]);

  // Listen for EE.log riven events
  useEffect(() => {
    const unlistenReroll  = listen("riven-reroll-detected", () => {
      setRollCount(c => c + 1);
      if (selectedWeapon) runAnalysis();
    });
    const unlistenUnveil  = listen("riven-unveiled", () => {
      setRollCount(0);
      inputRef.current?.focus();
    });
    return () => {
      unlistenReroll.then(fn => fn());
      unlistenUnveil.then(fn => fn());
    };
  }, [selectedWeapon, positives, negative]); // eslint-disable-line

  const selectWeapon = (w: string) => {
    setSelectedWeapon(w);
    setWeaponInput(w.charAt(0).toUpperCase() + w.slice(1));
    setFiltered([]);
    setPositives([]);
    setNegative("");
    setAnalysis(null);
    setRollCount(0);
  };

  const togglePositive = (stat: string) => {
    setPositives(prev =>
      prev.includes(stat) ? prev.filter(s => s !== stat) : [...prev, stat]
    );
  };

  const runAnalysis = useCallback(async () => {
    if (!selectedWeapon) return;
    const negs = negative ? [negative] : [];
    const result = await invoke<RivenAnalysis | null>("analyze_riven", {
      weapon: selectedWeapon,
      positives,
      negatives: negs,
    });
    setAnalysis(result ?? null);
  }, [selectedWeapon, positives, negative]);

  // Re-run analysis whenever stats change
  useEffect(() => { if (selectedWeapon) runAnalysis(); }, [positives, negative, runAnalysis]);

  const reset = () => {
    setPositives([]);
    setNegative("");
    setAnalysis(null);
    setRollCount(c => c + 1);
  };

  const reloadDb = async () => {
    setDbStatus("Reloading…");
    try {
      const count = await invoke<number>("reload_riven_database");
      const w = await invoke<string[]>("get_riven_weapons");
      setWeapons(w);
      setDbStatus(`${count} weapons loaded`);
    } catch { setDbStatus("Reload failed"); }
  };

  return (
    <div className="riven-analyzer">
      {/* Header */}
      <div className="riven-header">
        <span className="riven-title">Riven Analyzer</span>
        {rollCount > 0 && <span className="riven-roll-count">Roll #{rollCount}</span>}
        <button
          className="riven-check-btn"
          onClick={() => checkRivenNow()}
          title="Capture current riven card from Warframe screen"
        >
          🔍 Check Riven
        </button>
        <span className="riven-db-status">{dbStatus}</span>
        <button className="riven-refresh-btn" onClick={reloadDb} title="Reload database from Google Sheet">↻</button>
        <button className="riven-refresh-btn" title="View session log" onClick={async () => {
          const log = await invoke<string>("get_riven_session_log").catch(() => "Log unavailable");
          setSessionLog(log);
          setShowLog(v => !v);
        }}>📋</button>
      </div>

      {/* Weapon search */}
      <div className="riven-weapon-wrap">
        <input
          ref={inputRef}
          className="riven-weapon-input"
          placeholder="Type weapon name…"
          value={weaponInput}
          onChange={e => { setWeaponInput(e.target.value); setSelectedWeapon(""); setAnalysis(null); }}
        />
        {filtered.length > 0 && (
          <div className="riven-suggestions">
            {filtered.map(w => (
              <div key={w} className="riven-suggestion" onClick={() => selectWeapon(w)}>
                {w.charAt(0).toUpperCase() + w.slice(1)}
              </div>
            ))}
          </div>
        )}
      </div>

      {showLog && (
        <pre style={{ background: "rgba(0,0,0,.3)", border: "1px solid rgba(48,54,61,.6)", borderRadius: 5, padding: 10, fontSize: 10, color: "var(--muted)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 300, overflowY: "auto", flexShrink: 0 }}>
          {sessionLog}
        </pre>
      )}

      {selectedWeapon && (
        <>
          {/* Positive stat picker */}
          <div className="riven-section-label">Positive stats rolled</div>
          <div className="riven-stat-grid">
            {ALL_POSITIVES.map(stat => (
              <button
                key={stat}
                className={`riven-stat-btn${positives.includes(stat) ? " selected" : ""}`}
                onClick={() => togglePositive(stat)}
              >
                {stat}
              </button>
            ))}
          </div>

          {/* Negative stat picker */}
          <div className="riven-section-label">Negative stat rolled <span className="riven-optional">(if any)</span></div>
          <div className="riven-stat-grid">
            {ALL_NEGATIVES.map(stat => (
              <button
                key={stat}
                className={`riven-stat-btn riven-neg-btn${negative === stat ? " selected-neg" : ""}`}
                onClick={() => setNegative(prev => prev === stat ? "" : stat)}
              >
                −{stat}
              </button>
            ))}
          </div>

          {/* Analysis result */}
          {analysis && (
            <div className="riven-result">
              <div className="riven-verdict" style={{ color: verdictColor(analysis.verdict) }}>
                {analysis.verdict}
              </div>
              <ScoreBar score={analysis.score} />

              <div className="riven-stats-breakdown">
                {/* Matched positives */}
                {analysis.matched_positives.map(s => (
                  <div key={s} className="riven-stat-row riven-stat-good">
                    <span className="riven-stat-icon">✓</span>
                    <span>{s}</span>
                    <span className="riven-stat-tag">Wanted</span>
                  </div>
                ))}

                {/* Missing wanted positives */}
                {analysis.missing_positives.map(s => (
                  <div key={s} className="riven-stat-row riven-stat-miss">
                    <span className="riven-stat-icon">○</span>
                    <span>{s}</span>
                    <span className="riven-stat-tag">Not rolled</span>
                  </div>
                ))}

                {/* Negative */}
                {analysis.safe_negatives_present.map(s => (
                  <div key={s} className="riven-stat-row riven-stat-safe">
                    <span className="riven-stat-icon">✓</span>
                    <span>−{s}</span>
                    <span className="riven-stat-tag">Safe negative</span>
                  </div>
                ))}
                {analysis.harmful_negatives.map(s => (
                  <div key={s} className="riven-stat-row riven-stat-bad">
                    <span className="riven-stat-icon">✗</span>
                    <span>−{s}</span>
                    <span className="riven-stat-tag">Harmful negative</span>
                  </div>
                ))}
              </div>

              {analysis.notes && (
                <div className="riven-notes">ℹ {analysis.notes}</div>
              )}
            </div>
          )}

          <button className="riven-next-roll-btn" onClick={reset}>
            Next roll →
          </button>
        </>
      )}
    </div>
  );
}
