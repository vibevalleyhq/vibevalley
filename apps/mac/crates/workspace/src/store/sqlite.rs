use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    ExprTrait, QueryFilter, QueryOrder, QuerySelect,
};

use super::entities::{layouts, projects, settings, terminals};
use super::schema;
use super::types::{Project, ProjectId, Result, SavedTerminal, StoreError, begin_write_tx, project_from_model};

pub struct Store {
    conn: DatabaseConnection,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(super) fn sqlite_file_url(path: &Path) -> String {
    let raw = path_text(path);
    let mut encoded = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'%' => encoded.push_str("%25"),
            b' ' => encoded.push_str("%20"),
            b'"' => encoded.push_str("%22"),
            b'#' => encoded.push_str("%23"),
            b'<' => encoded.push_str("%3C"),
            b'>' => encoded.push_str("%3E"),
            b'?' => encoded.push_str("%3F"),
            b'`' => encoded.push_str("%60"),
            b'{' => encoded.push_str("%7B"),
            b'}' => encoded.push_str("%7D"),
            _ => encoded.push(byte as char),
        }
    }
    format!("sqlite://{encoded}?mode=rwc")
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

async fn project_by_id(conn: &impl ConnectionTrait, id: ProjectId) -> Result<Project> {
    let row = projects::Entity::find_by_id(id).one(conn).await?.ok_or(StoreError::NotFound)?;
    Ok(project_from_model(row))
}

