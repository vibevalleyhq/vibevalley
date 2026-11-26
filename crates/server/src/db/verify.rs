//! Startup database schema verification across SQLite and PostgreSQL.
//!
//! Ensures forward-only SeaORM migrations cannot silently skip an older
//! un-migrated database (via `CREATE TABLE IF NOT EXISTS`) or allow column
//! drift between [`crate::db::entity`] and the live database schema.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, EntityName, Iden, Iterable, Statement};

use crate::db::{DbBackend, DbError, DbResult};

const SERVER_MIGRATIONS_TABLE: &str = "seaql_server_migrations";

const EXPECTED_DURABLE_TABLES: &[&str] = &[
    "durable_conversation",
    "durable_document",
    "durable_entry",
    "durable_signal",
    "durable_submission",
    "durable_task",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableDrift {
    pub table: String,
    pub missing_table: bool,
    pub missing_columns: Vec<String>,
    pub extra_required_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaMismatchReport {
    pub backend: DbBackend,
    pub db_path: Option<PathBuf>,
    pub legacy_untracked: bool,
    pub applied_migrations: Vec<String>,
    pub drifts: Vec<TableDrift>,
}

impl SchemaMismatchReport {
    /// Multi-line diagnostic report suitable for logs and startup recovery UI.
    pub fn format_detail(&self) -> String {
        let mut lines = Vec::new();
        let backend_name = match self.backend {
            DbBackend::Sqlite => "SQLite",
            DbBackend::Postgres => "PostgreSQL",
        };
        lines.push(format!("Database backend: {backend_name}"));
        if let Some(path) = &self.db_path {
            lines.push(format!("Database path: {}", path.display()));
        }
        if self.legacy_untracked {
            lines.push(format!(
                "Migration table ({SERVER_MIGRATIONS_TABLE}): missing on an existing database (pre-migration legacy schema)"
            ));
        } else if self.applied_migrations.is_empty() {
            lines.push(format!("Applied migrations ({SERVER_MIGRATIONS_TABLE}): (none)"));
        } else {
            lines.push(format!(
                "Applied migrations ({SERVER_MIGRATIONS_TABLE}): {}",
                self.applied_migrations.join(", ")
            ));
        }
        lines.push(String::new());
        lines.push(format!("Detected schema drift ({} table(s)):", self.drifts.len()));
        for drift in &self.drifts {
            if drift.missing_table {
                lines.push(format!("  - {}: missing table", drift.table));
                continue;
            }
            let mut parts = Vec::new();
            if !drift.missing_columns.is_empty() {
                parts.push(format!("missing columns: {}", drift.missing_columns.join(", ")));
            }
            if !drift.extra_required_columns.is_empty() {
                parts.push(format!("extra NOT NULL columns without default: {}", drift.extra_required_columns.join(", ")));
            }
            lines.push(format!("  - {}: {}", drift.table, parts.join("; ")));
        }
        lines.push(String::new());
        match self.backend {
            DbBackend::Sqlite => {
                lines.push("Recovery: back up or move server.db (and any -wal/-shm files), then restart VibeValley to recreate a clean schema.".to_string());
            }
            DbBackend::Postgres => {
                lines.push("Recovery: run or reset the PostgreSQL database schema to match the current release before restarting VibeValley.".to_string());
            }
        }
        lines.join("\n")
    }
}

impl fmt::Display for SchemaMismatchReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let preview: Vec<&str> = self.drifts.iter().take(5).map(|d| d.table.as_str()).collect();
        let suffix = if self.drifts.len() > 5 {
            format!(", +{} more", self.drifts.len() - 5)
        } else {
            String::new()
        };
        if self.legacy_untracked {
            write!(
                f,
                "legacy database without migration tracking ({} drifted tables: {}{})",
                self.drifts.len(),
                preview.join(", "),
                suffix
            )
        } else {
            write!(
                f,
                "database schema mismatch ({} drifted tables: {}{})",
                self.drifts.len(),
                preview.join(", "),
                suffix
            )
        }
    }
}

