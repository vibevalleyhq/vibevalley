//! Unified SQLite connection pool builder with WAL mode, `busy_timeout`, `foreign_keys`,
//! performance pragmas, and split read/write pool support.

use std::path::Path;
use std::str::FromStr;

use sqlx::ConnectOptions as _;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

use super::config::{DbEngineError, SqlitePoolConfig};

/// Paired SQLite pools: a serialized writer pool (`max_connections = 1`) and a concurrent
/// read-only pool sharing the same WAL database file.
#[derive(Debug, Clone)]
pub struct SqliteSplitPools {
    pub write_pool: SqlitePool,
    pub read_pool: SqlitePool,
}

/// Translates [`SqlitePoolConfig`] into configured `sqlx` [`SqliteConnectOptions`].
pub fn sqlite_connect_options(cfg: &SqlitePoolConfig) -> SqliteConnectOptions {
    let mut opts = match &cfg.path {
        Some(path) => SqliteConnectOptions::new().filename(path),
        None => SqliteConnectOptions::new().in_memory(true),
    };
    opts = opts.busy_timeout(cfg.busy_timeout);
    if cfg.read_only {
        opts = opts.read_only(true);
    } else {
        if cfg.path.is_some() {
            opts = opts.create_if_missing(cfg.create_if_missing);
        }
        if cfg.wal_mode {
            opts = opts.journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal);
        }
        if cfg.foreign_keys {
            opts = opts.foreign_keys(true);
        }
    }
    if let Some(cache) = &cfg.cache_size_kib {
        opts = opts.pragma("cache_size", cache.clone());
    }
    if let Some(temp) = &cfg.temp_store {
        opts = opts.pragma("temp_store", temp.clone());
    }
    if let Some(mmap) = &cfg.mmap_size_bytes {
        opts = opts.pragma("mmap_size", mmap.clone());
    }
    opts = opts.disable_statement_logging();
    if let Some(threshold) = cfg.slow_query_threshold {
        opts = opts.log_slow_statements(tracing::log::LevelFilter::Warn, threshold);
    }
    opts
}

fn build_pool_options(cfg: &SqlitePoolConfig) -> SqlitePoolOptions {
    let max_conns = cfg.max_connections.max(1);
    let min_conns = cfg.min_connections.min(max_conns);
    let mut pool_opts = SqlitePoolOptions::new()
        .max_connections(max_conns)
        .min_connections(min_conns)
        .acquire_timeout(cfg.acquire_timeout);
    if cfg.keep_alive || cfg.path.is_none() {
        pool_opts = pool_opts.idle_timeout(None).max_lifetime(None);
    }
    pool_opts
}

/// Connects a single SQLite pool according to [`SqlitePoolConfig`], creating parent directories
/// automatically when `create_if_missing` is enabled on a file-backed database.
pub async fn connect_sqlite_pool(cfg: &SqlitePoolConfig) -> Result<SqlitePool, DbEngineError> {
    if !cfg.read_only
        && cfg.create_if_missing
        && let Some(path) = &cfg.path
        && let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    let connect_opts = sqlite_connect_options(cfg);
    let pool_opts = build_pool_options(cfg);
    Ok(pool_opts.connect_with(connect_opts).await?)
}

/// Connects a SQLite pool directly from a `sqlite:` URL (supporting `:memory:`, `mode=ro`,
/// query parameters, WAL, and `busy_timeout`).
pub async fn connect_sqlite_url(url: &str, cfg: &SqlitePoolConfig) -> Result<SqlitePool, DbEngineError> {
    let mut opts = SqliteConnectOptions::from_str(url)?.busy_timeout(cfg.busy_timeout);
    let is_read_only = cfg.read_only || url.contains("mode=ro");
    if !is_read_only {
        if cfg.wal_mode {
            opts = opts.journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal);
        }
        if cfg.foreign_keys {
            opts = opts.foreign_keys(true);
        }
    }
    opts = opts.disable_statement_logging();
    if let Some(threshold) = cfg.slow_query_threshold {
        opts = opts.log_slow_statements(tracing::log::LevelFilter::Warn, threshold);
    }
    let max_conns = cfg.max_connections.max(1);
    let min_conns = cfg.min_connections.min(max_conns);
    let mut pool_opts = SqlitePoolOptions::new()
        .max_connections(max_conns)
        .min_connections(min_conns)
        .acquire_timeout(cfg.acquire_timeout);
    if cfg.keep_alive || url.contains(":memory:") {
        pool_opts = pool_opts.idle_timeout(None).max_lifetime(None);
    }
    Ok(pool_opts.connect_with(opts).await?)
}

/// Connects paired SQLite write + read-only pools on `path`, ensuring the database file and WAL
/// journal are initialized by the writer before opening readers.
pub async fn connect_sqlite_split_pools(path: &Path, write_cfg: &SqlitePoolConfig, read_cfg: &SqlitePoolConfig) -> Result<SqliteSplitPools, DbEngineError> {
    let mut w = write_cfg.clone();
    w.path = Some(path.to_path_buf());
    w.read_only = false;
    let write_pool = connect_sqlite_pool(&w).await?;

    let mut r = read_cfg.clone();
    r.path = Some(path.to_path_buf());
    r.read_only = true;
    r.create_if_missing = false;
    let read_pool = connect_sqlite_pool(&r).await?;

    Ok(SqliteSplitPools { write_pool, read_pool })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_split_pools_apply_wal_foreign_keys_and_pragmas() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("nested/kit.db");
        let write_cfg = SqlitePoolConfig::writer(&db_path).with_server_pragmas();
        let read_cfg = SqlitePoolConfig::reader(&db_path, 4).with_server_pragmas();
        let pools = connect_sqlite_split_pools(&db_path, &write_cfg, &read_cfg).await.unwrap();

        let journal: String = sqlx::query_scalar("PRAGMA journal_mode;").fetch_one(&pools.write_pool).await.unwrap();
        assert_eq!(journal.to_ascii_lowercase(), "wal");
        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys;").fetch_one(&pools.write_pool).await.unwrap();
        assert_eq!(fk, 1);
        let cache: i64 = sqlx::query_scalar("PRAGMA cache_size;").fetch_one(&pools.read_pool).await.unwrap();
        assert_eq!(cache, -32000);

        pools.read_pool.close().await;
        pools.write_pool.close().await;
    }

    #[tokio::test]
    async fn sqlite_in_memory_pool_keeps_connection_alive() {
        let pool = connect_sqlite_pool(&SqlitePoolConfig::in_memory()).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (42)").execute(&pool).await.unwrap();
        let v: i64 = sqlx::query_scalar("SELECT id FROM t").fetch_one(&pool).await.unwrap();
        assert_eq!(v, 42);
        pool.close().await;
    }
}
