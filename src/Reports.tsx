import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Reports.css";

interface WfmTopItem {
  name: string;
  url_name: string;
  image_name?: string;
  unit_price: number;
  daily_volume: number;
  total_value_7d: number;
}

interface Trade {
  id: number;
  timestamp: string;
  with_player: string;
  direction: "sold" | "bought";
  item_name: string;
  item_url: string;
  quantity: number;
  platinum: number;
  source: string;
  notes: string;
}

interface CategoryStat {
  category: string;
  revenue: number;
  expenses: number;
  profit: number;
  color: string;
}

interface ItemStat {
  item_name: string;
  quantity: number;
  total_plat: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  Prime:   "#c4a44a",
  Riven:   "#9b59b6",
  Set:     "#4d8cca",
  Arcane:  "#e74c3c",
  Mod:     "#e67e22",
  Relic:   "#27ae60",
  Other:   "#7f8c8d",
};

function inferCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("riven"))  return "Riven";
  if (n.includes("arcane")) return "Arcane";
  if (n.includes("relic"))  return "Relic";
  if (n.includes("prime"))  return "Prime";
  if (/ set$/.test(n))      return "Set";
  if (/\bmod\b/.test(n))    return "Mod";
  return "Other";
}

function fmtK(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function PlatIcon({ size = 14 }: { size?: number }) {
  return <img src="/platinum.webp" alt="" width={size} height={size} style={{ objectFit: "contain", flexShrink: 0, verticalAlign: "middle" }} />;
}

// ── SVG Donut Chart ─────────────────────────────────────────────────────────

function DonutChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  const cx = 90, cy = 90, r = 75, ir = 48;
  let angle = -Math.PI / 2;

  const slices = data.map(d => {
    const start = angle;
    const sweep = (d.value / total) * 2 * Math.PI;
    angle += sweep;
    const end = angle;
    const large = sweep > Math.PI ? 1 : 0;

    const ox1 = cx + r * Math.cos(start), oy1 = cy + r * Math.sin(start);
    const ox2 = cx + r * Math.cos(end),   oy2 = cy + r * Math.sin(end);
    const ix1 = cx + ir * Math.cos(start), iy1 = cy + ir * Math.sin(start);
    const ix2 = cx + ir * Math.cos(end),   iy2 = cy + ir * Math.sin(end);

    // Full circle: use two arcs to avoid degenerate path
    const path = sweep >= 2 * Math.PI - 0.001
      ? `M${cx},${cy - r} A${r},${r} 0 1,1 ${cx - 0.001},${cy - r} Z`
      : `M${ox1},${oy1} A${r},${r} 0 ${large},1 ${ox2},${oy2} L${ix2},${iy2} A${ir},${ir} 0 ${large},0 ${ix1},${iy1} Z`;

    const mid = start + sweep / 2;
    const labelR = (r + ir) / 2;
    const lx = cx + labelR * Math.cos(mid);
    const ly = cy + labelR * Math.sin(mid);
    const pct = Math.round((d.value / total) * 100);

    return { ...d, path, lx, ly, pct };
  });

  return (
    <svg viewBox="0 0 180 180" width={180} height={180} className="rpt-donut">
      {slices.map((s, i) => (
        <path key={i} d={s.path} fill={s.color} stroke="#0d1117" strokeWidth={1.5} />
      ))}
      {slices.filter(s => s.pct >= 7).map((s, i) => (
        <text key={i} x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="middle"
          fontSize="11" fill="#fff" fontWeight="700">{s.pct}%</text>
      ))}
    </svg>
  );
}

// ── Legend ──────────────────────────────────────────────────────────────────

