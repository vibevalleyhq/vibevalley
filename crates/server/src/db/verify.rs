//! Startup database schema verification across SQLite and PostgreSQL.
//!
//! Ensures forward-only SeaORM migrations cannot silently skip an older
//! un-migrated database (via `CREATE TABLE IF NOT EXISTS`) or allow column
//! drift between [`crate::db::entity`] (34 business tables) + `vibevalley-kit`
//! mechanism tables (`outbox_item`, `seq_counter`) and the live database schema.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, EntityName, Iden, Iterable, Statement};
use vibevalley_kit::db::schema::{
    ActualColumn, ExpectedTable, collect_drifts, is_sqlite_fts_auxiliary_table, list_tables_sql, postgres_columns_sql, sqlite_table_info_sql,
};
pub use vibevalley_kit::db::schema::{SchemaMismatchReport, TableDrift};

use crate::db::{DbBackend, DbError, DbResult};

const SERVER_MIGRATIONS_TABLE: &str = "seaql_server_migrations";

#[cfg(test)]
const EXPECTED_KIT_TABLES: &[&str] = &["outbox_item", "seq_counter"];

const EXPECTED_DURABLE_TABLES: &[&str] = &[
    "durable_conversation",
    "durable_document",
    "durable_entry",
    "durable_signal",
    "durable_submission",
    "durable_task",
];

macro_rules! entity_table {
    ($mod_name:ident) => {{
        use crate::db::entity::$mod_name::{Column, Entity};
        ExpectedTable::new(Entity.table_name(), Column::iter().map(|col| Iden::to_string(&col)))
    }};
}

fn expected_server_entity_schema() -> Vec<ExpectedTable> {
    vec![
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
        entity_table!(note),
        entity_table!(note_change),
        entity_table!(note_collab),
        entity_table!(note_link),
        entity_table!(note_suggestion),
        entity_table!(note_version),
        entity_table!(pull),
        entity_table!(pull_event),
        entity_table!(remote_config),
        entity_table!(remote_device),
        entity_table!(session),
        entity_table!(session_event),
        entity_table!(session_mailbox),
        entity_table!(session_run),
    ]
}

fn expected_kit_schema() -> Vec<ExpectedTable> {
    vec![
        ExpectedTable::new(
            "outbox_item",
            ["id", "topic", "payload_json", "status", "attempts", "available_at", "created_at", "last_error"],
        ),
        ExpectedTable::new("seq_counter", ["name", "last_number"]),
    ]
}

fn expected_full_schema() -> Vec<ExpectedTable> {
    let mut all = expected_server_entity_schema();
    all.extend(expected_kit_schema());
    all
}

const SQLITE_FTS_PREFIXES: &[&str] = &["channel_message_fts", "memory_fts", "attachment_fts"];

fn to_kit_backend(backend: DatabaseBackend) -> DbBackend {
    match backend {
        DatabaseBackend::Postgres => DbBackend::Postgres,
        _ => DbBackend::Sqlite,
    }
}

