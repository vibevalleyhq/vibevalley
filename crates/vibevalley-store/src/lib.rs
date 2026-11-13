//! Persistent app state in one SQLite file: projects, per-project layout,
//! terminal restore data, the agent-session index, and settings. Source files
//! never go in here. `Store` is `Send + Sync`; calls block briefly.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

use std::path::{Path, PathBuf};

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

mod schema;
#[cfg(test)]
mod tests;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(String),
    #[error("io: {0}")]
    Io(String),
    #[error("not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub type ProjectId = i64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub path: PathBuf,
    pub name: String,
    /// Position in the project rail.
    pub position: i64,
    /// Milliseconds since the Unix epoch.
    pub last_opened_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedTerminal {
    /// Stable id the layout refers to.
    pub id: String,
    pub project_id: ProjectId,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub scrollback: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSessionRow {
    /// VibeValley's own id for the task.
    pub id: String,
    pub project_id: ProjectId,
    pub runtime_id: String,
    /// The runtime's session id, used to resume.
    pub session_id: Option<String>,
    pub title: String,
    /// Free-form status string owned by the workspace layer.
    pub status: String,
    pub worktree_path: Option<PathBuf>,
    pub branch: Option<String>,
    pub record_path: Option<PathBuf>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound,
            other => StoreError::Db(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Db(format!("json: {e}"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Drops trailing separators and `.` components so the same folder always
/// maps to the same row. Does not touch the filesystem: a project whose
/// folder is gone must still be addressable.
fn normalize(path: &Path) -> PathBuf {
    let cleaned: PathBuf = path.components().collect();
    if cleaned.as_os_str().is_empty() { path.to_path_buf() } else { cleaned }
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path_text(path))
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        name: row.get(2)?,
        position: row.get(3)?,
        last_opened_ms: row.get(4)?,
    })
}

const PROJECT_COLS: &str = "id, path, name, position, last_opened_ms";

const SESSION_COLS: &str = "id, project_id, runtime_id, session_id, title, status, \
     worktree_path, branch, record_path, created_ms, updated_ms";

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<AgentSessionRow> {
    Ok(AgentSessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        runtime_id: row.get(2)?,
        session_id: row.get(3)?,
        title: row.get(4)?,
        status: row.get(5)?,
        worktree_path: row.get::<_, Option<String>>(6)?.map(PathBuf::from),
        branch: row.get(7)?,
        record_path: row.get::<_, Option<String>>(8)?.map(PathBuf::from),
        created_ms: row.get(9)?,
        updated_ms: row.get(10)?,
    })
}

fn require_project(conn: &Connection, id: ProjectId) -> Result<()> {
    let found: Option<i64> = conn.query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    found.map(|_| ()).ok_or(StoreError::NotFound)
}

fn changed(rows: usize) -> Result<()> {
    if rows == 0 { Err(StoreError::NotFound) } else { Ok(()) }
}

impl Store {
    /// Opens (creating and migrating as needed) the database at `path`.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Io(e.to_string()))?;
        }
        Self::from_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut conn: Connection) -> Result<Store> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // In-memory databases answer "memory" here; that is fine.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        schema::migrate(&mut conn)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// `~/Library/Application Support/VibeValley/state.db` on macOS.
    pub fn default_path() -> PathBuf {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        home.join("Library/Application Support/VibeValley/state.db")
    }

    /// The schema version this build migrates databases to.
    pub fn schema_version() -> i64 {
        schema::MIGRATIONS.len() as i64
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written
        // (transactions roll back on drop), so a poisoned lock stays usable.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(&format!("SELECT {PROJECT_COLS} FROM projects ORDER BY position, id"))?;
        let rows = stmt.query_map([], project_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn project(&self, id: ProjectId) -> Result<Project> {
        let conn = self.lock();
        Ok(conn.query_row(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"), [id], project_from_row)?)
    }

    /// Adds the folder as a project, or returns the existing one.
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = normalize(path);
        let text = path_text(&path);
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let select = format!("SELECT {PROJECT_COLS} FROM projects WHERE path = ?1");
        if let Some(existing) = tx.query_row(&select, [&text], project_from_row).optional()? {
            return Ok(existing);
        }
        tx.execute(
            "INSERT INTO projects (path, name, position, last_opened_ms)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), ?3)",
            params![text, display_name(&path), now_ms()],
        )?;
        let project = tx.query_row(&select, [&text], project_from_row)?;
        tx.commit()?;
        Ok(project)
    }

    /// Also removes the project's layout, saved terminals and agent-session
    /// rows.
    pub fn remove_project(&self, id: ProjectId) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        // Explicit rather than relying on ON DELETE CASCADE alone, so the
        // guarantee does not hinge on the foreign_keys pragma.
        tx.execute("DELETE FROM layouts WHERE project_id = ?1", [id])?;
        tx.execute("DELETE FROM terminals WHERE project_id = ?1", [id])?;
        tx.execute("DELETE FROM agent_sessions WHERE project_id = ?1", [id])?;
        let rows = tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        changed(rows)?;
        tx.commit()?;
        Ok(())
    }

    pub fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        let conn = self.lock();
        changed(conn.execute("UPDATE projects SET name = ?2 WHERE id = ?1", params![id, name])?)
    }

    /// Fails with `Db` when another project already lives at `path`.
    pub fn relocate_project(&self, id: ProjectId, path: &Path) -> Result<()> {
        let text = path_text(&normalize(path));
        let conn = self.lock();
        changed(conn.execute("UPDATE projects SET path = ?2 WHERE id = ?1", params![id, text])?)
    }

    /// Listed projects take positions in the given order; projects not
    /// listed keep their relative order after them. Unknown ids are ignored.
    pub fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let current: Vec<ProjectId> = {
            let mut stmt = tx.prepare("SELECT id FROM projects ORDER BY position, id")?;
            stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut order: Vec<ProjectId> = Vec::with_capacity(current.len());
        for id in ids_in_order {
            if current.contains(id) && !order.contains(id) {
                order.push(*id);
            }
        }
        for id in &current {
            if !order.contains(id) {
                order.push(*id);
            }
        }
        {
            let mut stmt = tx.prepare("UPDATE projects SET position = ?2 WHERE id = ?1")?;
            for (position, id) in order.iter().enumerate() {
                stmt.execute(params![id, position as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn touch_project(&self, id: ProjectId) -> Result<()> {
        let conn = self.lock();
        changed(conn.execute("UPDATE projects SET last_opened_ms = ?2 WHERE id = ?1", params![id, now_ms()])?)
    }

    /// Opaque JSON owned by the workspace layer.
    pub fn layout(&self, id: ProjectId) -> Result<Option<serde_json::Value>> {
        let conn = self.lock();
        let json: Option<String> = conn
            .query_row("SELECT json FROM layouts WHERE project_id = ?1", [id], |r| r.get(0))
            .optional()?;
        json.map(|j| serde_json::from_str(&j).map_err(StoreError::from)).transpose()
    }

    pub fn set_layout(&self, id: ProjectId, layout: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string(layout)?;
        let conn = self.lock();
        require_project(&conn, id)?;
        conn.execute(
            "INSERT INTO layouts (project_id, json) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET json = excluded.json",
            params![id, json],
        )?;
        Ok(())
    }

    /// In the order they were saved.
    pub fn terminals(&self, id: ProjectId) -> Result<Vec<SavedTerminal>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, project_id, cwd, title, scrollback FROM terminals
             WHERE project_id = ?1 ORDER BY ord",
        )?;
        let rows = stmt.query_map([id], |row| {
            Ok(SavedTerminal {
                id: row.get(0)?,
                project_id: row.get(1)?,
                cwd: PathBuf::from(row.get::<_, String>(2)?),
                title: row.get(3)?,
                scrollback: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Replaces all saved terminals of the project. Rows are stored under
    /// `id` whatever their own `project_id` says.
    pub fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        require_project(&tx, id)?;
        tx.execute("DELETE FROM terminals WHERE project_id = ?1", [id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO terminals (project_id, id, ord, cwd, title, scrollback)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (ord, t) in terminals.iter().enumerate() {
                stmt.execute(params![id, t.id, ord as i64, path_text(&t.cwd), t.title, t.scrollback])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Newest first. `project` = `None` lists across all projects.
    pub fn agent_sessions(&self, project: Option<ProjectId>) -> Result<Vec<AgentSessionRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {SESSION_COLS} FROM agent_sessions
             WHERE ?1 IS NULL OR project_id = ?1
             ORDER BY created_ms DESC, rowid DESC"
        ))?;
        let rows = stmt.query_map([project], session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn agent_session(&self, id: &str) -> Result<Option<AgentSessionRow>> {
        let conn = self.lock();
        Ok(conn
            .query_row(&format!("SELECT {SESSION_COLS} FROM agent_sessions WHERE id = ?1"), [id], session_from_row)
            .optional()?)
    }

    /// `NotFound` when the row's project does not exist.
    pub fn upsert_agent_session(&self, row: &AgentSessionRow) -> Result<()> {
        let conn = self.lock();
        require_project(&conn, row.project_id)?;
        conn.execute(
            "INSERT INTO agent_sessions (id, project_id, runtime_id, session_id, title, status,
                 worktree_path, branch, record_path, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id,
                 runtime_id = excluded.runtime_id,
                 session_id = excluded.session_id,
                 title = excluded.title,
                 status = excluded.status,
                 worktree_path = excluded.worktree_path,
                 branch = excluded.branch,
                 record_path = excluded.record_path,
                 created_ms = excluded.created_ms,
                 updated_ms = excluded.updated_ms",
            params![
                row.id,
                row.project_id,
                row.runtime_id,
                row.session_id,
                row.title,
                row.status,
                row.worktree_path.as_deref().map(path_text),
                row.branch,
                row.record_path.as_deref().map(path_text),
                row.created_ms,
                row.updated_ms
            ],
        )?;
        Ok(())
    }

    /// Deleting an id that does not exist is not an error.
    pub fn delete_agent_session(&self, id: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM agent_sessions WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.lock();
        let json: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        json.map(|j| serde_json::from_str(&j).map_err(StoreError::from)).transpose()
    }

    /// Setting a key to JSON `null` removes it.
    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let conn = self.lock();
        if value.is_null() {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
            return Ok(());
        }
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    /// Stores a JSON document under `(kind, id)`, replacing any earlier one.
    /// Used by owners whose records are owned elsewhere as typed values
    /// (the issue workflow keeps its issues and sessions here).
    pub fn put_doc(&self, kind: &str, id: &str, value: &serde_json::Value) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO docs (kind, id, json, updated_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms",
            params![kind, id, serde_json::to_string(value)?, now_ms()],
        )?;
        Ok(())
    }

    pub fn doc(&self, kind: &str, id: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.lock();
        let json: Option<String> = conn
            .query_row("SELECT json FROM docs WHERE kind = ?1 AND id = ?2", params![kind, id], |r| r.get(0))
            .optional()?;
        json.map(|j| serde_json::from_str(&j).map_err(StoreError::from)).transpose()
    }

    /// Every document of a kind, oldest write first.
    pub fn docs(&self, kind: &str) -> Result<Vec<(String, serde_json::Value)>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT id, json FROM docs WHERE kind = ?1 ORDER BY updated_ms, id")?;
        let rows = stmt.query_map([kind], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, json) = row?;
            out.push((id, serde_json::from_str(&json)?));
        }
        Ok(out)
    }

    pub fn delete_doc(&self, kind: &str, id: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM docs WHERE kind = ?1 AND id = ?2", params![kind, id])?;
        Ok(())
    }
}
