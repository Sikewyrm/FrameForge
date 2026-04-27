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

pub fn init_db(db_path: &PathBuf) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS quantity_changes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            unique_name TEXT    NOT NULL,
            item_name   TEXT    NOT NULL,
            old_qty     INTEGER NOT NULL,
            new_qty     INTEGER NOT NULL,
            delta       INTEGER NOT NULL,
            timestamp   INTEGER NOT NULL
        );

        DELETE FROM quantity_changes;",
    )?;
    Ok(conn)
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
