//! Shared refusals (`base/errors.ts`), idempotent request keys, and the
//! server's single shared SQLite connection pool (`ServerDb`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqliteConnection, SqlitePool};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, Next};

const ALL_SCHEMAS: [&str; 13] = [
    crate::db::schema::SHARED,
    crate::db::schema::COLLAB_CHANNEL,
    crate::db::schema::COLLAB_CONNECTOR,
    crate::db::schema::CONTENT_ARTIFACT,
    crate::db::schema::CONTENT_ATTACHMENT,
    crate::db::schema::CONTENT_LIBRARY,
    crate::db::schema::CONTENT_MEDIA,
    crate::db::schema::INFRA_REMOTE,
    crate::db::schema::TEAM_MEMORY,
    crate::db::schema::WORK_CRON,
    crate::db::schema::WORK_ISSUE,
    crate::db::schema::WORK_PULL,
    crate::db::schema::WORK_SESSION,
];

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

const READ_POOL_MAX_CONNECTIONS: u32 = 6;
const WRITE_POOL_MAX_CONNECTIONS: u32 = 1;

/// Single shared SQLite door for `server.db`: split WAL-mode pools with a
/// multi-connection read-only pool (`read_pool`) for lock-free concurrent WAL
/// reads and a single-connection writer pool (`write_pool`) that serializes
/// writes cleanly in Tokio's async queue instead of hitting SQLite busy sleeps,
/// plus the single shared durable runtime `Store` and coordinated shutdown
/// checkpoint.
pub struct ServerDb {
    path: PathBuf,
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    durable: Mutex<Option<vibevalley_runtime::agent::durable::Store>>,
}

impl ServerDb {
    /// Opens `<home>/server.db` with split read/write pools and initializes all schemas once.
    pub fn open(home: &Path) -> sqlx::Result<Arc<Self>> {
        Self::open_at(&home.join("server.db"))
    }

    /// Opens `path` with split read/write pools and initializes all schemas once.
    pub fn open_at(path: &Path) -> sqlx::Result<Arc<Self>> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(parent);
        }
        let path_buf = path.to_path_buf();
        let (read_pool, write_pool) = vibevalley_runtime::rt::block_on(async {
            let write_options = SqliteConnectOptions::new()
                .filename(&path_buf)
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5))
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal)
                .foreign_keys(true);
            let write_pool = SqlitePoolOptions::new()
                .max_connections(WRITE_POOL_MAX_CONNECTIONS)
                .min_connections(1)
                .connect_with(write_options)
                .await?;
            let mut conn = write_pool.acquire().await?;
            for schema in ALL_SCHEMAS {
                sqlx::raw_sql(schema).execute(&mut *conn).await?;
            }
            drop(conn);

            let read_options = SqliteConnectOptions::new()
                .filename(&path_buf)
                .read_only(true)
                .busy_timeout(Duration::from_secs(5));
            let read_pool = SqlitePoolOptions::new()
                .max_connections(READ_POOL_MAX_CONNECTIONS)
                .min_connections(1)
                .connect_with(read_options)
                .await?;
            Ok::<_, sqlx::Error>((read_pool, write_pool))
        })?;
        Ok(Arc::new(Self {
            path: path_buf,
            read_pool,
            write_pool,
            durable: Mutex::new(None),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writer pool (backward-compatible default pool accessor).
    pub fn pool(&self) -> &SqlitePool {
        &self.write_pool
    }

    /// Multi-connection read-only WAL pool for concurrent pure read queries.
    pub fn read_pool(&self) -> &SqlitePool {
        &self.read_pool
    }

    /// Single-connection read-write pool serializing SQLite mutations.
    pub fn write_pool(&self) -> &SqlitePool {
        &self.write_pool
    }

    #[allow(dead_code)]
    pub(crate) async fn acquire_write(&self) -> sqlx::Result<PoolConnection<Sqlite>> {
        self.write_pool.acquire().await
    }

    #[allow(dead_code)]
    pub(crate) async fn acquire_read_async(&self) -> sqlx::Result<PoolConnection<Sqlite>> {
        self.read_pool.acquire().await
    }

    pub(crate) fn acquire(&self) -> sqlx::Result<DbConn> {
        vibevalley_runtime::rt::block_on(self.write_pool.acquire()).map(|conn| DbConn(Some(conn)))
    }

    pub(crate) fn acquire_read(&self) -> sqlx::Result<DbConn> {
        vibevalley_runtime::rt::block_on(self.read_pool.acquire()).map(|conn| DbConn(Some(conn)))
    }

    pub(crate) fn run<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.write_pool.acquire().await?;
            query(&mut conn).await
        })
    }

    pub(crate) fn run_api<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.write_pool.acquire().await.map_err(internal)?;
            query(&mut conn).await
        })
    }

    #[allow(dead_code)]
    pub(crate) fn read<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.read_pool.acquire().await?;
            query(&mut conn).await
        })
    }

    #[allow(dead_code)]
    pub(crate) fn read_api<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.read_pool.acquire().await.map_err(internal)?;
            query(&mut conn).await
        })
    }

    /// Returns the process-wide `durable::Store` handle backed by this `ServerDb`'s shared pools.
    pub(crate) fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        let mut slot = self.durable.lock();
        if let Some(store) = slot.as_ref() {
            return Ok(store.clone());
        }
        let store = vibevalley_runtime::agent::durable::Store::from_sqlite_pools(self.write_pool.clone(), Some(self.read_pool.clone()))?;
        *slot = Some(store.clone());
        Ok(store)
    }

    /// Coordinated SQLite shutdown: flushes and closes the durable store handle, closes the
    /// read pool first so no reader holds WAL frames, checkpoints WAL with
    /// `TRUNCATE` + `PRAGMA optimize`, and closes the write pool.
    pub fn close(&self) {
        if let Some(store) = self.durable.lock().take() {
            let _ = store.close();
        }
        vibevalley_runtime::rt::block_on(async {
            self.read_pool.close().await;
            if let Ok(mut conn) = self.write_pool.acquire().await {
                let _ = sqlx::raw_sql("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;").execute(&mut *conn).await;
            }
            self.write_pool.close().await;
        });
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
        let handle = vibevalley_runtime::rt::handle().spawn(run_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) fn stop(self) {
        self.cancel.cancel();
        let _ = vibevalley_runtime::rt::block_on(self.handle);
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
}
