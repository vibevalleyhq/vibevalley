//! Shared refusals (`base/errors.ts`), idempotent request keys, and the
//! server's shared dual-backend database door (`ServerDb`, SQLite + PostgreSQL).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, DbErr, SqlxSqliteConnector};
use sea_orm_migration::MigratorTrait;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqliteConnection, SqlitePool};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, Next};

// Wave 2-3 SQLite transition views for un-migrated collab_channel sqlx queries.
const SQLITE_CHANNEL_VIEWS: &str = "\
CREATE VIEW IF NOT EXISTS channel_message_detail AS \
SELECT m.*, p.name AS sender_name, p.kind AS sender_kind, p.agent_id AS sender_agent \
FROM channel_message m JOIN channel_participant p ON p.id = m.sender_id;\n\
CREATE VIEW IF NOT EXISTS channel_message_location AS \
SELECT d.*, c.type AS channel_type, c.root_number, \
       CAST(COALESCE(c.parent_id, c.id) AS TEXT) AS top_id, \
       CAST(COALESCE(ch.name, c.name, '') AS TEXT) AS channel_name \
FROM channel_message_detail d JOIN channel c ON c.id = d.channel_id LEFT JOIN channel ch ON ch.id = c.parent_id;";

const READ_POOL_MAX_CONNECTIONS: u32 = 6;
const WRITE_POOL_MAX_CONNECTIONS: u32 = 1;
const DEFAULT_POSTGRES_MAX_CONNECTIONS: u32 = 16;

fn redact_db_url(raw: &str) -> String {
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

fn parse_sqlite_url(url: &str) -> Result<PathBuf, DbErr> {
    let raw = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .ok_or_else(|| DbErr::Custom("expected sqlite: database URL".into()))?;
    let path_part = raw.split('?').next().unwrap_or(raw);
    if path_part.is_empty() || path_part == ":memory:" {
        return Err(DbErr::Custom("sqlite URL must reference a database file path".into()));
    }
    Ok(PathBuf::from(path_part))
}

fn db_err_to_sqlx(err: DbErr) -> sqlx::Error {
    sqlx::Error::Protocol(err.to_string())
}

#[derive(Clone, PartialEq, Eq)]
pub enum DatabaseConfig {
    Sqlite { path: PathBuf },
    Postgres { url: String, max_connections: u32 },
}

impl std::fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite { path } => f.debug_struct("Sqlite").field("path", path).finish(),
            Self::Postgres { url, max_connections } => f
                .debug_struct("Postgres")
                .field("url", &redact_db_url(url))
                .field("max_connections", max_connections)
                .finish(),
        }
    }
}

impl DatabaseConfig {
    pub fn from_url(url: &str) -> Result<Self, DbErr> {
        let trimmed = url.trim();
        if trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://") {
            let _ = url::Url::parse(trimmed).map_err(|e| DbErr::Custom(format!("invalid postgres URL ({}): {e}", redact_db_url(trimmed))))?;
            return Ok(Self::Postgres {
                url: trimmed.to_owned(),
                max_connections: DEFAULT_POSTGRES_MAX_CONNECTIONS,
            });
        }
        if trimmed.starts_with("sqlite:") {
            return Ok(Self::Sqlite {
                path: parse_sqlite_url(trimmed)?,
            });
        }
        Err(DbErr::Custom(format!("unsupported database URL scheme: {}", redact_db_url(trimmed))))
    }
}

/// Pooled SQLite connection guard that enters the shared Tokio runtime context
/// before returning the underlying `PoolConnection` to `SqlitePool` on drop, so
/// synchronous callers on non-Tokio threads never panic.
pub(crate) struct DbConn(Option<PoolConnection<Sqlite>>);

impl std::ops::Deref for DbConn {
    type Target = SqliteConnection;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("DbConn live before Drop")
    }
}

impl std::ops::DerefMut for DbConn {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("DbConn live before Drop")
    }
}

impl Drop for DbConn {
    fn drop(&mut self) {
        if let Some(conn) = self.0.take() {
            let _guard = vibevalley_runtime::rt::handle().enter();
            drop(conn);
        }
    }
}

enum DbBackendState {
    Sqlite {
        path: PathBuf,
        read_pool: SqlitePool,
        write_pool: SqlitePool,
    },
    Postgres,
}

/// Single shared dual-backend database door (`ServerDb`):
/// - On SQLite: split WAL-mode pools (`write_pool` max=1, `read_pool` max=6 read-only)
///   wrapped into SeaORM `DatabaseConnection`s via `SqlxSqliteConnector`.
/// - On PostgreSQL: pooled SeaORM `DatabaseConnection` shared by readers and writers.
pub struct ServerDb {
    config: DatabaseConfig,
    backend_state: DbBackendState,
    read_conn: DatabaseConnection,
    write_conn: DatabaseConnection,
    durable: Mutex<Option<vibevalley_runtime::agent::durable::Store>>,
}

impl ServerDb {
    /// Opens `<home>/server.db` with split read/write pools and initializes all schemas once.
    pub fn open(home: &Path) -> sqlx::Result<Arc<Self>> {
        Self::open_at(&home.join("server.db"))
    }

    /// Opens `path` with split read/write pools and initializes all schemas once.
    pub fn open_at(path: &Path) -> sqlx::Result<Arc<Self>> {
        Self::open_config(&DatabaseConfig::Sqlite { path: path.to_path_buf() }).map_err(db_err_to_sqlx)
    }

    /// Opens a SQLite or PostgreSQL database from a URL (`sqlite:...`, `postgres://...`, `postgresql://...`).
    pub fn open_url(url: &str) -> Result<Arc<Self>, DbErr> {
        let config = DatabaseConfig::from_url(url)?;
        Self::open_config(&config)
    }

