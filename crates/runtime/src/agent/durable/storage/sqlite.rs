//! SQLite `StorageBackend` with WAL mode, read-only reader pool, and group-commit savepoints.
//!
//! Retained as the Wave 1–3 transition bridge for callers requiring synchronous `&Sqlite<'_>`
//! (`Tx::connection()`); durable queries themselves execute through the shared SeaORM/SeaQuery
//! layer (`storage::ops`) and `durable::migration::Migrator`.

use std::path::Path;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use sea_orm::sea_query::{OptionEnum, Value as SeaValue, Values as SeaValues};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, ExecResult, QueryResult, RuntimeErr, SqlxSqliteConnector, Statement};
use sea_orm_migration::MigratorTrait;
use serde_json::Value;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Arguments, Connection, Executor, Sqlite as SqlxSqlite, SqliteConnection, SqlitePool};

use super::ops;
use super::{StorageBackend, StorageRead, StorageWrite, WriteCallback};
use crate::agent::durable::migration::Migrator;
use crate::agent::durable::{
    CommitStats, Conversation, Document, DocumentEvent, Entry, Error, Result, Signal, Sqlite, Submission, SubmissionStatus, Task, TaskStatus, now_ms,
};
use crate::rt::block_on;

type Ack = flume::Sender<std::result::Result<(), String>>;

/// Pooled SQLite connection guard that enters the shared Tokio runtime before
/// returning its `PoolConnection` to `SqlitePool`, preventing off-runtime drop panics.
struct PooledConn(Option<PoolConnection<SqlxSqlite>>);

impl PooledConn {
    fn new(conn: PoolConnection<SqlxSqlite>) -> Self {
        Self(Some(conn))
    }
}

impl std::ops::Deref for PooledConn {
    type Target = SqliteConnection;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("PooledConn live before drop")
    }
}

impl std::ops::DerefMut for PooledConn {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("PooledConn live before drop")
    }
}

impl Drop for PooledConn {
    fn drop(&mut self) {
        if let Some(conn) = self.0.take() {
            let _guard = crate::rt::handle().enter();
            drop(conn);
        }
    }
}

struct Database {
    /// Writer connection checked out only for the duration of an open group-commit batch.
    active_tx: Option<PooledConn>,
    waiting: Vec<Ack>,
    events: Vec<DocumentEvent>,
    tasks_changed: bool,
    docs: Vec<flume::Sender<DocumentEvent>>,
    tasks: Vec<flume::Sender<()>>,
    stats: CommitStats,
}

impl Database {
    fn new() -> Self {
        Self {
            active_tx: None,
            waiting: vec![],
            events: vec![],
            tasks_changed: false,
            docs: vec![],
            tasks: vec![],
            stats: CommitStats::default(),
        }
    }
}

fn batch(conn: &mut SqliteConnection, sql: &'static str) -> sqlx::Result<()> {
    block_on(sqlx::raw_sql(sql).execute(conn)).map(|_| ())
}

impl Database {
    fn flush(&mut self) -> Result<()> {
        if self.waiting.is_empty() {
            self.active_tx.take();
            return Ok(());
        }
        let mut conn = self.active_tx.take().expect("active_tx present while writers are waiting");
        self.stats.batches += 1;
        let outcome = batch(&mut conn, "COMMIT");
        if outcome.is_err() {
            let _ = batch(&mut conn, "ROLLBACK");
        }
        drop(conn);
        let receipt = outcome.as_ref().map(|_| ()).map_err(ToString::to_string);
        if outcome.is_ok() {
            self.stats.committed_ops += self.waiting.len() as u64;
            for e in std::mem::take(&mut self.events) {
                self.publish(e);
            }
            if self.tasks_changed {
                self.tasks.retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
            }
        } else {
            self.stats.failed_ops += self.waiting.len() as u64;
            self.events.clear();
        }
        self.tasks_changed = false;
        for ack in self.waiting.drain(..) {
            let _ = ack.send(receipt.clone());
        }
        Ok(outcome?)
    }

    fn publish(&mut self, event: DocumentEvent) {
        self.docs.retain(|tx| tx.send(event.clone()).is_ok());
    }
}

