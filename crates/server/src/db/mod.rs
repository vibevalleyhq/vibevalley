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
pub mod migration;
pub mod verify;

pub(crate) use database::begin_write_tx;
#[cfg(test)]
pub(crate) use database::test_pg;
pub use database::{BoxFuture, Database, DatabaseConfig, Tx, commit_tx, rollback_tx};
pub use error::{DbError, DbResult, internal_db};
pub use verify::{SchemaMismatchReport, TableDrift};

/// Database engine backing a [`Database`] instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbBackend {
    Sqlite,
    Postgres,
}