async fn require_project(conn: &impl ConnectionTrait, id: ProjectId) -> Result<()> {
    let found: Option<i64> = projects::Entity::find_by_id(id)
        .select_only()
        .column(projects::Column::Id)
        .into_tuple()
        .one(conn)
        .await?;
    found.map(|_| ()).ok_or(StoreError::NotFound)
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
        Self::connect(sqlite_file_url(path))
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::connect("sqlite::memory:".into())
    }

    fn connect(url: String) -> Result<Store> {
        let mut opts = ConnectOptions::new(url);
        opts.max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .after_connect(|conn| {
                Box::pin(async move {
                    conn.execute_unprepared("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
                        .await?;
                    Ok(())
                })
            });
        vibevalley_runtime::rt::block_on(async {
            let conn = Database::connect(opts).await?;
            schema::migrate(&conn).await?;
            Ok(Self { conn })
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
        schema::SCHEMA_VERSION
    }

    #[cfg(test)]
    pub(super) fn run<T>(&self, f: impl AsyncFnOnce(&DatabaseConnection) -> Result<T>) -> Result<T> {
        vibevalley_runtime::rt::block_on(f(&self.conn))
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        vibevalley_runtime::rt::block_on(async {
            let rows = projects::Entity::find()
                .order_by_asc(projects::Column::Position)
                .order_by_asc(projects::Column::Id)
                .all(&self.conn)
                .await?;
            Ok(rows.into_iter().map(project_from_model).collect())
        })
    }

    pub fn project(&self, id: ProjectId) -> Result<Project> {
        vibevalley_runtime::rt::block_on(project_by_id(&self.conn, id))
    }

    /// Adds the folder as a project, or returns the existing one.
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = normalize(path);
        vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(&self.conn).await?;
            let text = path_text(&path);
            let existing = projects::Entity::find().filter(projects::Column::Path.eq(text.clone())).one(&tx).await?;
            let project = match existing {
                Some(row) => project_from_model(row),
                None => {
                    let max_position: Option<i64> = projects::Entity::find()
                        .select_only()
                        .expr(Expr::col(projects::Column::Position).max())
                        .into_tuple()
                        .one(&tx)
                        .await?
                        .flatten();
                    let inserted = projects::ActiveModel {
                        id: NotSet,
                        path: Set(text),
                        name: Set(display_name(&path)),
                        position: Set(max_position.map_or(0, |m| m + 1)),
                        last_opened_ms: Set(crate::util::now_ms()),
                    }
                    .insert(&tx)
                    .await?;
                    project_from_model(inserted)
                }
            };
            tx.commit().await?;
            Ok(project)
        })
    }

    /// Removes saved layout and terminals even for a database without cascading keys.
    pub fn remove_project(&self, id: ProjectId) -> Result<()> {
        vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(&self.conn).await?;
            layouts::Entity::delete_by_id(id).exec(&tx).await?;
            terminals::Entity::delete_many().filter(terminals::Column::ProjectId.eq(id)).exec(&tx).await?;
            let res = projects::Entity::delete_by_id(id).exec(&tx).await?;
            changed(res.rows_affected)?;
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        let name = name.to_owned();
        vibevalley_runtime::rt::block_on(async {
            let res = projects::Entity::update_many()
                .col_expr(projects::Column::Name, Expr::value(name))
                .filter(projects::Column::Id.eq(id))
                .exec(&self.conn)
                .await?;
            changed(res.rows_affected)
        })
    }

    /// Fails with `Db` when another project already lives at `path`.
    pub fn relocate_project(&self, id: ProjectId, path: &Path) -> Result<()> {
        let path = path_text(&normalize(path));
        vibevalley_runtime::rt::block_on(async {
            let res = projects::Entity::update_many()
                .col_expr(projects::Column::Path, Expr::value(path))
                .filter(projects::Column::Id.eq(id))
                .exec(&self.conn)
                .await?;
            changed(res.rows_affected)
        })
    }

    /// Listed projects take positions in the given order; all others keep their relative order.
    pub fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(&self.conn).await?;
            let current: Vec<i64> = projects::Entity::find()
                .select_only()
                .column(projects::Column::Id)
                .order_by_asc(projects::Column::Position)
                .order_by_asc(projects::Column::Id)
                .into_tuple()
                .all(&tx)
                .await?;
            let mut remaining: HashSet<_> = current.iter().copied().collect();
            for (position, id) in ids_in_order.iter().chain(&current).filter(|id| remaining.remove(*id)).enumerate() {
                projects::Entity::update_many()
                    .col_expr(projects::Column::Position, Expr::value(position as i64))
                    .filter(projects::Column::Id.eq(*id))
                    .exec(&tx)
                    .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn touch_project(&self, id: ProjectId) -> Result<()> {
        vibevalley_runtime::rt::block_on(async {
            let res = projects::Entity::update_many()
                .col_expr(projects::Column::LastOpenedMs, Expr::value(crate::util::now_ms()))
                .filter(projects::Column::Id.eq(id))
                .exec(&self.conn)
                .await?;
            changed(res.rows_affected)
        })
    }

    pub fn layout(&self, id: ProjectId) -> Result<Option<serde_json::Value>> {
        vibevalley_runtime::rt::block_on(async {
            let row = layouts::Entity::find_by_id(id).one(&self.conn).await?;
            Ok(row.map(|r| serde_json::from_str(&r.json)).transpose()?)
        })
    }

    pub fn set_layout(&self, id: ProjectId, layout: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string(layout)?;
        vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(&self.conn).await?;
            require_project(&tx, id).await?;
            let model = layouts::ActiveModel {
                project_id: Set(id),
                json: Set(json),
            };
            let on_conflict = OnConflict::column(layouts::Column::ProjectId).update_column(layouts::Column::Json).to_owned();
            layouts::Entity::insert(model).on_conflict(on_conflict).exec(&tx).await?;
            tx.commit().await?;
            Ok(())
        })
    }

    /// In the order they were saved.
    pub fn terminals(&self, project_id: ProjectId) -> Result<Vec<SavedTerminal>> {
        vibevalley_runtime::rt::block_on(async {
            let rows = terminals::Entity::find()
                .filter(terminals::Column::ProjectId.eq(project_id))
                .order_by_asc(terminals::Column::Ord)
                .all(&self.conn)
                .await?;
            Ok(rows
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
        vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(&self.conn).await?;
            require_project(&tx, id).await?;
            terminals::Entity::delete_many().filter(terminals::Column::ProjectId.eq(id)).exec(&tx).await?;
            if !terminals.is_empty() {
                let models = terminals.iter().enumerate().map(|(ord, term)| terminals::ActiveModel {
                    project_id: Set(id),
                    id: Set(term.id.clone()),
                    ord: Set(ord as i64),
                    cwd: Set(path_text(&term.cwd)),
                    title: Set(term.title.clone()),
                    scrollback: Set(term.scrollback.clone()),
                });
                terminals::Entity::insert_many(models).exec(&tx).await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }

    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let key = key.to_owned();
        vibevalley_runtime::rt::block_on(async {
            let row = settings::Entity::find_by_id(key).one(&self.conn).await?;
            Ok(row.map(|r| serde_json::from_str(&r.value)).transpose()?)
        })
    }

    /// Setting a key to JSON `null` removes it.
    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let key = key.to_owned();
        vibevalley_runtime::rt::block_on(async {
            if value.is_null() {
                settings::Entity::delete_by_id(key).exec(&self.conn).await?;
            } else {
                let model = settings::ActiveModel {
                    key: Set(key),
                    value: Set(serde_json::to_string(value)?),
                };
                let on_conflict = OnConflict::column(settings::Column::Key).update_column(settings::Column::Value).to_owned();
                settings::Entity::insert(model).on_conflict(on_conflict).exec(&self.conn).await?;
            }
            Ok(())
        })
    }
}