struct SqliteInner {
    db: Mutex<Database>,
    write_pool: Option<SqlitePool>,
    read_pool: Option<SqlitePool>,
    owns_pools: bool,
    read_only: bool,
    closed: AtomicBool,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Drop for SqliteInner {
    fn drop(&mut self) {
        if let Ok(db) = self.db.get_mut()
            && !self.closed.load(Ordering::Acquire)
            && !self.read_only
        {
            let _ = db.flush();
        }
        let _guard = crate::rt::handle().enter();
        self.read_pool.take();
        self.write_pool.take();
    }
}

#[derive(Clone)]
pub struct SqliteStorage(Arc<SqliteInner>);

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_clock(Some(path), now_ms)
    }

    /// Wraps externally managed `SqlitePool`s (such as `ServerDb`'s shared write/read pools)
    /// and initializes durable's schema once on `write_pool`.
    pub fn from_pools(write_pool: SqlitePool, read_pool: Option<SqlitePool>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let sea_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool.clone());
        block_on(Migrator::up(&sea_conn, None))?;
        Ok(Self(Arc::new(SqliteInner {
            db: Mutex::new(Database::new()),
            write_pool: Some(write_pool),
            read_pool,
            owns_pools: false,
            read_only: false,
            closed: AtomicBool::new(false),
            clock: Arc::new(clock),
        })))
    }

    pub fn open_read_only(path: &Path) -> Result<Self> {
        if !path.is_file() {
            return Err(Error::Invalid(format!("sqlite database does not exist: {}", path.display())));
        }
        let path_buf = path.to_path_buf();
        let read_pool = block_on(async move {
            let options = SqliteConnectOptions::new()
                .filename(&path_buf)
                .read_only(true)
                .busy_timeout(Duration::from_secs(5));
            SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(options).await
        })?;
        Ok(Self(Arc::new(SqliteInner {
            db: Mutex::new(Database::new()),
            write_pool: None,
            read_pool: Some(read_pool),
            owns_pools: true,
            read_only: true,
            closed: AtomicBool::new(false),
            clock: Arc::new(now_ms),
        })))
    }

    pub fn memory() -> Result<Self> {
        Self::open_with_clock(None, now_ms)
    }

    pub fn open_with_clock(path: Option<&Path>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let path_buf = path.map(Path::to_path_buf);
        let (write_pool, read_pool) = block_on(async move {
            let base = SqliteConnectOptions::new().busy_timeout(Duration::from_secs(5));
            let (write_pool, read_pool) = match path_buf {
                Some(file) => {
                    let write_opts = base
                        .clone()
                        .filename(&file)
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal)
                        .synchronous(SqliteSynchronous::Normal);
                    let write_pool = SqlitePoolOptions::new().max_connections(1).min_connections(1).connect_with(write_opts).await?;
                    let sea_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool.clone());
                    Migrator::up(&sea_conn, None).await?;
                    let read_opts = base.filename(&file).read_only(true);
                    let read_pool = SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(read_opts).await?;
                    (write_pool, Some(read_pool))
                }
                None => {
                    // Disable pool recycling for in-memory SQLite so sqlx never drops and wipes the DB.
                    let write_opts = base.in_memory(true).journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal);
                    let write_pool = SqlitePoolOptions::new()
                        .max_connections(1)
                        .min_connections(1)
                        .idle_timeout(None)
                        .max_lifetime(None)
                        .connect_with(write_opts)
                        .await?;
                    let sea_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool.clone());
                    Migrator::up(&sea_conn, None).await?;
                    (write_pool, None)
                }
            };
            Ok::<_, Error>((write_pool, read_pool))
        })?;
        Ok(Self(Arc::new(SqliteInner {
            db: Mutex::new(Database::new()),
            write_pool: Some(write_pool),
            read_pool,
            owns_pools: true,
            read_only: false,
            closed: AtomicBool::new(false),
            clock: Arc::new(clock),
        })))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Database>> {
        let db = self.0.db.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        Ok(db)
    }
}

