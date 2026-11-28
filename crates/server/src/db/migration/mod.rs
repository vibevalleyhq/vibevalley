//! Forward-only SeaORM migrations for the VibeValley server schema (SQLite + PostgreSQL).
//!
//! Applied versions are tracked in `seaql_server_migrations`. Never edit an
//! already-shipped migration in place; append a new `mYYYYMMDD_HHMMSS_<desc>`
//! module so existing databases upgrade cleanly and pass `db::verify::verify_schema`.

pub mod m20261124_100001_create_server_tables;
pub mod m20261124_100002_create_outbox_item;
pub mod m20261125_100001_reconcile_legacy_baseline;
pub mod m20261125_100002_add_issue_attachments;
pub mod m20261126_100001_add_issue_tags_and_dates;
pub mod m20261127_100001_add_issue_status;
pub mod m20261127_100002_add_issue_owner;
pub mod m20261127_100003_extend_memory_profile_episode;
pub mod m20261127_100004_add_issue_relations;
pub mod m20261128_100001_replace_artifact_with_note;
pub mod m20261128_100002_add_issue_body_note_id;
pub mod m20261128_100003_query_perf_indexes_and_fts;
pub mod m20261128_100004_reconcile_unified_session_and_participants;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migration_table_name() -> DynIden {
        Alias::new("seaql_server_migrations").into_iden()
    }

    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261124_100001_create_server_tables::Migration),
            Box::new(m20261124_100002_create_outbox_item::Migration),
            Box::new(m20261125_100001_reconcile_legacy_baseline::Migration),
            Box::new(m20261125_100002_add_issue_attachments::Migration),
            Box::new(m20261126_100001_add_issue_tags_and_dates::Migration),
            Box::new(m20261127_100001_add_issue_status::Migration),
            Box::new(m20261127_100002_add_issue_owner::Migration),
            Box::new(m20261127_100003_extend_memory_profile_episode::Migration),
            Box::new(m20261127_100004_add_issue_relations::Migration),
            Box::new(m20261128_100001_replace_artifact_with_note::Migration),
            Box::new(m20261128_100002_add_issue_body_note_id::Migration),
            Box::new(m20261128_100003_query_perf_indexes_and_fts::Migration),
            Box::new(m20261128_100004_reconcile_unified_session_and_participants::Migration),
        ]
    }
}
