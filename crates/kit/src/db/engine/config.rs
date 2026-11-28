//! Database URL parsing, credential redaction, and strongly-typed SQLite/PostgreSQL pool configuration.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::db::telemetry::DEFAULT_SLOW_QUERY_THRESHOLD;

pub const DEFAULT_SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_SQLITE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_SQLITE_CACHE_SIZE_KIB: &str = "-32000";
pub const DEFAULT_SQLITE_TEMP_STORE: &str = "MEMORY";
pub const DEFAULT_SQLITE_MMAP_SIZE_BYTES: &str = "134217728";

pub const DEFAULT_POSTGRES_MAX_CONNECTIONS: u32 = 16;
pub const DEFAULT_POSTGRES_MIN_CONNECTIONS: u32 = 2;
pub const DEFAULT_POSTGRES_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_POSTGRES_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
pub const DEFAULT_POSTGRES_MAX_LIFETIME: Duration = Duration::from_secs(1800);

/// SQL dialect / backend kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DbBackendKind {
    Sqlite,
    Postgres,
}

impl DbBackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
        }
    }
}

/// Errors produced when configuring or opening a SQL connection pool.
#[derive(Debug, thiserror::Error)]
pub enum DbEngineError {
    #[error("invalid database configuration: {0}")]
    Config(String),

    #[error("database I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database driver error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Redacts any password embedded in a database connection URL before logging or formatting.
pub fn redact_db_url(raw: &str) -> String {
    if let Ok(mut parsed) = url::Url::parse(raw) {
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("***"));
        }
        return parsed.to_string();
    }
    if let Some((scheme_user, rest)) = raw.split_once('@')
        && let Some((prefix, _)) = scheme_user.rsplit_once(':')
        && prefix.contains("://")
    {
        return format!("{prefix}:***@{rest}");
    }
    raw.to_owned()
}

/// Parses a `sqlite://` or `sqlite:` file URL into a local filesystem path, rejecting `:memory:`.
pub fn parse_sqlite_url(url: &str) -> Result<PathBuf, DbEngineError> {
    let raw = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .ok_or_else(|| DbEngineError::Config("expected sqlite: database URL".into()))?;
    let path_part = raw.split('?').next().unwrap_or(raw);
    if path_part.is_empty() || path_part == ":memory:" {
        return Err(DbEngineError::Config("sqlite URL must reference a database file path".into()));
    }
    Ok(PathBuf::from(path_part))
}

/// Encodes a local filesystem path as a `sqlite://...?mode=rwc` URL, escaping RFC 3986 special characters.
pub fn sqlite_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'%' => encoded.push_str("%25"),
            b' ' => encoded.push_str("%20"),
            b'"' => encoded.push_str("%22"),
            b'#' => encoded.push_str("%23"),
            b'<' => encoded.push_str("%3C"),
            b'>' => encoded.push_str("%3E"),
            b'?' => encoded.push_str("%3F"),
            b'`' => encoded.push_str("%60"),
            b'{' => encoded.push_str("%7B"),
            b'}' => encoded.push_str("%7D"),
            _ => encoded.push(byte as char),
        }
    }
    format!("sqlite://{encoded}?mode=rwc")
}

/// Tuning parameters for opening a SQLite connection pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlitePoolConfig {
    /// File path to open, or `None` for an in-memory database.
    pub path: Option<PathBuf>,
    pub create_if_missing: bool,
    pub read_only: bool,
    pub wal_mode: bool,
    pub foreign_keys: bool,
    pub busy_timeout: Duration,
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout: Duration,
    /// When `true`, sets `idle_timeout(None)` and `max_lifetime(None)` (essential for `:memory:` or single-conn host stores).
    pub keep_alive: bool,
    pub cache_size_kib: Option<String>,
    pub temp_store: Option<String>,
    pub mmap_size_bytes: Option<String>,
    pub slow_query_threshold: Option<Duration>,
}

