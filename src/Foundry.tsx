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
  mastery_req?: number | null;
}

interface RecipeComponent {
  unique_name: string;
  name: string;
  count: number;
  result_count: number;
  components: RecipeComponent[];
}

interface CraftingJob {
  unique_name: string;
  item_name: string;
  completion_ms: number;
}

interface Props {
  quantities: Record<string, number>;
  masteryData: Record<string, number>;
  refreshKey: number;
  crafting: CraftingJob[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString(); }

function collectNeeds(
  nodes: RecipeComponent[],
  multiplier: number,
  acc: Map<string, { name: string; needed: number }>
) {
  for (const node of nodes) {
    const resultCount = node.result_count ?? 1;
    const craftsNeeded = Math.ceil((node.count * multiplier) / resultCount);
    if (node.components.length === 0) {
      const prev = acc.get(node.unique_name);
      acc.set(node.unique_name, { name: node.name, needed: (prev?.needed ?? 0) + node.count * multiplier });
    } else {
      collectNeeds(node.components, craftsNeeded, acc);
      const prev = acc.get(node.unique_name);
      acc.set(node.unique_name, { name: node.name, needed: (prev?.needed ?? 0) + node.count * multiplier });
    }
  }
}

type CompStatus = "none" | "blueprint" | "part";

function compStatus(comp: RecipeComponent, quantities: Record<string, number>): CompStatus {
  if ((quantities[comp.unique_name] ?? 0) > 0) return "part";
  const bpUnique = comp.components[0]?.unique_name;
  if (bpUnique && (quantities[bpUnique] ?? 0) > 0) return "blueprint";
  return "none";
}

function isLichWeapon(item: CatalogItem): boolean {
  return item.name.startsWith("Kuva ") || item.name.startsWith("Tenet ");
}

// ─── Relic helpers ────────────────────────────────────────────────────────────

function RelicIcon() {
  return (
    <svg viewBox="0 0 20 26" width="11" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" className="relic-icon">
      <ellipse cx="10" cy="13" rx="8.5" ry="11.5" fill="rgba(255,220,100,.15)" stroke="rgba(255,220,100,.7)" strokeWidth="1.2"/>
      <path d="M10 4 C7 7 6 10 8 13 C10 16 9 19 10 22" stroke="rgba(255,220,100,.9)" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      <path d="M10 4 C13 7 14 10 12 13 C10 16 11 19 10 22" stroke="rgba(255,220,100,.6)" strokeWidth="0.9" strokeLinecap="round" fill="none"/>
    </svg>
  );
}

const RELIC_SUFFIXES = ["Bronze", "Silver", "Gold", "Platinum"];
function ownsRelicVariant(relicUnique: string, quantities: Record<string, number>): boolean {
  const base = relicUnique.replace(/(Bronze|Silver|Gold|Platinum)$/, "");
  return RELIC_SUFFIXES.some(s => (quantities[`${base}${s}`] ?? 0) > 0);
}

// ─── Item image ───────────────────────────────────────────────────────────────

function ItemImg({ imageName, category, size = 40 }: { imageName?: string; category: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, flexShrink: 0 };
  if (!imageName || failed)
    return <span className="item-img-fallback" style={{ ...style, fontSize: size * 0.35 }}>{category[0].toUpperCase()}</span>;
  return (
    <img className="item-img" style={style} src={`https://cdn.warframestat.us/img/${imageName}`}
      alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

// ─── Comp row (used inside modal tree) ───────────────────────────────────────

function CompRow({ comp, quantities, relicDrops, relicNames }: {
  comp: RecipeComponent; quantities: Record<string, number>;
  relicDrops: Record<string, string[]>; relicNames: Record<string, string>;
}) {
  const status = compStatus(comp, quantities);
  const ownedRelics = [...new Set(
    (relicDrops[comp.unique_name] ?? [])
      .filter(r => ownsRelicVariant(r, quantities))
      .map(r => {
        const base = r.replace(/(Bronze|Silver|Gold|Platinum)$/, "");
        const owned = RELIC_SUFFIXES.find(s => (quantities[`${base}${s}`] ?? 0) > 0);
        const key = owned ? `${base}${owned}` : r;
        return relicNames[key] ?? relicNames[r] ?? r.split("/").pop() ?? r;
      })
  )];
  return (
    <div className={`comp-row comp-row-${status}`}>
      {ownedRelics.length > 0 && (
        <span className="relic-icon-wrap" title={ownedRelics.join("\n")}><RelicIcon /></span>
      )}
      <span className="comp-row-name">{comp.name}</span>
      {status === "part"      && <span className="comp-row-badge">✓</span>}
      {status === "blueprint" && <span className="comp-row-badge">BP</span>}
    </div>
  );
}

// ─── Tree node (modal recipe tree) ───────────────────────────────────────────

function TreeNode({ node, quantities, depth }: {
  node: RecipeComponent; quantities: Record<string, number>; depth: number;
}) {
  const owned = quantities[node.unique_name] ?? 0;
  const enough = owned >= node.count;
  const hasChildren = node.components.length > 0;
  // Don't auto-expand satisfied nodes — hides unnecessary sub-trees (e.g. Control Module Blueprint when you have 443)
  const [open, setOpen] = useState(!enough && depth < 3);
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        className={`recipe-row ${enough ? "recipe-ok" : "recipe-missing"}`}
        onClick={() => hasChildren && setOpen(o => !o)}
        style={{ cursor: hasChildren ? "pointer" : "default" }}
      >
        {hasChildren
          ? <span className="recipe-chevron">{open ? "▾" : "▸"}</span>
          : <span className="recipe-chevron recipe-chevron-leaf">·</span>}
        <span className="recipe-name">{node.name}</span>
        <span className="recipe-counts">
          <span className={enough ? "qty-have" : "qty-need"}>{fmt(owned)}</span>
          <span className="qty-sep">/</span>
          <span className="qty-required">{fmt(node.count)}</span>
        </span>
        {!enough && <span className="recipe-shortage">−{fmt(node.count - owned)}</span>}
      </div>
      {hasChildren && open && node.components.map((child, i) => (
        <TreeNode key={i} node={child} quantities={quantities} depth={depth + 1} />
      ))}
    </div>
  );
}

// ─── Recipe modal ─────────────────────────────────────────────────────────────

function RecipeModal({ item, recipe, quantities, isTracked, onTrack, onClose, crafting }: {
  item: CatalogItem; recipe: RecipeComponent[] | null;
  quantities: Record<string, number>; isTracked: boolean;
  onTrack: () => void; onClose: () => void; crafting: CraftingJob[];
}) {
  const [mode, setMode] = useState<"tree" | "needs">("tree");
  const isKuva = isLichWeapon(item);
  const craftJob = crafting.find(c =>
    c.unique_name === item.unique_name ||
    (recipe && recipe.length > 0 && recipe[0].unique_name === c.unique_name)
  );

  const needs = useMemo(() => {
    if (!recipe?.length) return [];
    const acc = new Map<string, { name: string; needed: number }>();
    collectNeeds(recipe, 1, acc);
    return Array.from(acc.entries())
      .map(([unique_name, { name, needed }]) => ({
        unique_name, name, needed, owned: quantities[unique_name] ?? 0,
      }))
      .filter(r => r.owned < r.needed)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [recipe, quantities]);

  return (
    <div className="craft-modal-overlay" onClick={onClose}>
      <div className="craft-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="craft-modal-header">
          <ItemImg imageName={item.image_name} category={item.category} size={36} />
          <span className="craft-modal-title">{item.name}</span>
          {craftJob && <span className="craft-modal-foundry-badge" title={`Building — ${item.name}`}>⚒ Building</span>}
          <button className={`foundry-track-btn-large ${isTracked ? "tracked" : ""}`} onClick={onTrack}>
            {isTracked ? "★ Tracked" : "☆ Track"}
          </button>
          <button className="craft-detail-close" onClick={onClose}>✕</button>
        </div>

        {isKuva ? (
          <div className="craft-modal-body">
            <div className="craft-kuva-notice">
              <span className="craft-kuva-icon">🔱</span>
              <div>
                <strong>{item.name}</strong> is obtained by converting a{" "}
                {item.name.startsWith("Kuva ") ? <strong>Kuva Lich</strong> : <strong>Tenet Sister</strong>},
                not crafted from a Blueprint.
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="craft-modal-tabs">
              <button className={`toggle-btn ${mode === "tree" ? "toggle-active" : ""}`} onClick={() => setMode("tree")}>Full tree</button>
              <button className={`toggle-btn ${mode === "needs" ? "toggle-active" : ""}`} onClick={() => setMode("needs")}>What I need</button>
            </div>
            <div className="craft-modal-body">
              {!recipe ? (
                <div className="empty-msg">Loading…</div>
              ) : recipe.length === 0 ? (
                <div className="empty-msg">No recipe data.</div>
              ) : mode === "tree" ? (
                recipe.map((node, i) => <TreeNode key={i} node={node} quantities={quantities} depth={0} />)
              ) : needs.length === 0 ? (
                <div className="empty-msg">✓ You have everything needed.</div>
              ) : (
                <div className="needs-list">
                  {needs.map(r => (
                    <div key={r.unique_name} className="needs-row">
                      <span className="needs-name">{r.name}</span>
                      <span className="needs-counts">
                        <span className="qty-need">{fmt(r.owned)}</span>
                        <span className="qty-sep">/</span>
                        <span className="qty-required">{fmt(r.needed)}</span>
                        <span className="recipe-shortage">−{fmt(r.needed - r.owned)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Craft card ───────────────────────────────────────────────────────────────

function CraftCard({ item, recipe, quantities, relicDrops, relicNames, masteryData, crafting, isTracked, onTrack, onOpen }: {
  item: CatalogItem; recipe: RecipeComponent[] | null;
  quantities: Record<string, number>; relicDrops: Record<string, string[]>;
  relicNames: Record<string, string>; masteryData: Record<string, number>;
  crafting: CraftingJob[]; isTracked: boolean; onTrack: () => void; onOpen: () => void;
}) {
  const isOwned    = (quantities[item.unique_name] ?? 0) > 0;
  const rank       = masteryData[item.unique_name];
  const isMastered = rank != null && rank >= 30;
  // Memory scanner stores the recipe/blueprint path; catalog uses the result-item path.
  // Check both so items like Forma (recipe path ≠ item path) still get the badge.
  const isCrafting = crafting.some(c =>
    c.unique_name === item.unique_name ||
    (recipe && recipe.length > 0 && recipe[0].unique_name === c.unique_name)
  );
  const isKuva     = isLichWeapon(item);
  const allParts   = recipe && recipe.length > 0 && recipe.every(c => compStatus(c, quantities) === "part");

  return (
    <div
      className={`craft-card${isOwned ? " craft-card-owned" : ""}${allParts && !isOwned ? " craft-card-ready" : ""}`}
      onClick={onOpen}
    >
      {/* Left: image + star + vault */}
      <div className="craft-card-left">
        <div className="craft-img-wrap">
          <ItemImg imageName={item.image_name} category={item.category} size={48} />
          {isMastered && <span className="craft-mastered-overlay" title="Mastered">★</span>}
        </div>
        {item.vaulted === true  && <span className="vault-badge vault-yes">🔒 Vaulted</span>}
        {item.vaulted === false && <span className="vault-badge vault-no">🔓 Unvaulted</span>}
        <button className={`craft-star ${isTracked ? "tracked" : ""}`}
          title={isTracked ? "Untrack" : "Track"}
          onClick={e => { e.stopPropagation(); onTrack(); }}>
          {isTracked ? "★" : "☆"}
        </button>
        {item.mastery_req != null && item.mastery_req > 0 && (
          <span className="craft-mr-req" title={`Requires MR ${item.mastery_req}`}>MR {item.mastery_req}</span>
        )}
      </div>

      {/* Right: name + badges + component rows */}
      <div className="craft-card-right">
        <div className="craft-card-name">
          {item.name}
          {isOwned    && <span className="craft-owned-tag">✓ Owned</span>}
          {isMastered && <span className="craft-mastered-tag">★ Mastered</span>}
          {isOwned && !isMastered && rank != null && <span className="craft-rank-tag">R{rank}</span>}
          {isCrafting && <span className="craft-foundry-badge" title="Currently building in Foundry">⚒</span>}
          {isKuva     && <span className="craft-kuva-tag">🔱 Lich/Sister</span>}
        </div>

        {recipe === null ? (
          <div className="craft-card-loading">Loading…</div>
        ) : recipe.length === 0 ? (
          <div className="craft-card-loading">No recipe data</div>
        ) : isKuva ? (
          <div className="craft-card-loading">Obtained via Lich / Sister — not crafted</div>
        ) : (
          <div className="comp-rows">
            {recipe.map((comp, i) => (
              <CompRow key={i} comp={comp} quantities={quantities} relicDrops={relicDrops} relicNames={relicNames} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Foundry ─────────────────────────────────────────────────────────────────

const CRAFT_CATEGORIES = [
  "Warframes", "Primary", "Secondary", "Melee",
  "Companions", "Archwing", "Blueprints", "Misc",
];

export default function Foundry({ quantities, masteryData, refreshKey, crafting }: Props) {
  const [craftable, setCraftable] = useState<CatalogItem[]>([]);
  const [search, setSearch]       = useState("");
  const [activeCat, setActiveCat] = useState("Warframes");
  const [recipes, setRecipes]     = useState<Map<string, RecipeComponent[]>>(new Map());
  const [relicDrops, setRelicDrops] = useState<Record<string, string[]>>({});
  const [relicNames, setRelicNames] = useState<Record<string, string>>({});
  const [modalItem, setModalItem] = useState<CatalogItem | null>(null);

  // Mix-and-match filters
  const [filterPrime,      setFilterPrime]      = useState(false);
  const [filterVaulted,    setFilterVaulted]     = useState(false);
  const [filterUnvaulted,  setFilterUnvaulted]   = useState(false);
  const [filterMastered,   setFilterMastered]    = useState(false);
  const [filterUnmastered, setFilterUnmastered]  = useState(false);
  const [filterOwned,      setFilterOwned]       = useState(false);
  const [filterUnowned,    setFilterUnowned]     = useState(false);
  const [filterReady,      setFilterReady]       = useState(false);

  // Tracking
  const [tracked, setTracked] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("ff-tracked") ?? "[]"); } catch { return []; }
  });
  const [trackedRecipes, setTrackedRecipes] = useState<Map<string, RecipeComponent[]>>(new Map());
  const [trackingView, setTrackingView] = useState<"need" | "all">("need");

  useEffect(() => { localStorage.setItem("ff-tracked", JSON.stringify(tracked)); }, [tracked]);

  useEffect(() => {
    invoke<CatalogItem[]>("get_craftable_items").then(setCraftable).catch(() => setCraftable([]));
    invoke<Record<string, string[]>>("get_relic_drops").then(setRelicDrops).catch(() => {});
    invoke<Array<{ unique_name: string; name: string; category: string }>>("get_all_items")
      .then(items => {
        const map: Record<string, string> = {};
        for (const i of items) if (i.category === "Relics") map[i.unique_name] = i.name;
        setRelicNames(map);
      }).catch(() => {});
  }, [refreshKey]);

  const visible = useMemo(() => {
    const q = search.toLowerCase();
    return craftable
      .filter(i => i.category === activeCat || activeCat === "All")
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .filter(i => !filterPrime     || i.name.includes("Prime") || i.vaulted != null)
      .filter(i => !filterVaulted   || i.vaulted === true)
      .filter(i => !filterUnvaulted || i.vaulted === false)
      .filter(i => {
        if (!filterMastered && !filterUnmastered) return true;
        const isMastered = (masteryData[i.unique_name] ?? 0) >= 30;
        return filterMastered ? isMastered : !isMastered;
      })
      .filter(i => {
        if (!filterOwned && !filterUnowned) return true;
        const owned = (quantities[i.unique_name] ?? 0) > 0;
        return filterOwned ? owned : !owned;
      })
      .filter(i => {
        if (!filterReady) return true;
        const r = recipes.get(i.unique_name);
        if (!r || r.length === 0) return false;
        if ((quantities[i.unique_name] ?? 0) > 0) return false;
        return r.every(c => compStatus(c, quantities) === "part");
      });
  }, [craftable, activeCat, search, filterPrime, filterVaulted, filterUnvaulted,
      filterMastered, filterUnmastered, filterOwned, filterUnowned, filterReady,
      recipes, quantities, masteryData]);

  // Load recipes for visible items
  useEffect(() => {
    const toLoad = visible.filter(i => !recipes.has(i.unique_name));
    if (toLoad.length === 0) return;
    let cancelled = false;
    Promise.all(
      toLoad.map(item =>
        invoke<RecipeComponent[]>("get_recipe", { uniqueName: item.unique_name })
          .then(r => [item.unique_name, r ?? []] as [string, RecipeComponent[]])
          .catch(() => [item.unique_name, []] as [string, RecipeComponent[]])
      )
    ).then(results => {
      if (cancelled) return;
      setRecipes(prev => {
        const next = new Map(prev);
        for (const [id, r] of results) next.set(id, r);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [visible]);

  // Load recipe for modal item
  useEffect(() => {
    if (!modalItem || recipes.has(modalItem.unique_name)) return;
    invoke<RecipeComponent[]>("get_recipe", { uniqueName: modalItem.unique_name })
      .then(r => setRecipes(prev => new Map(prev).set(modalItem.unique_name, r ?? [])))
      .catch(() => {});
  }, [modalItem]);

  const toggleTrack = useCallback((item: CatalogItem) => {
    setTracked(prev =>
      prev.includes(item.unique_name) ? prev.filter(id => id !== item.unique_name) : [...prev, item.unique_name]
    );
  }, []);

  // Load tracked recipes
  useEffect(() => {
    const toLoad = tracked.filter(id => !trackedRecipes.has(id));
    setTrackedRecipes(prev => {
      const next = new Map(prev);
      for (const k of next.keys()) if (!tracked.includes(k)) next.delete(k);
      return next;
    });
    if (toLoad.length === 0) return;
    Promise.all(
      toLoad.map(id =>
        invoke<RecipeComponent[]>("get_recipe", { uniqueName: id })
          .then(r => [id, r ?? []] as [string, RecipeComponent[]])
          .catch(() => [id, []] as [string, RecipeComponent[]])
      )
    ).then(results => {
      setTrackedRecipes(prev => {
        const next = new Map(prev);
        for (const [id, r] of results) if (r.length) next.set(id, r);
        return next;
      });
    });
  }, [tracked]);

  const totalNeeds = useMemo(() => {
    const acc = new Map<string, { name: string; needed: number }>();
    for (const r of trackedRecipes.values()) collectNeeds(r, 1, acc);
    return Array.from(acc.entries())
      .map(([unique_name, { name, needed }]) => ({
        unique_name, name, needed,
        owned: quantities[unique_name] ?? 0,
        shortage: Math.max(0, needed - (quantities[unique_name] ?? 0)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [trackedRecipes, quantities]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of craftable) counts[i.category] = (counts[i.category] ?? 0) + 1;
    return counts;
  }, [craftable]);

  const modalRecipe = modalItem ? (recipes.get(modalItem.unique_name) ?? null) : null;

  // Close modal on Escape
  useEffect(() => {
    if (!modalItem) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setModalItem(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modalItem]);

  return (
    <div className="foundry">

      {/* ── Modal overlay ── */}
      {modalItem && (
        <RecipeModal
          item={modalItem}
          recipe={modalRecipe}
          quantities={quantities}
          isTracked={tracked.includes(modalItem.unique_name)}
          onTrack={() => toggleTrack(modalItem)}
          onClose={() => setModalItem(null)}
          crafting={crafting}
        />
      )}

      {/* ── Col 1: Category sidebar ── */}
      <div className="foundry-sidebar">
        <div className="foundry-search-wrap">
          <input className="foundry-search" placeholder="Search…" value={search}
            onChange={e => { setSearch(e.target.value); if (e.target.value) setActiveCat("All" as any); }} />
        </div>
        {CRAFT_CATEGORIES.map(cat => (
          <button key={cat} className={`cat-btn ${activeCat === cat ? "cat-active" : ""}`}
            onClick={() => { setActiveCat(cat); setSearch(""); }}>
            <span className="cat-label">{cat}</span>
            {categoryCounts[cat] ? (
              <span className="cat-count"><span className="cat-total">{categoryCounts[cat]}</span></span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ── Col 2: Card grid ── */}
      <div className="foundry-main">
        <div className="filter-bar">
          <button className={`fchip ${filterPrime     ? "fchip-on" : ""}`} onClick={() => setFilterPrime(v => !v)}>Prime</button>
          <button className={`fchip ${filterVaulted   ? "fchip-on" : ""}`} onClick={() => setFilterVaulted(v => !v)}>🔒 Vaulted</button>
          <button className={`fchip ${filterUnvaulted ? "fchip-on" : ""}`} onClick={() => setFilterUnvaulted(v => !v)}>🔓 Unvaulted</button>
          <span className="fbar-sep"/>
          <button className={`fchip ${filterOwned     ? "fchip-on" : ""}`} onClick={() => setFilterOwned(v => !v)}>✓ Owned</button>
          <button className={`fchip ${filterUnowned   ? "fchip-on" : ""}`} onClick={() => setFilterUnowned(v => !v)}>✕ Unowned</button>
          <button className={`fchip ${filterReady     ? "fchip-on" : ""}`} onClick={() => setFilterReady(v => !v)}>⚡ Ready</button>
          <span className="fbar-sep"/>
          <button className={`fchip ${filterMastered  ? "fchip-on" : ""}`} onClick={() => setFilterMastered(v => !v)}>★ Mastered</button>
          <button className={`fchip ${filterUnmastered? "fchip-on" : ""}`} onClick={() => setFilterUnmastered(v => !v)}>☆ Unmastered</button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>{visible.length} items</span>
          <HelpTip items={[
            { swatch: "rgba(240,192,64,.4)",  label: "Gold card border", desc: "✓ Item already built and owned" },
            { swatch: "rgba(56,139,253,.4)",  label: "Blue card border", desc: "⚡ Ready to craft — all parts collected" },
            { swatch: "rgba(240,192,64,.35)", label: "Gold comp row",    desc: "Blueprint owned" },
            { swatch: "rgba(63,185,80,.35)",  label: "Green comp row",   desc: "Part / component owned" },
            { icon: "★",  label: "★ on image",  desc: "Mastered — item levelled to rank 30" },
            { icon: "⚒",  label: "⚒ badge",     desc: "Currently building in Foundry" },
            { icon: "MR", label: "MR{n} badge", desc: "Required Mastery Rank to use" },
          ]} />
        </div>

        <div className="craft-grid">
          {visible.length === 0 && (
            <div className="empty-msg">
              {craftable.length === 0 ? "No recipes loaded — refresh item list first." : "No items match."}
            </div>
          )}
          {visible.map(item => (
            <CraftCard
              key={item.unique_name}
              item={item}
              recipe={recipes.has(item.unique_name) ? recipes.get(item.unique_name)! : null}
              quantities={quantities}
              relicDrops={relicDrops}
              relicNames={relicNames}
              masteryData={masteryData}
              crafting={crafting}
              isTracked={tracked.includes(item.unique_name)}
              onTrack={() => toggleTrack(item)}
              onOpen={() => setModalItem(item)}
            />
          ))}
        </div>
      </div>

      {/* ── Col 3: Tracking panel ── */}
      <div className="foundry-tracking">
        <div className="tracking-header-row">
          <span className="tracking-title">Tracking {tracked.length > 0 ? `(${tracked.length})` : ""}</span>
        </div>

        {tracked.length === 0 ? (
          <div className="tracking-empty">Star ☆ items to track them.</div>
        ) : (
          <>
            <div className="foundry-tracked-list">
              {tracked.map(id => {
                const item = craftable.find(c => c.unique_name === id);
                if (!item) return null;
                const recipe = trackedRecipes.get(id);
                const isOwned = (quantities[item.unique_name] ?? 0) > 0;
                const allDone = recipe && recipe.length > 0 && recipe.every(c => compStatus(c, quantities) === "part");
                return (
                  <div key={id}
                    className={`tracking-item${isOwned ? " tracking-owned" : allDone ? " tracking-ready" : ""}`}
                    onClick={() => setModalItem(item)}>
                    <ItemImg imageName={item.image_name} category={item.category} size={28} />
                    <span className="tracking-item-name">{item.name}</span>
                    <span className="tracking-item-status">{isOwned ? "✓" : allDone ? "⚡" : ""}</span>
                    <button className="foundry-untrack-btn"
                      onClick={e => { e.stopPropagation(); toggleTrack(item); }}>×</button>
                  </div>
                );
              })}
            </div>

            <div className="tracking-req-header">
              <span className="tracking-req-title">Requirements</span>
              <div className="tracking-toggle">
                <button className={`tracking-toggle-btn ${trackingView === "need" ? "active" : ""}`} onClick={() => setTrackingView("need")}>Missing</button>
                <button className={`tracking-toggle-btn ${trackingView === "all" ? "active" : ""}`} onClick={() => setTrackingView("all")}>All</button>
              </div>
            </div>

            <div className="foundry-totals-list">
              {totalNeeds.length === 0 ? (
                <div className="tracking-all-good">✓ All resources covered</div>
              ) : (
                totalNeeds
                  .filter(r => trackingView === "all" || r.shortage > 0)
                  .map(r => (
                    <div key={r.unique_name} className={`foundry-total-row ${r.shortage > 0 ? "total-missing" : "total-ok"}`}>
                      <span className="foundry-total-name">{r.name}</span>
                      <span className="foundry-total-counts">
                        <span className={r.shortage === 0 ? "qty-have" : "qty-need"}>{fmt(r.owned)}</span>
                        <span className="qty-sep">/</span>
                        <span className="qty-required">{fmt(r.needed)}</span>
                        {r.shortage > 0 && <span className="recipe-shortage">−{fmt(r.shortage)}</span>}
                      </span>
                    </div>
                  ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