fn run_read_tx(conn: &mut SqliteConnection, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()> {
    let mut tx = block_on(conn.begin())?;
    let s = Sqlite::new(&mut tx);
    let read = SqliteTx(&s);
    let outcome = f(&read);
    match outcome {
        Ok(()) => {
            block_on(tx.commit())?;
            Ok(())
        }
        Err(err) => {
            let _ = block_on(tx.rollback());
            Err(err)
        }
    }
}

impl StorageBackend for SqliteStorage {
    fn kind(&self) -> &'static str {
        "sqlite"
    }

    fn is_read_only(&self) -> bool {
        self.0.read_only
    }

    fn now_ms(&self) -> i64 {
        (self.0.clock)()
    }

    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()> {
        if let Some(read_pool) = &self.0.read_pool {
            if self.0.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            let mut conn = PooledConn::new(block_on(read_pool.acquire())?);
            return run_read_tx(&mut conn, f);
        }
        let write_pool = self.0.write_pool.as_ref().ok_or_else(|| Error::Invalid("sqlite storage has no pool".into()))?;
        let mut db = self.lock()?;
        db.flush()?;
        let mut conn = PooledConn::new(block_on(write_pool.acquire())?);
        run_read_tx(&mut conn, f)
    }

    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()> {
        if self.0.read_only {
            return Err(Error::Invalid("sqlite storage is open read-only".into()));
        }
        let write_pool = self
            .0
            .write_pool
            .as_ref()
            .ok_or_else(|| Error::Invalid("sqlite storage has no writer pool".into()))?;
        let (ack, done) = flume::bounded(1);
        let leader = {
            let mut db = self.lock()?;
            db.stats.requests += 1;
            let leader = db.waiting.is_empty();
            if leader {
                let mut conn = PooledConn::new(block_on(write_pool.acquire())?);
                if let Err(error) = batch(&mut conn, "BEGIN IMMEDIATE; SAVEPOINT operation") {
                    let _ = batch(&mut conn, "ROLLBACK");
                    drop(conn);
                    return Err(error.into());
                }
                db.active_tx = Some(conn);
            } else {
                let conn = db.active_tx.as_mut().expect("active_tx present while writers are waiting");
                if let Err(error) = batch(conn, "SAVEPOINT operation") {
                    return Err(error.into());
                }
            }
            let now = self.now_ms();
            let outcome = {
                let conn = db.active_tx.as_mut().expect("active_tx present during write operation");
                let conn_wrap = Sqlite::new(conn);
                let tx = SqliteTx(&conn_wrap);
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&tx, &tx, Some(&conn_wrap), None, now)))
            };
            match outcome {
                Ok(Ok(write_outcome)) => {
                    let release_res = {
                        let conn = db.active_tx.as_mut().expect("active_tx present before release");
                        batch(conn, "RELEASE operation")
                    };
                    if let Err(error) = release_res {
                        db.stats.failed_ops += 1;
                        if leader {
                            if let Some(mut conn) = db.active_tx.take() {
                                let _ = batch(&mut conn, "ROLLBACK");
                            }
                        } else if let Some(conn) = db.active_tx.as_mut() {
                            let _ = batch(conn, "ROLLBACK TO operation; RELEASE operation");
                        }
                        return Err(error.into());
                    }
                    db.events.extend(write_outcome.events);
                    db.tasks_changed |= write_outcome.tasks_changed;
                    db.waiting.push(ack);
                    if db.waiting.len() >= 64 {
                        db.flush()?;
                    }
                    leader
                }
                other => {
                    db.stats.failed_ops += 1;
                    if leader {
                        if let Some(mut conn) = db.active_tx.take() {
                            let _ = batch(&mut conn, "ROLLBACK");
                        }
                    } else if let Some(conn) = db.active_tx.as_mut() {
                        let rb = batch(conn, "ROLLBACK TO operation; RELEASE operation");
                        if let (Ok(_), Err(err)) = (&other, rb) {
                            return Err(err.into());
                        }
                    }
                    match other {
                        Ok(Err(e)) => return Err(e),
                        Err(panic) => {
                            drop(db);
                            std::panic::resume_unwind(panic)
                        }
                        _ => unreachable!(),
                    }
                }
            }
        };
        if leader {
            // Other writers can join this commit, each with its own savepoint.
            std::thread::yield_now();
            let _ = self.0.db.lock().unwrap_or_else(|e| e.into_inner()).flush();
        }
        done.recv().map_err(|_| Error::Closed)?.map_err(Error::Commit)?;
        Ok(())
    }

    fn stats(&self) -> CommitStats {
        self.0.db.lock().unwrap().stats
    }

    fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        let (tx, rx) = flume::unbounded();
        self.lock()?.docs.push(tx);
        Ok(rx)
    }

    fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        let (tx, rx) = flume::bounded(1);
        self.lock()?.tasks.push(tx);
        Ok(rx)
    }

    fn close(&self) -> Result<()> {
        let should_close_pools = {
            let mut db = self.0.db.lock().unwrap_or_else(|e| e.into_inner());
            if self.0.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            if !self.0.read_only {
                db.flush()?;
            }
            self.0.closed.store(true, Ordering::Release);
            db.docs.clear();
            db.tasks.clear();
            self.0.owns_pools
        };
        if should_close_pools {
            let read_pool = self.0.read_pool.clone();
            let write_pool = self.0.write_pool.clone();
            block_on(async move {
                if let Some(pool) = read_pool {
                    pool.close().await;
                }
                if let Some(pool) = write_pool {
                    pool.close().await;
                }
            });
        }
        Ok(())
    }
}