    /// Opens a SQLite or PostgreSQL database from [`DatabaseConfig`] and runs both server and durable migrations.
    pub fn open_config(config: &DatabaseConfig) -> Result<Arc<Self>, DbErr> {
        let config_owned = config.clone();
        if let DatabaseConfig::Sqlite { path } = &config_owned
            && let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(parent);
        }

        let (backend_state, read_conn, write_conn) = vibevalley_runtime::rt::block_on(async {
            match &config_owned {
                DatabaseConfig::Sqlite { path } => {
                    let write_options = SqliteConnectOptions::new()
                        .filename(path)
                        .create_if_missing(true)
                        .busy_timeout(Duration::from_secs(5))
                        .journal_mode(SqliteJournalMode::Wal)
                        .synchronous(SqliteSynchronous::Normal)
                        .foreign_keys(true);
                    let write_pool = SqlitePoolOptions::new()
                        .max_connections(WRITE_POOL_MAX_CONNECTIONS)
                        .min_connections(1)
                        .connect_with(write_options)
                        .await
                        .map_err(|e| DbErr::Conn(sea_orm::RuntimeErr::SqlxError(Arc::new(e))))?;
                    let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool.clone());
                    crate::db::migration::Migrator::up(&write_conn, None).await?;
                    vibevalley_runtime::agent::durable::migration::Migrator::up(&write_conn, None).await?;
                    write_conn.execute_unprepared(SQLITE_CHANNEL_VIEWS).await?;

                    let read_options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(Duration::from_secs(5));
                    let read_pool = SqlitePoolOptions::new()
                        .max_connections(READ_POOL_MAX_CONNECTIONS)
                        .min_connections(1)
                        .connect_with(read_options)
                        .await
                        .map_err(|e| DbErr::Conn(sea_orm::RuntimeErr::SqlxError(Arc::new(e))))?;
                    let read_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool.clone());

                    Ok::<_, DbErr>((
                        DbBackendState::Sqlite {
                            path: path.clone(),
                            read_pool,
                            write_pool,
                        },
                        read_conn,
                        write_conn,
                    ))
                }
                DatabaseConfig::Postgres { url, max_connections } => {
                    let mut opts = ConnectOptions::new(url);
                    opts.max_connections((*max_connections).max(1)).sqlx_logging(false);
                    let conn = Database::connect(opts).await.inspect_err(|err| {
                        tracing::error!(url = %redact_db_url(url), error = %err, "failed to connect to postgres database");
                    })?;
                    crate::db::migration::Migrator::up(&conn, None).await?;
                    vibevalley_runtime::agent::durable::migration::Migrator::up(&conn, None).await?;
                    Ok::<_, DbErr>((DbBackendState::Postgres, conn.clone(), conn))
                }
            }
        })?;

        Ok(Arc::new(Self {
            config: config_owned,
            backend_state,
            read_conn,
            write_conn,
            durable: Mutex::new(None),
        }))
    }

    pub fn write_conn(&self) -> &DatabaseConnection {
        &self.write_conn
    }

    pub fn read_conn(&self) -> &DatabaseConnection {
        &self.read_conn
    }

    pub fn backend(&self) -> DatabaseBackend {
        self.write_conn.get_database_backend()
    }

    pub fn is_postgres(&self) -> bool {
        matches!(self.config, DatabaseConfig::Postgres { .. })
    }

    pub fn database_config(&self) -> &DatabaseConfig {
        &self.config
    }

    pub fn path(&self) -> &Path {
        match &self.backend_state {
            DbBackendState::Sqlite { path, .. } => path,
            DbBackendState::Postgres => panic!("ServerDb::path() is only available on SQLite"),
        }
    }

    /// Writer pool (backward-compatible SQLite transition accessor).
    pub fn pool(&self) -> &SqlitePool {
        self.write_pool()
    }

    /// Multi-connection read-only WAL pool for concurrent pure read queries (SQLite transition).
    pub fn read_pool(&self) -> &SqlitePool {
        match &self.backend_state {
            DbBackendState::Sqlite { read_pool, .. } => read_pool,
            DbBackendState::Postgres => panic!("ServerDb::read_pool() is only available on SQLite; use read_conn()"),
        }
    }

    /// Single-connection read-write pool serializing SQLite mutations (SQLite transition).
    pub fn write_pool(&self) -> &SqlitePool {
        match &self.backend_state {
            DbBackendState::Sqlite { write_pool, .. } => write_pool,
            DbBackendState::Postgres => panic!("ServerDb::write_pool() is only available on SQLite; use write_conn()"),
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn acquire_write(&self) -> sqlx::Result<PoolConnection<Sqlite>> {
        self.write_pool().acquire().await
    }

    #[allow(dead_code)]
    pub(crate) async fn acquire_read_async(&self) -> sqlx::Result<PoolConnection<Sqlite>> {
        self.read_pool().acquire().await
    }

    pub(crate) fn acquire(&self) -> sqlx::Result<DbConn> {
        vibevalley_runtime::rt::block_on(self.write_pool().acquire()).map(|conn| DbConn(Some(conn)))
    }

    pub(crate) fn run<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        let write_pool = self.write_pool();
        vibevalley_runtime::rt::block_on(async {
            let mut conn = write_pool.acquire().await?;
            query(&mut conn).await
        })
    }

    pub(crate) fn run_api<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let write_pool = self.write_pool();
        vibevalley_runtime::rt::block_on(async {
            let mut conn = write_pool.acquire().await.map_err(internal)?;
            query(&mut conn).await
        })
    }

    #[allow(dead_code)]
    pub(crate) fn read<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        let read_pool = self.read_pool();
        vibevalley_runtime::rt::block_on(async {
            let mut conn = read_pool.acquire().await?;
            query(&mut conn).await
        })
    }

    #[allow(dead_code)]
    pub(crate) fn read_api<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let read_pool = self.read_pool();
        vibevalley_runtime::rt::block_on(async {
            let mut conn = read_pool.acquire().await.map_err(internal)?;
            query(&mut conn).await
        })
    }

    /// Returns the process-wide `durable::Store` handle backed by this `ServerDb`:
    /// uses the Wave 1–3 `SqliteStorage` transition bridge on SQLite (so un-migrated
    /// `modules/work/*` callers using `tx.connection()` keep working until Wave 3)
    /// and `Store::from_sea_orm_conns` on PostgreSQL.
    pub(crate) fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        let mut slot = self.durable.lock();
        if let Some(store) = slot.as_ref() {
            return Ok(store.clone());
        }
        let store = match &self.backend_state {
            DbBackendState::Sqlite { .. } => vibevalley_runtime::agent::durable::Store::from_sea_orm_conns(
                self.write_conn.clone(),
                Some(self.read_conn.clone()),
                vibevalley_runtime::agent::durable::now_ms,
            )?,
            DbBackendState::Postgres => {
                vibevalley_runtime::agent::durable::Store::from_sea_orm_conns(self.write_conn.clone(), None, vibevalley_runtime::agent::durable::now_ms)?
            }
        };
        *slot = Some(store.clone());
        Ok(store)
    }

    /// Coordinated async database shutdown: closes the durable store handle, then closes
    /// SQLite pools (with WAL `TRUNCATE` + `PRAGMA optimize`) or PostgreSQL pool.
    pub async fn close_async(&self) {
        if let Some(store) = self.durable.lock().take() {
            let _ = store.close();
        }
        match &self.backend_state {
            DbBackendState::Sqlite { read_pool, write_pool, .. } => {
                read_pool.close().await;
                if let Ok(mut conn) = write_pool.acquire().await {
                    let _ = sqlx::raw_sql("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;").execute(&mut *conn).await;
                }
                write_pool.close().await;
            }
            DbBackendState::Postgres => {
                let _ = self.write_conn.clone().close().await;
            }
        }
    }

    /// Coordinated database shutdown: closes the durable store handle, then closes
    /// SQLite pools (with WAL `TRUNCATE` + `PRAGMA optimize`) or PostgreSQL pool.
    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }
}

