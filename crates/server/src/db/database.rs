use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction, SqliteTransactionMode, SqlxSqliteConnector, Statement, TransactionOptions,
    TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use tokio_util::sync::CancellationToken;
use vibevalley_core::SliceMask;
pub use vibevalley_kit::db::engine::{
    DEFAULT_POSTGRES_ACQUIRE_TIMEOUT, DEFAULT_POSTGRES_IDLE_TIMEOUT, DEFAULT_POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_LIFETIME,
    DEFAULT_POSTGRES_MIN_CONNECTIONS, DatabaseConfig,
};
use vibevalley_kit::db::engine::{SqlPool, SqlitePoolConfig, connect_sqlite_pool, redact_db_url};
use vibevalley_kit::db::seq::{DEFAULT_SEQ_TABLE, SeqAllocator, next_seq_sql};
use vibevalley_kit::db::tx::PostCommitHooks;
use vibevalley_kit::queue::outbox::{DEFAULT_OUTBOX_TABLE, OutboxLeaseMode, SqlOutbox};

use super::{DbBackend, DbError, DbResult, QueryMetrics, migration, verify};

/// Active database write transaction passed to `*_in_tx` methods on `crate::service::Service` sub-services.
pub type Tx = DatabaseTransaction;

/// Boxed `Send` future used by transaction callbacks.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const READ_POOL_MAX_CONNECTIONS: u32 = 6;
const SQLITE_OPTIMIZE_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

enum DbBackendState {
    Sqlite {
        path: PathBuf,
    },
    #[cfg(feature = "postgres")]
    Postgres,
}

