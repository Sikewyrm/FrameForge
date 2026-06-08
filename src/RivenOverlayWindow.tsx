import { useState, useEffect, useRef } from "react";
import { listen, emit } from "@tauri-apps/api/event";

// Tells App.tsx to run OCR again (for "Check New Roll" / "Start Comparison")
const triggerNewCheck = () => emit("riven-manual-check", {}).catch(() => {});

// Save current roll directly from overlay
async function saveOverlayRoll(
  weapon: string,
  stats: { name: string; value: string; positive: boolean }[],
  verdict: string, score: number, rollCount: number
) {
  if (!weapon || stats.length === 0) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const now = new Date();
  const label = `${weapon.charAt(0).toUpperCase() + weapon.slice(1)} · Roll #${rollCount} · ${now.getDate()} ${now.toLocaleString("en",{month:"short"})}`;
  await invoke("save_riven_roll", {
    weapon, label, statsJson: JSON.stringify(stats), verdict, score,
  }).catch(() => {});
  const { emit } = await import("@tauri-apps/api/event");
  await emit("riven-roll-saved").catch(() => {});
}

import "./RivenOverlayWindow.css";

// No auto-hide — user dismisses with ✕ or the poll detects screen closure.
// Only a very long emergency fallback (60 min) in case everything else fails.

// Ask App.tsx to hide this overlay — App.tsx owns the rivenWin reference
// Tell App.tsx to hide the overlay AND log the reason BEFORE hiding
const requestHide = (reason: string) => {
  emit("riven-overlay-hide", { reason }).catch(() => {});
};

interface AlternativeResult { label: string; matched: string[]; missing: string[]; score: number; verdict: string; }

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

interface RolledStat {
  name: string;
  value: string;
  positive: boolean;
}

function verdictColor(verdict: string): string {
  if (verdict.startsWith("GREAT"))    return "#3fb950";
  if (verdict.startsWith("GOOD"))     return "#a8d8a8";
  if (verdict.startsWith("MEDIOCRE")) return "#f0c040";
  return "#f85149";
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.8 ? "#3fb950" : score >= 0.6 ? "#a8d8a8" : score >= 0.4 ? "#f0c040" : "#f85149";
  return (
    <div className="rov-score-wrap">
      <div className="rov-score-track">
        <div className="rov-score-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="rov-score-pct" style={{ color }}>{pct}%</span>
    </div>
  );
}

