import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./WfmTrading.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WfmOrder {
  id: string;
  type: "sell" | "buy";
  platinum: number;
  quantity: number;
  visible: boolean;
  item?: { slug?: string; urlName?: string; url_name?: string; en?: { item_name: string }; i18n?: { en?: { name: string } }; };
}

interface WfmWhisper {
  from: string;
  message: string;
  item?: string;
  price?: number;
  timestamp: string;
}

interface WfmItemEntry { id: string; item_name: string; url_name: string; }

interface Props {
  wfmLookup: Map<string, string>;
  wfmItems: WfmItemEntry[];
  quantities: Record<string, number>;
  onNewWhisper: () => void;
  onLoginChange: (username: string | null) => void;
}

function fmt(n: number) { return n.toLocaleString(); }

/** Debug helper: call from browser console via window.__wfmDump('/v2/orders/my') */
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__wfmDump = async (path: string) => {
    const result = await invoke<string>("wfm_debug_dump", { path }).catch(e => String(e));
    console.log(result);
    return result;
  };
}

/** Invoke a WFM command. On 401, the v1 token has expired — surface SESSION_EXPIRED. */
async function invokeWfm<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (String(e).includes("401")) {
      throw new Error("SESSION_EXPIRED");
    }
    throw e;
  }
}

// ── Login panel ───────────────────────────────────────────────────────────────

