use super::{Result, StoreError};
use sqlx::{Connection, SqliteConnection};

pub(crate) const MIGRATIONS: &[&str] = &[include_str!("../../sql/migrations/0001_workspace.sql")];

pub(crate) async fn migrate(conn: &mut SqliteConnection) -> Result<()> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let current: i64 = sqlx::query_scalar("PRAGMA user_version").fetch_one(&mut *tx).await?;
    let target = MIGRATIONS.len() as i64;
    if !(0..=target).contains(&current) {
        return Err(StoreError::Db(format!(
            "unsupported database schema version {current}, this build supports 0 through {target}"
        )));
    }
    for &sql in &MIGRATIONS[current as usize..] {
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
