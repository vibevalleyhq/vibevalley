//! SeaORM migrations for the durable runtime schema (SQLite + PostgreSQL).

pub mod m20261124_000001_create_durable_tables;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20261124_000001_create_durable_tables::Migration)]
    }
}