/// A cancelable background periodic ticker running blocking work on the Tokio pool.
pub(crate) struct Ticker {
    cancel: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

async fn run_ticker(cancel: tokio_util::sync::CancellationToken, interval: Duration, immediate: bool, mut tick: impl FnMut() -> bool + Send + 'static) {
    let period = if interval.is_zero() { Duration::from_millis(1) } else { interval };
    let mut timer = if immediate {
        tokio::time::interval(period)
    } else {
        tokio::time::interval_at(tokio::time::Instant::now() + period, period)
    };
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = timer.tick() => {}
        }
        if cancel.is_cancelled() {
            return;
        }
        let result = tokio::task::spawn_blocking(move || {
            let keep_going = tick();
            (tick, keep_going)
        })
        .await;
        let Ok((returned, true)) = result else { return };
        tick = returned;
    }
}

impl Ticker {
    pub(crate) fn spawn_on(hub: &crate::Hub, interval: Duration, immediate: bool, tick: impl FnMut() -> bool + Send + 'static) -> Self {
        let cancel = hub.child_token();
        let handle = hub.spawn_task(run_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) fn spawn_detached(interval: Duration, immediate: bool, tick: impl FnMut() -> bool + Send + 'static) -> Self {
        let cancel = tokio_util::sync::CancellationToken::new();
        let handle = vibevalley_runtime::rt::current_or_global_handle().spawn(run_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) async fn stop_async(self) {
        self.cancel.cancel();
        let _ = self.handle.await;
    }

    pub(crate) fn stop(self) {
        vibevalley_runtime::rt::block_on(self.stop_async());
    }
}

/// `lookIn`: a hint listing the ones there are, and the code a miss gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookIn {
    Issue,
    Session,
    Repo,
    Runtime,
    Agent,
    Skill,
    Template,
    Cron,
    Channel,
    Artifact,
    Library,
}

impl LookIn {
    fn parts(self) -> (&'static str, BizCode, Option<[&'static str; 2]>) {
        match self {
            LookIn::Issue => ("issue", BizCode::IssueNotFound, Some(["issue", "list"])),
            LookIn::Session => ("session", BizCode::SessionNotFound, Some(["session", "list"])),
            LookIn::Repo => ("repo", BizCode::RepoNotFound, Some(["repo", "list"])),
            LookIn::Runtime => ("runtime", BizCode::RuntimeNotFound, Some(["runtime", "list"])),
            LookIn::Agent => ("agent", BizCode::AgentNotFound, Some(["agent", "list"])),
            LookIn::Skill => ("skill", BizCode::AgentNotFound, None),
            LookIn::Template => ("template", BizCode::AgentNotFound, None),
            LookIn::Cron => ("cron", BizCode::CronNotFound, Some(["cron", "list"])),
            LookIn::Channel => ("channel", BizCode::ChannelNotFound, Some(["channel", "list"])),
            LookIn::Artifact => ("artifact", BizCode::ArtifactNotFound, Some(["artifact", "list"])),
            LookIn::Library => ("library", BizCode::LibraryNotFound, None),
        }
    }

    pub fn next(self) -> Next {
        let (key, _, run) = self.parts();
        let run = match self {
            LookIn::Library => Some(vec!["library".into(), "item".into(), "list".into()]),
            _ => run.map(|r| r.iter().map(|s| s.to_string()).collect()),
        };
        Next {
            say: t(&format!("server.lookIn.{key}"), &[]),
            run,
        }
    }
}

