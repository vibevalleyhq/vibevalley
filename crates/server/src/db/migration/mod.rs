//! Forward-only SeaORM migrations for the VibeValley server schema (SQLite + PostgreSQL).
//!
//! Applied versions are tracked in `seaql_server_migrations`. Never edit an
//! already-shipped migration in place; append a new `mYYYYMMDD_HHMMSS_<desc>`
//! module so existing databases upgrade cleanly and pass `db::verify::verify_schema`.

pub mod m20261124_100001_create_server_tables;
pub mod m20261124_100002_create_outbox_item;
pub mod m20261125_100001_reconcile_legacy_baseline;
pub mod m20261125_100002_add_issue_attachments;

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
        ]
    }
}
