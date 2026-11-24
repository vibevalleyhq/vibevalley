//! Unified dual-backend database door (`ServerDb`, SQLite + PostgreSQL),
//! schema entities, migrations, and shared column serialization helpers.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr, SqliteTransactionMode, SqlxSqliteConnector,
    TransactionOptions, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;

pub(crate) mod column;
pub(crate) mod entities;
pub(crate) mod error;
pub(crate) mod migration;

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

enum DbBackendState {
    Sqlite { path: PathBuf },
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
    /// Opens `<home>/server.db` with split read/write connections and initializes all schemas once.
    pub fn open(home: &Path) -> Result<Arc<Self>, DbErr> {
        Self::open_at(&home.join("server.db"))
    }

    /// Opens `path` with split read/write connections and initializes all schemas once.
    pub fn open_at(path: &Path) -> Result<Arc<Self>, DbErr> {
        Self::open_config(&DatabaseConfig::Sqlite { path: path.to_path_buf() })
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
                    let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool);
                    crate::db::migration::Migrator::up(&write_conn, None).await?;
                    vibevalley_runtime::agent::durable::migration::Migrator::up(&write_conn, None).await?;

                    let read_options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(Duration::from_secs(5));
                    let read_pool = SqlitePoolOptions::new()
                        .max_connections(READ_POOL_MAX_CONNECTIONS)
                        .min_connections(1)
                        .connect_with(read_options)
                        .await
                        .map_err(|e| DbErr::Conn(sea_orm::RuntimeErr::SqlxError(Arc::new(e))))?;
                    let read_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool);

                    Ok::<_, DbErr>((DbBackendState::Sqlite { path: path.clone() }, read_conn, write_conn))
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
            DbBackendState::Sqlite { path } => path,
            DbBackendState::Postgres => panic!("ServerDb::path() is only available on SQLite"),
        }
    }

    /// Returns the process-wide `durable::Store` handle backed by this `ServerDb`
    /// via `Store::from_sea_orm_conns`.
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
    /// SQLite connections (with WAL `TRUNCATE` + `PRAGMA optimize`) or the PostgreSQL pool.
    pub async fn close_async(&self) {
        if let Some(store) = self.durable.lock().take() {
            let _ = store.close();
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

    /// Coordinated database shutdown: closes the durable store handle, then closes
    /// SQLite connections (with WAL `TRUNCATE` + `PRAGMA optimize`) or the PostgreSQL pool.
    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }
}

pub(crate) async fn next_seq_async(db: &impl sea_orm::ConnectionTrait, name: &str, at_least: i64) -> Result<i64, DbErr> {
    use sea_orm::sea_query::{Expr, OnConflict};
    use sea_orm::{ActiveValue::Set, EntityTrait, ExprTrait};

    let model = entities::shared::seq_counter::ActiveModel {
        name: Set(name.to_owned()),
        last_number: Set(at_least + 1),
    };
    let current = Expr::col((entities::shared::seq_counter::Entity, entities::shared::seq_counter::Column::LastNumber));
    let next_expr = Expr::expr(Expr::case(current.clone().gt(at_least), current).finally(at_least)).add(1);
    let on_conflict = OnConflict::column(entities::shared::seq_counter::Column::Name)
        .value(entities::shared::seq_counter::Column::LastNumber, next_expr)
        .to_owned();
    let saved = entities::shared::seq_counter::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_with_returning(db)
        .await?;
    Ok(saved.last_number)
}

