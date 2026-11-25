//! Low-level dual-backend database layer (SQLite + PostgreSQL):
//! connection pools ([`Database`]), schema migrations (`migration/`),
//! one-table-per-file SeaORM entities (`entity/`), column serialization helpers,
//! opaque errors ([`DbError`]), and transaction handle ([`Tx`]).
//!
//! Business-oriented data operations live in `crate::service::Service`.
//! No module outside `crate::db` and `crate::service` imports `sea_orm::` or `db::entity`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database as SeaDatabase, DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr, SqliteTransactionMode,
    SqlxSqliteConnector, TransactionOptions, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use vibevalley_core::SliceMask;

pub(crate) mod column;
pub(crate) mod entity;
pub mod error;
pub mod migration;
pub mod verify;

pub use error::{DbError, DbResult, internal_db};
pub use verify::{SchemaMismatchReport, TableDrift};

/// Active database write transaction passed to `*_in_tx` methods on `crate::service::Service` sub-services.
pub type Tx = DatabaseTransaction;

/// Boxed `Send` future used by transaction callbacks.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const READ_POOL_MAX_CONNECTIONS: u32 = 6;
const WRITE_POOL_MAX_CONNECTIONS: u32 = 1;
const DEFAULT_POSTGRES_MAX_CONNECTIONS: u32 = 16;

/// Database engine backing a [`Database`] instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbBackend {
    Sqlite,
    Postgres,
}

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

fn parse_sqlite_url(url: &str) -> DbResult<PathBuf> {
    let raw = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .ok_or_else(|| DbError::custom("expected sqlite: database URL"))?;
    let path_part = raw.split('?').next().unwrap_or(raw);
    if path_part.is_empty() || path_part == ":memory:" {
        return Err(DbError::custom("sqlite URL must reference a database file path"));
    }
    Ok(PathBuf::from(path_part))
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
    pub fn from_url(url: &str) -> DbResult<Self> {
        let trimmed = url.trim();
        if trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://") {
            let _ = url::Url::parse(trimmed).map_err(|e| DbError::custom(format!("invalid postgres URL ({}): {e}", redact_db_url(trimmed))))?;
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
        Err(DbError::custom(format!("unsupported database URL scheme: {}", redact_db_url(trimmed))))
    }
}

enum DbBackendState {
    Sqlite { path: PathBuf },
    Postgres,
}

/// Single shared dual-backend database handle:
/// - On SQLite: split WAL-mode pools (`write_pool` max=1, `read_pool` max=6 read-only)
///   wrapped into SeaORM `DatabaseConnection`s via `SqlxSqliteConnector`.
/// - On PostgreSQL: pooled SeaORM `DatabaseConnection` shared by readers and writers.
pub struct Database {
    config: DatabaseConfig,
    backend_state: DbBackendState,
    read_conn: DatabaseConnection,
    write_conn: DatabaseConnection,
    durable: Mutex<Option<vibevalley_runtime::agent::durable::Store>>,
}

async fn run_migrations_and_verify(conn: &DatabaseConnection, backend: DbBackend, db_path: Option<&Path>) -> DbResult<()> {
    tracing::info!(backend = ?backend, path = ?db_path, "running database migrations");
    crate::db::migration::Migrator::up(conn, None).await?;
    vibevalley_runtime::agent::durable::migration::Migrator::up(conn, None).await?;

    if let Err(err) = verify::verify_schema(conn, backend, db_path).await {
        if let Some(report) = err.schema_mismatch() {
            tracing::error!(backend = ?backend, detail = %report.format_detail(), "post-migration database schema verification failed");
        }
        return Err(err);
    }
    Ok(())
}

impl Database {
    /// Opens `<home>/server.db` with split read/write connections and runs all migrations.
    pub async fn open(home: &Path) -> DbResult<Arc<Self>> {
        Self::open_at(&home.join("server.db")).await
    }

    /// Opens `path` with split read/write connections and runs all migrations.
    pub async fn open_at(path: &Path) -> DbResult<Arc<Self>> {
        Self::open_config(&DatabaseConfig::Sqlite { path: path.to_path_buf() }).await
    }

