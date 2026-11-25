//! SeaORM migrations for the VibeValley server schema (SQLite + PostgreSQL).

pub mod m20261124_100001_create_server_tables;
pub mod m20261124_100002_create_outbox_item;
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
            Box::new(m20261125_100002_add_issue_attachments::Migration),
        ]
    }
}