/// `missing(what, [lookIn.x])`.
pub fn missing(what: impl Into<String>, look: LookIn) -> ApiError {
    ApiError::new(look.parts().1, what.into()).with_next(vec![look.next()])
}

pub fn refused(code: BizCode, text: impl Into<String>) -> ApiError {
    ApiError::new(code, text.into())
}

pub fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, e.to_string())
}

const REQUEST_KEY_MAX: usize = 64;
const REQUEST_KEYS_KEPT: usize = 500;
const REQUEST_KEY_TTL_MS: i64 = 5 * 60_000;

/// `requestKeys`: a retry with the same key gets the first answer for five
/// minutes; a failure is forgotten.
pub struct RequestKeys<T> {
    seen: Mutex<Answered<T>>,
}

/// The keys oldest first, and each key's expiry and answer.
type Answered<T> = (Vec<String>, std::collections::HashMap<String, (i64, T)>);

impl<T> Default for RequestKeys<T> {
    fn default() -> Self {
        RequestKeys { seen: Mutex::default() }
    }
}

impl<T: Clone> RequestKeys<T> {
    pub fn once(&self, key: Option<&str>, work: impl FnOnce() -> Result<T, ApiError>) -> Result<T, ApiError> {
        let Some(key) = key.filter(|k| !k.is_empty()) else { return work() };
        if key.chars().count() > REQUEST_KEY_MAX {
            return Err(ApiError::new(
                BizCode::RequestKeyTooLong,
                t("server.base.requestKeyLong", &[("max", REQUEST_KEY_MAX.into())]),
            ));
        }
        // Held while working: a duplicate waits for the first answer.
        let mut seen = self.seen.lock();
        if let Some((expires, done)) = seen.1.get(key)
            && *expires > crate::now()
        {
            return Ok(done.clone());
        }
        let done = work()?;
        seen.0.retain(|k| k != key);
        seen.0.push(key.to_string());
        seen.1.insert(key.to_string(), (crate::now() + REQUEST_KEY_TTL_MS, done.clone()));
        while seen.0.len() > REQUEST_KEYS_KEPT {
            let old = seen.0.remove(0);
            seen.1.remove(&old);
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn concurrent_reads_succeed_immediately_while_write_pool_holds_begin_immediate() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();

        db.run(async |conn| {
            sqlx::raw_sql("INSERT INTO channel (id, type, is_default, name, created_at) VALUES ('c1', 'channel', 1, 'general', 100);")
                .execute(&mut *conn)
                .await
        })
        .unwrap();

        // Hold an open BEGIN IMMEDIATE write transaction with an uncommitted row.
        let mut writer = db.acquire().unwrap();
        vibevalley_runtime::rt::block_on(async {
            sqlx::raw_sql("BEGIN IMMEDIATE;").execute(&mut *writer).await.unwrap();
            sqlx::raw_sql("INSERT INTO channel (id, type, is_default, name, created_at) VALUES ('c2', 'channel', 0, 'pending', 200);")
                .execute(&mut *writer)
                .await
                .unwrap();
        });

        // Multiple concurrent read() calls must succeed immediately against the WAL snapshot
        // without blocking on the active write transaction or hitting SQLite busy_timeout.
        let started = Instant::now();
        let mut threads = Vec::new();
        for _ in 0..6 {
            let db = db.clone();
            threads.push(std::thread::spawn(move || {
                db.read(async |conn| {
                    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channel").fetch_one(&mut *conn).await?;
                    Ok(count)
                })
                .unwrap()
            }));
        }
        let counts: Vec<i64> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        let elapsed = started.elapsed();
        assert_eq!(counts, vec![1; 6], "readers must see committed WAL snapshot while writer holds BEGIN IMMEDIATE");
        assert!(
            elapsed < Duration::from_secs(1),
            "concurrent read_pool queries took too long while write tx open: {elapsed:?}"
        );

        // Verify read_pool enforces read_only(true).
        let write_on_read_pool = db.read(async |conn| {
            sqlx::raw_sql("INSERT INTO channel (id, type, is_default, name, created_at) VALUES ('c3', 'channel', 0, 'illegal', 300);")
                .execute(&mut *conn)
                .await
        });
        assert!(write_on_read_pool.is_err(), "read_pool must reject writes");

        // Commit the write transaction and release the write connection.
        vibevalley_runtime::rt::block_on(async {
            sqlx::raw_sql("COMMIT;").execute(&mut *writer).await.unwrap();
        });
        drop(writer);

        // New reads immediately see the committed write.
        let after: i64 = db
            .read(async |conn| sqlx::query_scalar("SELECT COUNT(*) FROM channel").fetch_one(&mut *conn).await)
            .unwrap();
        assert_eq!(after, 2);

        // Coordinated shutdown closes read_pool first, checkpoints WAL (TRUNCATE), and closes write_pool.
        db.close();
        drop(db);

        let reopened = ServerDb::open(dir.path()).unwrap();
        let persisted: i64 = reopened
            .read(async |conn| sqlx::query_scalar("SELECT COUNT(*) FROM channel").fetch_one(&mut *conn).await)
            .unwrap();
        assert_eq!(persisted, 2);
        reopened.close();
    }

    #[test]
    fn ticker_runs_on_interval_and_cancels_cleanly() {
        let count = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = flume::bounded(1);
        let c = count.clone();
        let ticker = Ticker::spawn_detached(Duration::from_millis(15), true, move || {
            let n = c.fetch_add(1, Ordering::SeqCst) + 1;
            if n >= 3 {
                let _ = done_tx.try_send(());
                return false;
            }
            true
        });
        done_rx.recv_timeout(Duration::from_secs(2)).expect("ticker fired 3 times");
        ticker.stop();
        assert!(count.load(Ordering::SeqCst) >= 3);
    }

    #[tokio::test(start_paused = true)]
    async fn ticker_advances_deterministically_over_virtual_minutes_and_stops_async() {
        let wall_start = Instant::now();
        let (tick_tx, mut tick_rx) = tokio::sync::mpsc::unbounded_channel();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let ticker = Ticker::spawn_detached(Duration::from_secs(60), false, move || {
            let n = c.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = tick_tx.send(n);
            true
        });

        tokio::task::yield_now().await;
        assert!(tick_rx.try_recv().is_err(), "non-immediate ticker must not fire at t=0");

        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert!(tick_rx.try_recv().is_err(), "ticker must not fire before 60s");

        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(tick_rx.recv().await, Some(1));

        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(tick_rx.recv().await, Some(2));

        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(tick_rx.recv().await, Some(3));

        ticker.stop_async().await;
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(
            wall_start.elapsed() < Duration::from_secs(1),
            "3 virtual minutes of Ticker ticks must finish instantaneously, took {:?}",
            wall_start.elapsed()
        );
    }

    #[test]
    fn async_acquire_write_and_read_helpers_work_inside_send_futures() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let db_task = db.clone();
        let count = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                let mut writer = db_task.acquire_write().await?;
                sqlx::raw_sql("INSERT INTO channel (id, type, is_default, name, created_at) VALUES ('async-c1', 'channel', 0, 'async', 100);")
                    .execute(&mut *writer)
                    .await?;
                drop(writer);

                let mut reader = db_task.acquire_read_async().await?;
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channel WHERE id = 'async-c1'")
                    .fetch_one(&mut *reader)
                    .await?;
                Ok::<_, sqlx::Error>(count)
            })
            .await
            .unwrap()
        })
        .unwrap();
        assert_eq!(count, 1);
        db.close();
    }

    #[test]
    fn concurrent_server_db_and_durable_writes_serialize_without_busy_or_deadlock() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let durable = db.durable().unwrap();

        let server_threads = 4;
        let durable_threads = 4;
        let reader_threads = 2;
        let ops_per_thread = 25;
        let barrier = Arc::new(std::sync::Barrier::new(server_threads + durable_threads + reader_threads));

        std::thread::scope(|scope| {
            for t in 0..server_threads {
                let db = db.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    for i in 0..ops_per_thread {
                        let id = format!("ch-{t}-{i}");
                        let name = format!("channel-{t}-{i}");
                        db.run(async move |conn| {
                            sqlx::raw_sql("BEGIN IMMEDIATE;").execute(&mut *conn).await?;
                            let res = sqlx::query("INSERT INTO channel (id, type, is_default, name, created_at) VALUES (?1, 'channel', 0, ?2, ?3)")
                                .bind(&id)
                                .bind(&name)
                                .bind((t * ops_per_thread + i) as i64)
                                .execute(&mut *conn)
                                .await;
                            match res {
                                Ok(_) => {
                                    sqlx::raw_sql("COMMIT;").execute(&mut *conn).await?;
                                    Ok(())
                                }
                                Err(err) => {
                                    let _ = sqlx::raw_sql("ROLLBACK;").execute(&mut *conn).await;
                                    Err(err)
                                }
                            }
                        })
                        .expect("ServerDb::run write must serialize cleanly without SQLITE_BUSY");
                    }
                });
            }

            for t in 0..durable_threads {
                let durable = durable.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    for i in 0..ops_per_thread {
                        let doc_id = format!("doc-{t}-{i}");
                        let payload = serde_json::json!({ "thread": t, "iter": i });
                        durable
                            .write(|tx| {
                                tx.put_document("stress", &doc_id, "item", &payload)?;
                                Ok(())
                            })
                            .expect("durable.write must serialize cleanly without SQLITE_BUSY");
                    }
                });
            }

            for _ in 0..reader_threads {
                let db = db.clone();
                let durable = durable.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..ops_per_thread {
                        let _: i64 = db
                            .read(async |conn| sqlx::query_scalar("SELECT COUNT(*) FROM channel").fetch_one(&mut *conn).await)
                            .expect("concurrent ServerDb::read must succeed");
                        let _ = durable
                            .read(|r| r.documents_by_kind("stress", "item"))
                            .expect("concurrent durable.read must succeed");
                    }
                });
            }
        });

        let channel_count: i64 = db
            .read(async |conn| sqlx::query_scalar("SELECT COUNT(*) FROM channel").fetch_one(&mut *conn).await)
            .unwrap();
        assert_eq!(channel_count, (server_threads * ops_per_thread) as i64);

        let durable_docs = durable.read(|r| r.documents_by_kind("stress", "item")).unwrap();
        assert_eq!(durable_docs.len(), durable_threads * ops_per_thread);

        // Writer connection must be released immediately after durable writes finish.
        let writer = db.acquire().expect("write_pool connection must not be starved by durable");
        drop(writer);

        db.close();
    }

    async fn verify_dual_db_core(db: &Arc<ServerDb>, expected_backend: DatabaseBackend) {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};

        use crate::db::entities::{
            collab_channel::{channel, channel_delivery, channel_event, channel_message, channel_participant},
            collab_connector::{connector_account, connector_inbound, connector_outbox},
            content_artifact::artifact,
            content_attachment::attachment,
            content_library::media_library_item,
            content_media::{media_input, media_input_pin, media_job},
            infra_remote::{remote_config, remote_device},
            team_memory::memory,
            work_cron::cron,
            work_issue::issue,
            work_pull::{pull, pull_event},
            work_session::{session, session_event, session_mailbox, session_run},
        };
        use crate::db::error::{is_fk_violation, is_unique_violation};
        use crate::db::next_seq_async;

        assert_eq!(db.backend(), expected_backend);
        assert_eq!(db.is_postgres(), expected_backend == DatabaseBackend::Postgres);

        let w = db.write_conn();
        let r = db.read_conn();

        assert_eq!(next_seq_async(w, "issue", 0).await.unwrap(), 1);
        assert_eq!(next_seq_async(w, "issue", 0).await.unwrap(), 2);
        assert_eq!(next_seq_async(w, "issue", 10).await.unwrap(), 11);
        assert_eq!(next_seq_async(w, "issue", 5).await.unwrap(), 12);

        let durable = db.durable().unwrap();
        durable
            .write(|tx| {
                tx.create_conversation("conv-core", "deepseek-flash")?;
                tx.append_entry("conv-core", "pi.user", &serde_json::json!({"text": "hi"}))?;
                tx.put_document("global", "core", "pi.state", &serde_json::json!({"ok": true}))?;
                Ok(())
            })
            .unwrap();
        let doc = durable.read(|rd| rd.document("global", "core", "pi.state")).unwrap().unwrap();
        assert_eq!(doc.state, serde_json::json!({"ok": true}));

        channel_participant::ActiveModel {
            id: Set("system".into()),
            kind: Set("system".into()),
            name: Set("System".into()),
            agent_id: Set(None),
            home_id: Set(None),
            joined_at: Set(100),
            left_at: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        channel::ActiveModel {
            id: Set("ch-1".into()),
            channel_type: Set("channel".into()),
            is_default: Set(true),
            root_id: Set(None),
            root_number: Set(None),
            subject_kind: Set(None),
            subject_id: Set(None),
            last_number: Set(Some(1)),
            reply_count: Set(0),
            created_at: Set(100),
            name: Set(Some("general".into())),
            description: Set(None),
            repo: Set(None),
            parent_id: Set(None),
            peer_id: Set(None),
            revision: Set(1),
            category: Set(None),
            position: Set(None),
            archived_at: Set(None),
            notify: Set("all".into()),
        }
        .insert(w)
        .await
        .unwrap();

        channel_message::ActiveModel {
            id: Set("m-1".into()),
            channel_id: Set("ch-1".into()),
            number: Set(1),
            sender_id: Set("system".into()),
            kind: Set("notice".into()),
            body: Set("hello".into()),
            meta: Set(Some(r#"{"code":"welcome"}"#.into())),
            system_code: Set(Some("welcome".into())),
            send_key: Set(Some("sk-1".into())),
            created_at: Set(101),
            revision: Set(1),
            reply_number: Set(None),
            edited_at: Set(None),
            deleted_at: Set(None),
            pinned_at: Set(None),
            reactions: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        let by_code = channel_message::Entity::find()
            .filter(channel_message::Column::ChannelId.eq("ch-1"))
            .filter(channel_message::Column::SystemCode.eq("welcome"))
            .one(r)
            .await
            .unwrap()
            .expect("message found by system_code");
        assert_eq!(by_code.id, "m-1");

        let ev = channel_event::ActiveModel {
            kind: Set("posted".into()),
            channel_id: Set("ch-1".into()),
            message_id: Set("m-1".into()),
            at: Set(101),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap();
        assert!(ev.seq > 0);

        let del = channel_delivery::ActiveModel {
            message_id: Set("m-1".into()),
            channel_id: Set("ch-1".into()),
            recipient_kind: Set("orchestrator".into()),
            recipient_id: Set("orch".into()),
            reason: Set("channel".into()),
            wakes: Set(true),
            held_by: Set(None),
            status: Set("pending".into()),
            created_at: Set(101),
            settled_at: Set(None),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap();
        assert!(del.id > 0);
        assert!(del.wakes);

        // Unique violation check via session_mailbox.idempotency_key
        let mb = session_mailbox::ActiveModel {
            session_id: Set("s-1".into()),
            idempotency_key: Set("idem-1".into()),
            source: Set("channel".into()),
            source_message_id: Set(Some("m-1".into())),
            payload: Set("{}".into()),
            status: Set("pending".into()),
            created_at: Set(100),
            updated_at: Set(100),
            result: Set(None),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap();
        assert!(mb.id > 0);

        let dup_mb = session_mailbox::ActiveModel {
            session_id: Set("s-1".into()),
            idempotency_key: Set("idem-1".into()),
            source: Set("channel".into()),
            source_message_id: Set(None),
            payload: Set("{}".into()),
            status: Set("pending".into()),
            created_at: Set(101),
            updated_at: Set(101),
            result: Set(None),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap_err();
        assert!(is_unique_violation(&dup_mb), "expected unique violation, got {dup_mb:?}");

        // FK violation check via cron.issue_id -> issue.id
        let fk_err = cron::ActiveModel {
            id: Set("cron-bad".into()),
            name: Set("bad".into()),
            body: Set("ping".into()),
            channel_id: Set("ch-1".into()),
            agent: Set(None),
            repo: Set(None),
            issue_id: Set(Some("missing-issue".into())),
            spec: Set("* * * * *".into()),
            tz: Set("UTC".into()),
            enabled: Set(true),
            created_at: Set(100),
            last_run: Set(None),
            set_by: Set("user".into()),
            pending: Set(false),
        }
        .insert(w)
        .await
        .unwrap_err();
        assert!(is_fk_violation(&fk_err), "expected fk violation, got {fk_err:?}");

        // Touch remaining domain entity models to confirm schema parity across backends.
        issue::ActiveModel {
            id: Set("iss-1".into()),
            number: Set(1),
            title: Set("t".into()),
            description: Set("d".into()),
            repo: Set(None),
            machine_id: Set(None),
            priority: Set("medium".into()),
            rank: Set(None),
            deliver: Set("merge".into()),
            parent: Set(None),
            created_at: Set(100),
            queued_at: Set(None),
            closed_at: Set(None),
            reviewed_at: Set(None),
            canceled: Set(None),
            delivered: Set(None),
            mandate: Set("{}".into()),
            constraints: Set(None),
            conflict: Set(None),
            last_run: Set(None),
            answer: Set(None),
            delivery_evidence: Set(None),
            queued_words: Set("[]".into()),
            blocked_by: Set("[]".into()),
            criteria: Set("[]".into()),
            checks: Set("[]".into()),
            findings: Set("[]".into()),
            questions: Set("[]".into()),
            assignments: Set("[]".into()),
        }
        .insert(w)
        .await
        .unwrap();

        session::ActiveModel {
            id: Set("s-1".into()),
            controller: Set("issue".into()),
            role: Set(None),
            name: Set("worker".into()),
            profile: Set(None),
            runtime: Set("scripted".into()),
            brief: Set("b".into()),
            cwd: Set(None),
            policy: Set("{}".into()),
            bindings: Set("{}".into()),
            hired_at: Set(100),
            runs: Set(0),
            last_run: Set(None),
            spent: Set(None),
            tool_connections: Set(None),
            machine: Set(None),
            phase: Set("idle".into()),
            departed: Set(false),
            title: Set(None),
            model: Set(None),
            effort: Set(None),
            permission_mode: Set(None),
            agent_session: Set(None),
            base: Set(None),
            run: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        session_run::ActiveModel {
            id: Set("r1".into()),
            session: Set("s-1".into()),
            issue: Set(Some("iss-1".into())),
            triggered_by: Set("user".into()),
            heard: Set("hi".into()),
            started_at: Set(100),
            ended_at: Set(None),
            outcome: Set(None),
            summary: Set("".into()),
            spent: Set(None),
            subagent_summary: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        session_event::ActiveModel {
            session_id: Set("s-1".into()),
            seq: Set(0),
            run_id: Set(Some("r1".into())),
            payload: Set("{}".into()),
        }
        .insert(w)
        .await
        .unwrap();

        pull::ActiveModel {
            id: Set("p-1".into()),
            platform: Set("github".into()),
            repo: Set("o/r".into()),
            number: Set(42),
            url: Set("https://github.com/o/r/pull/42".into()),
            branch: Set("b".into()),
            base: Set("main".into()),
            state: Set("open".into()),
            issue_id: Set(Some("iss-1".into())),
            check_fingerprint: Set("".into()),
            check_revision: Set(0),
            created_at: Set(100),
            updated_at: Set(100),
        }
        .insert(w)
        .await
        .unwrap();

        pull_event::ActiveModel {
            pull_id: Set("p-1".into()),
            key: Set("k1".into()),
            bot_round_key: Set(None),
            bot_round: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        connector_account::ActiveModel {
            connector: Set("qq".into()),
            secrets: Set("{}".into()),
            user_id: Set(None),
            pair_code: Set(None),
            cursor: Set("".into()),
            reply_context: Set(None),
            last_inbound: Set(None),
            paused_until: Set(None),
            connected_at: Set(100),
            channel_id: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        let inb = connector_inbound::ActiveModel {
            connector: Set("qq".into()),
            ext_id: Set("e1".into()),
            from_id: Set("u1".into()),
            body: Set("hi".into()),
            reply: Set("{}".into()),
            quoted: Set("{}".into()),
            message_id: Set(None),
            created_at: Set(100),
            delivered: Set(false),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap();
        assert!(inb.seq > 0);

        let outb = connector_outbox::ActiveModel {
            connector: Set("qq".into()),
            message_id: Set("m-1".into()),
            body: Set("yo".into()),
            state: Set("pending".into()),
            ext_id: Set(None),
            error: Set(None),
            created_at: Set(100),
            sent_at: Set(None),
            ..Default::default()
        }
        .insert(w)
        .await
        .unwrap();
        assert!(outb.seq > 0);

        attachment::ActiveModel {
            id: Set("att-1".into()),
            name: Set("a.png".into()),
            content_type: Set("image/png".into()),
            size: Set(12),
            created_at: Set(100),
        }
        .insert(w)
        .await
        .unwrap();

        media_library_item::ActiveModel {
            attachment_id: Set("att-1".into()),
            kind: Set("uploaded".into()),
            origin: Set("{}".into()),
            added_at: Set(100),
            last_at: Set(100),
            source_job_id: Set(None),
            removed_at: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        media_input::ActiveModel {
            id: Set("mi-1".into()),
            metadata: Set("{}".into()),
            size: Set(12),
            phase: Set("ready".into()),
            hash: Set(None),
            created_at: Set(100),
            expires_at: Set(200),
        }
        .insert(w)
        .await
        .unwrap();

        media_input_pin::ActiveModel {
            input_id: Set("mi-1".into()),
            holder: Set("h1".into()),
        }
        .insert(w)
        .await
        .unwrap();

        media_job::ActiveModel {
            id: Set("mj-1".into()),
            kind: Set("image".into()),
            phase: Set("queued".into()),
            data: Set("{}".into()),
            created_at: Set(100),
            updated_at: Set(100),
        }
        .insert(w)
        .await
        .unwrap();

        artifact::ActiveModel {
            id: Set("art-1".into()),
            title: Set("Doc".into()),
            body: Set("blocks".into()),
            artifact_type: Set(Some("docs".into())),
            is_default: Set(false),
            display: Set(None),
            channel_id: Set(Some("ch-1".into())),
            message_id: Set(None),
            issue: Set(Some("iss-1".into())),
            by_id: Set("user".into()),
            by_name: Set("User".into()),
            version: Set(1),
            seq: Set(0),
            created_at: Set(100),
            updated_at: Set(100),
        }
        .insert(w)
        .await
        .unwrap();

        memory::ActiveModel {
            id: Set("mem-1".into()),
            agent: Set("laozhou".into()),
            kind: Set("note".into()),
            body: Set("remember".into()),
            repo: Set(None),
            session: Set(None),
            author: Set("user".into()),
            created_at: Set(100),
            updated_at: Set(100),
            recalled: Set(0),
            recalled_at: Set(None),
        }
        .insert(w)
        .await
        .unwrap();

        remote_config::ActiveModel {
            id: Set(1),
            enabled: Set(false),
            bind_addr: Set(None),
            port: Set(8791),
            updated_at: Set(100),
        }
        .insert(w)
        .await
        .unwrap();

        remote_device::ActiveModel {
            id: Set("dev-1".into()),
            name: Set("iPhone".into()),
            platform: Set("ios".into()),
            token_hash: Set("hash-1".into()),
            scope: Set("full".into()),
            created_at: Set(100),
            last_seen_at: Set(None),
            revoked_at: Set(None),
        }
        .insert(w)
        .await
        .unwrap();
    }

    #[test]
    fn database_config_from_url_parses_and_redacts_passwords() {
        let pg = DatabaseConfig::from_url("postgres://admin:supersecret@127.0.0.1:5432/vibevalley").unwrap();
        let dbg = format!("{pg:?}");
        assert!(!dbg.contains("supersecret"), "Debug must redact password: {dbg}");
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
    fn sqlite_open_url_migrates_server_and_durable_schemas_and_runs_core_ops() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("core.db");
        let url = format!("sqlite://{}", db_path.display());

        let db = ServerDb::open_url(&url).unwrap();
        assert_eq!(db.path(), db_path);
        vibevalley_runtime::rt::block_on(verify_dual_db_core(&db, DatabaseBackend::Sqlite));
        db.close();
        drop(db);

        // Reopen idempotently with ServerDb::open_config.
        let reopened = ServerDb::open_config(&DatabaseConfig::Sqlite { path: db_path }).unwrap();
        assert_eq!(
            vibevalley_runtime::rt::block_on(crate::db::next_seq_async(reopened.write_conn(), "issue", 0)).unwrap(),
            13
        );
        reopened.close();
    }

    struct EphemeralPostgres {
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        port: u16,
        _temp: tempfile::TempDir,
    }

    impl EphemeralPostgres {
        fn start() -> Option<Self> {
            let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;
            let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;

            let temp = tempfile::tempdir().ok()?;
            let data_dir = temp.path().join("pgdata");
            let sock_dir = temp.path().join("sock");
            std::fs::create_dir_all(&sock_dir).ok()?;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            drop(listener);

            let init = std::process::Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
                .output()
                .ok()?;
            assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

            use std::io::Write;
            let conf = format!(
                "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
                sock_dir.display()
            );
            std::fs::OpenOptions::new()
                .append(true)
                .open(data_dir.join("postgresql.conf"))
                .unwrap()
                .write_all(conf.as_bytes())
                .unwrap();

            let log = temp.path().join("postgres.log");
            let start = std::process::Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log)
                .args(["-w", "start"])
                .output()
                .ok()?;
            assert!(
                start.status.success(),
                "pg_ctl start failed: {}\nlog:\n{}",
                String::from_utf8_lossy(&start.stderr),
                std::fs::read_to_string(&log).unwrap_or_default()
            );

            Some(Self {
                data_dir,
                pg_ctl,
                port,
                _temp: temp,
            })
        }

        fn create_database(&self, db_name: &str) {
            let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
            let name = db_name.to_owned();
            vibevalley_runtime::rt::block_on(async move {
                let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
                db.execute_unprepared(&format!("CREATE DATABASE \"{name}\""))
                    .await
                    .expect("create test database");
                db.close().await.expect("close admin db");
            });
        }

        fn db_url(&self, db_name: &str) -> String {
            format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
        }
    }

    impl Drop for EphemeralPostgres {
        fn drop(&mut self) {
            let _ = std::process::Command::new(&self.pg_ctl)
                .arg("-D")
                .arg(&self.data_dir)
                .args(["-m", "immediate", "-w", "stop"])
                .output();
        }
    }

    #[test]
    fn postgres_open_url_migrates_server_and_durable_schemas_and_runs_core_ops() {
        let Some(pg) = EphemeralPostgres::start() else {
            eprintln!("skipping postgres_open_url_migrates_server_and_durable_schemas_and_runs_core_ops: initdb/pg_ctl not found");
            return;
        };
        pg.create_database("server_core_wave2");
        let url = pg.db_url("server_core_wave2");

        let db = ServerDb::open_url(&url).unwrap();
        vibevalley_runtime::rt::block_on(verify_dual_db_core(&db, DatabaseBackend::Postgres));
        db.close();
        drop(db);

        // Reopen idempotently with ServerDb::open_config and confirm both migration tables coexist.
        let reopened = ServerDb::open_config(&DatabaseConfig::Postgres { url, max_connections: 8 }).unwrap();
        assert_eq!(
            vibevalley_runtime::rt::block_on(crate::db::next_seq_async(reopened.write_conn(), "issue", 0)).unwrap(),
            13
        );
        let durable = reopened.durable().unwrap();
        let doc = durable.read(|rd| rd.document("global", "core", "pi.state")).unwrap().unwrap();
        assert_eq!(doc.state, serde_json::json!({"ok": true}));
        reopened.close();
    }
}
