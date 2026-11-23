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

/// Single shared SQLite door for `server.db`: one WAL-mode `SqlitePool`
/// initialized once with every module schema, plus the single shared
/// durable runtime `Store` and coordinated shutdown checkpoint.
pub struct ServerDb {
    path: PathBuf,
    pool: SqlitePool,
    durable: Mutex<Option<vibevalley_runtime::agent::durable::Store>>,
}

impl ServerDb {
    /// Opens `<home>/server.db` with the unified pool and initializes all schemas once.
    pub fn open(home: &Path) -> sqlx::Result<Arc<Self>> {
        Self::open_at(&home.join("server.db"))
    }

    /// Opens `path` with the unified pool and initializes all schemas once.
    pub fn open_at(path: &Path) -> sqlx::Result<Arc<Self>> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(parent);
        }
        let path_buf = path.to_path_buf();
        let pool = vibevalley_runtime::rt::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&path_buf)
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(5))
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal)
                .foreign_keys(true);
            let pool = SqlitePoolOptions::new().max_connections(8).min_connections(1).connect_with(options).await?;
            let mut conn = pool.acquire().await?;
            for schema in ALL_SCHEMAS {
                sqlx::raw_sql(schema).execute(&mut *conn).await?;
            }
            drop(conn);
            Ok::<_, sqlx::Error>(pool)
        })?;
        Ok(Arc::new(Self {
            path: path_buf,
            pool,
            durable: Mutex::new(None),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub(crate) fn acquire(&self) -> sqlx::Result<DbConn> {
        vibevalley_runtime::rt::block_on(self.pool.acquire()).map(|conn| DbConn(Some(conn)))
    }

    pub(crate) fn run<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> sqlx::Result<T>) -> sqlx::Result<T> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.pool.acquire().await?;
            query(&mut conn).await
        })
    }

    pub(crate) fn run_api<T>(&self, query: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        vibevalley_runtime::rt::block_on(async {
            let mut conn = self.pool.acquire().await.map_err(internal)?;
            query(&mut conn).await
        })
    }

    /// Returns the process-wide `durable::Store` handle backed by this same `server.db`.
    pub(crate) fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        let mut slot = self.durable.lock();
        if let Some(store) = slot.as_ref() {
            return Ok(store.clone());
        }
        let store = vibevalley_runtime::agent::durable::Store::open(&self.path)?;
        *slot = Some(store.clone());
        Ok(store)
    }

    /// Coordinated SQLite shutdown: drops the durable store handle, runs a
    /// passive WAL checkpoint and `PRAGMA optimize`, and closes the pool.
    pub fn close(&self) {
        self.durable.lock().take();
        vibevalley_runtime::rt::block_on(async {
            if let Ok(mut conn) = self.pool.acquire().await {
                let _ = sqlx::raw_sql("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;").execute(&mut *conn).await;
            }
            self.pool.close().await;
        });
    }
}

/// A cancelable background periodic ticker running blocking work on the Tokio pool.
pub(crate) struct Ticker {
    cancel: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

async fn run_ticker(cancel: tokio_util::sync::CancellationToken, interval: Duration, immediate: bool, mut tick: impl FnMut() -> bool + Send + 'static) {
    if !immediate {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(interval) => {}
        }
    }
    loop {
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
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(interval) => {}
        }
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
