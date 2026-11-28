//! Unified PostgreSQL connection pool builder (`postgres` feature).

#[cfg(feature = "postgres")]
use std::str::FromStr as _;

#[cfg(feature = "postgres")]
use sqlx::ConnectOptions as _;
#[cfg(feature = "postgres")]
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

#[cfg(feature = "postgres")]
use super::config::{DbEngineError, PostgresPoolConfig, redact_db_url};

/// Connects a PostgreSQL pool with clamped connection counts, timeouts, and slow-query logging.
#[cfg(feature = "postgres")]
pub async fn connect_postgres_pool(cfg: &PostgresPoolConfig) -> Result<PgPool, DbEngineError> {
    let mut connect_opts = PgConnectOptions::from_str(&cfg.url)
        .map_err(|e| DbEngineError::Config(format!("invalid postgres URL ({}): {e}", redact_db_url(&cfg.url))))?
        .disable_statement_logging();
    if let Some(threshold) = cfg.slow_query_threshold {
        connect_opts = connect_opts.log_slow_statements(tracing::log::LevelFilter::Warn, threshold);
    }
    let max_conns = cfg.clamped_max_connections();
    let min_conns = cfg.clamped_min_connections();
    let pool = PgPoolOptions::new()
        .max_connections(max_conns)
        .min_connections(min_conns)
        .acquire_timeout(cfg.acquire_timeout)
        .idle_timeout(Some(cfg.idle_timeout))
        .max_lifetime(Some(cfg.max_lifetime))
        .connect_with(connect_opts)
        .await?;
    Ok(pool)
}