    /// Opens a SQLite or PostgreSQL database from a URL (`sqlite:...`, `postgres://...`, `postgresql://...`).
    pub async fn open_url(url: &str) -> DbResult<Arc<Self>> {
        let config = DatabaseConfig::from_url(url)?;
        Self::open_config(&config).await
    }

    /// Opens a SQLite or PostgreSQL database from [`DatabaseConfig`] and runs server and durable migrations.
    pub async fn open_config(config: &DatabaseConfig) -> DbResult<Arc<Self>> {
        let config_owned = config.clone();
        if let DatabaseConfig::Sqlite { path } = &config_owned
            && let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        let (backend_state, read_conn, write_conn) = match &config_owned {
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
                let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool);
                run_migrations_and_verify(&write_conn, DbBackend::Sqlite, Some(path.as_path())).await?;

                let read_options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(Duration::from_secs(5));
                let read_pool = SqlitePoolOptions::new()
                    .max_connections(READ_POOL_MAX_CONNECTIONS)
                    .min_connections(1)
                    .connect_with(read_options)
                    .await
                    .map_err(|e| DbErr::Conn(sea_orm::RuntimeErr::SqlxError(Arc::new(e))))?;
                let read_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool);

                (DbBackendState::Sqlite { path: path.clone() }, read_conn, write_conn)
            }
            DatabaseConfig::Postgres { url, max_connections } => {
                let mut opts = ConnectOptions::new(url);
                opts.max_connections((*max_connections).max(1)).sqlx_logging(false);
                let conn = SeaDatabase::connect(opts).await.inspect_err(|err| {
                    tracing::error!(url = %redact_db_url(url), error = %err, "failed to connect to postgres database");
                })?;
                run_migrations_and_verify(&conn, DbBackend::Postgres, None).await?;
                (DbBackendState::Postgres, conn.clone(), conn)
            }
        };

        Ok(Arc::new(Self {
            config: config_owned,
            backend_state,
            read_conn,
            write_conn,
            durable: Mutex::new(None),
        }))
    }

    pub(crate) fn write_conn(&self) -> &DatabaseConnection {
        &self.write_conn
    }

    pub(crate) fn read_conn(&self) -> &DatabaseConnection {
        &self.read_conn
    }

    pub fn backend(&self) -> DbBackend {
        match self.write_conn.get_database_backend() {
            DatabaseBackend::Postgres => DbBackend::Postgres,
            _ => DbBackend::Sqlite,
        }
    }

    pub fn is_postgres(&self) -> bool {
        matches!(self.config, DatabaseConfig::Postgres { .. })
    }

    pub fn database_config(&self) -> &DatabaseConfig {
        &self.config
    }

    pub fn path(&self) -> Option<&Path> {
        match &self.backend_state {
            DbBackendState::Sqlite { path } => Some(path.as_path()),
            DbBackendState::Postgres => None,
        }
    }

    /// Returns the process-wide `durable::Store` handle backed by this [`Database`]
    /// via `Store::from_sea_orm_conns`.
    pub async fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        if let Some(store) = self.durable.lock().clone() {
            return Ok(store);
        }
        let store = match &self.backend_state {
            DbBackendState::Sqlite { .. } => {
                vibevalley_runtime::agent::durable::Store::from_sea_orm_conns(
                    self.write_conn.clone(),
                    Some(self.read_conn.clone()),
                    vibevalley_runtime::agent::durable::now_ms,
                )
                .await?
            }
            DbBackendState::Postgres => {
                vibevalley_runtime::agent::durable::Store::from_sea_orm_conns(self.write_conn.clone(), None, vibevalley_runtime::agent::durable::now_ms).await?
            }
        };
        let mut slot = self.durable.lock();
        if let Some(existing) = slot.as_ref() {
            return Ok(existing.clone());
        }
        *slot = Some(store.clone());
        Ok(store)
    }

    /// Coordinated async database shutdown: closes the durable store handle, then closes
    /// SQLite connections (with WAL `TRUNCATE` + `PRAGMA optimize`) or the PostgreSQL pool.
    pub async fn close(&self) {
        let store = self.durable.lock().take();
        if let Some(store) = store {
            let _ = store.close().await;
        }
        match &self.backend_state {
            DbBackendState::Sqlite { .. } => {
                let _ = self.read_conn.clone().close().await;
                let _ = self.write_conn.execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;").await;
                let _ = self.write_conn.clone().close().await;
            }
            DbBackendState::Postgres => {
                let _ = self.write_conn.clone().close().await;
            }
        }
    }

    /// Alias for [`Self::close`].
    pub async fn close_async(&self) {
        self.close().await;
    }

    /// Opens an explicit write transaction (`BEGIN IMMEDIATE` on SQLite).
    pub async fn begin_tx(&self) -> DbResult<Tx> {
        begin_write_tx(&self.write_conn).await
    }

    /// Runs an async write transaction, committing on `Ok` and rolling back on `Err`.
    pub async fn transaction<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<T, E>> + Send) -> Result<T, E>
    where
        E: From<DbError>,
    {
        self.transaction_with(E::from, f).await
    }

    /// Runs an async write transaction like [`Self::transaction`] with an explicit [`DbError`] mapper.
    pub async fn transaction_with<T, E>(
        &self,
        mut map_err: impl FnMut(DbError) -> E,
        f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<T, E>> + Send,
    ) -> Result<T, E> {
        let tx = begin_write_tx(&self.write_conn).await.map_err(&mut map_err)?;
        match f(&tx).await {
            Ok(val) => {
                commit_tx(tx).await.map_err(map_err)?;
                Ok(val)
            }
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    /// Runs an async write transaction whose closure returns `(T, SliceMask)`.
    /// Commits only on `Ok` and rolls back on `Err`, guaranteeing dirty slice masks are
    /// never surfaced from a failed or rolled-back transaction.
    pub async fn write_dirty<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send) -> Result<(T, SliceMask), E>
    where
        E: From<DbError>,
    {
        self.write_dirty_with(E::from, f).await
    }

    /// Runs an async write transaction like [`Self::write_dirty`] with an explicit [`DbError`] mapper.
    pub async fn write_dirty_with<T, E>(
        &self,
        mut map_err: impl FnMut(DbError) -> E,
        f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send,
    ) -> Result<(T, SliceMask), E> {
        let tx = begin_write_tx(&self.write_conn).await.map_err(&mut map_err)?;
        match f(&tx).await {
            Ok((val, dirty)) => {
                commit_tx(tx).await.map_err(map_err)?;
                Ok((val, dirty))
            }
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    /// Atomically allocates the next monotonic counter value strictly above `at_least`.
    pub async fn next_seq(&self, name: &str, at_least: i64) -> DbResult<i64> {
        next_seq_impl(&self.write_conn, name, at_least).await
    }

    /// Atomically allocates the next monotonic counter value strictly above `at_least` inside `tx`.
    pub async fn next_seq_in_tx(&self, tx: &Tx, name: &str, at_least: i64) -> DbResult<i64> {
        next_seq_impl(tx, name, at_least).await
    }
}

/// Commits an explicit [`Tx`] opened via [`Database::begin_tx`].
pub async fn commit_tx(tx: Tx) -> DbResult<()> {
    tx.commit().await.map_err(DbError::from)
}

/// Rolls back an explicit [`Tx`] opened via [`Database::begin_tx`].
pub async fn rollback_tx(tx: Tx) -> DbResult<()> {
    tx.rollback().await.map_err(DbError::from)
}

async fn next_seq_impl(db: &impl ConnectionTrait, name: &str, at_least: i64) -> DbResult<i64> {
    use sea_orm::sea_query::{Expr, OnConflict};
    use sea_orm::{ActiveValue::Set, EntityTrait, ExprTrait};

    let model = entity::seq_counter::ActiveModel {
        name: Set(name.to_owned()),
        last_number: Set(at_least + 1),
    };
    let current = Expr::col((entity::seq_counter::Entity, entity::seq_counter::Column::LastNumber));
    let next_expr = Expr::expr(Expr::case(current.clone().gt(at_least), current).finally(at_least)).add(1);
    let on_conflict = OnConflict::column(entity::seq_counter::Column::Name)
        .value(entity::seq_counter::Column::LastNumber, next_expr)
        .to_owned();
    let saved = entity::seq_counter::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_with_returning(db)
        .await?;
    Ok(saved.last_number)
}

/// Opens a write transaction, using `BEGIN IMMEDIATE` on SQLite so writers serialize at begin.
pub(crate) async fn begin_write_tx(conn: &DatabaseConnection) -> DbResult<Tx> {
    let opts = match conn.get_database_backend() {
        DatabaseBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await.map_err(DbError::from)
}

#[cfg(test)]
pub(crate) mod test_pg {
    use std::io::Write;
    use std::path::PathBuf;

    use sea_orm::{ConnectionTrait, Database};

    pub(crate) struct EphemeralPostgres {
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        port: u16,
        _temp: tempfile::TempDir,
    }

    impl EphemeralPostgres {
        pub(crate) fn start() -> Option<Self> {
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

        pub(crate) async fn create_database(&self, db_name: &str) {
            let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
            let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
            db.execute_unprepared(&format!("CREATE DATABASE \"{db_name}\""))
                .await
                .expect("create test database");
            db.close().await.expect("close admin db");
        }

        pub(crate) fn db_url(&self, db_name: &str) -> String {
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
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, PaginatorTrait};

    use super::*;

    fn make_channel(id: &str, name: &str, default: bool, created_at: i64) -> entity::channel::ActiveModel {
        entity::channel::ActiveModel {
            id: Set(id.into()),
            channel_type: Set("channel".into()),
            is_default: Set(default),
            root_id: Set(None),
            root_number: Set(None),
            subject_kind: Set(None),
            subject_id: Set(None),
            last_number: Set(None),
            reply_count: Set(0),
            created_at: Set(created_at),
            name: Set(Some(name.into())),
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
    }

    #[tokio::test]
    async fn concurrent_reads_succeed_immediately_while_write_tx_holds_begin_immediate() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap();

        make_channel("c1", "general", true, 100).insert(db.write_conn()).await.unwrap();

        let write_tx = db.begin_tx().await.unwrap();
        make_channel("c2", "pending", false, 200).insert(&write_tx).await.unwrap();

        let started = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let db = db.clone();
            tasks.push(tokio::spawn(
                async move { entity::channel::Entity::find().count(db.read_conn()).await.unwrap() },
            ));
        }
        let mut counts = Vec::new();
        for task in tasks {
            counts.push(task.await.unwrap());
        }
        let elapsed = started.elapsed();
        assert_eq!(counts, vec![1; 6], "readers must see committed WAL snapshot while writer holds BEGIN IMMEDIATE");
        assert!(
            elapsed < Duration::from_secs(1),
            "concurrent reads took too long while write tx open: {elapsed:?}"
        );

        let write_on_read = make_channel("c3", "illegal", false, 300).insert(db.read_conn()).await;
        assert!(write_on_read.is_err(), "read_conn must reject writes");

        commit_tx(write_tx).await.unwrap();
        assert_eq!(entity::channel::Entity::find().count(db.read_conn()).await.unwrap(), 2);

        db.close().await;
        drop(db);

        let reopened = Database::open(dir.path()).await.unwrap();
        assert_eq!(entity::channel::Entity::find().count(reopened.read_conn()).await.unwrap(), 2);
        reopened.close().await;
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

    #[tokio::test]
    async fn sqlite_open_url_migrates_and_allocates_monotonic_sequences() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("core.db");
        let url = format!("sqlite://{}", db_path.display());

        let db = Database::open_url(&url).await.unwrap();
        assert_eq!(db.backend(), DbBackend::Sqlite);
        assert!(!db.is_postgres());
        assert_eq!(db.path(), Some(db_path.as_path()));

        assert_eq!(db.next_seq("issue", 0).await.unwrap(), 1);
        assert_eq!(db.next_seq("issue", 0).await.unwrap(), 2);
        assert_eq!(db.next_seq("issue", 10).await.unwrap(), 11);
        assert_eq!(db.next_seq("issue", 5).await.unwrap(), 12);

        db.close().await;
        drop(db);

        let reopened = Database::open_config(&DatabaseConfig::Sqlite { path: db_path }).await.unwrap();
        assert_eq!(reopened.next_seq("issue", 0).await.unwrap(), 13);
        reopened.close().await;
    }
}
