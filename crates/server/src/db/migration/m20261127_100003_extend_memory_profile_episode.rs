use std::collections::BTreeSet;

use sea_orm::{DatabaseBackend, Statement};
use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

async fn table_columns(manager: &SchemaManager<'_>, table: &str) -> Result<BTreeSet<String>, DbErr> {
    let conn = manager.get_connection();
    let backend = manager.get_database_backend();
    let mut cols = BTreeSet::new();
    match backend {
        DatabaseBackend::Postgres => {
            let rows = conn
                .query_all_raw(Statement::from_sql_and_values(
                    backend,
                    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
                    [table.into()],
                ))
                .await?;
            for row in rows {
                let name: String = row.try_get_by_index(0)?;
                cols.insert(name);
            }
        }
        _ => {
            let escaped = table.replace('"', "\"\"");
            let rows = conn
                .query_all_raw(Statement::from_string(backend, format!("PRAGMA table_info(\"{escaped}\")")))
                .await?;
            for row in rows {
                let name: String = row.try_get_by_index(1)?;
                cols.insert(name);
            }
        }
    }
    Ok(cols)
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let cols = table_columns(manager, "memory").await?;
        if cols.is_empty() {
            return Ok(());
        }
        if !cols.contains("scope") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("memory"))
                        .add_column(text(Alias::new("scope")).default("agent"))
                        .to_owned(),
                )
                .await?;
        }
        if !cols.contains("title") {
            manager
                .alter_table(Table::alter().table(Alias::new("memory")).add_column(text_null(Alias::new("title"))).to_owned())
                .await?;
        }
        if !cols.contains("importance") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("memory"))
                        .add_column(big_integer(Alias::new("importance")).default(0))
                        .to_owned(),
                )
                .await?;
        }
        if !cols.contains("replaced_by") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("memory"))
                        .add_column(text_null(Alias::new("replaced_by")))
                        .to_owned(),
                )
                .await?;
        }
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("memory_scope_kind")
                    .table(Alias::new("memory"))
                    .col(Alias::new("scope"))
                    .col(Alias::new("kind"))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let cols = table_columns(manager, "memory").await?;
        if cols.is_empty() {
            return Ok(());
        }
        manager
            .drop_index(Index::drop().if_exists().name("memory_scope_kind").table(Alias::new("memory")).to_owned())
            .await?;
        for col in ["replaced_by", "importance", "title", "scope"] {
            if cols.contains(col) {
                manager
                    .alter_table(Table::alter().table(Alias::new("memory")).drop_column(Alias::new(col)).to_owned())
                    .await?;
            }
        }
        Ok(())
    }
}