export default function RivenOverlayWindow() {
  const [analysis, setAnalysis]         = useState<RivenAnalysis | null>(null);
  const [rolledStats, setRolledStats]   = useState<RolledStat[]>([]);
  const [originalStats, setOriginalStats] = useState<RolledStat[]>([]);
  const [isComparison, setIsComparison] = useState(false);
  const [ocrRaw, setOcrRaw]             = useState("");
  const [parsedWeapon, setParsedWeapon] = useState("");
  const [rollCount, setRollCount]       = useState(0);
  const [scanning, setScanning]         = useState(true);
  const [saved, setSaved]               = useState(false);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetToScanning = () => {
    setScanning(true);
    setAnalysis(null);
    setRolledStats([]);
    setOriginalStats([]);
    setIsComparison(false);
    setOcrRaw("");
    setParsedWeapon("");
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    // 60-min emergency fallback — only fires if poll completely breaks
    scanTimerRef.current = setTimeout(() => requestHide("emergency-60min"), 3_600_000);
  };

  useEffect(() => {
    const unlistenStart = listen("riven-scanning-start", () => resetToScanning());

    const unlistenUpdate = listen<{
      analysis: RivenAnalysis | null;
      rollCount: number;
      ocrRaw?: string;
      weapon?: string;
      rolledStats?: RolledStat[];
      originalStats?: RolledStat[];
      isComparison?: boolean;
    }>("riven-analysis-update", e => {
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      setAnalysis(e.payload.analysis ?? null);
      setRollCount(e.payload.rollCount);
      setOcrRaw(e.payload.ocrRaw ?? "");
      setParsedWeapon(e.payload.weapon ?? "");
      setRolledStats(e.payload.rolledStats ?? []);
      setOriginalStats(e.payload.originalStats ?? []);
      setIsComparison(e.payload.isComparison ?? false);
      setScanning(false);
      // Reset emergency fallback timer — 60 min from last data shown
      scanTimerRef.current = setTimeout(() => requestHide("emergency-60min"), 3_600_000);
    });

    // Tell App.tsx the listener is registered and the pending payload can be sent now.
    emit("riven-window-ready", {}).catch(() => {});

    // Initial hide fallback — same as resetToScanning's timer
    scanTimerRef.current = setTimeout(() => requestHide("emergency-60min"), 3_600_000);

    return () => {
      unlistenStart.then(fn => fn());
      unlistenUpdate.then(fn => fn());
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, []); // eslint-disable-line

  const weaponName = analysis?.weapon ?? parsedWeapon;
  const displayName = weaponName
    ? weaponName.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : "Riven Analyzer";

  // All wanted stat names — matched (in new roll) + missing (from groups like "MS / TOX / DMG")
  const allWantedNames = new Set<string>();
  if (analysis) {
    analysis.matched_positives.forEach(s => allWantedNames.add(s));
    analysis.missing_positives.forEach(group =>
      group.split(" / ").forEach(s => allWantedNames.add(s.trim()))
    );
  }

  // Classify a rolled stat against the analysis
  const classifyStat = (stat: RolledStat): "wanted" | "neutral" | "safe_neg" | "harmful" => {
    if (!analysis) return "neutral";
    if (!stat.positive) {
      return analysis.safe_negatives_present.includes(stat.name) ? "safe_neg" : "harmful";
    }
    return analysis.matched_positives.includes(stat.name) ? "wanted" : "neutral";
  };

  // Classify an original-roll stat — same logic but uses the full wanted list
  const classifyOriginalStat = (stat: RolledStat): "wanted" | "neutral" | "safe_neg" | "harmful" => {
    if (!analysis) return "neutral";
    if (!stat.positive) {
      // For original negatives, mark as safe if in the weapon's safe list (same DB)
      return analysis.safe_negatives_present.includes(stat.name) ? "safe_neg" : "neutral";
    }
    return allWantedNames.has(stat.name) ? "wanted" : "neutral";
  };

  const statClass = (cls: "wanted" | "neutral" | "safe_neg" | "harmful") => {
    if (cls === "wanted")    return "rov-stat-wanted";
    if (cls === "neutral")   return "rov-stat-neutral";
    if (cls === "safe_neg")  return "rov-stat-safeneg";
    return "rov-stat-harmful";
  };

  const statIcon = (cls: "wanted" | "neutral" | "safe_neg" | "harmful") => {
    if (cls === "wanted")   return "✓";
    if (cls === "safe_neg") return "✓";
    if (cls === "harmful")  return "✗";
    return "○";
  };

  return (
    <div className="rov-root">
      <div className="rov-card">
        {/* Header */}
        <div className="rov-header">
          <span className="rov-title">{displayName}</span>
          <button className="rov-compare-btn" onClick={() => triggerNewCheck()} title="Re-scan (use after cycling for comparison)">
            {isComparison ? "🔄 Refresh" : "⚡ New Roll"}
          </button>
          {rolledStats.length > 0 && (
            <button className="rov-save-btn" title="Save this roll"
              onClick={async () => {
                await saveOverlayRoll(weaponName, rolledStats, analysis?.verdict ?? "", analysis?.score ?? 0, rollCount);
                setSaved(true); setTimeout(() => setSaved(false), 2000);
              }}>
              {saved ? "✓" : "💾"}
            </button>
          )}
          <button className="rov-close-btn" onClick={() => requestHide("x-button")} title="Dismiss">✕</button>
        </div>

        {/* Scanning */}
        {scanning && (
          <div className="rov-scanning">Scanning stats…</div>
        )}

        {/* No result */}
        {!scanning && rolledStats.length === 0 && !analysis && (
          <div className="rov-scanning" style={{ color: "#f85149" }}>
            Could not read card stats
            {parsedWeapon && <div style={{ fontSize: 10, marginTop: 3, color: "rgba(139,148,158,.7)" }}>Weapon: "{parsedWeapon}"</div>}
          </div>
        )}

        {/* Result */}
        {!scanning && (rolledStats.length > 0 || analysis) && (
          <>
            {/* One analysis card per build alternative */}
            {analysis && analysis.alternatives.map((alt, i) => (
              <div key={i} className="rov-alt-card">
                {analysis.alternatives.length > 1 && (
                  <span className="rov-alt-label">{alt.label}</span>
                )}
                <div className="rov-verdict" style={{ color: verdictColor(alt.verdict) }}>
                  {alt.verdict}
                </div>
                <ScoreBar score={alt.score} />
                {/* Negatives shown once on first card */}
                {i === 0 && analysis.safe_negatives_present.map(s => (
                  <div key={s} className="rov-stat-row rov-stat-safeneg">
                    <span className="rov-stat-icon">✓</span>
                    <span className="rov-stat-name">−{s}</span>
                    <span className="rov-stat-value" style={{fontSize:10}}>Safe</span>
                  </div>
                ))}
                {i === 0 && analysis.harmful_negatives.map(s => (
                  <div key={s} className="rov-stat-row rov-stat-harmful">
                    <span className="rov-stat-icon">✗</span>
                    <span className="rov-stat-name">−{s}</span>
                    <span className="rov-stat-value" style={{fontSize:10}}>Harmful</span>
                  </div>
                ))}
                {alt.missing.length > 0 && (
                  <div className="rov-missing">
                    <span className="rov-missing-label">Wanted: </span>
                    {alt.missing.map((s, j) => (
                      <span key={s} className="rov-missing-stat">
                        {s}{j < alt.missing.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Rolled stats — what's actually on the card */}
            {rolledStats.length > 0 && (
              <div className="rov-rolled-stats">
              {isComparison && <div className="rov-new-roll-label">New roll</div>}
                {rolledStats.map((stat, i) => {
                  const cls = classifyStat(stat);
                  return (
                    <div key={i} className={`rov-stat-row ${statClass(cls)}`}>
                      <span className="rov-stat-icon">{statIcon(cls)}</span>
                      <span className="rov-stat-name">{stat.name}</span>
                      <span className="rov-stat-value">{stat.value}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Original roll (comparison mode only) — same quality colors as new roll */}
            {isComparison && originalStats.length > 0 && (
              <div className="rov-original-section">
                <div className="rov-section-label">Original roll</div>
                <div className="rov-rolled-stats">
                  {originalStats.map((stat, i) => {
                    const cls = classifyOriginalStat(stat);
                    return (
                      <div key={i} className={`rov-stat-row ${statClass(cls)}`} style={{ opacity: 0.75 }}>
                        <span className="rov-stat-icon">{statIcon(cls)}</span>
                        <span className="rov-stat-name">{stat.name}</span>
                        <span className="rov-stat-value">{stat.value}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}


            {/* No DB entry */}
            {!analysis && rolledStats.length > 0 && (
              <div className="rov-missing" style={{ color: "rgba(139,148,158,.6)" }}>
                No database entry for {displayName}
              </div>
            )}

            {analysis?.notes && (
              <div className="rov-notes">ℹ {analysis.notes}</div>
            )}

            {/* Raw OCR fallback */}
            {!analysis && ocrRaw && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 10, color: "rgba(139,148,158,.5)", cursor: "pointer" }}>Raw OCR</summary>
                <pre style={{ fontSize: 9, color: "rgba(139,148,158,.6)", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto", marginTop: 3 }}>{ocrRaw}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