struct SqliteConnExec<'c>(tokio::sync::Mutex<&'c mut SqliteConnection>);

fn bind_sqlite_values(values: Option<SeaValues>) -> std::result::Result<SqliteArguments, DbErr> {
    let mut args = SqliteArguments::default();
    let Some(values) = values else {
        return Ok(args);
    };
    for arg in values.into_iter() {
        match arg {
            SeaValue::Bool(v) => {
                let _ = args.add(v);
            }
            SeaValue::TinyInt(v) => {
                let _ = args.add(v);
            }
            SeaValue::SmallInt(v) => {
                let _ = args.add(v);
            }
            SeaValue::Int(v) => {
                let _ = args.add(v);
            }
            SeaValue::BigInt(v) => {
                let _ = args.add(v);
            }
            SeaValue::TinyUnsigned(v) => {
                let _ = args.add(v);
            }
            SeaValue::SmallUnsigned(v) => {
                let _ = args.add(v);
            }
            SeaValue::Unsigned(v) => {
                let _ = args.add(v);
            }
            SeaValue::BigUnsigned(v) => {
                let v = v.map(i64::try_from).transpose().map_err(|_| DbErr::ConvertFromU64("BigUnsigned"))?;
                let _ = args.add(v);
            }
            SeaValue::Float(v) => {
                let _ = args.add(v);
            }
            SeaValue::Double(v) => {
                let _ = args.add(v);
            }
            SeaValue::String(v) => {
                let _ = args.add(v);
            }
            SeaValue::Enum(e) => {
                let v = match e {
                    OptionEnum::Some(v) => Some(v.value.into_owned()),
                    OptionEnum::None(_) => None,
                };
                let _ = args.add(v);
            }
            SeaValue::Char(v) => {
                let _ = args.add(v.map(|c| c.to_string()));
            }
            SeaValue::Bytes(v) => {
                let _ = args.add(v);
            }
            SeaValue::Json(v) => {
                let _ = args.add(v.map(|j| *j));
            }
            SeaValue::Uuid(v) => {
                let _ = args.add(v);
            }
            other => {
                return Err(DbErr::Type(format!("unsupported sqlite SeaQuery value: {other:?}")));
            }
        }
    }
    Ok(args)
}

#[sea_orm_migration::prelude::async_trait::async_trait]
impl ConnectionTrait for SqliteConnExec<'_> {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Sqlite
    }

    async fn execute_raw(&self, stmt: Statement) -> std::result::Result<ExecResult, DbErr> {
        let args = bind_sqlite_values(stmt.values)?;
        let mut conn = self.0.lock().await;
        sqlx::query_with(sqlx::AssertSqlSafe(stmt.sql.as_str()), args)
            .execute(&mut **conn)
            .await
            .map(ExecResult::from)
            .map_err(|e| DbErr::Exec(RuntimeErr::SqlxError(Arc::new(e))))
    }

    async fn execute_unprepared(&self, sql: &str) -> std::result::Result<ExecResult, DbErr> {
        let mut conn = self.0.lock().await;
        Executor::execute(&mut **conn, sqlx::AssertSqlSafe(sql))
            .await
            .map(ExecResult::from)
            .map_err(|e| DbErr::Exec(RuntimeErr::SqlxError(Arc::new(e))))
    }

    async fn query_one_raw(&self, stmt: Statement) -> std::result::Result<Option<QueryResult>, DbErr> {
        let args = bind_sqlite_values(stmt.values)?;
        let mut conn = self.0.lock().await;
        sqlx::query_with(sqlx::AssertSqlSafe(stmt.sql.as_str()), args)
            .fetch_optional(&mut **conn)
            .await
            .map(|row| row.map(QueryResult::from))
            .map_err(|e| DbErr::Query(RuntimeErr::SqlxError(Arc::new(e))))
    }

    async fn query_all_raw(&self, stmt: Statement) -> std::result::Result<Vec<QueryResult>, DbErr> {
        let args = bind_sqlite_values(stmt.values)?;
        let mut conn = self.0.lock().await;
        sqlx::query_with(sqlx::AssertSqlSafe(stmt.sql.as_str()), args)
            .fetch_all(&mut **conn)
            .await
            .map(|rows| rows.into_iter().map(QueryResult::from).collect())
            .map_err(|e| DbErr::Query(RuntimeErr::SqlxError(Arc::new(e))))
    }
}

struct SqliteTx<'b, 'a>(&'b Sqlite<'a>);

