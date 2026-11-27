use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let cols = table_columns(manager, "issue").await?;
        if !cols.iter().any(|c| c == "body_note_id") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("issue"))
                        .add_column(ColumnDef::new(Alias::new("body_note_id")).text().null())
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let cols = table_columns(manager, "issue").await?;
        if cols.iter().any(|c| c == "body_note_id") {
            manager
                .alter_table(Table::alter().table(Alias::new("issue")).drop_column(Alias::new("body_note_id")).to_owned())
                .await?;
        }
        Ok(())
    }
}

async fn table_columns(manager: &SchemaManager<'_>, table: &str) -> Result<Vec<String>, DbErr> {
    let conn = manager.get_connection();
    let backend = manager.get_database_backend();
    let sql = match backend {
        sea_orm::DatabaseBackend::Postgres => format!(
            "SELECT column_name AS name FROM information_schema.columns \
             WHERE table_schema = current_schema() AND table_name = '{table}'"
        ),
        _ => format!("PRAGMA table_info({table})"),
    };
    let rows = conn.query_all_raw(sea_orm::Statement::from_string(backend, sql)).await?;
    let mut names = Vec::with_capacity(rows.len());
    for row in rows {
        names.push(row.try_get::<String>("", "name")?);
    }
    Ok(names)
}
