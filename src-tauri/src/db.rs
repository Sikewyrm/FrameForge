use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuantityChange {
    pub id: i64,
    pub unique_name: String,
    pub item_name: String,
    pub old_qty: i64,
    pub new_qty: i64,
    pub delta: i64,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Trade {
    pub id: i64,
    pub timestamp: String,      // ISO-8601
    pub with_player: String,
    pub direction: String,      // "sold" | "bought"
    pub item_name: String,
    pub item_url: String,       // WFM slug (for price lookup), may be empty
    pub quantity: i64,
    pub platinum: i64,
    pub source: String,         // "wfm" | "ingame" | "manual"
    pub notes: String,
}

pub fn init_db(db_path: &PathBuf) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Schema migrations keyed by version number.
/// To add a schema change in a future release: add an `if version < N` block
/// with the ALTER/CREATE SQL and bump `pragma_update` to N.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS quantity_changes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                unique_name TEXT    NOT NULL,
                item_name   TEXT    NOT NULL,
                old_qty     INTEGER NOT NULL,
                new_qty     INTEGER NOT NULL,
                delta       INTEGER NOT NULL,
                timestamp   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trades (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT    NOT NULL,
                with_player TEXT    NOT NULL DEFAULT '',
                direction   TEXT    NOT NULL DEFAULT 'sold',
                item_name   TEXT    NOT NULL,
                item_url    TEXT    NOT NULL DEFAULT '',
                quantity    INTEGER NOT NULL DEFAULT 1,
                platinum    INTEGER NOT NULL DEFAULT 0,
                source      TEXT    NOT NULL DEFAULT 'manual',
                notes       TEXT    NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS saved_rivens (
                id          TEXT    PRIMARY KEY,
                weapon      TEXT    NOT NULL,
                label       TEXT    NOT NULL,
                stats_json  TEXT    NOT NULL,
                verdict     TEXT    NOT NULL DEFAULT '',
                score       REAL    NOT NULL DEFAULT 0,
                saved_at    TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tracked_items (
                unique_name  TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                added_at     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS item_snapshots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                unique_name TEXT    NOT NULL,
                date        TEXT    NOT NULL,
                quantity    INTEGER NOT NULL,
                UNIQUE(unique_name, date)
            );",
        )?;
        conn.pragma_update(None, "user_version", 2)?;
    }

    // quantity_changes is a transient scan log — cleared on every startup intentionally.
    conn.execute_batch("DELETE FROM quantity_changes;")?;

    Ok(())
}

// ── Tracked items / daily snapshots ──────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct TrackedItem {
    pub unique_name:  String,
    pub display_name: String,
    pub added_at:     String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SnapshotPoint {
    pub date:     String,
    pub quantity: i64,
    pub change:   i64,
}

pub fn add_tracked_item(conn: &Connection, unique_name: &str, display_name: &str) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        "INSERT OR IGNORE INTO tracked_items (unique_name, display_name, added_at)
         VALUES (?1, ?2, ?3)",
        params![unique_name, display_name, now],
    )?;
    Ok(())
}

pub fn remove_tracked_item(conn: &Connection, unique_name: &str) -> Result<()> {
    conn.execute("DELETE FROM tracked_items  WHERE unique_name = ?1", params![unique_name])?;
    conn.execute("DELETE FROM item_snapshots WHERE unique_name = ?1", params![unique_name])?;
    Ok(())
}

pub fn get_tracked_items(conn: &Connection) -> Result<Vec<TrackedItem>> {
    let mut stmt = conn.prepare(
        "SELECT unique_name, display_name, added_at FROM tracked_items ORDER BY display_name",
    )?;
    let rows = stmt.query_map([], |row| Ok(TrackedItem {
        unique_name:  row.get(0)?,
        display_name: row.get(1)?,
        added_at:     row.get(2)?,
    }))?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

/// Record quantity for a tracked item on a given date.
/// INSERT OR IGNORE — the first scan of each day wins (stable historical record).
pub fn record_snapshot(conn: &Connection, unique_name: &str, date: &str, quantity: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO item_snapshots (unique_name, date, quantity) VALUES (?1, ?2, ?3)",
        params![unique_name, date, quantity],
    )?;
    Ok(())
}

