//! Parameterized SQL transactional outbox store (SQLite 3.35+ and PostgreSQL compatible, zero ORM entities).
//!
//! Features:
//! - Single-roundtrip `INSERT ... RETURNING id` (both standalone and inside caller's SQL transaction).
//! - Single-statement atomic `UPDATE ... WHERE id IN (SELECT ... [FOR UPDATE SKIP LOCKED]) RETURNING ...` claim.
//! - Crash-recovery via `recover_processing` and lease expiration (`locked_until` or `available_at` compatibility mode).
//! - Dead-letter inspection, single/bulk replay, and bounded TTL `prune_done_batch`.

use sqlx::Row as _;

use super::{BoxFuture, OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING, OutboxError, OutboxItem, OutboxStore};
use crate::db::engine::{DbBackendKind, SqlPool};

/// Default SQL table name matching existing server migrations.
pub const DEFAULT_OUTBOX_TABLE: &str = "outbox_item";

/// Controls how [`SqlOutbox`] tracks crash-recovery lease deadlines on `processing` rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxLeaseMode {
    /// Dedicated nullable `locked_until BIGINT` column (default for newly provisioned schemas).
    LockedUntilColumn,
    /// Zero-migration compatibility mode reusing `available_at` as the lease deadline while
    /// `status = 'processing'` on existing 8-column `outbox_item` tables.
    AvailableAtColumn,
}

fn validate_table_name(table: &str) -> Result<(), OutboxError> {
    if table.is_empty() || !table.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(OutboxError::InvalidTableName(table.to_owned()));
    }
    Ok(())
}

/// Returns DDL creating the outbox table with a `locked_until` lease column and claim/prune indexes.
pub fn ensure_outbox_table_sql(backend: DbBackendKind, table: &str) -> Result<Vec<String>, OutboxError> {
    validate_table_name(table)?;
    let pk = match backend {
        DbBackendKind::Sqlite => "INTEGER PRIMARY KEY AUTOINCREMENT",
        DbBackendKind::Postgres => "BIGSERIAL PRIMARY KEY",
    };
    Ok(vec![
        format!(
            "CREATE TABLE IF NOT EXISTS \"{table}\" (\
             id {pk}, \
             topic TEXT NOT NULL, \
             payload_json TEXT NOT NULL, \
             status TEXT NOT NULL DEFAULT 'pending', \
             attempts BIGINT NOT NULL DEFAULT 0, \
             available_at BIGINT NOT NULL, \
             created_at BIGINT NOT NULL, \
             last_error TEXT, \
             locked_until BIGINT\
             )"
        ),
        format!("CREATE INDEX IF NOT EXISTS \"{table}_claim\" ON \"{table}\" (status, available_at, id)"),
        format!("CREATE INDEX IF NOT EXISTS \"{table}_done_prune\" ON \"{table}\" (status, created_at, id)"),
    ])
}

/// Returns the single-roundtrip parameterized `INSERT ... RETURNING id` SQL for enqueuing an outbox item
/// (`bind 1 = topic`, `bind 2 = payload_json`, `bind 3 = available_at`, `bind 4 = created_at`).
///
/// Host apps using an external transaction wrapper (such as SeaORM `DatabaseTransaction`) can execute
/// this exact SQL inside their transaction without opening a second connection.
pub fn enqueue_outbox_sql(backend: DbBackendKind, table: &str) -> Result<String, OutboxError> {
    validate_table_name(table)?;
    let (p1, p2, p3, p4) = match backend {
        DbBackendKind::Sqlite => ("?1", "?2", "?3", "?4"),
        DbBackendKind::Postgres => ("$1", "$2", "$3", "$4"),
    };
    Ok(format!(
        "INSERT INTO \"{table}\" (topic, payload_json, status, attempts, available_at, created_at, last_error) \
         VALUES ({p1}, {p2}, '{OUTBOX_STATUS_PENDING}', 0, {p3}, {p4}, NULL) \
         RETURNING id"
    ))
}

fn row_from_sqlite(row: &sqlx::sqlite::SqliteRow, has_locked_until: bool) -> Result<OutboxItem, sqlx::Error> {
    let locked_until = if has_locked_until { row.try_get(8)? } else { None };
    Ok(OutboxItem {
        id: row.try_get(0)?,
        topic: row.try_get(1)?,
        payload_json: row.try_get(2)?,
        status: row.try_get(3)?,
        attempts: row.try_get(4)?,
        available_at: row.try_get(5)?,
        created_at: row.try_get(6)?,
        last_error: row.try_get(7)?,
        locked_until,
    })
}