async fn list_existing_tables(conn: &DatabaseConnection, backend: DatabaseBackend) -> DbResult<BTreeSet<String>> {
    let sql = list_tables_sql(to_kit_backend(backend));
    let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
    let mut tables = BTreeSet::new();
    for row in rows {
        let name: String = row.try_get_by_index(0)?;
        if backend == DatabaseBackend::Sqlite && is_sqlite_fts_auxiliary_table(&name, SQLITE_FTS_PREFIXES) {
            continue;
        }
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
            let rows = conn.query_all_raw(Statement::from_string(backend, postgres_columns_sql())).await?;
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
                let sql = sqlite_table_info_sql(table);
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

/// Verifies after running migrations that every business entity table (34), kit mechanism table (2),
/// and durable execution table (6) exists with all expected columns and no blocking legacy columns.
pub(crate) async fn verify_schema(conn: &DatabaseConnection, backend: DbBackend, db_path: Option<&Path>) -> DbResult<()> {
    let raw_backend = conn.get_database_backend();
    let existing_tables = list_existing_tables(conn, raw_backend).await?;
    let applied_migrations = list_applied_migrations(conn, raw_backend, &existing_tables).await?;
    let actual_columns = load_actual_columns(conn, raw_backend, &existing_tables).await?;
    let expected = expected_full_schema();
    let drifts = collect_drifts(&expected, EXPECTED_DURABLE_TABLES, &existing_tables, &actual_columns);
    if drifts.is_empty() {
        return Ok(());
    }
    let report = SchemaMismatchReport {
        backend,
        db_path: db_path.map(Path::to_path_buf),
        migrations_table: SERVER_MIGRATIONS_TABLE.to_owned(),
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
        let expected_entity_names: BTreeSet<String> = expected_server_entity_schema().into_iter().map(|t| t.name).collect();
        let kit_names: BTreeSet<&str> = EXPECTED_KIT_TABLES.iter().copied().collect();
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

        assert_eq!(
            entity_files.len(),
            34,
            "expected 34 business ORM entity files (outbox_item & seq_counter retired to kit)"
        );
        assert_eq!(
            expected_entity_names, entity_files,
            "expected_server_entity_schema must list every db/entity/*.rs file"
        );
        for kit_table in EXPECTED_KIT_TABLES {
            assert!(existing.contains(*kit_table), "kit mechanism table `{kit_table}` must exist in migrated DB");
        }

        let server_tables: BTreeSet<String> = existing
            .into_iter()
            .filter(|name| {
                name != "seaql_migrations" && name != SERVER_MIGRATIONS_TABLE && !durable_names.contains(name.as_str()) && !kit_names.contains(name.as_str())
            })
            .collect();
        assert_eq!(
            server_tables, expected_entity_names,
            "migrations must create exact same business tables as entities"
        );

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
        assert!(session_row.try_get_by_index::<String>(3).unwrap().contains("directCwd"));
        assert!(session_row.try_get_by_index::<String>(4).unwrap().contains("issue"));
        assert_eq!(session_row.try_get_by_index::<Option<String>>(5).unwrap().as_deref(), Some("main"));

        let existing = list_existing_tables(db.read_conn(), DatabaseBackend::Sqlite).await.unwrap();
        assert!(!existing.contains("pkm_term"));
        assert!(!existing.contains("artifact_entry"));
        assert!(!existing.contains("artifact"));
        assert!(existing.contains("note"));
        assert!(existing.contains("note_link"));

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
        assert!(issue_cols.contains("relations"), "issue table must include relations column");
        assert!(issue_cols.contains("body_note_id"), "issue table must include body_note_id column");

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

        let msg_cols: BTreeSet<&str> = actual_columns
            .get("channel_message")
            .expect("channel_message table must exist")
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        for col in ["has_file", "has_image", "has_link"] {
            assert!(msg_cols.contains(col), "channel_message table must include {col} column");
        }
        let ev_cols: BTreeSet<&str> = actual_columns
            .get("session_event")
            .expect("session_event table must exist")
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert!(ev_cols.contains("event_type"), "session_event table must include event_type column");

        let migrations = list_applied_migrations(db.read_conn(), DatabaseBackend::Sqlite, &existing).await.unwrap();
        assert_eq!(migrations.len(), 13);
        db.close().await;
    }

    #[tokio::test]
    async fn pre_unified_session_and_participants_db_upgrades_cleanly() {
        use sea_orm_migration::MigratorTrait;
        use vibevalley_protocol::{ExecutionPolicy, Landing, SessionController, SessionPermissionMode};

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());

        let conn = SeaDatabase::connect(&url).await.unwrap();
        // Apply migrations 1..=12 (before m20261128_100004) and recreate pre-9db84ff51 legacy state.
        crate::db::migration::Migrator::up(&conn, Some(12)).await.unwrap();
        conn.execute_unprepared(
            "DROP TABLE channel_delivery;
             CREATE TABLE channel_delivery (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               message_id TEXT NOT NULL REFERENCES channel_message (id) ON DELETE CASCADE,
               channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
               recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('session', 'issue', 'orchestrator', 'direct')),
               recipient_id TEXT NOT NULL,
               reason TEXT NOT NULL CHECK (reason IN ('mention', 'everyone', 'own_thread', 'member', 'channel', 'direct', 'addressed')),
               wakes INTEGER NOT NULL DEFAULT 0,
               held_by TEXT CHECK (held_by IN ('hop_limit', 'cooldown')),
               status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'withdrawn', 'failed')),
               created_at INTEGER NOT NULL,
               settled_at INTEGER,
               UNIQUE (message_id, recipient_kind, recipient_id)
             );
             INSERT INTO session (id, controller, role, name, runtime, brief, policy, bindings, hired_at, runs, phase, departed)
             VALUES
               ('orchestrator', 'orchestrator', 'orchestrator', 'Orchestrator', 'vibevalley', '', '{\"kind\":\"sandboxDir\"}', '[]', 100, 1, '{\"_tag\":\"resting\"}', 0),
               ('w-wt', 'issueBoard', 'worker', 'Worker', 'codex', 'ship it', '{\"kind\":\"managedWorktree\",\"repo\":\"vibevalley\",\"branch\":\"feat/x\"}', '[]', 110, 1, '{\"_tag\":\"done\"}', 0);
             INSERT INTO issue (id, number, title, description, priority, deliver, delivered, created_at, mandate, blocked_by, criteria, checks, findings, questions, assignments)
             VALUES ('i1', 1, 'Subtask', '', 'medium', 'change', 'merged_into_parent', 100, '{}', '[]', '[]', '[]', '[]', '[]', '[]');
             INSERT INTO channel_participant (id, kind, name, agent_id, joined_at)
             VALUES
               ('user', 'user', '用户', NULL, 100),
               ('user:self', 'user', '用户', NULL, 200),
               ('orchestrator', 'agent', 'Orchestrator', NULL, 100),
               ('profile:reviewer', 'agent', 'Reviewer', 'reviewer', 105);
             INSERT INTO channel (id, type, is_default, created_at, name)
             VALUES ('general', 'channel', 1, 100, 'general');
             INSERT INTO channel (id, type, is_default, created_at, peer_id)
             VALUES ('dm-rev', 'direct', 0, 106, 'profile:reviewer');
             INSERT INTO channel_member (channel_id, participant_id, reason, from_number)
             VALUES ('general', 'user', 'user', 1), ('general', 'orchestrator', 'manual', 0);
             INSERT INTO channel_read_cursor (participant_id, channel_id, read_number, updated_at)
             VALUES ('user', 'general', 5, 150);
             INSERT INTO channel_message (id, channel_id, number, sender_id, kind, body, created_at, revision, reactions)
             VALUES ('msg-1', 'general', 1, 'user', 'chat', 'hello @Orchestrator', 120, 1, '{\"👀\":[\"orchestrator\",\"user\",\"profile:reviewer\"]}');
             INSERT INTO channel_delivery (message_id, channel_id, recipient_kind, recipient_id, reason, wakes, status, created_at, settled_at)
             VALUES
               ('msg-1', 'general', 'orchestrator', 'orchestrator', 'addressed', 1, 'delivered', 120, 121),
               ('msg-1', 'general', 'issue', 'i1', 'own_thread', 1, 'delivered', 120, 121),
               ('msg-1', 'general', 'direct', 'profile:reviewer', 'direct', 1, 'delivered', 120, 121);",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        let db = Database::open_at(&db_path)
            .await
            .expect("pre-unified alpha DB must migrate cleanly through m20261128_100004");

        let orch_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT controller, policy FROM session WHERE id = 'orchestrator'",
            ))
            .await
            .unwrap()
            .unwrap();
        let ctrl: SessionController = serde_json::from_value(serde_json::Value::String(orch_row.try_get_by_index(0).unwrap())).unwrap();
        assert_eq!(ctrl, SessionController::Daemon);

        let wt_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, "SELECT policy FROM session WHERE id = 'w-wt'"))
            .await
            .unwrap()
            .unwrap();
        let wt_policy: ExecutionPolicy = serde_json::from_str(&wt_row.try_get_by_index::<String>(0).unwrap()).unwrap();
        assert_eq!(
            wt_policy,
            ExecutionPolicy::DirectCwd {
                repo: Some("vibevalley".into()),
                permission_mode: SessionPermissionMode::Bypass,
            }
        );

        let issue_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, "SELECT delivered FROM issue WHERE id = 'i1'"))
            .await
            .unwrap()
            .unwrap();
        let landing: Landing = serde_json::from_value(serde_json::Value::String(issue_row.try_get_by_index(0).unwrap())).unwrap();
        assert_eq!(landing, Landing::Merged);

        let cursor_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT read_number FROM channel_read_cursor WHERE participant_id = 'user:self' AND channel_id = 'general'",
            ))
            .await
            .unwrap()
            .expect("legacy user read cursor migrated to user:self");
        assert_eq!(cursor_row.try_get_by_index::<i64>(0).unwrap(), 5);

        let legacy_participants = db
            .read_conn()
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT id FROM channel_participant WHERE id = 'user' OR id LIKE 'profile:%'",
            ))
            .await
            .unwrap();
        assert!(legacy_participants.is_empty(), "legacy participant ids must be removed after migration");

        let msg_row = db
            .read_conn()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT sender_id, reactions FROM channel_message WHERE id = 'msg-1'",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(msg_row.try_get_by_index::<String>(0).unwrap(), "user:self");
        let reactions = msg_row.try_get_by_index::<String>(1).unwrap();
        assert!(reactions.contains("user:self") && reactions.contains("agent:reviewer"));

        // Verify the rebuilt channel_delivery CHECK constraint accepts canonical ('user', 'agent', 'session') rows.
        db.write_conn()
            .execute_unprepared(
                "INSERT INTO channel_delivery (message_id, channel_id, recipient_kind, recipient_id, reason, wakes, status, created_at)
                 VALUES ('msg-1', 'general', 'user', 'self', 'mention', 1, 'pending', 300)",
            )
            .await
            .expect("rebuilt channel_delivery table must accept recipient_kind = 'user'");

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