function Legend({ items }: { items: { label: string; color: string; value: number }[] }) {
  const total = items.reduce((s, d) => s + d.value, 0);
  return (
    <div className="rpt-legend">
      {items.map(item => (
        <div key={item.label} className="rpt-legend-row">
          <span className="rpt-legend-dot" style={{ background: item.color }} />
          <span className="rpt-legend-label">{item.label}</span>
          <span className="rpt-legend-pct">{total > 0 ? Math.round((item.value / total) * 100) : 0}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

function ItemImg({ imageName, size = 28 }: { imageName?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const s: React.CSSProperties = { width: size, height: size, objectFit: "contain", flexShrink: 0, borderRadius: 3 };
  if (!imageName || failed)
    return <span style={{ ...s, background: "rgba(255,255,255,.06)", border: "1px solid #30363d", display: "inline-block" }} />;
  return <img style={s} src={`https://cdn.warframestat.us/img/${imageName}`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export default function Reports() {
  const [trades, setTrades]         = useState<Trade[]>([]);
  const [loading, setLoading]       = useState(true);
  const [dateRange, setDateRange]   = useState<number | "all">(30);
  const [topItems, setTopItems]     = useState<WfmTopItem[]>([]);
  const [topLoading, setTopLoading] = useState(true);

  useEffect(() => {
    invoke<Trade[]>("get_trades")
      .then(t => { setTrades(t); setLoading(false); })
      .catch(() => setLoading(false));

    // Fetch top WFM items in background — first load takes ~15s (rate-limited),
    // subsequent opens within 3 hours are instant from cache.
    invoke<WfmTopItem[]>("get_wfm_top_items")
      .then(items => { setTopItems(items); setTopLoading(false); })
      .catch(() => setTopLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (dateRange === "all") return trades;
    const cutoff = Date.now() - dateRange * 86_400_000;
    return trades.filter(t => new Date(t.timestamp).getTime() >= cutoff);
  }, [trades, dateRange]);

  const totalRevenue  = useMemo(() => filtered.filter(t => t.direction === "sold").reduce((s, t) => s + t.platinum * t.quantity, 0), [filtered]);
  const totalExpenses = useMemo(() => filtered.filter(t => t.direction === "bought").reduce((s, t) => s + t.platinum * t.quantity, 0), [filtered]);
  const profit        = totalRevenue - totalExpenses;

  const byCategory = useMemo((): CategoryStat[] => {
    const map: Record<string, { revenue: number; expenses: number }> = {};
    for (const t of filtered) {
      const cat = inferCategory(t.item_name);
      if (!map[cat]) map[cat] = { revenue: 0, expenses: 0 };
      const val = t.platinum * t.quantity;
      if (t.direction === "sold")   map[cat].revenue  += val;
      else                          map[cat].expenses += val;
    }
    return Object.entries(map)
      .map(([category, { revenue, expenses }]) => ({
        category, revenue, expenses,
        profit: revenue - expenses,
        color: CATEGORY_COLORS[category] ?? "#7f8c8d",
      }))
      .sort((a, b) => b.profit - a.profit);
  }, [filtered]);

  const topSold = useMemo((): ItemStat[] => {
    const map: Record<string, ItemStat> = {};
    for (const t of filtered.filter(t => t.direction === "sold")) {
      if (!map[t.item_name]) map[t.item_name] = { item_name: t.item_name, quantity: 0, total_plat: 0 };
      map[t.item_name].quantity   += t.quantity;
      map[t.item_name].total_plat += t.platinum * t.quantity;
    }
    return Object.values(map).sort((a, b) => b.total_plat - a.total_plat).slice(0, 7);
  }, [filtered]);

  const topBought = useMemo((): ItemStat[] => {
    const map: Record<string, ItemStat> = {};
    for (const t of filtered.filter(t => t.direction === "bought")) {
      if (!map[t.item_name]) map[t.item_name] = { item_name: t.item_name, quantity: 0, total_plat: 0 };
      map[t.item_name].quantity   += t.quantity;
      map[t.item_name].total_plat += t.platinum * t.quantity;
    }
    return Object.values(map).sort((a, b) => b.total_plat - a.total_plat).slice(0, 7);
  }, [filtered]);

  const profitChartData = useMemo(() =>
    byCategory
      .filter(c => c.profit > 0)
      .map(c => ({ label: c.category, value: c.profit, color: c.color })),
  [byCategory]);

  const topTradedItems = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of filtered) {
      map[t.item_name] = (map[t.item_name] ?? 0) + t.platinum * t.quantity;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 7)
      .map(([item_name, total_plat]) => ({ item_name, total_plat }));
  }, [filtered]);

  const topItemsChartData = useMemo(() =>
    topTradedItems.map((item, i) => ({
      label: item.item_name,
      value: item.total_plat,
      color: Object.values(CATEGORY_COLORS)[i % Object.values(CATEGORY_COLORS).length],
    })),
  [topItems]);

  const RANGES: { label: string; value: number | "all" }[] = [
    { label: "7d",  value: 7  },
    { label: "30d", value: 30 },
    { label: "90d", value: 90 },
    { label: "All", value: "all" },
  ];

  const topItemsChartForWfm = topItems.slice(0, 7).map((item, i) => ({
    label: item.name,
    value: item.total_value_7d,
    color: Object.values(CATEGORY_COLORS)[i % Object.values(CATEGORY_COLORS).length],
  }));

  if (loading) return <div className="rpt-root"><div className="rpt-loading">Loading…</div></div>;

  return (
    <div className="rpt-root">
      <div className="rpt-scroll">

        {/* ── Top WFM items ── always visible, independent of trade history */}
        <div className="rpt-card">
          <div className="rpt-card-title">Top Warframe.Market items (last 7 days)</div>
          {topLoading ? (
            <div className="rpt-top-loading">
              <span className="rpt-top-spinner" />
              Fetching market data… (first load takes ~15s, then cached for 3h)
            </div>
          ) : topItems.length === 0 ? (
            <div className="rpt-top-loading" style={{ color: "var(--muted)" }}>No market data available</div>
          ) : (
            <div className="rpt-top-wrap">
              <table className="rpt-table">
                <thead>
                  <tr><th>Item</th><th>Unit price</th><th>Volume (day)</th><th>Total value</th></tr>
                </thead>
                <tbody>
                  {topItems.map((item, i) => (
                    <tr key={item.url_name}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <ItemImg imageName={item.image_name} size={24} />
                          <span className="rpt-dot" style={{ background: topItemsChartForWfm[i]?.color }} />
                          {item.name}
                        </div>
                      </td>
                      <td className="rpt-num">{item.unit_price.toLocaleString()} <PlatIcon /></td>
                      <td className="rpt-num">{Math.round(item.daily_volume).toLocaleString()}</td>
                      <td className="rpt-num rpt-green">{fmtK(item.total_value_7d)} <PlatIcon /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ flexShrink: 0 }}>
                <DonutChart data={topItemsChartForWfm} />
                <Legend items={topItemsChartForWfm} />
              </div>
            </div>
          )}
        </div>

        {/* ── Date range ── */}
        <div className="rpt-range-row">
          <span className="rpt-range-label">Period:</span>
          {RANGES.map(r => (
            <button key={String(r.value)}
              className={`rpt-range-btn ${dateRange === r.value ? "rpt-range-active" : ""}`}
              onClick={() => setDateRange(r.value)}>
              {r.label}
            </button>
          ))}
          <span className="rpt-trade-count">{filtered.length} trade{filtered.length !== 1 ? "s" : ""}</span>
        </div>

        {trades.length === 0 ? (
          <div className="rpt-empty">
            <div className="rpt-empty-icon">📊</div>
            <div className="rpt-empty-title">No trade history yet</div>
            <div className="rpt-empty-desc">
              Trade history is recorded from the Market tab when you log trades.<br />
              Add trades in the Market → Trading section to see analytics here.
            </div>
          </div>
        ) : <>

        {/* ── Summary stats ── */}
        <div className="rpt-summary">
          <div className="rpt-stat-card">
            <span className="rpt-stat-label">Total revenue</span>
            <span className="rpt-stat-value rpt-green">{fmtK(totalRevenue)} <PlatIcon /></span>
          </div>
          <div className="rpt-stat-card">
            <span className="rpt-stat-label">Total expenses</span>
            <span className="rpt-stat-value rpt-red">{fmtK(totalExpenses)} <PlatIcon /></span>
          </div>
          <div className="rpt-stat-card rpt-stat-highlight">
            <span className="rpt-stat-label">Profit</span>
            <span className={`rpt-stat-value ${profit >= 0 ? "rpt-green" : "rpt-red"}`}>
              {profit >= 0 ? "+" : ""}{fmtK(profit)} <PlatIcon />
            </span>
          </div>
        </div>

        {/* ── Top items + category breakdown ── */}
        <div className="rpt-row">

          {/* Top traded items */}
          <div className="rpt-card rpt-card-flex">
            <div className="rpt-card-title">Top traded items</div>
            <div className="rpt-chart-wrap">
              <DonutChart data={topItemsChartData} />
              <Legend items={topItemsChartData.map(d => ({ label: d.label, color: d.color, value: d.value }))} />
            </div>
            <table className="rpt-table">
              <thead>
                <tr><th>Item</th><th>Total value</th></tr>
              </thead>
              <tbody>
                {topTradedItems.map((item, i) => (
                  <tr key={item.item_name}>
                    <td>
                      <span className="rpt-dot" style={{ background: topItemsChartData[i]?.color }} />
                      {item.item_name}
                    </td>
                    <td className="rpt-num">{fmtK(item.total_plat)} <PlatIcon /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Category breakdown */}
          <div className="rpt-card rpt-card-flex">
            <div className="rpt-card-title">Your trade history stats</div>
            <div className="rpt-chart-wrap">
              <DonutChart data={profitChartData} />
              <Legend items={profitChartData} />
            </div>
            <table className="rpt-table">
              <thead>
                <tr><th>Type</th><th>Revenue</th><th>Expenses</th><th>Profit</th></tr>
              </thead>
              <tbody>
                {byCategory.map(cat => (
                  <tr key={cat.category}>
                    <td>
                      <span className="rpt-dot" style={{ background: cat.color }} />
                      {cat.category}
                    </td>
                    <td className="rpt-num">{cat.revenue > 0 ? <>{fmtK(cat.revenue)} <PlatIcon /></> : <span className="rpt-muted">–</span>}</td>
                    <td className="rpt-num">{cat.expenses > 0 ? <>{fmtK(cat.expenses)} <PlatIcon /></> : <span className="rpt-muted">–</span>}</td>
                    <td className={`rpt-num ${cat.profit >= 0 ? "rpt-green" : "rpt-red"}`}>
                      {cat.profit >= 0 ? "+" : ""}{fmtK(cat.profit)} <PlatIcon />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>

        {/* ── Sales / Purchases ── */}
        <div className="rpt-row">

          <div className="rpt-card">
            <div className="rpt-card-title">Sales</div>
            <table className="rpt-table">
              <thead>
                <tr><th>Item</th><th>Amount</th><th>Total value</th></tr>
              </thead>
              <tbody>
                {topSold.length === 0
                  ? <tr><td colSpan={3} className="rpt-empty-row">No sales recorded</td></tr>
                  : topSold.map(item => (
                    <tr key={item.item_name}>
                      <td>{item.item_name}</td>
                      <td className="rpt-num">{item.quantity.toLocaleString()}</td>
                      <td className="rpt-num rpt-green">{fmtK(item.total_plat)} <PlatIcon /></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>

          <div className="rpt-card">
            <div className="rpt-card-title">Purchases</div>
            <table className="rpt-table">
              <thead>
                <tr><th>Item</th><th>Amount</th><th>Total value</th></tr>
              </thead>
              <tbody>
                {topBought.length === 0
                  ? <tr><td colSpan={3} className="rpt-empty-row">No purchases recorded</td></tr>
                  : topBought.map(item => (
                    <tr key={item.item_name}>
                      <td>{item.item_name}</td>
                      <td className="rpt-num">{item.quantity.toLocaleString()}</td>
                      <td className="rpt-num rpt-red">{fmtK(item.total_plat)} <PlatIcon /></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>

        </div>

        </> /* end trades.length > 0 fragment */}

      </div>
    </div>
  );
}
