//! Low-level dual-backend database layer (SQLite + PostgreSQL):
//! connection pools ([`Database`]), schema migrations (`migration/`),
//! one-table-per-file SeaORM entities (`entity/`), column serialization helpers,
//! opaque errors ([`DbError`]), and transaction handle ([`Tx`]).
//!
//! Business-oriented data operations live in `crate::service::Service`.
//! No module outside `crate::db` and `crate::service` imports `sea_orm::` or `db::entity`.

pub(crate) mod column;
mod database;
pub(crate) mod entity;
pub mod error;
pub mod metrics;
pub mod migration;
pub mod verify;

#[cfg(all(test, feature = "postgres"))]
pub(crate) use database::test_pg;
pub use database::{
    BoxFuture, DEFAULT_POSTGRES_ACQUIRE_TIMEOUT, DEFAULT_POSTGRES_IDLE_TIMEOUT, DEFAULT_POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_LIFETIME,
    DEFAULT_POSTGRES_MIN_CONNECTIONS, Database, DatabaseConfig, Tx, commit_tx, rollback_tx,
};
pub(crate) use database::{begin_read_tx, begin_write_tx};
pub use error::{DbError, DbResult, internal_db};
pub use metrics::{DEFAULT_SLOW_QUERY_THRESHOLD, QueryMetrics, QueryStatsSnapshot, redact_sql_literals};
pub use verify::{SchemaMismatchReport, TableDrift};

/// Database engine backing a [`Database`] instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbBackend {
    Sqlite,
    Postgres,
}