#[cfg(feature = "postgres")]
fn row_from_postgres(row: &sqlx::postgres::PgRow, has_locked_until: bool) -> Result<OutboxItem, sqlx::Error> {
    let locked_until = if has_locked_until { row.try_get(8)? } else { None };
    Ok(OutboxItem {
        id: row.try_get(0)?,
        topic: row.try_get(1)?,
        payload_json: row.try_get(2)?,
        status: row.try_get(3)?,
        attempts: row.try_get(4)?,
        available_at: row.try_get(5)?,
        created_at: row.try_get(6)?,
        last_error: row.try_get(7)?,
        locked_until,
    })
}

/// Dual-backend parameterized SQL transactional outbox store.
#[derive(Debug, Clone)]
pub struct SqlOutbox {
    write_pool: SqlPool,
    read_pool: SqlPool,
    table: String,
    lease_mode: OutboxLeaseMode,
}

impl SqlOutbox {
    /// Creates a [`SqlOutbox`] targeting [`DEFAULT_OUTBOX_TABLE`] with [`OutboxLeaseMode::LockedUntilColumn`].
    pub fn new(pool: SqlPool) -> Self {
        Self::with_options(pool.clone(), pool, DEFAULT_OUTBOX_TABLE, OutboxLeaseMode::LockedUntilColumn).expect("default outbox table name is valid")
    }

    /// Creates a [`SqlOutbox`] with explicit split write/read pools, table identifier, and lease column mode.
    pub fn with_options(write_pool: SqlPool, read_pool: SqlPool, table: impl Into<String>, lease_mode: OutboxLeaseMode) -> Result<Self, OutboxError> {
        let table = table.into();
        validate_table_name(&table)?;
        Ok(Self {
            write_pool,
            read_pool,
            table,
            lease_mode,
        })
    }

    pub fn table(&self) -> &str {
        &self.table
    }

    pub fn backend(&self) -> DbBackendKind {
        self.write_pool.backend()
    }

    pub fn lease_mode(&self) -> OutboxLeaseMode {
        self.lease_mode
    }

    fn has_locked_until(&self) -> bool {
        self.lease_mode == OutboxLeaseMode::LockedUntilColumn
    }

    fn select_cols(&self) -> &'static str {
        if self.has_locked_until() {
            "id, topic, payload_json, status, attempts, available_at, created_at, last_error, locked_until"
        } else {
            "id, topic, payload_json, status, attempts, available_at, created_at, last_error"
        }
    }

    /// Creates the outbox table and indexes if they do not exist.
    pub async fn ensure_schema(&self) -> Result<(), OutboxError> {
        let stmts = ensure_outbox_table_sql(self.backend(), &self.table)?;
        match &self.write_pool {
            SqlPool::Sqlite(pool) => {
                for sql in stmts {
                    sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await?;
                }
            }
            #[cfg(feature = "postgres")]
            SqlPool::Postgres(pool) => {
                for sql in stmts {
                    sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await?;
                }
            }
        }
        Ok(())
    }

    /// Single-roundtrip enqueue inside an open `sqlx` SQLite transaction.
    pub async fn enqueue_in_sqlite_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        topic: &str,
        payload_json: &str,
        created_at: i64,
        available_at: i64,
    ) -> Result<i64, OutboxError> {
        let sql = enqueue_outbox_sql(DbBackendKind::Sqlite, &self.table)?;
        let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(topic)
            .bind(payload_json)
            .bind(available_at)
            .bind(created_at)
            .fetch_one(&mut **tx)
            .await?;
        Ok(id)
    }

    /// Single-roundtrip enqueue inside an open `sqlx` PostgreSQL transaction.
    #[cfg(feature = "postgres")]
    pub async fn enqueue_in_postgres_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        topic: &str,
        payload_json: &str,
        created_at: i64,
        available_at: i64,
    ) -> Result<i64, OutboxError> {
        let sql = enqueue_outbox_sql(DbBackendKind::Postgres, &self.table)?;
        let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(topic)
            .bind(payload_json)
            .bind(available_at)
            .bind(created_at)
            .fetch_one(&mut **tx)
            .await?;
        Ok(id)
    }
}