impl SqlitePoolConfig {
    /// Default single-writer WAL configuration for a file-backed database.
    pub fn writer(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
            create_if_missing: true,
            read_only: false,
            wal_mode: true,
            foreign_keys: true,
            busy_timeout: DEFAULT_SQLITE_BUSY_TIMEOUT,
            max_connections: 1,
            min_connections: 1,
            acquire_timeout: DEFAULT_SQLITE_ACQUIRE_TIMEOUT,
            keep_alive: false,
            cache_size_kib: None,
            temp_store: None,
            mmap_size_bytes: None,
            slow_query_threshold: Some(DEFAULT_SLOW_QUERY_THRESHOLD),
        }
    }

    /// Default read-only pool configuration for a file-backed WAL database.
    pub fn reader(path: impl Into<PathBuf>, max_connections: u32) -> Self {
        Self {
            path: Some(path.into()),
            create_if_missing: false,
            read_only: true,
            wal_mode: false,
            foreign_keys: false,
            busy_timeout: DEFAULT_SQLITE_BUSY_TIMEOUT,
            max_connections: max_connections.max(1),
            min_connections: 1,
            acquire_timeout: DEFAULT_SQLITE_ACQUIRE_TIMEOUT,
            keep_alive: false,
            cache_size_kib: None,
            temp_store: None,
            mmap_size_bytes: None,
            slow_query_threshold: Some(DEFAULT_SLOW_QUERY_THRESHOLD),
        }
    }

    /// Default single-connection in-memory SQLite database configuration (`keep_alive = true`).
    pub fn in_memory() -> Self {
        Self {
            path: None,
            create_if_missing: true,
            read_only: false,
            wal_mode: true,
            foreign_keys: true,
            busy_timeout: DEFAULT_SQLITE_BUSY_TIMEOUT,
            max_connections: 1,
            min_connections: 1,
            acquire_timeout: DEFAULT_SQLITE_ACQUIRE_TIMEOUT,
            keep_alive: true,
            cache_size_kib: None,
            temp_store: None,
            mmap_size_bytes: None,
            slow_query_threshold: None,
        }
    }

    /// Enables server-grade SQLite memory/mmap pragmas (`cache_size`, `temp_store`, `mmap_size`).
    pub fn with_server_pragmas(mut self) -> Self {
        self.cache_size_kib = Some(DEFAULT_SQLITE_CACHE_SIZE_KIB.to_owned());
        self.temp_store = Some(DEFAULT_SQLITE_TEMP_STORE.to_owned());
        self.mmap_size_bytes = Some(DEFAULT_SQLITE_MMAP_SIZE_BYTES.to_owned());
        self
    }

    pub fn with_keep_alive(mut self, keep_alive: bool) -> Self {
        self.keep_alive = keep_alive;
        self
    }

    pub fn with_foreign_keys(mut self, foreign_keys: bool) -> Self {
        self.foreign_keys = foreign_keys;
        self
    }

    pub fn with_slow_query_threshold(mut self, threshold: Option<Duration>) -> Self {
        self.slow_query_threshold = threshold;
        self
    }
}

/// Tuning parameters for opening a PostgreSQL connection pool.
#[derive(Clone, PartialEq, Eq)]
pub struct PostgresPoolConfig {
    pub url: String,
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout: Duration,
    pub idle_timeout: Duration,
    pub max_lifetime: Duration,
    pub slow_query_threshold: Option<Duration>,
}

impl fmt::Debug for PostgresPoolConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PostgresPoolConfig")
            .field("url", &redact_db_url(&self.url))
            .field("max_connections", &self.max_connections)
            .field("min_connections", &self.min_connections)
            .field("acquire_timeout", &self.acquire_timeout)
            .field("idle_timeout", &self.idle_timeout)
            .field("max_lifetime", &self.max_lifetime)
            .field("slow_query_threshold", &self.slow_query_threshold)
            .finish()
    }
}

impl PostgresPoolConfig {
    pub fn new(url: impl Into<String>) -> Result<Self, DbEngineError> {
        let raw = url.into();
        let trimmed = raw.trim();
        if !(trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://")) {
            return Err(DbEngineError::Config(format!(
                "expected postgres:// or postgresql:// URL: {}",
                redact_db_url(trimmed)
            )));
        }
        let _ = url::Url::parse(trimmed).map_err(|e| DbEngineError::Config(format!("invalid postgres URL ({}): {e}", redact_db_url(trimmed))))?;
        Ok(Self {
            url: trimmed.to_owned(),
            max_connections: DEFAULT_POSTGRES_MAX_CONNECTIONS,
            min_connections: DEFAULT_POSTGRES_MIN_CONNECTIONS,
            acquire_timeout: DEFAULT_POSTGRES_ACQUIRE_TIMEOUT,
            idle_timeout: DEFAULT_POSTGRES_IDLE_TIMEOUT,
            max_lifetime: DEFAULT_POSTGRES_MAX_LIFETIME,
            slow_query_threshold: Some(DEFAULT_SLOW_QUERY_THRESHOLD),
        })
    }