/// Single shared dual-backend database handle:
/// - On SQLite: split WAL-mode pools built by `vibevalley_kit::db::engine` (`write_pool` max=1,
///   `read_pool` max=6 read-only) wrapped into SeaORM `DatabaseConnection`s via `SqlxSqliteConnector`.
/// - On PostgreSQL: pooled connection built by `vibevalley_kit::db::engine` wrapped via `SqlxPostgresConnector`.
/// - Mechanism tables (`seq_counter`, `outbox_item`) run directly on `kit::db::seq::SeqAllocator`
///   and `kit::queue::outbox::SqlOutbox` with zero ORM entities.
pub struct Database {
    config: DatabaseConfig,
    backend_state: DbBackendState,
    read_conn: DatabaseConnection,
    write_conn: DatabaseConnection,
    seq: SeqAllocator,
    sql_outbox: SqlOutbox,
    durable: Mutex<Option<vibevalley_runtime::agent::durable::Store>>,
    metrics: Arc<QueryMetrics>,
    optimize_cancel: CancellationToken,
    optimize_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

async fn run_migrations_and_verify(conn: &DatabaseConnection, backend: DbBackend, db_path: Option<&Path>) -> DbResult<()> {
    tracing::info!(backend = ?backend, path = ?db_path, "running database migrations");
    migration::Migrator::up(conn, None).await?;
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

        let (backend_state, read_conn, write_conn, write_sql_pool, read_sql_pool) = match &config_owned {
            DatabaseConfig::Sqlite { path } => {
                let write_cfg = SqlitePoolConfig::writer(path).with_server_pragmas();
                let write_pool = connect_sqlite_pool(&write_cfg).await?;
                let write_sql_pool = SqlPool::Sqlite(write_pool.clone());
                let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool);
                run_migrations_and_verify(&write_conn, DbBackend::Sqlite, Some(path.as_path())).await?;
                let _ = write_conn.execute_unprepared("PRAGMA optimize(0x10002);").await;

                let read_cfg = SqlitePoolConfig::reader(path, READ_POOL_MAX_CONNECTIONS).with_server_pragmas();
                let read_pool = connect_sqlite_pool(&read_cfg).await?;
                let read_sql_pool = SqlPool::Sqlite(read_pool.clone());
                let read_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool);

                (
                    DbBackendState::Sqlite { path: path.clone() },
                    read_conn,
                    write_conn,
                    write_sql_pool,
                    read_sql_pool,
                )
            }
            DatabaseConfig::Postgres {
                url,
                max_connections,
                min_connections,
                acquire_timeout,
                idle_timeout,
                max_lifetime,
            } => {
                #[cfg(feature = "postgres")]
                {
                    use vibevalley_kit::db::engine::{PostgresPoolConfig, connect_postgres_pool};
                    use vibevalley_kit::db::telemetry::DEFAULT_SLOW_QUERY_THRESHOLD;

                    let pg_cfg = PostgresPoolConfig {
                        url: url.clone(),
                        max_connections: *max_connections,
                        min_connections: *min_connections,
                        acquire_timeout: *acquire_timeout,
                        idle_timeout: *idle_timeout,
                        max_lifetime: *max_lifetime,
                        slow_query_threshold: Some(DEFAULT_SLOW_QUERY_THRESHOLD),
                    };
                    let pg_pool = connect_postgres_pool(&pg_cfg).await.inspect_err(|err| {
                        tracing::error!(url = %redact_db_url(url), error = %err, "failed to connect to postgres database");
                    })?;
                    let sql_pool = SqlPool::Postgres(pg_pool.clone());
                    let conn = sea_orm::SqlxPostgresConnector::from_sqlx_postgres_pool(pg_pool);
                    run_migrations_and_verify(&conn, DbBackend::Postgres, None).await?;
                    (DbBackendState::Postgres, conn.clone(), conn, sql_pool.clone(), sql_pool)
                }
                #[cfg(not(feature = "postgres"))]
                {
                    let _ = (max_connections, min_connections, acquire_timeout, idle_timeout, max_lifetime);
                    return Err(DbError::custom(format!("postgres feature is not enabled for {}", redact_db_url(url))));
                }
            }
        };

        let seq = SeqAllocator::new(write_sql_pool.clone());
        let sql_outbox = SqlOutbox::with_options(write_sql_pool, read_sql_pool, DEFAULT_OUTBOX_TABLE, OutboxLeaseMode::AvailableAtColumn)?;

        let optimize_cancel = CancellationToken::new();
        let optimize_task = if matches!(backend_state, DbBackendState::Sqlite { .. }) {
            let conn = write_conn.clone();
            let cancel = optimize_cancel.clone();
            Some(tokio::spawn(async move {
                let mut ticker = vibevalley_kit::task::Ticker::periodic_delayed(SQLITE_OPTIMIZE_INTERVAL).with_delay_behavior();
                loop {
                    tokio::select! {
                        () = cancel.cancelled() => break,
                        _ = ticker.tick() => {
                            if let Err(err) = conn.execute_unprepared("PRAGMA optimize;").await {
                                tracing::debug!(error = %err, "periodic sqlite PRAGMA optimize failed");
                            }
                        }
                    }
                }
            }))
        } else {
            None
        };

        Ok(Arc::new(Self {
            config: config_owned,
            backend_state,
            read_conn,
            write_conn,
            seq,
            sql_outbox,
            durable: Mutex::new(None),
            metrics: Arc::new(QueryMetrics::default()),
            optimize_cancel,
            optimize_task: Mutex::new(optimize_task),
        }))
    }

    pub(crate) fn write_conn(&self) -> &DatabaseConnection {
        &self.write_conn
    }

    pub(crate) fn read_conn(&self) -> &DatabaseConnection {
        &self.read_conn
    }

    pub(crate) fn sql_outbox(&self) -> &SqlOutbox {
        &self.sql_outbox
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

    pub fn query_metrics(&self) -> &Arc<QueryMetrics> {
        &self.metrics
    }

    /// Runs `PRAGMA optimize` on SQLite (no-op on PostgreSQL) to refresh query planner statistics.
    pub async fn run_pragma_optimize(&self) -> DbResult<()> {
        if matches!(self.backend_state, DbBackendState::Sqlite { .. }) {
            self.write_conn.execute_unprepared("PRAGMA optimize;").await?;
        }
        Ok(())
    }

    pub fn path(&self) -> Option<&Path> {
        match &self.backend_state {
            DbBackendState::Sqlite { path } => Some(path.as_path()),
            #[cfg(feature = "postgres")]
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
            #[cfg(feature = "postgres")]
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
        self.optimize_cancel.cancel();
        let handle = self.optimize_task.lock().take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
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
            #[cfg(feature = "postgres")]
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

    /// Runs an async write transaction with an attached [`PostCommitHooks`] collector whose
    /// `on_commit` callbacks (e.g. `outbox.wake()`) fire ONLY after commit succeeds.
    pub async fn write_with_hooks<T, E>(
        &self,
        f: impl for<'a> FnOnce(&'a Tx, &'a mut PostCommitHooks) -> BoxFuture<'a, Result<T, E>> + Send,
    ) -> Result<(T, vibevalley_kit::core::DirtyMask), E>
    where
        E: From<DbError>,
    {
        let tx = begin_write_tx(&self.write_conn).await.map_err(E::from)?;
        let mut hooks = PostCommitHooks::new();
        match f(&tx, &mut hooks).await {
            Ok(val) => {
                if let Err(err) = commit_tx(tx).await {
                    hooks.discard();
                    return Err(E::from(err));
                }
                let dirty = hooks.fire();
                Ok((val, dirty))
            }
            Err(err) => {
                hooks.discard();
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    /// Atomically allocates the next monotonic counter value strictly above `at_least`
    /// via `vibevalley_kit::db::seq::SeqAllocator`.
    pub async fn next_seq(&self, name: &str, at_least: i64) -> DbResult<i64> {
        Ok(self.seq.next_seq(name, at_least).await?)
    }

    /// Atomically allocates the next monotonic counter value strictly above `at_least` inside `tx`.
    pub async fn next_seq_in_tx(&self, tx: &Tx, name: &str, at_least: i64) -> DbResult<i64> {
        let raw_backend = tx.get_database_backend();
        let kit_backend = match raw_backend {
            DatabaseBackend::Postgres => DbBackend::Postgres,
            _ => DbBackend::Sqlite,
        };
        let sql = next_seq_sql(kit_backend, DEFAULT_SEQ_TABLE)?;
        let initial = at_least.saturating_add(1);
        let stmt = Statement::from_sql_and_values(raw_backend, sql, [name.into(), initial.into(), at_least.into()]);
        let row = tx
            .query_one_raw(stmt)
            .await?
            .ok_or_else(|| DbError::custom("seq_counter upsert returned no row"))?;
        let next: i64 = row.try_get_by_index(0)?;
        Ok(next)
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

/// Opens a read transaction pinning a single consistent snapshot across multiple queries
/// (`BEGIN DEFERRED` on SQLite WAL, non-blocking with concurrent writers).
pub(crate) async fn begin_read_tx(conn: &DatabaseConnection) -> DbResult<Tx> {
    let opts = match conn.get_database_backend() {
        DatabaseBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Deferred),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await.map_err(DbError::from)
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

#[cfg(all(test, feature = "postgres"))]
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
    use crate::db::entity;

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

        // Also exercise next_seq_in_tx on an open SeaORM write transaction.
        let tx = db.begin_tx().await.unwrap();
        assert_eq!(db.next_seq_in_tx(&tx, "issue", 0).await.unwrap(), 13);
        rollback_tx(tx).await.unwrap();
        assert_eq!(db.next_seq("issue", 0).await.unwrap(), 13);

        db.close().await;
        drop(db);

        let reopened = Database::open_config(&DatabaseConfig::Sqlite { path: db_path }).await.unwrap();
        assert_eq!(reopened.next_seq("issue", 0).await.unwrap(), 14);
        reopened.close().await;
    }

    #[tokio::test]
    async fn sqlite_pools_apply_engine_pragmas_and_optimize() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap();

        for conn in [db.write_conn(), db.read_conn()] {
            let cache_size: i64 = conn
                .query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, "PRAGMA cache_size;"))
                .await
                .unwrap()
                .unwrap()
                .try_get_by_index(0)
                .unwrap();
            assert_eq!(cache_size, -32000, "cache_size must be tuned to -32000 KiB");

            let temp_store: i64 = conn
                .query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, "PRAGMA temp_store;"))
                .await
                .unwrap()
                .unwrap()
                .try_get_by_index(0)
                .unwrap();
            assert_eq!(temp_store, 2, "temp_store must be MEMORY (2)");

            let mmap_size: i64 = conn
                .query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, "PRAGMA mmap_size;"))
                .await
                .unwrap()
                .unwrap()
                .try_get_by_index(0)
                .unwrap();
            assert!(mmap_size > 0, "mmap_size must be enabled (> 0), got {mmap_size}");
        }

        db.run_pragma_optimize().await.unwrap();
        db.close().await;
    }
}