impl OutboxStore for SqlOutbox {
    fn enqueue_at<'a>(&'a self, topic: &'a str, payload_json: &'a str, created_at: i64, available_at: i64) -> BoxFuture<'a, Result<i64, OutboxError>> {
        Box::pin(async move {
            let sql = enqueue_outbox_sql(self.backend(), &self.table)?;
            let id: i64 = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                        .bind(topic)
                        .bind(payload_json)
                        .bind(available_at)
                        .bind(created_at)
                        .fetch_one(pool)
                        .await?
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                        .bind(topic)
                        .bind(payload_json)
                        .bind(available_at)
                        .bind(created_at)
                        .fetch_one(pool)
                        .await?
                }
            };
            Ok(id)
        })
    }

    fn claim_with_lease<'a>(&'a self, now_ms: i64, limit: u64, lease_ms: Option<i64>) -> BoxFuture<'a, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(Vec::new());
            }
            let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);
            let lease_deadline = lease_ms.map(|ms| now_ms.saturating_add(ms.max(0)));
            let cols = self.select_cols();
            let t = &self.table;
            let has_locked = self.has_locked_until();

            let mut items = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = match (self.lease_mode, lease_deadline) {
                        (OutboxLeaseMode::LockedUntilColumn, _) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1, locked_until = ?3 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= ?1 \
                                 ORDER BY available_at ASC, id ASC LIMIT ?2 \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                        (OutboxLeaseMode::AvailableAtColumn, Some(_)) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1, available_at = ?3 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= ?1 \
                                 ORDER BY available_at ASC, id ASC LIMIT ?2 \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                        (OutboxLeaseMode::AvailableAtColumn, None) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= ?1 \
                                 ORDER BY available_at ASC, id ASC LIMIT ?2 \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                    };
                    let rows = match (self.lease_mode, lease_deadline) {
                        (OutboxLeaseMode::LockedUntilColumn, _) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(now_ms)
                                .bind(limit_i64)
                                .bind(lease_deadline)
                                .fetch_all(pool)
                                .await?
                        }
                        (OutboxLeaseMode::AvailableAtColumn, Some(deadline)) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(now_ms)
                                .bind(limit_i64)
                                .bind(deadline)
                                .fetch_all(pool)
                                .await?
                        }
                        (OutboxLeaseMode::AvailableAtColumn, None) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).bind(limit_i64).fetch_all(pool).await?
                        }
                    };
                    let mut out = Vec::with_capacity(rows.len());
                    for row in &rows {
                        out.push(row_from_sqlite(row, has_locked)?);
                    }
                    out
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = match (self.lease_mode, lease_deadline) {
                        (OutboxLeaseMode::LockedUntilColumn, _) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1, locked_until = $3 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= $1 \
                                 ORDER BY available_at ASC, id ASC LIMIT $2 \
                                 FOR UPDATE SKIP LOCKED \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                        (OutboxLeaseMode::AvailableAtColumn, Some(_)) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1, available_at = $3 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= $1 \
                                 ORDER BY available_at ASC, id ASC LIMIT $2 \
                                 FOR UPDATE SKIP LOCKED \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                        (OutboxLeaseMode::AvailableAtColumn, None) => format!(
                            "UPDATE \"{t}\" \
                             SET status = '{OUTBOX_STATUS_PROCESSING}', attempts = attempts + 1 \
                             WHERE id IN ( \
                                 SELECT id FROM \"{t}\" \
                                 WHERE status = '{OUTBOX_STATUS_PENDING}' AND available_at <= $1 \
                                 ORDER BY available_at ASC, id ASC LIMIT $2 \
                                 FOR UPDATE SKIP LOCKED \
                             ) AND status = '{OUTBOX_STATUS_PENDING}' \
                             RETURNING {cols}"
                        ),
                    };
                    let rows = match (self.lease_mode, lease_deadline) {
                        (OutboxLeaseMode::LockedUntilColumn, _) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(now_ms)
                                .bind(limit_i64)
                                .bind(lease_deadline)
                                .fetch_all(pool)
                                .await?
                        }
                        (OutboxLeaseMode::AvailableAtColumn, Some(deadline)) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(now_ms)
                                .bind(limit_i64)
                                .bind(deadline)
                                .fetch_all(pool)
                                .await?
                        }
                        (OutboxLeaseMode::AvailableAtColumn, None) => {
                            sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).bind(limit_i64).fetch_all(pool).await?
                        }
                    };
                    let mut out = Vec::with_capacity(rows.len());
                    for row in &rows {
                        out.push(row_from_postgres(row, has_locked)?);
                    }
                    out
                }
            };
            items.sort_by_key(|row| (row.available_at, row.id));
            Ok(items)
        })
    }

    fn recover_processing<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            let affected = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = ?1{clear_lease} \
                         WHERE status = '{OUTBOX_STATUS_PROCESSING}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = $1{clear_lease} \
                         WHERE status = '{OUTBOX_STATUS_PROCESSING}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
            };
            Ok(affected)
        })
    }

    fn reclaim_expired_leases<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let affected = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = match self.lease_mode {
                        OutboxLeaseMode::LockedUntilColumn => format!(
                            "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = ?1, locked_until = NULL \
                             WHERE status = '{OUTBOX_STATUS_PROCESSING}' AND locked_until IS NOT NULL AND locked_until <= ?1"
                        ),
                        OutboxLeaseMode::AvailableAtColumn => format!(
                            "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = ?1 \
                             WHERE status = '{OUTBOX_STATUS_PROCESSING}' AND available_at <= ?1"
                        ),
                    };
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = match self.lease_mode {
                        OutboxLeaseMode::LockedUntilColumn => format!(
                            "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = $1, locked_until = NULL \
                             WHERE status = '{OUTBOX_STATUS_PROCESSING}' AND locked_until IS NOT NULL AND locked_until <= $1"
                        ),
                        OutboxLeaseMode::AvailableAtColumn => format!(
                            "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = $1 \
                             WHERE status = '{OUTBOX_STATUS_PROCESSING}' AND available_at <= $1"
                        ),
                    };
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
            };
            Ok(affected)
        })
    }

    fn next_pending_at(&self) -> BoxFuture<'_, Result<Option<i64>, OutboxError>> {
        Box::pin(async move {
            let sql = format!(
                "SELECT available_at FROM \"{}\" WHERE status = '{OUTBOX_STATUS_PENDING}' ORDER BY available_at ASC, id ASC LIMIT 1",
                self.table
            );
            let next: Option<i64> = match &self.read_pool {
                SqlPool::Sqlite(pool) => sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).fetch_optional(pool).await?,
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).fetch_optional(pool).await?,
            };
            Ok(next)
        })
    }

    fn complete(&self, id: i64) -> BoxFuture<'_, Result<(), OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_DONE}', last_error = NULL{clear_lease} WHERE id = ?1");
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id).execute(pool).await?;
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_DONE}', last_error = NULL{clear_lease} WHERE id = $1");
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id).execute(pool).await?;
                }
            }
            Ok(())
        })
    }

    fn reschedule<'a>(&'a self, id: i64, available_at: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = ?1, last_error = ?2{clear_lease} WHERE id = ?3");
                    sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(available_at)
                        .bind(error)
                        .bind(id)
                        .execute(pool)
                        .await?;
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', available_at = $1, last_error = $2{clear_lease} WHERE id = $3");
                    sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(available_at)
                        .bind(error)
                        .bind(id)
                        .execute(pool)
                        .await?;
                }
            }
            Ok(())
        })
    }

    fn fail<'a>(&'a self, id: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_FAILED}', last_error = ?1{clear_lease} WHERE id = ?2");
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(error).bind(id).execute(pool).await?;
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!("UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_FAILED}', last_error = $1{clear_lease} WHERE id = $2");
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(error).bind(id).execute(pool).await?;
                }
            }
            Ok(())
        })
    }

    fn list_failed(&self, limit: u64) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(Vec::new());
            }
            let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);
            let cols = self.select_cols();
            let t = &self.table;
            let has_locked = self.has_locked_until();
            match &self.read_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!("SELECT {cols} FROM \"{t}\" WHERE status = '{OUTBOX_STATUS_FAILED}' ORDER BY id DESC LIMIT ?1");
                    let rows = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(limit_i64).fetch_all(pool).await?;
                    rows.iter()
                        .map(|r| row_from_sqlite(r, has_locked))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(Into::into)
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!("SELECT {cols} FROM \"{t}\" WHERE status = '{OUTBOX_STATUS_FAILED}' ORDER BY id DESC LIMIT $1");
                    let rows = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(limit_i64).fetch_all(pool).await?;
                    rows.iter()
                        .map(|r| row_from_postgres(r, has_locked))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(Into::into)
                }
            }
        })
    }

    fn count_failed(&self) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            let sql = format!("SELECT COUNT(*) FROM \"{}\" WHERE status = '{OUTBOX_STATUS_FAILED}'", self.table);
            let count: i64 = match &self.read_pool {
                SqlPool::Sqlite(pool) => sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await?,
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await?,
            };
            Ok(count.max(0) as u64)
        })
    }

    fn replay_failed(&self, id: i64, now_ms: i64) -> BoxFuture<'_, Result<bool, OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            let affected = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', attempts = 0, available_at = ?1, last_error = NULL{clear_lease} \
                         WHERE id = ?2 AND status = '{OUTBOX_STATUS_FAILED}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).bind(id).execute(pool).await?.rows_affected()
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', attempts = 0, available_at = $1, last_error = NULL{clear_lease} \
                         WHERE id = $2 AND status = '{OUTBOX_STATUS_FAILED}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).bind(id).execute(pool).await?.rows_affected()
                }
            };
            Ok(affected > 0)
        })
    }

    fn replay_all_failed(&self, now_ms: i64) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            let t = &self.table;
            let clear_lease = if self.has_locked_until() { ", locked_until = NULL" } else { "" };
            let affected = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', attempts = 0, available_at = ?1, last_error = NULL{clear_lease} \
                         WHERE status = '{OUTBOX_STATUS_FAILED}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!(
                        "UPDATE \"{t}\" SET status = '{OUTBOX_STATUS_PENDING}', attempts = 0, available_at = $1, last_error = NULL{clear_lease} \
                         WHERE status = '{OUTBOX_STATUS_FAILED}'"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(now_ms).execute(pool).await?.rows_affected()
                }
            };
            Ok(affected)
        })
    }

    fn prune_done_batch(&self, before_ms: i64, limit: u64) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(0);
            }
            let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);
            let t = &self.table;
            let affected = match &self.write_pool {
                SqlPool::Sqlite(pool) => {
                    let sql = format!(
                        "DELETE FROM \"{t}\" WHERE id IN ( \
                             SELECT id FROM \"{t}\" WHERE status = '{OUTBOX_STATUS_DONE}' AND created_at < ?1 ORDER BY id ASC LIMIT ?2 \
                         )"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(before_ms)
                        .bind(limit_i64)
                        .execute(pool)
                        .await?
                        .rows_affected()
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let sql = format!(
                        "DELETE FROM \"{t}\" WHERE id IN ( \
                             SELECT id FROM \"{t}\" WHERE status = '{OUTBOX_STATUS_DONE}' AND created_at < $1 ORDER BY id ASC LIMIT $2 \
                         )"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(before_ms)
                        .bind(limit_i64)
                        .execute(pool)
                        .await?
                        .rows_affected()
                }
            };
            Ok(affected)
        })
    }

    fn list_all(&self) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            let cols = self.select_cols();
            let t = &self.table;
            let has_locked = self.has_locked_until();
            let sql = format!("SELECT {cols} FROM \"{t}\" ORDER BY id ASC");
            match &self.read_pool {
                SqlPool::Sqlite(pool) => {
                    let rows = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(pool).await?;
                    rows.iter()
                        .map(|r| row_from_sqlite(r, has_locked))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(Into::into)
                }
                #[cfg(feature = "postgres")]
                SqlPool::Postgres(pool) => {
                    let rows = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(pool).await?;
                    rows.iter()
                        .map(|r| row_from_postgres(r, has_locked))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(Into::into)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::{SqlitePoolConfig, connect_sqlite_pool};

    #[tokio::test]
    async fn sql_outbox_tx_enqueue_commits_and_rolls_back_atomically() {
        let pool = connect_sqlite_pool(&SqlitePoolConfig::in_memory()).await.unwrap();
        let store = SqlOutbox::new(SqlPool::Sqlite(pool.clone()));
        store.ensure_schema().await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        let _ = store.enqueue_in_sqlite_tx(&mut tx, "aborted", r#"{"ok":false}"#, 100, 100).await.unwrap();
        tx.rollback().await.unwrap();
        assert!(store.list_all().await.unwrap().is_empty());

        let mut tx2 = pool.begin().await.unwrap();
        let id = store.enqueue_in_sqlite_tx(&mut tx2, "committed", r#"{"ok":true}"#, 200, 200).await.unwrap();
        tx2.commit().await.unwrap();
        let rows = store.list_all().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].topic, "committed");

        pool.close().await;
    }
}