function LoginPanel({ onLogin }: { onLogin: (u: string) => void }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [saveChecked, setSaveChecked] = useState(false);

  // Check if we have a saved token (for the "Forget saved session" button visibility)
  useEffect(() => {
    invoke<[string, string] | null>("wfm_load_credentials")
      .then(c => { if (c) setHasSaved(true); })
      .catch(() => {});
  }, []); // eslint-disable-line

  const submit = async () => {
    if (!email || !password) return;
    setLoading(true); setError("");
    try {
      const username = await invoke<string>("wfm_login", { email, password });
      if (saveChecked) {
        // Save the session token (not the password) for next session
        const tokenJson = await invoke<string | null>("wfm_get_jwt").catch(() => null);
        if (tokenJson) await invoke("wfm_save_credentials", { email: "token", password: tokenJson }).catch(() => {});
      }
      onLogin(username);
    } catch (e) { setError(String(e)); setLoading(false); }
  };

  const forget = () => { invoke("wfm_delete_credentials").catch(() => {}); setHasSaved(false); };

  return (
    <div className="wfm-login-wrap">
      <div className="wfm-login-card">
        <div className="wfm-login-title">Connect warframe.market</div>
        <p className="wfm-login-desc">Log in to view live orders, manage listings, and receive trade whispers.</p>
        <div className="wfm-field">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} autoComplete="off" />
        </div>
        <div className="wfm-field">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <label className="wfm-save-row">
          <input type="checkbox" checked={saveChecked}
            onChange={e => { if (e.target.checked) setShowWarning(true); else setSaveChecked(false); }} />
          <span>Stay logged in</span>
        </label>
        {hasSaved && <button className="wfm-forget-btn" onClick={forget}>Forget saved session</button>}
        {error && <div className="wfm-error">{error}</div>}
        <button className="wfm-btn-primary" onClick={submit} disabled={loading || !email || !password}>
          {loading ? "Logging in…" : "Log in"}
        </button>
      </div>

      {showWarning && (
        <div className="wfm-warning-overlay" onClick={() => setShowWarning(false)}>
          <div className="wfm-warning-card" onClick={e => e.stopPropagation()}>
            <div className="wfm-warning-title">⚠ About staying logged in</div>
            <ul className="wfm-warning-list">
              <li>Your <strong>session token</strong> (not your password) is saved to <strong>Windows Credential Manager</strong> — the encrypted OS vault used by Chrome and Windows apps.</li>
              <li>Your email and password are <strong>never stored</strong>.</li>
              <li>Encrypted with your Windows login key.</li>
              <li>Remove it any time using "Forget saved session".</li>
            </ul>
            <div className="wfm-warning-actions">
              <button className="wfm-btn-primary" onClick={() => { setSaveChecked(true); setShowWarning(false); }}>Got it — stay logged in</button>
              <button className="wfm-btn-secondary" onClick={() => setShowWarning(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Listings panel ────────────────────────────────────────────────────────────

function ListingsPanel({ itemIdMap }: { username: string; itemIdMap: Map<string, string> }) {
  const [orders, setOrders] = useState<{ sell: WfmOrder[]; buy: WfmOrder[] }>({ sell: [], buy: [] });
  const [loading, setLoading] = useState(true);
  const [editId, setEditId]   = useState<string | null>(null);
  const [editPt, setEditPt]   = useState(0);
  const [editQty, setEditQty] = useState(1);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const all = await invokeWfm<WfmOrder[]>("wfm_get_orders");
      setOrders({
        sell: (all ?? []).filter(o => o.type === "sell"),
        buy:  (all ?? []).filter(o => o.type === "buy"),
      });
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const deleteOrder = async (id: string) => {
    await invokeWfm("wfm_delete_order", { orderId: id }).catch(() => {});
    loadOrders();
  };

  const saveEdit = async () => {
    if (!editId) return;
    await invokeWfm("wfm_update_order", { orderId: editId, platinum: editPt, quantity: editQty, visible: true }).catch(() => {});
    setEditId(null);
    loadOrders();
  };

  const startEdit = (o: WfmOrder) => { setEditId(o.id); setEditPt(o.platinum); setEditQty(o.quantity); };

  const allOrders = [...orders.sell, ...orders.buy];

  return (
    <div className="wfm-panel">
      <div className="wfm-section-label">
        Active Listings
        <button className="wfm-refresh-btn" onClick={loadOrders} title="Refresh">↻</button>
      </div>
      <div className="wfm-listings-hint">To post a new listing, click any set in the Prime Sets tab.</div>
      {loading ? <div className="wfm-empty">Loading…</div> :
       allOrders.length === 0 ? <div className="wfm-empty">No active listings.</div> :
       <div className="wfm-orders">
         {allOrders.map(o => (
           <div key={o.id} className={`wfm-order-row${editId === o.id ? " editing" : ""}`}>
             <span className={`wfm-order-type ${o.type}`}>{o.type === "sell" ? "S" : "B"}</span>
             <span className="wfm-order-name">{
               // Try all known v2 name fields, then fall back to itemId lookup
               o.item?.i18n?.en?.name
               ?? o.item?.en?.item_name
               ?? o.item?.urlName
               ?? o.item?.url_name
               ?? (o.item?.slug ? (o.item.slug as string).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : null)
               ?? ((o as unknown as Record<string, unknown>).itemId ? itemIdMap.get((o as unknown as Record<string, unknown>).itemId as string) : null)
               ?? "—"
             }</span>
             {editId === o.id ? (
               <>
                 <input className="wfm-edit-input" type="number" value={editPt} onChange={e => setEditPt(+e.target.value)} />
                 <span className="wfm-plat">p</span>
                 <input className="wfm-edit-input wfm-edit-qty" type="number" value={editQty} onChange={e => setEditQty(+e.target.value)} />
                 <button className="wfm-btn-sm wfm-btn-save" onClick={saveEdit}>Save</button>
                 <button className="wfm-btn-sm" onClick={() => setEditId(null)}>Cancel</button>
               </>
             ) : (
               <>
                 <span className="wfm-order-price">{fmt(o.platinum)}p</span>
                 <span className="wfm-order-qty">×{o.quantity}</span>
                 <button className="wfm-btn-sm" onClick={() => startEdit(o)}>Edit</button>
                 <button className="wfm-btn-sm wfm-btn-del" onClick={() => deleteOrder(o.id)}>✕</button>
               </>
             )}
           </div>
         ))}
       </div>
      }

    </div>
  );
}

// ── Messages panel ────────────────────────────────────────────────────────────

function MessagesPanel({ username: _username }: { username: string }) {
  const [whispers, setWhispers] = useState<WfmWhisper[]>([]);
  const [copied, setCopied]     = useState<string | null>(null);
  const bottomRef               = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<WfmWhisper>("wfm-whisper", e => {
      setWhispers(prev => [...prev, e.payload]);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [whispers]);

  const copyInvite = (from: string) => {
    const msg = `/w ${from} Hi! I'm online, come to my orbiter.`;
    navigator.clipboard.writeText(msg).then(() => {
      setCopied(from);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const copySold = (from: string, item?: string, price?: number) => {
    const msg = item
      ? `/w ${from} ${item} sold! Thank you.`
      : `/w ${from} Sold! Thank you.`;
    navigator.clipboard.writeText(msg);
    // Auto-log the trade to Statistics
    if (item) {
      invoke("add_trade", {
        withPlayer: from,
        direction: "sold",
        itemName: item,
        itemUrl: "",
        quantity: 1,
        platinum: price ?? 0,
        source: "wfm",
        notes: "",
      }).catch(() => {});
    }
    setWhispers(prev => prev.filter(w => w.from !== from));
  };

  return (
    <div className="wfm-panel">
      {whispers.length === 0 ? (
        <div className="wfm-empty-msg">
          <div>No trade whispers yet.</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            When someone whispers you a warframe.market trade offer, it will appear here.
          </div>
        </div>
      ) : (
        <>
          <button className="wfm-clear-btn" onClick={() => setWhispers([])}>Clear all</button>
          {whispers.map((w, i) => (
            <div key={i} className="wfm-whisper">
              <div className="wfm-whisper-header">
                <span className="wfm-whisper-from">{w.from}</span>
                <span className="wfm-whisper-time">{w.timestamp}</span>
              </div>
              {w.item && (
                <div className="wfm-whisper-summary">
                  Wants: <span className="wfm-whisper-item">{w.item}</span>
                  {w.price && <span className="wfm-whisper-price"> · {fmt(w.price)}p</span>}
                </div>
              )}
              <div className="wfm-whisper-actions">
                <button className="wfm-btn-sm wfm-btn-invite" onClick={() => copyInvite(w.from)}>
                  {copied === w.from ? "✓ Copied!" : "📋 Copy invite"}
                </button>
                <button className="wfm-btn-sm wfm-btn-sold" onClick={() => copySold(w.from, w.item, w.price)}>
                  ✓ Sold
                </button>
                <button className="wfm-btn-sm" onClick={() => setWhispers(prev => prev.filter((_, j) => j !== i))}>
                  Ignore
                </button>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function WfmTrading({ wfmLookup: _wfmLookup, wfmItems, quantities: _quantities, onNewWhisper, onLoginChange }: Props) {
  const [tab, setTab]           = useState<"listings" | "messages">("listings");
  const [username, setUsername]         = useState<string | null>(null);
  const [checking, setChecking]         = useState(true);
  const [unread, setUnread]             = useState(0);
  const [wfmStatus, setWfmStatus]       = useState<"online" | "ingame" | "invisible" | "offline">("offline");
  const [statusBusy, setStatusBusy]     = useState(false);
  const [statusError, setStatusError]   = useState("");

  const syncStatus = () => {
    invoke<string>("wfm_fetch_status")
      .then(s => {
        if (s === "online" || s === "ingame" || s === "invisible" || s === "offline") {
          setWfmStatus(s);
        }
      })
      .catch(() => {});
  };

  // On mount: restore existing Rust session OR try saved credentials.
  // Both paths return [username, status] — dots update with no extra network call.
  useEffect(() => {
    (async () => {
      let resolvedUser: string | null = null;

      const existing = await invoke<[string, string] | null>("wfm_get_session").catch(() => null);
      if (existing) {
        [resolvedUser] = existing;
      } else {
        const creds = await invoke<[string, string] | null>("wfm_load_credentials").catch(() => null);
        if (creds) {
          try {
            [resolvedUser] = await invoke<[string, string]>("wfm_set_jwt", { jwt: creds[1] });
          } catch { /* token expired — show login form */ }
        }
      }

      if (resolvedUser) {
        setUsername(resolvedUser);
        onLoginChange(resolvedUser);
        // Set invisible on every launch so the user controls when they appear online.
        setWfmStatus("invisible");
        invoke("wfm_set_status", { status: "invisible" }).catch(() => {});
      }
      setChecking(false);
    })();
  }, []); // eslint-disable-line

  // Re-sync status every 5 minutes — WFM can reset it to offline after inactivity
  useEffect(() => {
    if (!username) return;
    const id = setInterval(syncStatus, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [username]); // eslint-disable-line

  // Listen for whispers to increment badge
  useEffect(() => {
    const unlisten = listen("wfm-whisper", () => {
      if (tab !== "messages") {
        setUnread(n => n + 1);
        onNewWhisper();
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [tab, onNewWhisper]);

  const switchToMessages = () => { setTab("messages"); setUnread(0); };

  const logout = () => {
    invoke("wfm_logout").catch(() => {});
    setUsername(null);
    onLoginChange(null);
  };

  if (checking) {
    return <div className="wfm-login-wrap"><div className="wfm-login-loading" style={{ marginTop: 40 }}>Connecting to warframe.market…</div></div>;
  }

  if (!username) {
    return <LoginPanel onLogin={u => { setUsername(u); onLoginChange(u); }} />;
  }

  return (
    <div className="wfm-trading">
      <div className="wfm-header">
        <div className="wfm-tabs">
          <button className={tab === "listings" ? "active" : ""} onClick={() => setTab("listings")}>Listings</button>
          <button className={tab === "messages" ? "active" : ""} onClick={switchToMessages}>
            Messages {unread > 0 && <span className="wfm-badge">{unread}</span>}
          </button>
        </div>
        <div className="wfm-session-info">
          <div className="wfm-status-picker"
            title={wfmStatus === "offline"
              ? "WFM set you offline — click a dot to reconnect"
              : `Status: ${wfmStatus}. Click to change.`}>
            {(["online", "ingame", "invisible"] as const).map(s => (
              <button key={s} disabled={statusBusy}
                className={`wfm-status-opt${wfmStatus === s ? " active" : ""} wfm-status-${s}`}
                title={{ online: "Set Online", ingame: "Set In Game", invisible: "Set Invisible" }[s]}
                onClick={async () => {
                  setStatusBusy(true); setStatusError("");
                  try {
                    await invoke("wfm_set_status", { status: s });
                    setWfmStatus(s);
                  } catch (e) { setStatusError(String(e)); }
                  setStatusBusy(false);
                }}>●</button>
            ))}
          </div>
          <span className="wfm-username">{username}</span>
          <button className="wfm-logout-btn" onClick={logout} title="Log out">⏻</button>
        </div>
      </div>

      {statusError && (
        <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--red)", background: "rgba(248,81,73,.08)", borderBottom: "1px solid rgba(248,81,73,.2)" }}>
          {statusError}
        </div>
      )}

      {tab === "listings"
        ? <ListingsPanel username={username} itemIdMap={new Map(wfmItems.map(i => [i.id, i.item_name]))} />
        : <MessagesPanel username={username} />
      }
    </div>
  );
}
