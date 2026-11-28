//! Unified SQLite and PostgreSQL connection pool builders shared across server, agent, and desktop hosts.

pub mod config;
pub mod postgres;
pub mod sqlite;

pub use config::{
    DEFAULT_POSTGRES_ACQUIRE_TIMEOUT, DEFAULT_POSTGRES_IDLE_TIMEOUT, DEFAULT_POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_LIFETIME,
    DEFAULT_POSTGRES_MIN_CONNECTIONS, DEFAULT_SQLITE_ACQUIRE_TIMEOUT, DEFAULT_SQLITE_BUSY_TIMEOUT, DatabaseConfig, DbBackendKind, DbEngineError,
    PostgresPoolConfig, SqlitePoolConfig, parse_sqlite_url, redact_db_url, sqlite_file_url,
};
#[cfg(feature = "postgres")]
pub use postgres::connect_postgres_pool;
pub use sqlite::{SqliteSplitPools, connect_sqlite_pool, connect_sqlite_split_pools, connect_sqlite_url, sqlite_connect_options};

/// Unified dual-backend `sqlx` connection pool handle.
#[derive(Debug, Clone)]
pub enum SqlPool {
    Sqlite(sqlx::SqlitePool),
    #[cfg(feature = "postgres")]
    Postgres(sqlx::PgPool),
}

impl SqlPool {
    pub fn backend(&self) -> DbBackendKind {
        match self {
            Self::Sqlite(_) => DbBackendKind::Sqlite,
            #[cfg(feature = "postgres")]
            Self::Postgres(_) => DbBackendKind::Postgres,
        }
    }

    pub fn as_sqlite(&self) -> Option<&sqlx::SqlitePool> {
        match self {
            Self::Sqlite(pool) => Some(pool),
            #[cfg(feature = "postgres")]
            Self::Postgres(_) => None,
        }
    }

    #[cfg(feature = "postgres")]
    pub fn as_postgres(&self) -> Option<&sqlx::PgPool> {
        match self {
            Self::Postgres(pool) => Some(pool),
            Self::Sqlite(_) => None,
        }
    }

    pub async fn close(&self) {
        match self {
            Self::Sqlite(pool) => pool.close().await,
            #[cfg(feature = "postgres")]
            Self::Postgres(pool) => pool.close().await,
        }
    }
}