struct ExpectedTable {
    name: &'static str,
    columns: Vec<String>,
}

macro_rules! entity_table {
    ($mod_name:ident) => {{
        use crate::db::entity::$mod_name::{Column, Entity};
        ExpectedTable {
            name: Entity.table_name(),
            columns: Column::iter().map(|col| Iden::to_string(&col)).collect(),
        }
    }};
}

fn expected_server_schema() -> Vec<ExpectedTable> {
    vec![
        entity_table!(artifact),
        entity_table!(artifact_change),
        entity_table!(artifact_collab),
        entity_table!(artifact_suggestion),
        entity_table!(artifact_version),
        entity_table!(attachment),
        entity_table!(channel),
        entity_table!(channel_delivery),
        entity_table!(channel_event),
        entity_table!(channel_member),
        entity_table!(channel_mention),
        entity_table!(channel_message),
        entity_table!(channel_participant),
        entity_table!(channel_read_cursor),
        entity_table!(channel_seen),
        entity_table!(connector_account),
        entity_table!(connector_inbound),
        entity_table!(connector_outbox),
        entity_table!(cron),
        entity_table!(issue),
        entity_table!(media_input),
        entity_table!(media_input_pin),
        entity_table!(media_job),
        entity_table!(media_library_item),
        entity_table!(memory),
        entity_table!(outbox_item),
        entity_table!(pull),
        entity_table!(pull_event),
        entity_table!(remote_config),
        entity_table!(remote_device),
        entity_table!(seq_counter),
        entity_table!(session),
        entity_table!(session_event),
        entity_table!(session_mailbox),
        entity_table!(session_run),
    ]
}

#[derive(Debug, Clone)]
struct ActualColumn {
    name: String,
    required_without_default: bool,
}

