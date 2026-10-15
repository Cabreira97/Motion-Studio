//! Local SQLite persistence. All user data lives in a single SQLite file in
//! the app data directory; nothing is ever sent anywhere.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub data: String,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let store = Store { conn };
        store.create_schema()?;
        Ok(store)
    }

    #[allow(dead_code)]
    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let store = Store { conn };
        store.create_schema()?;
        Ok(store)
    }

    fn create_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS projects (
                     id         TEXT PRIMARY KEY,
                     name       TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL,
                     data       TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_projects_updated
                     ON projects(updated_at DESC);
                 CREATE TABLE IF NOT EXISTS settings (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );",
            )
            .map_err(|e| e.to_string())
    }

    /// Inserts or replaces a project. `data` is the full JSON document.
    pub fn upsert_project(
        &self,
        id: &str,
        name: &str,
        created_at: i64,
        updated_at: i64,
        data: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     updated_at = excluded.updated_at,
                     data = excluded.data",
                params![id, name, created_at, updated_at, data],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectRow>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, created_at, updated_at, data FROM projects ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    data: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<ProjectRow>, String> {
        self.conn
            .query_row(
                "SELECT id, name, created_at, updated_at, data FROM projects WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ProjectRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        data: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn delete_project(&self, id: &str) -> Result<bool, String> {
        let changed = self
            .conn
            .execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    #[allow(dead_code)]
    pub fn count_projects(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(|e| e.to_string())
    }

    #[allow(dead_code)]
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::in_memory().expect("in-memory store")
    }

    #[test]
    fn upsert_and_list() {
        let store = store();
        store
            .upsert_project("p1", "One", 100, 100, r#"{"id":"p1"}"#)
            .unwrap();
        store
            .upsert_project("p2", "Two", 200, 200, r#"{"id":"p2"}"#)
            .unwrap();
        let rows = store.list_projects().unwrap();
        assert_eq!(rows.len(), 2);
        // Ordered by updated_at DESC.
        assert_eq!(rows[0].id, "p2");
    }

    #[test]
    fn upsert_updates_existing() {
        let store = store();
        store.upsert_project("p1", "One", 1, 1, "{}").unwrap();
        store
            .upsert_project("p1", "One Renamed", 1, 5, r#"{"n":2}"#)
            .unwrap();
        let row = store.get_project("p1").unwrap().unwrap();
        assert_eq!(row.name, "One Renamed");
        assert_eq!(row.data, r#"{"n":2}"#);
        assert_eq!(store.count_projects().unwrap(), 1);
    }

    #[test]
    fn delete_and_get() {
        let store = store();
        store.upsert_project("p1", "One", 1, 1, "{}").unwrap();
        assert!(store.delete_project("p1").unwrap());
        assert!(store.get_project("p1").unwrap().is_none());
        assert!(!store.delete_project("missing").unwrap());
    }

    #[test]
    fn settings_roundtrip() {
        let store = store();
        assert_eq!(store.get_setting("theme").unwrap(), None);
        store.set_setting("theme", "dark").unwrap();
        assert_eq!(store.get_setting("theme").unwrap().as_deref(), Some("dark"));
        store.set_setting("theme", "light").unwrap();
        assert_eq!(
            store.get_setting("theme").unwrap().as_deref(),
            Some("light")
        );
    }
}