    pub fn clamped_max_connections(&self) -> u32 {
        self.max_connections.max(1)
    }

    pub fn clamped_min_connections(&self) -> u32 {
        self.min_connections.min(self.clamped_max_connections())
    }
}

/// Top-level dual-backend database configuration parsed from URL or constructed explicitly.
#[derive(Clone, PartialEq, Eq)]
pub enum DatabaseConfig {
    Sqlite {
        path: PathBuf,
    },
    Postgres {
        url: String,
        max_connections: u32,
        min_connections: u32,
        acquire_timeout: Duration,
        idle_timeout: Duration,
        max_lifetime: Duration,
    },
}

impl fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite { path } => f.debug_struct("Sqlite").field("path", path).finish(),
            Self::Postgres {
                url,
                max_connections,
                min_connections,
                acquire_timeout,
                idle_timeout,
                max_lifetime,
            } => f
                .debug_struct("Postgres")
                .field("url", &redact_db_url(url))
                .field("max_connections", max_connections)
                .field("min_connections", min_connections)
                .field("acquire_timeout", acquire_timeout)
                .field("idle_timeout", idle_timeout)
                .field("max_lifetime", max_lifetime)
                .finish(),
        }
    }
}

impl DatabaseConfig {
    pub fn from_url(url: &str) -> Result<Self, DbEngineError> {
        let trimmed = url.trim();
        if trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://") {
            let pg = PostgresPoolConfig::new(trimmed)?;
            return Ok(Self::Postgres {
                url: pg.url,
                max_connections: pg.max_connections,
                min_connections: pg.min_connections,
                acquire_timeout: pg.acquire_timeout,
                idle_timeout: pg.idle_timeout,
                max_lifetime: pg.max_lifetime,
            });
        }
        if trimmed.starts_with("sqlite:") {
            return Ok(Self::Sqlite {
                path: parse_sqlite_url(trimmed)?,
            });
        }
        Err(DbEngineError::Config(format!("unsupported database URL scheme: {}", redact_db_url(trimmed))))
    }

    pub fn backend(&self) -> DbBackendKind {
        match self {
            Self::Sqlite { .. } => DbBackendKind::Sqlite,
            Self::Postgres { .. } => DbBackendKind::Postgres,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_config_from_url_redacts_passwords_and_validates_schemes() {
        let pg = DatabaseConfig::from_url("postgres://admin:supersecret@127.0.0.1:5432/vibevalley").unwrap();
        let dbg = format!("{pg:?}");
        assert!(!dbg.contains("supersecret"), "Debug leaked password: {dbg}");
        assert!(dbg.contains("***"));

        let sqlite = DatabaseConfig::from_url("sqlite:///tmp/test-server.db").unwrap();
        assert_eq!(
            sqlite,
            DatabaseConfig::Sqlite {
                path: PathBuf::from("/tmp/test-server.db")
            }
        );

        assert!(DatabaseConfig::from_url("sqlite::memory:").is_err());
        assert!(DatabaseConfig::from_url("mysql://localhost/db").is_err());
    }

    #[test]
    fn sqlite_file_url_encodes_spaces_and_special_chars() {
        let url = sqlite_file_url(Path::new("/tmp/My App/state #1.db"));
        assert_eq!(url, "sqlite:///tmp/My%20App/state%20%231.db?mode=rwc");
    }

    #[test]
    fn postgres_pool_config_clamps_bounds() {
        let mut pg = PostgresPoolConfig::new("postgres://postgres@127.0.0.1:5432/db").unwrap();
        pg.max_connections = 0;
        pg.min_connections = 8;
        assert_eq!(pg.clamped_max_connections(), 1);
        assert_eq!(pg.clamped_min_connections(), 1);
    }
}