impl SqliteTx<'_, '_> {
    fn run<T>(&self, f: impl for<'c> AsyncFnOnce(&'c SqliteConnExec<'c>) -> Result<T>) -> Result<T> {
        let mut out: Option<Result<T>> = None;
        self.0.query(async |db| {
            let exec = SqliteConnExec(tokio::sync::Mutex::new(db));
            out = Some(f(&exec).await);
            Ok(())
        })?;
        out.expect("sqlite query closure executes once")
    }
}

impl StorageRead for SqliteTx<'_, '_> {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        self.run(async |db| ops::document(db, scope, id, kind).await)
    }

    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        self.run(async |db| ops::documents_by_kind(db, scope, kind).await)
    }

    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        self.run(async |db| ops::documents_by_scope(db, scope, id).await)
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        self.run(async |db| ops::conversation(db, id).await)
    }

    fn conversations(&self) -> Result<Vec<Conversation>> {
        self.run(async |db| ops::conversations(db).await)
    }

    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>> {
        self.run(async |db| ops::conversations_by_owner_task(db, owner_task_id).await)
    }

    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
        self.run(async |db| ops::entries_from(db, conv, from_seq).await)
    }

    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
        self.run(async |db| ops::entries_within(db, conv, first_seq, last_seq).await)
    }

    fn submission(&self, id: &str) -> Result<Option<Submission>> {
        self.run(async |db| ops::submission(db, id).await)
    }

    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>> {
        self.run(async |db| ops::submission_by_request(db, conv, request_id).await)
    }

    fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        self.run(async |db| ops::submissions(db, conv).await)
    }

    fn task(&self, id: &str) -> Result<Option<Task>> {
        self.run(async |db| ops::task(db, id).await)
    }

    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        self.run(async |db| ops::task_by_dedup(db, owner, key).await)
    }

    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>> {
        self.run(async |db| ops::tasks_by_conversation(db, conv).await)
    }

    fn children(&self, owner: &str) -> Result<Vec<Task>> {
        self.run(async |db| ops::children(db, owner).await)
    }

    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        self.run(async |db| ops::tasks_by_status(db, status).await)
    }

    fn active_tasks(&self) -> Result<Vec<Task>> {
        self.run(async |db| ops::active_tasks(db).await)
    }

    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        self.run(async |db| ops::signals(db, task_id, include_consumed).await)
    }

    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
        self.run(async |db| ops::signal_by_key(db, task_id, name, key).await)
    }
}

impl StorageWrite for SqliteTx<'_, '_> {
    fn put_document(&self, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64> {
        self.run(async |db| ops::put_document(db, scope, id, kind, state, now_ms).await)
    }

    fn delete_document(&self, scope: &str, id: &str, kind: &str) -> Result<()> {
        self.run(async |db| ops::delete_document(db, scope, id, kind).await)
    }

    fn insert_conversation(&self, conv: &Conversation) -> Result<()> {
        self.run(async |db| ops::insert_conversation(db, conv).await)
    }

    fn advance_sequence(&self, conv: &str, now_ms: i64) -> Result<Option<i64>> {
        self.run(async |db| ops::advance_sequence(db, conv, now_ms).await)
    }

    fn insert_entry(&self, entry: &Entry) -> Result<()> {
        self.run(async |db| ops::insert_entry(db, entry).await)
    }

    fn set_head(&self, conv: &str, head_seq: i64) -> Result<()> {
        self.run(async |db| ops::set_head(db, conv, head_seq).await)
    }

    fn reset_head(&self, conv: &str) -> Result<()> {
        self.run(async |db| ops::reset_head(db, conv).await)
    }

    fn insert_submission(&self, sub: &Submission) -> Result<()> {
        self.run(async |db| ops::insert_submission(db, sub).await)
    }

    fn set_submission_status(&self, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()> {
        self.run(async |db| ops::set_submission_status(db, id, status, now_ms).await)
    }

    fn settle_submission(&self, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()> {
        self.run(async |db| ops::settle_submission(db, id, status, result, now_ms).await)
    }

    fn insert_task(&self, t: &Task) -> Result<()> {
        self.run(async |db| ops::insert_task(db, t).await)
    }

    fn update_task(&self, t: &Task, now_ms: i64) -> Result<bool> {
        self.run(async |db| ops::update_task(db, t, now_ms).await)
    }

    fn insert_signal(&self, signal: &Signal) -> Result<Signal> {
        self.run(async |db| ops::insert_signal(db, signal).await)
    }

    fn consume_first_signal(&self, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>> {
        self.run(async |db| ops::consume_first_signal(db, task_id, name, now_ms).await)
    }
}
