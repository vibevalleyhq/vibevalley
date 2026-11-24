use sea_orm::sea_query::{ColumnDef, ForeignKey, ForeignKeyAction, Index, Table};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

use super::entities::{layouts, projects, settings, terminals};
use super::{Result, StoreError, begin_write_tx};

pub(crate) const SCHEMA_VERSION: i64 = 1;

pub(crate) async fn migrate(conn: &DatabaseConnection) -> Result<()> {
    let tx = begin_write_tx(conn).await?;
    let row = tx
        .query_one_raw(Statement::from_string(DbBackend::Sqlite, "PRAGMA user_version"))
        .await?
        .ok_or_else(|| StoreError::Db("missing PRAGMA user_version result".into()))?;
    let current: i64 = row.try_get_by_index(0)?;
    if !(0..=SCHEMA_VERSION).contains(&current) {
        return Err(StoreError::Db(format!(
            "unsupported database schema version {current}, this build supports 0 through {SCHEMA_VERSION}"
        )));
    }
    if current < SCHEMA_VERSION {
        create_v1_tables(&tx).await?;
        tx.execute_unprepared("PRAGMA user_version = 1").await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn create_v1_tables(conn: &impl ConnectionTrait) -> Result<()> {
    let projects_table = Table::create()
        .table(projects::Entity)
        .if_not_exists()
        .col(ColumnDef::new(projects::Column::Id).integer().not_null().primary_key().auto_increment())
        .col(ColumnDef::new(projects::Column::Path).text().not_null().unique_key())
        .col(ColumnDef::new(projects::Column::Name).text().not_null())
        .col(ColumnDef::new(projects::Column::Position).integer().not_null())
        .col(ColumnDef::new(projects::Column::LastOpenedMs).integer().not_null())
        .to_owned();
    conn.execute(&projects_table).await?;

    let layouts_table = Table::create()
        .table(layouts::Entity)
        .if_not_exists()
        .col(ColumnDef::new(layouts::Column::ProjectId).integer().not_null().primary_key())
        .col(ColumnDef::new(layouts::Column::Json).text().not_null())
        .foreign_key(
            ForeignKey::create()
                .from(layouts::Entity, layouts::Column::ProjectId)
                .to(projects::Entity, projects::Column::Id)
                .on_delete(ForeignKeyAction::Cascade),
        )
        .to_owned();
    conn.execute(&layouts_table).await?;

    let terminals_table = Table::create()
        .table(terminals::Entity)
        .if_not_exists()
        .col(ColumnDef::new(terminals::Column::ProjectId).integer().not_null())
        .col(ColumnDef::new(terminals::Column::Id).text().not_null())
        .col(ColumnDef::new(terminals::Column::Ord).integer().not_null())
        .col(ColumnDef::new(terminals::Column::Cwd).text().not_null())
        .col(ColumnDef::new(terminals::Column::Title).text().null())
        .col(ColumnDef::new(terminals::Column::Scrollback).text().not_null())
        .primary_key(Index::create().col(terminals::Column::ProjectId).col(terminals::Column::Id))
        .foreign_key(
            ForeignKey::create()
                .from(terminals::Entity, terminals::Column::ProjectId)
                .to(projects::Entity, projects::Column::Id)
                .on_delete(ForeignKeyAction::Cascade),
        )
        .to_owned();
    conn.execute(&terminals_table).await?;

    let settings_table = Table::create()
        .table(settings::Entity)
        .if_not_exists()
        .col(ColumnDef::new(settings::Column::Key).text().not_null().primary_key())
        .col(ColumnDef::new(settings::Column::Value).text().not_null())
        .to_owned();
    conn.execute(&settings_table).await?;

    Ok(())
}