async fn list_existing_tables(conn: &DatabaseConnection, backend: DatabaseBackend) -> DbResult<BTreeSet<String>> {
    let sql = match backend {
        DatabaseBackend::Postgres => "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
        _ => "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    };
    let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
    let mut tables = BTreeSet::new();
    for row in rows {
        let name: String = row.try_get_by_index(0)?;
        tables.insert(name);
    }
    Ok(tables)
}

async fn list_applied_migrations(conn: &DatabaseConnection, backend: DatabaseBackend, existing_tables: &BTreeSet<String>) -> DbResult<Vec<String>> {
    if !existing_tables.contains(SERVER_MIGRATIONS_TABLE) {
        return Ok(Vec::new());
    }
    let sql = format!("SELECT version FROM {SERVER_MIGRATIONS_TABLE} ORDER BY version");
    let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
    let mut versions = Vec::with_capacity(rows.len());
    for row in rows {
        let version: String = row.try_get_by_index(0)?;
        versions.push(version);
    }
    Ok(versions)
}

async fn load_actual_columns(
    conn: &DatabaseConnection,
    backend: DatabaseBackend,
    existing_tables: &BTreeSet<String>,
) -> DbResult<BTreeMap<String, Vec<ActualColumn>>> {
    let mut out: BTreeMap<String, Vec<ActualColumn>> = BTreeMap::new();
    match backend {
        DatabaseBackend::Postgres => {
            let sql = "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema()";
            let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
            for row in rows {
                let table_name: String = row.try_get_by_index(0)?;
                let column_name: String = row.try_get_by_index(1)?;
                let is_nullable: String = row.try_get_by_index(2)?;
                let column_default: Option<String> = row.try_get_by_index(3)?;
                let required_without_default = is_nullable.eq_ignore_ascii_case("NO") && column_default.is_none();
                out.entry(table_name).or_default().push(ActualColumn {
                    name: column_name,
                    required_without_default,
                });
            }
        }
        _ => {
            for table in existing_tables {
                let escaped = table.replace('"', "\"\"");
                let sql = format!("PRAGMA table_info(\"{escaped}\")");
                let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
                let mut cols = Vec::with_capacity(rows.len());
                for row in rows {
                    let name: String = row.try_get_by_index(1)?;
                    let notnull: i64 = row.try_get_by_index(3)?;
                    let dflt_value: Option<String> = row.try_get_by_index(4)?;
                    let pk: i64 = row.try_get_by_index(5)?;
                    cols.push(ActualColumn {
                        name,
                        required_without_default: notnull != 0 && dflt_value.is_none() && pk == 0,
                    });
                }
                out.insert(table.clone(), cols);
            }
        }
    }
    Ok(out)
}

fn collect_drifts(
    expected: &[ExpectedTable],
    durable_tables: &[&str],
    existing_tables: &BTreeSet<String>,
    actual_columns: &BTreeMap<String, Vec<ActualColumn>>,
) -> Vec<TableDrift> {
    let mut drifts = Vec::new();
    for table in expected {
        if !existing_tables.contains(table.name) {
            drifts.push(TableDrift {
                table: table.name.to_owned(),
                missing_table: true,
                missing_columns: Vec::new(),
                extra_required_columns: Vec::new(),
            });
            continue;
        }
        let actual = actual_columns.get(table.name).map(Vec::as_slice).unwrap_or(&[]);
        let actual_names: BTreeSet<&str> = actual.iter().map(|c| c.name.as_str()).collect();
        let expected_names: BTreeSet<&str> = table.columns.iter().map(String::as_str).collect();

        let missing_columns: Vec<String> = table.columns.iter().filter(|col| !actual_names.contains(col.as_str())).cloned().collect();
        let extra_required_columns: Vec<String> = actual
            .iter()
            .filter(|col| col.required_without_default && !expected_names.contains(col.name.as_str()))
            .map(|col| col.name.clone())
            .collect();

        if !missing_columns.is_empty() || !extra_required_columns.is_empty() {
            drifts.push(TableDrift {
                table: table.name.to_owned(),
                missing_table: false,
                missing_columns,
                extra_required_columns,
            });
        }
    }

    for &durable_table in durable_tables {
        if !existing_tables.contains(durable_table) {
            drifts.push(TableDrift {
                table: durable_table.to_owned(),
                missing_table: true,
                missing_columns: Vec::new(),
                extra_required_columns: Vec::new(),
            });
        }
    }
    drifts
}

/// Verifies after running migrations that every server entity table and durable
/// execution table exists with all expected columns and no blocking legacy columns.
pub(crate) async fn verify_schema(conn: &DatabaseConnection, backend: DbBackend, db_path: Option<&Path>) -> DbResult<()> {
    let raw_backend = conn.get_database_backend();
    let existing_tables = list_existing_tables(conn, raw_backend).await?;
    let applied_migrations = list_applied_migrations(conn, raw_backend, &existing_tables).await?;
    let actual_columns = load_actual_columns(conn, raw_backend, &existing_tables).await?;
    let expected = expected_server_schema();
    let drifts = collect_drifts(&expected, EXPECTED_DURABLE_TABLES, &existing_tables, &actual_columns);
    if drifts.is_empty() {
        return Ok(());
    }
    let report = SchemaMismatchReport {
        backend,
        db_path: db_path.map(Path::to_path_buf),
        legacy_untracked: false,
        applied_migrations,
        drifts,
    };
    Err(DbError::from_schema_mismatch(report))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use sea_orm::{ConnectionTrait, Database as SeaDatabase, Statement};

    use super::*;
    use crate::db::Database;

    #[tokio::test]
    async fn fresh_migrations_match_all_entities_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap();

        let existing = list_existing_tables(db.write_conn(), DatabaseBackend::Sqlite).await.unwrap();
        let expected_names: BTreeSet<&str> = expected_server_schema().into_iter().map(|t| t.name).collect();
        let durable_names: BTreeSet<&str> = EXPECTED_DURABLE_TABLES.iter().copied().collect();

        let entity_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db/entity");
        let mut entity_files = BTreeSet::new();
        for entry in std::fs::read_dir(&entity_dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != "mod.rs" && name.ends_with(".rs") {
                entity_files.insert(name.trim_end_matches(".rs").to_owned());
            }
        }

        let expected_owned: BTreeSet<String> = expected_names.iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(expected_owned, entity_files, "expected_server_schema must list every db/entity/*.rs file");

        let server_tables: BTreeSet<String> = existing
            .into_iter()
            .filter(|name| name != "seaql_migrations" && name != SERVER_MIGRATIONS_TABLE && !durable_names.contains(name.as_str()))
            .collect();
        assert_eq!(server_tables, expected_owned, "migrations must create exact same tables as entities");

        db.close().await;
    }

    #[tokio::test]
    async fn legacy_pre_seaorm_db_is_upgraded_to_baseline_preserving_data() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());

        let conn = SeaDatabase::connect(&url).await.unwrap();
        conn.execute_unprepared(
            "CREATE TABLE artifact (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                artifact_type TEXT,
                is_default INTEGER NOT NULL DEFAULT 0,
                display TEXT,
                channel_id TEXT,
                message_id TEXT,
                issue TEXT,
                by_id TEXT NOT NULL,
                by_name TEXT NOT NULL,
                version INTEGER NOT NULL,
                seq INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE artifact_collab (
                artifact_id TEXT PRIMARY KEY REFERENCES artifact (id) ON DELETE CASCADE,
                snapshot BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE artifact_entry (
                artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                PRIMARY KEY (artifact_id, path)
            );
            CREATE TABLE pkm_term (term TEXT PRIMARY KEY);
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                name TEXT NOT NULL,
                agent TEXT NOT NULL,
                runtime TEXT NOT NULL,
                brief TEXT NOT NULL,
                repo TEXT,
                branch TEXT,
                worktree TEXT,
                hired_at INTEGER NOT NULL,
                runs INTEGER NOT NULL,
                last_run TEXT,
                spent TEXT,
                channel TEXT,
                issue TEXT,
                refining INTEGER NOT NULL,
                tool_connections TEXT,
                machine TEXT,
                phase TEXT NOT NULL,
                departed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE memory (
                id TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                terms TEXT NOT NULL DEFAULT '',
                terms_of INTEGER NOT NULL DEFAULT 0,
                repo TEXT,
                session TEXT,
                author TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                recalled INTEGER NOT NULL DEFAULT 0,
                recalled_at INTEGER
            );
            INSERT INTO artifact (id, title, body, artifact_type, is_default, display, by_id, by_name, version, seq, created_at, updated_at)
            VALUES ('a1', 'Legacy Whiteboard', 'store', 'whiteboard', 0, NULL, 'u1', 'User', 1, 5, 100, 200);
            INSERT INTO artifact_collab (artifact_id, snapshot, updated_at)
            VALUES ('a1', X'010203', 200);
            INSERT INTO session (id, role, name, agent, runtime, brief, repo, branch, worktree, hired_at, runs, channel, issue, refining, phase, departed)
            VALUES ('s1', 'coder', 'Alpha Coder', 'agent-1', 'codex', 'fix db', 'acme/repo', 'main', '/tmp/wt', 100, 2, 'c1', 'i1', 1, 'idle', 0);
            INSERT INTO memory (id, agent, kind, body, terms, terms_of, author, created_at, updated_at)
            VALUES ('m1', 'agent-1', 'note', 'remember sqlite', 'remember sqlite', 1, 'u1', 100, 100);",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        let db = Database::open_at(&db_path)
            .await
            .expect("legacy pre-SeaORM db must upgrade cleanly via baseline reconciliation migration");

        let artifact_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT id, title, artifact_type, seq FROM artifact WHERE id = 'a1'",
            ))
            .await
            .unwrap()
            .expect("artifact row preserved");
        assert_eq!(artifact_row.try_get_by_index::<String>(1).unwrap(), "Legacy Whiteboard");
        assert_eq!(artifact_row.try_get_by_index::<String>(2).unwrap(), "whiteboard");
        assert_eq!(artifact_row.try_get_by_index::<i64>(3).unwrap(), 5);

        let collab_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT snapshot FROM artifact_collab WHERE artifact_id = 'a1'",
            ))
            .await
            .unwrap()
            .expect("artifact_collab snapshot preserved");
        assert_eq!(collab_row.try_get_by_index::<Vec<u8>>(0).unwrap(), vec![1, 2, 3]);

        let session_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT controller, profile, cwd, policy, bindings, base FROM session WHERE id = 's1'",
            ))
            .await
            .unwrap()
            .expect("session row preserved");
        assert_eq!(session_row.try_get_by_index::<String>(0).unwrap(), "issueBoard");
        assert_eq!(session_row.try_get_by_index::<Option<String>>(1).unwrap().as_deref(), Some("agent-1"));
        assert_eq!(session_row.try_get_by_index::<Option<String>>(2).unwrap().as_deref(), Some("/tmp/wt"));
        assert!(session_row.try_get_by_index::<String>(3).unwrap().contains("managedWorktree"));
        assert!(session_row.try_get_by_index::<String>(4).unwrap().contains("issue"));
        assert_eq!(session_row.try_get_by_index::<Option<String>>(5).unwrap().as_deref(), Some("main"));

        let existing = list_existing_tables(db.read_conn(), DatabaseBackend::Sqlite).await.unwrap();
        assert!(!existing.contains("pkm_term"));
        assert!(!existing.contains("artifact_entry"));

        let actual_columns = load_actual_columns(db.read_conn(), DatabaseBackend::Sqlite, &existing).await.unwrap();
        let issue_cols: BTreeSet<&str> = actual_columns
            .get("issue")
            .expect("issue table must exist")
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert!(issue_cols.contains("attachments"), "issue table must include attachments column");
        assert!(issue_cols.contains("tags_json"), "issue table must include tags_json column");
        assert!(issue_cols.contains("start_at"), "issue table must include start_at column");
        assert!(issue_cols.contains("due_at"), "issue table must include due_at column");
        assert!(issue_cols.contains("status"), "issue table must include status column");
        assert!(issue_cols.contains("owner"), "issue table must include owner column");

        let memory_cols: BTreeSet<&str> = actual_columns
            .get("memory")
            .expect("memory table must exist")
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        for col in ["scope", "title", "importance", "replaced_by"] {
            assert!(memory_cols.contains(col), "memory table must include {col} column");
        }
        let memory_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT scope, title, importance, replaced_by FROM memory WHERE id = 'm1'",
            ))
            .await
            .unwrap()
            .expect("legacy memory row preserved");
        assert_eq!(memory_row.try_get_by_index::<String>(0).unwrap(), "agent");
        assert_eq!(memory_row.try_get_by_index::<Option<String>>(1).unwrap(), None);
        assert_eq!(memory_row.try_get_by_index::<i64>(2).unwrap(), 0);
        assert_eq!(memory_row.try_get_by_index::<Option<String>>(3).unwrap(), None);

        let migrations = list_applied_migrations(db.read_conn(), DatabaseBackend::Sqlite, &existing).await.unwrap();
        assert_eq!(migrations.len(), 8);
        db.close().await;
    }

    #[tokio::test]
    async fn drifted_db_with_recorded_migrations_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let db = Database::open_at(&db_path).await.unwrap();
        db.close().await;
        drop(db);

        let url = format!("sqlite://{}?mode=rwc", db_path.display());
        let conn = SeaDatabase::connect(&url).await.unwrap();
        conn.execute_unprepared("ALTER TABLE issue DROP COLUMN machine_id;").await.unwrap();
        conn.close().await.unwrap();

        let err = Database::open_at(&db_path).await.err().expect("drifted db must fail verify_schema");
        let report = err.schema_mismatch().expect("expected SchemaMismatch DbError");
        assert!(!report.legacy_untracked);
        assert!(!report.applied_migrations.is_empty());
        assert_eq!(report.drifts.len(), 1);
        assert_eq!(report.drifts[0].table, "issue");
        assert_eq!(report.drifts[0].missing_columns, vec!["machine_id".to_string()]);
        let detail = report.format_detail();
        assert!(detail.contains("machine_id"));
        assert!(detail.contains("m20261124_100001_create_server_tables"));
    }
}
