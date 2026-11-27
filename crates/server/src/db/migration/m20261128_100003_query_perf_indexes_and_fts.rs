use std::collections::HashSet;

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{DatabaseBackend, Statement};
use sea_orm_migration::sea_query::IndexOrder;

#[derive(DeriveMigrationName)]
pub struct Migration;

async fn existing_columns(conn: &SchemaManagerConnection<'_>, table: &str) -> Result<HashSet<String>, DbErr> {
    let backend = conn.get_database_backend();
    let sql = match backend {
        DatabaseBackend::Postgres => {
            format!("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '{table}'")
        }
        _ => format!("PRAGMA table_info({table})"),
    };
    let rows = conn.query_all_raw(Statement::from_string(backend, sql)).await?;
    let mut cols = HashSet::new();
    for row in rows {
        let name: String = match backend {
            DatabaseBackend::Postgres => row.try_get("", "column_name")?,
            _ => row.try_get("", "name")?,
        };
        cols.insert(name);
    }
    Ok(cols)
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let backend = conn.get_database_backend();

        // 1. Explicit indexed filter columns on `channel_message` replacing JSON/body `LIKE` scans.
        let msg_cols = existing_columns(conn, "channel_message").await?;
        if !msg_cols.is_empty() {
            for col in ["has_file", "has_image", "has_link"] {
                if !msg_cols.contains(col) {
                    manager
                        .alter_table(
                            Table::alter()
                                .table(Alias::new("channel_message"))
                                .add_column(ColumnDef::new(Alias::new(col)).boolean().not_null().default(false))
                                .to_owned(),
                        )
                        .await?;
                }
            }
            let backfill_sql = match backend {
                DatabaseBackend::Postgres => {
                    "UPDATE channel_message SET \
                     has_file = (meta IS NOT NULL AND meta LIKE '%\"attachments\"%'), \
                     has_image = (meta IS NOT NULL AND meta LIKE '%\"type\":\"image/%'), \
                     has_link = (body LIKE '%http://%' OR body LIKE '%https://%') \
                     WHERE deleted_at IS NULL"
                }
                _ => {
                    "UPDATE channel_message SET \
                     has_file = CASE WHEN meta IS NOT NULL AND meta LIKE '%\"attachments\"%' THEN 1 ELSE 0 END, \
                     has_image = CASE WHEN meta IS NOT NULL AND meta LIKE '%\"type\":\"image/%' THEN 1 ELSE 0 END, \
                     has_link = CASE WHEN body LIKE '%http://%' OR body LIKE '%https://%' THEN 1 ELSE 0 END \
                     WHERE deleted_at IS NULL"
                }
            };
            conn.execute_unprepared(backfill_sql).await?;
        }

        // 2. Explicit `event_type` column on `session_event` replacing `payload LIKE '%llm/usage%'` scans.
        let ev_cols = existing_columns(conn, "session_event").await?;
        if !ev_cols.is_empty() && !ev_cols.contains("event_type") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("session_event"))
                        .add_column(ColumnDef::new(Alias::new("event_type")).text().null())
                        .to_owned(),
                )
                .await?;
            conn.execute_unprepared(
                "UPDATE session_event SET event_type = CASE \
                 WHEN payload LIKE '%\"llm/usage\"%' THEN 'llm/usage' \
                 WHEN payload LIKE '%\"llm/retry\"%' THEN 'llm/retry' \
                 WHEN payload LIKE '%\"run/error\"%' THEN 'run/error' \
                 ELSE NULL END \
                 WHERE event_type IS NULL",
            )
            .await?;
        }

        // 3. Composite and partial indexes covering audited hot queries across all domains.
        create_query_perf_indexes(manager).await?;

        // 4. Dual-backend full-text / trigram search indexes (`channel_message`, `memory`, `attachment`).
        match backend {
            DatabaseBackend::Postgres => create_postgres_search_indexes(conn).await?,
            _ => create_sqlite_fts5_indexes(conn).await?,
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let backend = conn.get_database_backend();

        match backend {
            DatabaseBackend::Postgres => {
                for sql in [
                    "DROP INDEX IF EXISTS channel_message_body_trgm_idx",
                    "DROP INDEX IF EXISTS channel_message_body_tsv_idx",
                    "DROP INDEX IF EXISTS memory_text_trgm_idx",
                    "DROP INDEX IF EXISTS attachment_name_trgm_idx",
                ] {
                    conn.execute_unprepared(sql).await?;
                }
            }
            _ => {
                for sql in [
                    "DROP TRIGGER IF EXISTS channel_message_fts_ai",
                    "DROP TRIGGER IF EXISTS channel_message_fts_ad",
                    "DROP TRIGGER IF EXISTS channel_message_fts_au",
                    "DROP TABLE IF EXISTS channel_message_fts",
                    "DROP TRIGGER IF EXISTS memory_fts_ai",
                    "DROP TRIGGER IF EXISTS memory_fts_ad",
                    "DROP TRIGGER IF EXISTS memory_fts_au",
                    "DROP TABLE IF EXISTS memory_fts",
                    "DROP TRIGGER IF EXISTS attachment_fts_ai",
                    "DROP TRIGGER IF EXISTS attachment_fts_ad",
                    "DROP TRIGGER IF EXISTS attachment_fts_au",
                    "DROP TABLE IF EXISTS attachment_fts",
                ] {
                    conn.execute_unprepared(sql).await?;
                }
            }
        }

        for (table, index) in [
            ("channel_message", "channel_message_kind_id"),
            ("channel_message", "channel_message_pinned"),
            ("channel_message", "channel_message_search_active"),
            ("channel_message", "channel_message_has_file"),
            ("channel_message", "channel_message_has_image"),
            ("channel_message", "channel_message_has_link"),
            ("channel_message", "channel_message_channel_sender_id"),
            ("channel_message", "channel_message_channel_kind"),
            ("channel_delivery", "channel_delivery_kind_pending_id"),
            ("channel_delivery", "channel_delivery_settled_prune"),
            ("channel_member", "channel_member_active_participant"),
            ("channel_event", "channel_event_msg_kind"),
            ("session", "session_departed_hired_id"),
            ("session_run", "session_run_session_started_id"),
            ("session_event", "session_event_telemetry"),
            ("session_mailbox", "session_mailbox_settled_prune"),
            ("memory", "memory_agent_active"),
            ("memory", "memory_active_created"),
            ("memory", "memory_farm_profiles"),
            ("note_link", "note_link_by_source_created"),
            ("note_link", "note_link_by_target_created"),
            ("note_collab", "note_collab_updated"),
            ("note_suggestion", "note_suggestion_by_note_created_id"),
            ("media_job", "media_job_phase"),
            ("media_library_item", "media_library_item_kind_recent"),
            ("connector_inbound", "connector_inbound_pending"),
            ("connector_outbox", "connector_outbox_message"),
            ("outbox_item", "outbox_item_done_prune"),
            ("attachment", "attachment_created_at"),
            ("issue", "issue_status_rank"),
        ] {
            manager
                .drop_index(Index::drop().if_exists().name(index).table(Alias::new(table)).to_owned())
                .await?;
        }

        Ok(())
    }
}