pub fn get_snapshots(conn: &Connection, unique_name: &str, days: Option<u32>) -> Result<Vec<SnapshotPoint>> {
    let raw: Vec<(String, i64)> = match days {
        Some(d) => {
            let cutoff = format!("-{} days", d);
            let mut stmt = conn.prepare(
                "SELECT date, quantity FROM item_snapshots
                 WHERE unique_name = ?1 AND date >= date('now', ?2)
                 ORDER BY date ASC",
            )?;
            let rows: Vec<(String, i64)> = stmt
                .query_map(params![unique_name, cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT date, quantity FROM item_snapshots
                 WHERE unique_name = ?1 ORDER BY date ASC",
            )?;
            let rows: Vec<(String, i64)> = stmt
                .query_map(params![unique_name], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        }
    };

    Ok(raw.iter().enumerate().map(|(i, (date, qty))| {
        let change = if i == 0 { 0 } else { qty - raw[i - 1].1 };
        SnapshotPoint { date: date.clone(), quantity: *qty, change }
    }).collect())
}

// ── Saved rivens ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedRiven {
    pub id: String,
    pub weapon: String,
    pub label: String,
    pub stats_json: String,   // JSON array of {name, value, positive}
    pub verdict: String,
    pub score: f64,
    pub saved_at: String,
}

pub fn save_riven(conn: &Connection, riven: &SavedRiven) -> Result<()> {
    conn.execute(
        "INSERT INTO saved_rivens (id, weapon, label, stats_json, verdict, score, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![riven.id, riven.weapon, riven.label, riven.stats_json,
                riven.verdict, riven.score, riven.saved_at],
    )?;
    Ok(())
}

pub fn get_saved_rivens(conn: &Connection) -> Result<Vec<SavedRiven>> {
    let mut stmt = conn.prepare(
        "SELECT id, weapon, label, stats_json, verdict, score, saved_at
         FROM saved_rivens ORDER BY saved_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| Ok(SavedRiven {
        id: row.get(0)?, weapon: row.get(1)?, label: row.get(2)?,
        stats_json: row.get(3)?, verdict: row.get(4)?,
        score: row.get(5)?, saved_at: row.get(6)?,
    }))?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

pub fn delete_saved_riven(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM saved_rivens WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_saved_riven(conn: &Connection, id: &str, label: &str) -> Result<()> {
    conn.execute("UPDATE saved_rivens SET label = ?1 WHERE id = ?2", params![label, id])?;
    Ok(())
}

pub fn count_saved_rivens(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM saved_rivens", [], |r| r.get(0))
}

pub fn add_trade(conn: &Connection, trade: &Trade) -> Result<i64> {
    conn.execute(
        "INSERT INTO trades (timestamp, with_player, direction, item_name, item_url, quantity, platinum, source, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            trade.timestamp, trade.with_player, trade.direction,
            trade.item_name, trade.item_url, trade.quantity,
            trade.platinum, trade.source, trade.notes,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_trades(conn: &Connection) -> Result<Vec<Trade>> {
    let mut stmt = conn.prepare(
        "SELECT id, timestamp, with_player, direction, item_name, item_url,
                quantity, platinum, source, notes
         FROM trades ORDER BY timestamp DESC",
    )?;
    let rows = stmt.query_map([], |row| Ok(Trade {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        with_player: row.get(2)?,
        direction: row.get(3)?,
        item_name: row.get(4)?,
        item_url: row.get(5)?,
        quantity: row.get(6)?,
        platinum: row.get(7)?,
        source: row.get(8)?,
        notes: row.get(9)?,
    }))?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

pub fn delete_trade(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM trades WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_quantity_change(
    conn: &Connection,
    unique_name: &str,
    item_name: &str,
    old_qty: i64,
    new_qty: i64,
) -> Result<()> {
    let delta = new_qty - old_qty;
    let timestamp = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO quantity_changes (unique_name, item_name, old_qty, new_qty, delta, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![unique_name, item_name, old_qty, new_qty, delta, timestamp],
    )?;
    Ok(())
}

pub fn get_quantity_changes(conn: &Connection, limit: i64) -> Result<Vec<QuantityChange>> {
    let mut stmt = conn.prepare(
        "SELECT id, unique_name, item_name, old_qty, new_qty, delta, timestamp
         FROM quantity_changes
         ORDER BY id DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(QuantityChange {
                id: row.get(0)?,
                unique_name: row.get(1)?,
                item_name: row.get(2)?,
                old_qty: row.get(3)?,
                new_qty: row.get(4)?,
                delta: row.get(5)?,
                timestamp: row.get(6)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