/// Opens a write transaction, using `BEGIN IMMEDIATE` on SQLite so writers serialize at begin.
pub(crate) async fn begin_write_tx(conn: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    let opts = match conn.get_database_backend() {
        DatabaseBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await
}

pub(crate) async fn write_tx<T, E>(
    db: &DatabaseConnection,
    map_err: fn(DbErr) -> E,
    f: impl for<'a> FnOnce(&'a DatabaseTransaction) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send + 'a>> + Send,
) -> Result<T, E> {
    let tx = begin_write_tx(db).await.map_err(map_err)?;
    match f(&tx).await {
        Ok(val) => {
            tx.commit().await.map_err(map_err)?;
            Ok(val)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
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

        pub(crate) fn create_database(&self, db_name: &str) {
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

    use super::*;

    #[test]
    fn concurrent_reads_succeed_immediately_while_write_tx_holds_begin_immediate() {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, PaginatorTrait};

        use crate::db::begin_write_tx;
        use crate::db::entities::collab_channel::channel;

        fn make_channel(id: &str, name: &str, default: bool, created_at: i64) -> channel::ActiveModel {
            channel::ActiveModel {
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

        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();

        vibevalley_runtime::rt::block_on(async {
            make_channel("c1", "general", true, 100).insert(db.write_conn()).await.unwrap();
        });

        // Hold an open BEGIN IMMEDIATE write transaction with an uncommitted row.
        let write_tx = vibevalley_runtime::rt::block_on(async {
            let tx = begin_write_tx(db.write_conn()).await.unwrap();
            make_channel("c2", "pending", false, 200).insert(&tx).await.unwrap();
            tx
        });

        // Multiple concurrent read_conn() calls must succeed immediately against the WAL snapshot
        // without blocking on the active write transaction or hitting SQLite busy_timeout.
        let started = Instant::now();
        let mut threads = Vec::new();
        for _ in 0..6 {
            let db = db.clone();
            threads.push(std::thread::spawn(move || {
                vibevalley_runtime::rt::block_on(async { channel::Entity::find().count(db.read_conn()).await.unwrap() })
            }));
        }
        let counts: Vec<u64> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        let elapsed = started.elapsed();
        assert_eq!(counts, vec![1; 6], "readers must see committed WAL snapshot while writer holds BEGIN IMMEDIATE");
        assert!(
            elapsed < Duration::from_secs(1),
            "concurrent read_conn queries took too long while write tx open: {elapsed:?}"
        );

        // Verify read_conn enforces read_only(true).
        let write_on_read_conn = vibevalley_runtime::rt::block_on(async { make_channel("c3", "illegal", false, 300).insert(db.read_conn()).await });
        assert!(write_on_read_conn.is_err(), "read_conn must reject writes");

        // Commit the write transaction.
        vibevalley_runtime::rt::block_on(write_tx.commit()).unwrap();

        // New reads immediately see the committed write.
        let after = vibevalley_runtime::rt::block_on(async { channel::Entity::find().count(db.read_conn()).await.unwrap() });
        assert_eq!(after, 2);

        // Coordinated shutdown closes read_conn first, checkpoints WAL (TRUNCATE), and closes write_conn.
        db.close();
        drop(db);

        let reopened = ServerDb::open(dir.path()).unwrap();
        let persisted = vibevalley_runtime::rt::block_on(async { channel::Entity::find().count(reopened.read_conn()).await.unwrap() });
        assert_eq!(persisted, 2);
        reopened.close();
    }

    #[test]
    fn async_write_and_read_conns_work_inside_send_futures() {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};

        use crate::db::entities::collab_channel::channel;

        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let db_task = db.clone();
        let count = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                channel::ActiveModel {
                    id: Set("async-c1".into()),
                    channel_type: Set("channel".into()),
                    is_default: Set(false),
                    root_id: Set(None),
                    root_number: Set(None),
                    subject_kind: Set(None),
                    subject_id: Set(None),
                    last_number: Set(None),
                    reply_count: Set(0),
                    created_at: Set(100),
                    name: Set(Some("async".into())),
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
                .insert(db_task.write_conn())
                .await?;

                channel::Entity::find()
                    .filter(channel::Column::Id.eq("async-c1"))
                    .count(db_task.read_conn())
                    .await
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
        use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, PaginatorTrait};

        use crate::db::begin_write_tx;
        use crate::db::entities::collab_channel::channel;

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
                        vibevalley_runtime::rt::block_on(async {
                            let tx = begin_write_tx(db.write_conn()).await?;
                            channel::ActiveModel {
                                id: Set(id),
                                channel_type: Set("channel".into()),
                                is_default: Set(false),
                                root_id: Set(None),
                                root_number: Set(None),
                                subject_kind: Set(None),
                                subject_id: Set(None),
                                last_number: Set(None),
                                reply_count: Set(0),
                                created_at: Set((t * ops_per_thread + i) as i64),
                                name: Set(Some(name)),
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
                            .insert(&tx)
                            .await?;
                            tx.commit().await
                        })
                        .expect("ServerDb::write_conn write must serialize cleanly without SQLITE_BUSY");
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
                        let _ = vibevalley_runtime::rt::block_on(async { channel::Entity::find().count(db.read_conn()).await })
                            .expect("concurrent ServerDb::read_conn must succeed");
                        let _ = durable
                            .read(|r| r.documents_by_kind("stress", "item"))
                            .expect("concurrent durable.read must succeed");
                    }
                });
            }
        });

        let channel_count = vibevalley_runtime::rt::block_on(async { channel::Entity::find().count(db.read_conn()).await }).unwrap();
        assert_eq!(channel_count, (server_threads * ops_per_thread) as u64);

        let durable_docs = durable.read(|r| r.documents_by_kind("stress", "item")).unwrap();
        assert_eq!(durable_docs.len(), durable_threads * ops_per_thread);

        // Writer connection must remain usable after durable writes finish.
        let tx = vibevalley_runtime::rt::block_on(begin_write_tx(db.write_conn())).expect("write_conn must not be starved by durable");
        vibevalley_runtime::rt::block_on(tx.rollback()).unwrap();

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

    #[test]
    fn postgres_open_url_migrates_server_and_durable_schemas_and_runs_core_ops() {
        let Some(pg) = crate::db::test_pg::EphemeralPostgres::start() else {
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