async fn create_query_perf_indexes(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let indexes: Vec<IndexCreateStatement> = vec![
        // channel_message hot query paths
        Index::create()
            .if_not_exists()
            .name("channel_message_kind_id")
            .table(Alias::new("channel_message"))
            .col(Alias::new("kind"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_pinned")
            .table(Alias::new("channel_message"))
            .col(Alias::new("channel_id"))
            .col((Alias::new("pinned_at"), IndexOrder::Desc))
            .and_where(Expr::col(Alias::new("pinned_at")).is_not_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_search_active")
            .table(Alias::new("channel_message"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .col(Alias::new("created_at"))
            .and_where(Expr::col(Alias::new("deleted_at")).is_null())
            .and_where(Expr::col(Alias::new("kind")).ne("notice"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_has_file")
            .table(Alias::new("channel_message"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .col(Alias::new("created_at"))
            .and_where(Expr::col(Alias::new("has_file")).eq(true))
            .and_where(Expr::col(Alias::new("deleted_at")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_has_image")
            .table(Alias::new("channel_message"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .col(Alias::new("created_at"))
            .and_where(Expr::col(Alias::new("has_image")).eq(true))
            .and_where(Expr::col(Alias::new("deleted_at")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_has_link")
            .table(Alias::new("channel_message"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .col(Alias::new("created_at"))
            .and_where(Expr::col(Alias::new("has_link")).eq(true))
            .and_where(Expr::col(Alias::new("deleted_at")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_channel_sender_id")
            .table(Alias::new("channel_message"))
            .col(Alias::new("channel_id"))
            .col(Alias::new("sender_id"))
            .col((Alias::new("id"), IndexOrder::Desc))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_message_channel_kind")
            .table(Alias::new("channel_message"))
            .col(Alias::new("channel_id"))
            .col(Alias::new("kind"))
            .to_owned(),
        // channel_delivery, channel_member, channel_event
        Index::create()
            .if_not_exists()
            .name("channel_delivery_kind_pending_id")
            .table(Alias::new("channel_delivery"))
            .col(Alias::new("recipient_kind"))
            .col(Alias::new("id"))
            .and_where(Expr::col(Alias::new("status")).eq("pending"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_delivery_settled_prune")
            .table(Alias::new("channel_delivery"))
            .col(Alias::new("settled_at"))
            .col(Alias::new("id"))
            .and_where(Expr::col(Alias::new("status")).ne("pending"))
            .and_where(Expr::col(Alias::new("settled_at")).is_not_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_member_active_participant")
            .table(Alias::new("channel_member"))
            .col(Alias::new("participant_id"))
            .col(Alias::new("channel_id"))
            .col(Alias::new("from_number"))
            .and_where(Expr::col(Alias::new("left_at")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("channel_event_msg_kind")
            .table(Alias::new("channel_event"))
            .col(Alias::new("message_id"))
            .col(Alias::new("kind"))
            .to_owned(),
        // session, session_run, session_event, session_mailbox
        Index::create()
            .if_not_exists()
            .name("session_departed_hired_id")
            .table(Alias::new("session"))
            .col(Alias::new("departed"))
            .col(Alias::new("hired_at"))
            .col(Alias::new("id"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("session_run_session_started_id")
            .table(Alias::new("session_run"))
            .col(Alias::new("session"))
            .col((Alias::new("started_at"), IndexOrder::Desc))
            .col((Alias::new("id"), IndexOrder::Desc))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("session_event_telemetry")
            .table(Alias::new("session_event"))
            .col(Alias::new("session_id"))
            .col(Alias::new("seq"))
            .and_where(Expr::col(Alias::new("event_type")).is_in(["llm/usage", "llm/retry", "run/error"]))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("session_mailbox_settled_prune")
            .table(Alias::new("session_mailbox"))
            .col(Alias::new("updated_at"))
            .col(Alias::new("id"))
            .and_where(Expr::col(Alias::new("status")).is_not_in(["pending", "claimed"]))
            .to_owned(),
        // memory active & farm profile queries
        Index::create()
            .if_not_exists()
            .name("memory_agent_active")
            .table(Alias::new("memory"))
            .col(Alias::new("agent"))
            .col((Alias::new("created_at"), IndexOrder::Desc))
            .col((Alias::new("id"), IndexOrder::Desc))
            .and_where(Expr::col(Alias::new("replaced_by")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("memory_active_created")
            .table(Alias::new("memory"))
            .col((Alias::new("created_at"), IndexOrder::Desc))
            .col((Alias::new("id"), IndexOrder::Desc))
            .and_where(Expr::col(Alias::new("replaced_by")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("memory_farm_profiles")
            .table(Alias::new("memory"))
            .col(Alias::new("scope"))
            .col(Alias::new("kind"))
            .col((Alias::new("importance"), IndexOrder::Desc))
            .col((Alias::new("updated_at"), IndexOrder::Desc))
            .col((Alias::new("id"), IndexOrder::Desc))
            .and_where(Expr::col(Alias::new("replaced_by")).is_null())
            .to_owned(),
        // note_link, note_collab, note_suggestion
        Index::create()
            .if_not_exists()
            .name("note_link_by_source_created")
            .table(Alias::new("note_link"))
            .col(Alias::new("source_kind"))
            .col(Alias::new("source_id"))
            .col(Alias::new("created_at"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("note_link_by_target_created")
            .table(Alias::new("note_link"))
            .col(Alias::new("target_kind"))
            .col(Alias::new("target_id"))
            .col(Alias::new("created_at"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("note_collab_updated")
            .table(Alias::new("note_collab"))
            .col((Alias::new("updated_at"), IndexOrder::Desc))
            .col(Alias::new("note_id"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("note_suggestion_by_note_created_id")
            .table(Alias::new("note_suggestion"))
            .col(Alias::new("note_id"))
            .col(Alias::new("created_at"))
            .col(Alias::new("id"))
            .to_owned(),
        // media_job, media_library_item, attachment
        Index::create()
            .if_not_exists()
            .name("media_job_phase")
            .table(Alias::new("media_job"))
            .col(Alias::new("phase"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("media_library_item_kind_recent")
            .table(Alias::new("media_library_item"))
            .col(Alias::new("kind"))
            .col((Alias::new("last_at"), IndexOrder::Desc))
            .col(Alias::new("attachment_id"))
            .and_where(Expr::col(Alias::new("removed_at")).is_null())
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("attachment_created_at")
            .table(Alias::new("attachment"))
            .col(Alias::new("created_at"))
            .col(Alias::new("id"))
            .to_owned(),
        // connector, outbox, issue
        Index::create()
            .if_not_exists()
            .name("connector_inbound_pending")
            .table(Alias::new("connector_inbound"))
            .col(Alias::new("connector"))
            .col(Alias::new("seq"))
            .and_where(Expr::col(Alias::new("delivered")).eq(false))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("connector_outbox_message")
            .table(Alias::new("connector_outbox"))
            .col(Alias::new("connector"))
            .col(Alias::new("message_id"))
            .col(Alias::new("state"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("outbox_item_done_prune")
            .table(Alias::new("outbox_item"))
            .col(Alias::new("created_at"))
            .col(Alias::new("id"))
            .and_where(Expr::col(Alias::new("status")).eq("done"))
            .to_owned(),
        Index::create()
            .if_not_exists()
            .name("issue_status_rank")
            .table(Alias::new("issue"))
            .col(Alias::new("status"))
            .col(Alias::new("rank"))
            .col(Alias::new("number"))
            .to_owned(),
    ];

    for idx in indexes {
        manager.create_index(idx).await?;
    }
    Ok(())
}

async fn create_sqlite_fts5_indexes(conn: &SchemaManagerConnection<'_>) -> Result<(), DbErr> {
    let ddl = [
        // channel_message FTS5 (external content, trigram tokenizer supports ASCII & CJK substrings)
        "CREATE VIRTUAL TABLE IF NOT EXISTS channel_message_fts USING fts5(body, content='channel_message', content_rowid='rowid', tokenize='trigram')",
        "CREATE TRIGGER IF NOT EXISTS channel_message_fts_ai AFTER INSERT ON channel_message BEGIN \
             INSERT INTO channel_message_fts(rowid, body) VALUES (new.rowid, new.body); \
         END",
        "CREATE TRIGGER IF NOT EXISTS channel_message_fts_ad AFTER DELETE ON channel_message BEGIN \
             INSERT INTO channel_message_fts(channel_message_fts, rowid, body) VALUES ('delete', old.rowid, old.body); \
         END",
        "CREATE TRIGGER IF NOT EXISTS channel_message_fts_au AFTER UPDATE OF body ON channel_message BEGIN \
             INSERT INTO channel_message_fts(channel_message_fts, rowid, body) VALUES ('delete', old.rowid, old.body); \
             INSERT INTO channel_message_fts(rowid, body) VALUES (new.rowid, new.body); \
         END",
        "INSERT INTO channel_message_fts(channel_message_fts) VALUES ('rebuild')",
        // memory FTS5 (title + body)
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memory', content_rowid='rowid', tokenize='trigram')",
        "CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN \
             INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); \
         END",
        "CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN \
             INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); \
         END",
        "CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF title, body ON memory BEGIN \
             INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); \
             INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); \
         END",
        "INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')",
        // attachment FTS5 (filename)
        "CREATE VIRTUAL TABLE IF NOT EXISTS attachment_fts USING fts5(name, content='attachment', content_rowid='rowid', tokenize='trigram')",
        "CREATE TRIGGER IF NOT EXISTS attachment_fts_ai AFTER INSERT ON attachment BEGIN \
             INSERT INTO attachment_fts(rowid, name) VALUES (new.rowid, new.name); \
         END",
        "CREATE TRIGGER IF NOT EXISTS attachment_fts_ad AFTER DELETE ON attachment BEGIN \
             INSERT INTO attachment_fts(attachment_fts, rowid, name) VALUES ('delete', old.rowid, old.name); \
         END",
        "CREATE TRIGGER IF NOT EXISTS attachment_fts_au AFTER UPDATE OF name ON attachment BEGIN \
             INSERT INTO attachment_fts(attachment_fts, rowid, name) VALUES ('delete', old.rowid, old.name); \
             INSERT INTO attachment_fts(rowid, name) VALUES (new.rowid, new.name); \
         END",
        "INSERT INTO attachment_fts(attachment_fts) VALUES ('rebuild')",
    ];

    for sql in ddl {
        conn.execute_unprepared(sql).await?;
    }
    Ok(())
}

async fn create_postgres_search_indexes(conn: &SchemaManagerConnection<'_>) -> Result<(), DbErr> {
    conn.execute_unprepared("CREATE INDEX IF NOT EXISTS channel_message_body_tsv_idx ON channel_message USING gin (to_tsvector('simple', body))")
        .await?;

    // Enable `pg_trgm` when permitted so case-insensitive substring `LIKE '%...%'` queries use GIN Bitmap Index Scans.
    if conn.execute_unprepared("CREATE EXTENSION IF NOT EXISTS pg_trgm").await.is_ok() {
        for sql in [
            "CREATE INDEX IF NOT EXISTS channel_message_body_trgm_idx ON channel_message USING gin (LOWER(body) gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS memory_text_trgm_idx ON memory USING gin (LOWER(COALESCE(title, '') || ' ' || body) gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS attachment_name_trgm_idx ON attachment USING gin (LOWER(name) gin_trgm_ops)",
        ] {
            conn.execute_unprepared(sql).await?;
        }
    }
    Ok(())
}
