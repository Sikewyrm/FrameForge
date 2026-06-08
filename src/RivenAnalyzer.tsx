import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkRivenNow } from "./App";
import "./RivenAnalyzer.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AlternativeResult {
  label: string;
  matched: string[];
  missing: string[];
  score: number;
  verdict: string;
}

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
  alternatives: AlternativeResult[];
}

// ── Saved riven types ─────────────────────────────────────────────────────────

interface SavedRiven {
  id: string; weapon: string; label: string;
  stats_json: string; verdict: string; score: number; saved_at: string;
}
interface StatEntry { name: string; value: string; positive: boolean; useMultiplier?: boolean; }

function verdictColor2(v: string) {
  if (v.startsWith("GREAT")) return "var(--green)";
  if (v.startsWith("GOOD"))  return "#a8d8a8";
  if (v.startsWith("MED"))   return "#f0c040";
  return "var(--red)";
}

// All riven stats in one list — sign (+/-) is set per-roll by the user
const ALL_STATS = [
  "Critical Damage", "Critical Chance", "Multishot", "Base Damage",
  "Fire Rate", "Status Chance", "Toxicity", "Heat", "Electricity",
  "Cold", "Punch Through", "Reload Speed", "Magazine Size",
  "Projectile Flight Speed", "Status Duration",
  "Damage to Infested", "Damage to Grineer", "Damage to Corpus",
  "Attack Speed", "Range", "Combo Count Chance", "Initial Combo",
  "Heavy Attack Efficiency", "Slide Critical Chance",
  "Zoom", "Recoil", "Puncture", "Impact", "Slash", "Ammo Maximum",
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
  const [analysis, setAnalysis]       = useState<RivenAnalysis | null>(null);
  const [_rollCount, setRollCount]     = useState(0);

  // Unified stat builder: each stat has a name, value, sign, and format
  const [builtStats, setBuiltStats]   = useState<StatEntry[]>([]);
  // editingId: if set, the save button becomes "Update" and targets this saved roll
  const [editingId, setEditingId]     = useState<string | null>(null);

  // Inline card edit state
  const [inlineEditId, setInlineEditId]       = useState<string | null>(null);
  const [inlineEditLabel, setInlineEditLabel] = useState("");
  const [inlineEditStats, setInlineEditStats] = useState<StatEntry[]>([]);

  // Derive positives/negatives for the analysis call
  const positives = builtStats.filter(s => s.positive).map(s => s.name);
  const negative  = builtStats.find(s => !s.positive)?.name ?? "";

  const toggleStat = (name: string) => {
    setBuiltStats(prev => {
      const exists = prev.find(s => s.name === name);
      if (exists) return prev.filter(s => s.name !== name);
      // Damage-to stats default to × multiplier format
      const useMultiplier = name.startsWith("Damage to");
      return [...prev, { name, value: "", positive: true, useMultiplier }];
    });
  };

  const updateStatValue = (name: string, value: string) =>
    setBuiltStats(prev => prev.map(s => s.name === name ? { ...s, value } : s));

  const toggleStatSign = (name: string) =>
    setBuiltStats(prev => prev.map(s => s.name === name ? { ...s, positive: !s.positive } : s));

  const toggleStatFormat = (name: string) =>
    setBuiltStats(prev => prev.map(s =>
      s.name === name ? { ...s, useMultiplier: !s.useMultiplier } : s
    ));

  const [dbStatus, setDbStatus]       = useState("");
  const [showLog, setShowLog]         = useState(false);
  const [sessionLog, setSessionLog]   = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Saved rivens ────────────────────────────────────────────────────────────
  const [savedRivens, setSavedRivens] = useState<SavedRiven[]>([]);
  const [saveStatus, setSaveStatus]   = useState("");
  // Comparison: set of selected ids
  const [compareIds, setCompareIds]   = useState<Set<string>>(new Set());
  // Inline rename: id → draft label
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});

  const loadSavedRivens = useCallback(async () => {
    const list = await invoke<SavedRiven[]>("get_saved_riven_rolls").catch(() => []);
    setSavedRivens(list);
  }, []);

  useEffect(() => { loadSavedRivens(); }, [loadSavedRivens]);

  const saveCurrentRoll = async () => {
    if (!selectedWeapon) return;
    const stats = builtStats.filter(s => s.value.trim() !== "");
    if (stats.length === 0) { setSaveStatus("Add stat values before saving."); return; }
    const now = new Date();
    try {
      if (editingId) {
        // Update existing roll
        await invoke("delete_saved_riven_roll", { id: editingId });
        await invoke("save_riven_roll", {
          weapon: selectedWeapon,
          label: savedRivens.find(r => r.id === editingId)?.label ?? `${selectedWeapon.charAt(0).toUpperCase() + selectedWeapon.slice(1)} · ${now.getDate()} ${now.toLocaleString("en",{month:"short"})}`,
          statsJson: JSON.stringify(stats),
          verdict: analysis?.verdict ?? "", score: analysis?.score ?? 0,
        });
        setEditingId(null);
        setSaveStatus("Updated!");
      } else {
        const label = `${selectedWeapon.charAt(0).toUpperCase() + selectedWeapon.slice(1)} · ${now.getDate()} ${now.toLocaleString("en",{month:"short"})} ${now.getFullYear()}`;
        await invoke("save_riven_roll", {
          weapon: selectedWeapon, label, statsJson: JSON.stringify(stats),
          verdict: analysis?.verdict ?? "", score: analysis?.score ?? 0,
        });
        setSaveStatus("Saved!");
      }
      loadSavedRivens();
      setTimeout(() => setSaveStatus(""), 2000);
    } catch (e: unknown) { setSaveStatus(String(e)); }
  };

  const startInlineEdit = (r: SavedRiven) => {
    const stats: StatEntry[] = (() => { try { return JSON.parse(r.stats_json); } catch { return []; } })();
    setInlineEditId(r.id);
    setInlineEditLabel(r.label);
    setInlineEditStats(stats);
  };

  const saveInlineEdit = async (r: SavedRiven) => {
    const stats = inlineEditStats.filter(s => s.value.trim() !== "");
    try {
      await invoke("delete_saved_riven_roll", { id: r.id });
      await invoke("save_riven_roll", {
        weapon: r.weapon,
        label: inlineEditLabel,
        statsJson: JSON.stringify(stats),
        verdict: r.verdict,
        score: r.score,
      });
      loadSavedRivens();
      setInlineEditId(null);
    } catch {}
  };

  const deleteSaved = async (id: string) => {
    await invoke("delete_saved_riven_roll", { id }).catch(() => {});
    setSavedRivens(prev => prev.filter(r => r.id !== id));
    setCompareIds(prev => { const s = new Set(prev); s.delete(id); return s; });
  };

  const applyRename = async (id: string) => {
    const label = renameDraft[id]?.trim();
    if (!label) return;
    await invoke("rename_saved_riven_roll", { id, label }).catch(() => {});
    setSavedRivens(prev => prev.map(r => r.id === id ? { ...r, label } : r));
    setRenameDraft(prev => { const d = { ...prev }; delete d[id]; return d; });
  };

  const toggleCompare = (id: string) => {
    setCompareIds(prev => {
      const s = new Set(prev);
      if (s.has(id)) { s.delete(id); } else if (s.size < 2) { s.add(id); }
      return s;
    });
  };

  const compareList = savedRivens.filter(r => compareIds.has(r.id));

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
    const unlistenSaved = listen("riven-roll-saved", () => loadSavedRivens());
    return () => {
      unlistenReroll.then(fn => fn());
      unlistenUnveil.then(fn => fn());
      unlistenSaved.then(fn => fn());
    };
  }, [selectedWeapon, positives, negative]); // eslint-disable-line

  const selectWeapon = (w: string) => {
    setSelectedWeapon(w);
    setWeaponInput(w.charAt(0).toUpperCase() + w.slice(1));
    setFiltered([]);
    setBuiltStats([]);
    setAnalysis(null);
    setRollCount(0);
    setEditingId(null);
  };

  const runAnalysis = useCallback(async () => {
    if (!selectedWeapon || builtStats.length === 0) { setAnalysis(null); return; }
    const result = await invoke<RivenAnalysis | null>("analyze_riven", {
      weapon: selectedWeapon,
      positives: builtStats.filter(s => s.positive).map(s => s.name),
      negatives: builtStats.filter(s => !s.positive).map(s => s.name),
    });
    setAnalysis(result ?? null);
  }, [selectedWeapon, builtStats]);

  useEffect(() => { if (selectedWeapon) runAnalysis(); }, [builtStats, runAnalysis]);

  const reset = () => {
    setBuiltStats([]);
    setAnalysis(null);
    setEditingId(null);
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
          {/* Unified stat picker — click to add, sign toggled below */}
          <div className="riven-section-label">Select stats rolled <span className="riven-optional">(click to add, set + / − below)</span></div>
          <div className="riven-stat-grid">
            {ALL_STATS.map(stat => {
              const entry = builtStats.find(s => s.name === stat);
              return (
                <button
                  key={stat}
                  className={`riven-stat-btn${entry ? (entry.positive ? " selected" : " selected-neg") : ""}`}
                  onClick={() => toggleStat(stat)}
                >
                  {entry ? (entry.positive ? "+" : "−") : ""}{stat}
                </button>
              );
            })}
          </div>

          {/* Per-stat value rows with +/- and %/× toggles */}
          {builtStats.length > 0 && (
            <div className="riven-value-inputs">
              <div className="riven-section-label">Stat values</div>
              {builtStats.map(stat => (
                <div key={stat.name} className="riven-value-row">
                  {/* +/- toggle */}
                  <button
                    className={`riven-sign-btn${stat.positive ? " sign-pos" : " sign-neg"}`}
                    onClick={() => toggleStatSign(stat.name)}
                    title="Toggle positive / negative"
                  >{stat.positive ? "+" : "−"}</button>
                  <span className="riven-value-label">{stat.name}</span>
                  <input
                    className="riven-value-input"
                    placeholder={stat.useMultiplier ? "e.g. 0.88" : "e.g. 85"}
                    value={stat.value}
                    onChange={e => updateStatValue(stat.name, e.target.value)}
                  />
                  {/* %/× toggle — click to switch format */}
                  <button
                    className="riven-fmt-btn"
                    onClick={() => toggleStatFormat(stat.name)}
                    title="Click to switch between % and × (multiplier)"
                  >
                    {stat.useMultiplier ? "×" : "%"}
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <button className="riven-save-btn" onClick={saveCurrentRoll}>
                  {editingId ? "✓ Update Roll" : "💾 Save Roll"}
                </button>
                {editingId && <button className="riven-cancel-edit-btn" onClick={reset}>Cancel</button>}
                {saveStatus && <span style={{ fontSize: 11, color: saveStatus.includes("!") || saveStatus.includes("✓") ? "var(--green)" : "var(--red)" }}>{saveStatus}</span>}
              </div>
            </div>
          )}

          {/* Analysis — one card per build alternative */}
          {analysis && (
            <div className="riven-alternatives">
              {analysis.alternatives.map((alt, i) => (
                <div key={i} className="riven-alt-card">
                  <div className="riven-alt-header">
                    {analysis.alternatives.length > 1 && (
                      <span className="riven-alt-label">{alt.label}</span>
                    )}
                    <span className="riven-verdict" style={{ color: verdictColor(alt.verdict) }}>
                      {alt.verdict}
                    </span>
                  </div>
                  <ScoreBar score={alt.score} />
                  <div className="riven-stats-breakdown">
                    {alt.matched.map(s => (
                      <div key={s} className="riven-stat-row riven-stat-good">
                        <span className="riven-stat-icon">✓</span><span>{s}</span>
                        <span className="riven-stat-tag">Wanted</span>
                      </div>
                    ))}
                    {alt.missing.map(s => (
                      <div key={s} className="riven-stat-row riven-stat-miss">
                        <span className="riven-stat-icon">○</span><span>{s}</span>
                        <span className="riven-stat-tag">Not rolled</span>
                      </div>
                    ))}
                    {i === 0 && analysis.safe_negatives_present.map(s => (
                      <div key={s} className="riven-stat-row riven-stat-safe">
                        <span className="riven-stat-icon">✓</span><span>−{s}</span>
                        <span className="riven-stat-tag">Safe neg</span>
                      </div>
                    ))}
                    {i === 0 && analysis.harmful_negatives.map(s => (
                      <div key={s} className="riven-stat-row riven-stat-bad">
                        <span className="riven-stat-icon">✗</span><span>−{s}</span>
                        <span className="riven-stat-tag">Harmful</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
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

      {/* ── Saved Rolls ──────────────────────────────────────────────────────── */}
      {savedRivens.length > 0 && (
        <div className="riven-saved-section">
          <div className="riven-section-label" style={{ marginBottom: 8 }}>
            Saved Rolls ({savedRivens.length}/50)
            {compareIds.size > 0 && <span style={{ marginLeft: 8, color: "var(--accent)", fontSize: 11 }}>
              {compareIds.size === 1 ? "Select 1 more to compare" : "Comparing ↓"}
            </span>}
          </div>

          <div className="riven-saved-grid">
            {savedRivens.map(r => {
              const stats: StatEntry[] = (() => { try { return JSON.parse(r.stats_json); } catch { return []; } })();
              const isSelected = compareIds.has(r.id);
              const isEditing = inlineEditId === r.id;
              return (
                <div key={r.id} className={`riven-saved-card${isSelected ? " riven-saved-selected" : ""}`}>
                  {/* Card header */}
                  <div className="riven-saved-header">
                    <input
                      className="riven-saved-label-input"
                      value={isEditing ? inlineEditLabel : r.label}
                      onChange={e => isEditing ? setInlineEditLabel(e.target.value) : setRenameDraft(p => ({ ...p, [r.id]: e.target.value }))}
                      onBlur={() => !isEditing && applyRename(r.id)}
                      onKeyDown={e => !isEditing && e.key === "Enter" && applyRename(r.id)}
                    />
                    <div className="riven-saved-actions">
                      {isEditing ? (<>
                        <button className="riven-saved-compare-btn active" onClick={() => saveInlineEdit(r)} title="Save changes">✓</button>
                        <button className="riven-saved-delete-btn" onClick={() => setInlineEditId(null)} title="Cancel edit">✕</button>
                      </>) : (<>
                        <button
                          className={`riven-saved-compare-btn${isSelected ? " active" : ""}`}
                          onClick={() => toggleCompare(r.id)}
                          title="Select for comparison"
                        >{isSelected ? "✓" : "⚖"}</button>
                        <button className="riven-saved-edit-btn" onClick={() => startInlineEdit(r)} title="Edit roll">✎</button>
                        <button className="riven-saved-delete-btn" onClick={() => deleteSaved(r.id)} title="Delete">✕</button>
                      </>)}
                    </div>
                  </div>

                  {/* Verdict */}
                  {r.verdict && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: verdictColor2(r.verdict), marginBottom: 4 }}>
                      {r.verdict.split("—")[0].trim()} · {Math.round(r.score * 100)}%
                    </div>
                  )}

                  {/* Stats — editable in edit mode */}
                  <div className="riven-saved-stats">
                    {(isEditing ? inlineEditStats : stats).map((s, i) => (
                      <div key={i} className="riven-saved-stat" style={{ alignItems: "center", gap: 4 }}>
                        {isEditing ? (<>
                          <button
                            className="riven-sign-btn" style={{ width: 18, height: 18, fontSize: 11, padding: 0 }}
                            onClick={() => setInlineEditStats(prev => prev.map((x, j) => j === i ? { ...x, positive: !x.positive } : x))}
                          >{s.positive ? "+" : "−"}</button>
                          <input
                            style={{ width: 48, background: "rgba(0,0,0,.3)", border: "1px solid rgba(48,54,61,.6)", borderRadius: 3, color: "var(--text)", fontSize: 11, padding: "1px 4px", textAlign: "right" }}
                            value={s.value}
                            onChange={e => setInlineEditStats(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                          />
                          <span style={{ fontSize: 11, color: "var(--muted)" }}>% {s.name}</span>
                        </>) : (<>
                          <span style={{ color: s.positive ? "rgba(139,148,158,.7)" : "var(--red)" }}>
                            {s.positive ? "+" : "−"}
                          </span>
                          <span>{s.value && `${s.value}% `}{s.name}</span>
                        </>)}
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 10, color: "rgba(139,148,158,.4)", marginTop: 4 }}>
                    {r.saved_at.slice(0, 10)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Comparison panel */}
          {compareList.length === 2 && (
            <div className="riven-compare-panel">
              <div className="riven-section-label" style={{ marginBottom: 8 }}>Comparison</div>
              <div className="riven-compare-grid">
                {compareList.map(r => {
                  const stats: StatEntry[] = (() => { try { return JSON.parse(r.stats_json); } catch { return []; } })();
                  return (
                    <div key={r.id} className="riven-compare-col">
                      <div className="riven-compare-label">{r.label}</div>
                      {r.verdict && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: verdictColor2(r.verdict), marginBottom: 6 }}>
                          {r.verdict.split("—")[0].trim()} · {Math.round(r.score * 100)}%
                        </div>
                      )}
                      {stats.map((s, i) => (
                        <div key={i} className="riven-saved-stat">
                          <span style={{ color: s.positive ? "rgba(139,148,158,.7)" : "var(--red)" }}>
                            {s.positive ? "+" : "−"}
                          </span>
                          <span>{s.value && `${s.value}% `}{s.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
