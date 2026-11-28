//! Parameterized SQL monotonic sequence allocator (`seq_counter`).

use crate::db::engine::{DbBackendKind, SqlPool};

/// Default sequence table name shared with existing server migrations.
pub const DEFAULT_SEQ_TABLE: &str = "seq_counter";

/// Errors returned by [`SeqAllocator`].
#[derive(Debug, thiserror::Error)]
pub enum SeqError {
    #[error("invalid sequence table identifier `{0}`")]
    InvalidTableName(String),

    #[error("sequence allocator SQL error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

fn validate_table_name(table: &str) -> Result<(), SeqError> {
    if table.is_empty() || !table.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(SeqError::InvalidTableName(table.to_owned()));
    }
    Ok(())
}

/// Returns a dialect-compatible `CREATE TABLE IF NOT EXISTS` DDL statement for the sequence table.
pub fn ensure_seq_table_sql(table: &str) -> Result<String, SeqError> {
    validate_table_name(table)?;
    Ok(format!(
        "CREATE TABLE IF NOT EXISTS \"{table}\" (name TEXT PRIMARY KEY NOT NULL, last_number BIGINT NOT NULL)"
    ))
}

/// Returns the parameterized UPSERT SQL allocating the next monotonic sequence strictly above
/// `at_least` (`bind 1 = name`, `bind 2 = at_least + 1`, `bind 3 = at_least`).
///
/// Works identically on SQLite 3.35+ and PostgreSQL.
pub fn next_seq_sql(backend: DbBackendKind, table: &str) -> Result<String, SeqError> {
    validate_table_name(table)?;
    let (p1, p2, p3) = match backend {
        DbBackendKind::Sqlite => ("?1", "?2", "?3"),
        DbBackendKind::Postgres => ("$1", "$2", "$3"),
    };
    Ok(format!(
        "INSERT INTO \"{table}\" (name, last_number) VALUES ({p1}, {p2}) \
         ON CONFLICT (name) DO UPDATE \
         SET last_number = (CASE WHEN \"{table}\".last_number > {p3} THEN \"{table}\".last_number ELSE {p3} END) + 1 \
         RETURNING last_number"
    ))
}

/// Domain-agnostic monotonic sequence allocator backed by a dual-backend [`SqlPool`].
#[derive(Debug, Clone)]
pub struct SeqAllocator {
    pool: SqlPool,
    table: String,
    sql: String,
}

impl SeqAllocator {
    /// Creates an allocator targeting the default [`DEFAULT_SEQ_TABLE`] (`seq_counter`).
    pub fn new(pool: SqlPool) -> Self {
        Self::with_table(pool, DEFAULT_SEQ_TABLE).expect("default seq table name is valid")
    }

    /// Creates an allocator targeting a custom validated SQL table identifier.
    pub fn with_table(pool: SqlPool, table: impl Into<String>) -> Result<Self, SeqError> {
        let table = table.into();
        let sql = next_seq_sql(pool.backend(), &table)?;
        Ok(Self { pool, table, sql })
    }

    pub fn table(&self) -> &str {
        &self.table
    }

    pub fn sql(&self) -> &str {
        &self.sql
    }

    /// Creates the sequence table if it does not already exist.
    pub async fn ensure_schema(&self) -> Result<(), SeqError> {
        let ddl = ensure_seq_table_sql(&self.table)?;
        match &self.pool {
            SqlPool::Sqlite(pool) => {
                sqlx::query(sqlx::AssertSqlSafe(ddl)).execute(pool).await?;
            }
            #[cfg(feature = "postgres")]
            SqlPool::Postgres(pool) => {
                sqlx::query(sqlx::AssertSqlSafe(ddl)).execute(pool).await?;
            }
        }
        Ok(())
    }

    /// Atomically allocates the next monotonic counter value strictly above `at_least`.
    pub async fn next_seq(&self, name: &str, at_least: i64) -> Result<i64, SeqError> {
        let initial = at_least.saturating_add(1);
        match &self.pool {
            SqlPool::Sqlite(pool) => {
                let next: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(self.sql.clone()))
                    .bind(name)
                    .bind(initial)
                    .bind(at_least)
                    .fetch_one(pool)
                    .await?;
                Ok(next)
            }
            #[cfg(feature = "postgres")]
            SqlPool::Postgres(pool) => {
                let next: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(self.sql.clone()))
                    .bind(name)
                    .bind(initial)
                    .bind(at_least)
                    .fetch_one(pool)
                    .await?;
                Ok(next)
            }
        }
    }

    /// Atomically allocates the next monotonic counter value inside an open `sqlx` SQLite transaction.
    pub async fn next_seq_in_sqlite_tx(&self, tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, name: &str, at_least: i64) -> Result<i64, SeqError> {
        let initial = at_least.saturating_add(1);
        let sql = next_seq_sql(DbBackendKind::Sqlite, &self.table)?;
        let next: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(name)
            .bind(initial)
            .bind(at_least)
            .fetch_one(&mut **tx)
            .await?;
        Ok(next)
    }

    /// Atomically allocates the next monotonic counter value inside an open `sqlx` PostgreSQL transaction.
    #[cfg(feature = "postgres")]
    pub async fn next_seq_in_postgres_tx(&self, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, name: &str, at_least: i64) -> Result<i64, SeqError> {
        let initial = at_least.saturating_add(1);
        let sql = next_seq_sql(DbBackendKind::Postgres, &self.table)?;
        let next: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(name)
            .bind(initial)
            .bind(at_least)
            .fetch_one(&mut **tx)
            .await?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::{SqlitePoolConfig, connect_sqlite_pool};

    #[tokio::test]
    async fn seq_allocator_allocates_monotonically_respects_at_least_and_rolls_back_in_tx() {
        let pool = connect_sqlite_pool(&SqlitePoolConfig::in_memory()).await.unwrap();
        let seq = SeqAllocator::new(SqlPool::Sqlite(pool.clone()));
        seq.ensure_schema().await.unwrap();

        assert_eq!(seq.next_seq("issue", 0).await.unwrap(), 1);
        assert_eq!(seq.next_seq("issue", 0).await.unwrap(), 2);
        assert_eq!(seq.next_seq("issue", 10).await.unwrap(), 11);
        assert_eq!(seq.next_seq("issue", 5).await.unwrap(), 12);
        assert_eq!(seq.next_seq("session", 0).await.unwrap(), 1);

        // Inside a rolled-back transaction, allocation does not persist.
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(seq.next_seq_in_sqlite_tx(&mut tx, "issue", 0).await.unwrap(), 13);
        tx.rollback().await.unwrap();
        assert_eq!(seq.next_seq("issue", 0).await.unwrap(), 13);

        // Invalid table name rejected.
        assert!(SeqAllocator::with_table(SqlPool::Sqlite(pool.clone()), "bad; DROP TABLE x").is_err());

        pool.close().await;
    }
}
