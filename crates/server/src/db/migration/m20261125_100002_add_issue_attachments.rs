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
        let cols = table_columns(manager, "issue").await?;
        if !cols.is_empty() && !cols.contains("attachments") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("issue"))
                        .add_column(text(Alias::new("attachments")).default("[]"))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let cols = table_columns(manager, "issue").await?;
        if cols.contains("attachments") {
            manager
                .alter_table(Table::alter().table(Alias::new("issue")).drop_column(Alias::new("attachments")).to_owned())
                .await?;
        }
        Ok(())
    }
}
