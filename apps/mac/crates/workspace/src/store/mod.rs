//! Persistent app state in one SQLite file: projects, per-project layout,
//! terminal restore data, and settings. Source files never go in here.
//! `Store` is `Send + Sync`; calls block briefly.

use std::path::{Path, PathBuf};

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{ConnectOptions, Connection, SqliteConnection};

#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;
use queries as q;
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

pub struct Store {
    conn: Mutex<SqliteConnection>,
}

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => StoreError::NotFound,
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

async fn project_by_id(conn: &mut SqliteConnection, id: ProjectId) -> Result<Project> {
    let row = q::get_project(conn, q::GetProjectParams { id }).await?;
    Ok(Project {
        id: row.id,
        path: row.path.into(),
        name: row.name,
        position: row.position,
        last_opened_ms: row.last_opened_ms,
    })
}

fn optional<T>(result: std::result::Result<T, sqlx::Error>) -> Result<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(sqlx::Error::RowNotFound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn changed(rows: u64) -> Result<()> {
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
        Self::connect(SqliteConnectOptions::new().filename(path).create_if_missing(true))
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::connect(SqliteConnectOptions::new().in_memory(true))
    }

    fn connect(options: SqliteConnectOptions) -> Result<Store> {
        let options = options
            .busy_timeout(Duration::from_secs(5))
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);
        vibevalley_runtime::rt::block_on(async {
            let mut conn = options.connect().await?;
            schema::migrate(&mut conn).await?;
            Ok(Self { conn: Mutex::new(conn) })
        })
    }

    /// `~/Library/Application Support/<app_dir_name>/state.db` on macOS.
    pub fn default_path_for(app_dir_name: &str) -> PathBuf {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        home.join("Library/Application Support").join(app_dir_name).join("state.db")
    }

    /// `~/Library/Application Support/VibeValley/state.db` on macOS.
    pub fn default_path() -> PathBuf {
        Self::default_path_for("VibeValley")
    }

    /// The schema version this build migrates databases to.
    pub fn schema_version() -> i64 {
        schema::MIGRATIONS.len() as i64
    }

    fn run<T>(&self, f: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        vibevalley_runtime::rt::block_on(f(&mut conn))
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        self.run(async |conn| {
            Ok(q::list_projects(conn)
                .await?
                .into_iter()
                .map(|r| Project {
                    id: r.id,
                    path: r.path.into(),
                    name: r.name,
                    position: r.position,
                    last_opened_ms: r.last_opened_ms,
                })
                .collect())
        })
    }

    pub fn project(&self, id: ProjectId) -> Result<Project> {
        self.run(async |conn| project_by_id(conn, id).await)
    }

    /// Adds the folder as a project, or returns the existing one.
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = normalize(path);
        self.run(async |conn| {
            let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
            let text = path_text(&path);
            let existing = optional(q::find_project_id(&mut *tx, q::FindProjectIdParams { path: text.clone() }).await)?;
            let id = match existing {
                Some(row) => row.id,
                None => {
                    q::insert_project(
                        &mut *tx,
                        q::InsertProjectParams {
                            path: text,
                            name: display_name(&path),
                            last_opened_ms: now_ms(),
                        },
                    )
                    .await?
                    .id
                }
            };
            let project = project_by_id(&mut tx, id).await?;
            tx.commit().await?;
            Ok(project)
        })
    }

    /// Removes saved layout and terminals even for a database without cascading keys.
    pub fn remove_project(&self, id: ProjectId) -> Result<()> {
        self.run(async |conn| {
            let mut tx = conn.begin().await?;
            q::delete_layout(&mut *tx, q::DeleteLayoutParams { project_id: id }).await?;
            q::delete_terminals(&mut *tx, q::DeleteTerminalsParams { project_id: id }).await?;
            changed(q::remove_project(&mut *tx, q::RemoveProjectParams { id }).await?)?;
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        self.run(async |conn| changed(q::rename_project(conn, q::RenameProjectParams { id, name: name.into() }).await?))
    }

    /// Fails with `Db` when another project already lives at `path`.
    pub fn relocate_project(&self, id: ProjectId, path: &Path) -> Result<()> {
        self.run(async |conn| {
            changed(
                q::relocate_project(
                    conn,
                    q::RelocateProjectParams {
                        id,
                        path: path_text(&normalize(path)),
                    },
                )
                .await?,
            )
        })
    }

    /// Listed projects take positions in the given order; all others keep their relative order.
    pub fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        self.run(async |conn| {
            let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
            let current: Vec<_> = q::list_project_ids(&mut *tx).await?.into_iter().map(|r| r.id).collect();
            let mut remaining: std::collections::HashSet<_> = current.iter().copied().collect();
            for (position, id) in ids_in_order.iter().chain(&current).filter(|id| remaining.remove(*id)).enumerate() {
                q::set_position(
                    &mut *tx,
                    q::SetPositionParams {
                        id: *id,
                        position: position as i64,
                    },
                )
                .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn touch_project(&self, id: ProjectId) -> Result<()> {
        self.run(async |conn| changed(q::touch_project(conn, q::TouchProjectParams { id, last_opened_ms: now_ms() }).await?))
    }

    pub fn layout(&self, id: ProjectId) -> Result<Option<serde_json::Value>> {
        self.run(async |conn| {
            let row = optional(q::read_layout(conn, q::ReadLayoutParams { project_id: id }).await)?;
            Ok(row.map(|r| serde_json::from_str(&r.json)).transpose()?)
        })
    }

    pub fn set_layout(&self, id: ProjectId, layout: &serde_json::Value) -> Result<()> {
        self.run(async |conn| {
            let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
            let project_id = q::require_project(&mut *tx, q::RequireProjectParams { id }).await?.id;
            q::write_layout(
                &mut *tx,
                q::WriteLayoutParams {
                    project_id,
                    json: serde_json::to_string(layout)?,
                },
            )
            .await?;
            tx.commit().await?;
            Ok(())
        })
    }

    /// In the order they were saved.
    pub fn terminals(&self, project_id: ProjectId) -> Result<Vec<SavedTerminal>> {
        self.run(async |conn| {
            Ok(q::list_terminals(conn, q::ListTerminalsParams { project_id })
                .await?
                .into_iter()
                .map(|r| SavedTerminal {
                    id: r.id,
                    project_id: r.project_id,
                    cwd: r.cwd.into(),
                    title: r.title,
                    scrollback: r.scrollback,
                })
                .collect())
        })
    }

    /// Replaces the set atomically. A restored row belongs to the requested project.
    pub fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()> {
        self.run(async |conn| {
            let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
            let project_id = q::require_project(&mut *tx, q::RequireProjectParams { id }).await?.id;
            q::delete_terminals(&mut *tx, q::DeleteTerminalsParams { project_id }).await?;
            for (ord, term) in terminals.iter().enumerate() {
                q::insert_terminal(
                    &mut *tx,
                    q::InsertTerminalParams {
                        project_id,
                        id: term.id.clone(),
                        ord: ord as i64,
                        cwd: path_text(&term.cwd),
                        title: term.title.clone(),
                        scrollback: term.scrollback.clone(),
                    },
                )
                .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        self.run(async |conn| {
            let row = optional(q::read_setting(conn, q::ReadSettingParams { key: key.into() }).await)?;
            Ok(row.map(|r| serde_json::from_str(&r.value)).transpose()?)
        })
    }

    /// Setting a key to JSON `null` removes it.
    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.run(async |conn| {
            if value.is_null() {
                q::delete_setting(conn, q::DeleteSettingParams { key: key.into() }).await?;
            } else {
                q::write_setting(
                    conn,
                    q::WriteSettingParams {
                        key: key.into(),
                        value: serde_json::to_string(value)?,
                    },
                )
                .await?;
            }
            Ok(())
        })
    }
}
