//! Dual-backend SeaORM `StorageBackend` supporting SQLite and PostgreSQL.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use sea_orm::{
    AccessMode, ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend, SqliteTransactionMode, SqlxSqliteConnector,
    TransactionOptions, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use tokio::sync::Mutex as AsyncMutex;

use super::live::LiveHub;
use super::ops;
use super::{BoxFuture, ReadAsyncOp, StorageBackend, StorageRead, StorageWrite, WriteAsyncOp, WriteCallback};
use crate::agent::durable::migration::Migrator;
use crate::agent::durable::{
    CommitStats, Conversation, Document, DocumentEvent, Entry, Error, Result, Signal, Submission, SubmissionStatus, Task, TaskStatus, now_ms,
};
use crate::rt::block_on;

/// Active SeaORM transaction exposed to `WriteCallback` / `Tx::db_tx()` for same-transaction domain writes.
pub struct DbTx<'a>(&'a DatabaseTransaction);

impl<'a> DbTx<'a> {
    pub fn new(tx: &'a DatabaseTransaction) -> Self {
        Self(tx)
    }

    pub fn inner(&self) -> &'a DatabaseTransaction {
        self.0
    }
}

struct SeaOrmInner {
    write_conn: Mutex<Option<DatabaseConnection>>,
    read_conn: Mutex<Option<DatabaseConnection>>,
    write_lock: AsyncMutex<()>,
    backend: DbBackend,
    owns_conns: bool,
    read_only: bool,
    hub: LiveHub,
}

impl Drop for SeaOrmInner {
    fn drop(&mut self) {
        self.hub.mark_closed();
        let _guard = crate::rt::handle().enter();
        if let Ok(slot) = self.read_conn.get_mut() {
            slot.take();
        } else if let Ok(mut slot) = self.read_conn.lock() {
            slot.take();
        }
        if let Ok(slot) = self.write_conn.get_mut() {
            slot.take();
        } else if let Ok(mut slot) = self.write_conn.lock() {
            slot.take();
        }
    }
}

/// SeaORM-backed `StorageBackend` supporting both SQLite and PostgreSQL.
#[derive(Clone)]
pub struct SeaOrmStorage(Arc<SeaOrmInner>);

impl SeaOrmStorage {
    /// Connects to a SQLite or PostgreSQL database URL, runs durable migrations, and opens storage.
    pub fn connect(url: &str) -> Result<Self> {
        Self::connect_with_clock(url, now_ms)
    }

    /// Connects to a SQLite or PostgreSQL database URL with a custom clock.
    pub fn connect_with_clock(url: &str, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        if url.starts_with("sqlite:") {
            let conn = block_on(async {
                let mut sqlx_opts: SqliteConnectOptions = url.parse()?;
                sqlx_opts = sqlx_opts.busy_timeout(Duration::from_secs(5));
                if !url.contains("mode=ro") {
                    sqlx_opts = sqlx_opts.journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal);
                }
                let mut pool_opts = SqlitePoolOptions::new().max_connections(1).min_connections(1);
                if url.contains(":memory:") {
                    pool_opts = pool_opts.idle_timeout(None).max_lifetime(None);
                }
                let pool = pool_opts.connect_with(sqlx_opts).await?;
                Ok::<_, sqlx::Error>(SqlxSqliteConnector::from_sqlx_sqlite_pool(pool))
            })?;
            return Self::init(conn, None, true, false, clock);
        }
        let mut opts = ConnectOptions::new(url);
        opts.sqlx_logging(false);
        let conn = block_on(Database::connect(opts))?;
        Self::init(conn, None, true, false, clock)
    }

    /// Opens a file-backed SQLite database using SeaORM (with WAL and split read pool).
    pub fn open_sqlite(path: &Path) -> Result<Self> {
        Self::open_sqlite_with_clock(Some(path), now_ms)
    }

    /// Opens an in-memory SQLite database using SeaORM.
    pub fn sqlite_memory() -> Result<Self> {
        Self::open_sqlite_with_clock(None, now_ms)
    }

    /// Opens a file-backed or in-memory SQLite database using SeaORM with a custom clock.
    pub fn open_sqlite_with_clock(path: Option<&Path>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let path_buf = path.map(Path::to_path_buf);
        let (write_conn, read_conn) = block_on(async move {
            let base = SqliteConnectOptions::new().busy_timeout(Duration::from_secs(5));
            match path_buf {
                Some(file) => {
                    let write_opts = base
                        .clone()
                        .filename(&file)
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal)
                        .synchronous(SqliteSynchronous::Normal);
                    let write_pool = SqlitePoolOptions::new().max_connections(1).min_connections(1).connect_with(write_opts).await?;
                    let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool);
                    Migrator::up(&write_conn, None).await?;

                    let read_opts = base.filename(&file).read_only(true);
                    let read_pool = SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(read_opts).await?;
                    let read_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool);
                    Ok::<_, Error>((write_conn, Some(read_conn)))
                }
                None => {
                    let write_opts = base.in_memory(true).journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal);
                    let write_pool = SqlitePoolOptions::new()
                        .max_connections(1)
                        .min_connections(1)
                        .idle_timeout(None)
                        .max_lifetime(None)
                        .connect_with(write_opts)
                        .await?;
                    let write_conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(write_pool);
                    Migrator::up(&write_conn, None).await?;
                    Ok((write_conn, None))
                }
            }
        })?;
        let backend = write_conn.get_database_backend();
        Ok(Self(Arc::new(SeaOrmInner {
            write_conn: Mutex::new(Some(write_conn)),
            read_conn: Mutex::new(read_conn),
            write_lock: AsyncMutex::new(()),
            backend,
            owns_conns: true,
            read_only: false,
            hub: LiveHub::new(Arc::new(clock)),
        })))
    }

    /// Opens a file-backed SQLite database in read-only mode via SeaORM.
    pub fn open_sqlite_read_only(path: &Path) -> Result<Self> {
        if !path.is_file() {
            return Err(Error::Invalid(format!("sqlite database does not exist: {}", path.display())));
        }
        let path_buf = path.to_path_buf();
        let read_conn = block_on(async move {
            let read_opts = SqliteConnectOptions::new()
                .filename(&path_buf)
                .read_only(true)
                .busy_timeout(Duration::from_secs(5));
            let read_pool = SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(read_opts).await?;
            Ok::<_, sqlx::Error>(SqlxSqliteConnector::from_sqlx_sqlite_pool(read_pool))
        })?;
        let backend = read_conn.get_database_backend();
        Ok(Self(Arc::new(SeaOrmInner {
            write_conn: Mutex::new(None),
            read_conn: Mutex::new(Some(read_conn)),
            write_lock: AsyncMutex::new(()),
            backend,
            owns_conns: true,
            read_only: true,
            hub: LiveHub::new(Arc::new(now_ms)),
        })))
    }

    /// Wraps externally managed `DatabaseConnection` handles (e.g., server's shared pools) and runs durable migrations.
    pub fn from_sea_orm_conns(write: DatabaseConnection, read: Option<DatabaseConnection>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Self::init(write, read, false, false, clock)
    }

    fn init(
        write: DatabaseConnection,
        read: Option<DatabaseConnection>,
        owns_conns: bool,
        read_only: bool,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self> {
        if !read_only {
            block_on(Migrator::up(&write, None))?;
        }
        let backend = write.get_database_backend();
        Ok(Self(Arc::new(SeaOrmInner {
            write_conn: Mutex::new(Some(write)),
            read_conn: Mutex::new(read),
            write_lock: AsyncMutex::new(()),
            backend,
            owns_conns,
            read_only,
            hub: LiveHub::new(Arc::new(clock)),
        })))
    }

    fn clone_read_conn(&self) -> Result<DatabaseConnection> {
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        if let Some(conn) = self.0.read_conn.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            return Ok(conn.clone());
        }
        self.0
            .write_conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::Invalid("sea-orm storage has no connection".into()))
    }

    fn clone_write_conn(&self) -> Result<DatabaseConnection> {
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        self.0
            .write_conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::Invalid("sea-orm storage has no writer connection".into()))
    }
}

impl StorageBackend for SeaOrmStorage {
    fn kind(&self) -> &'static str {
        match self.0.backend {
            DbBackend::Sqlite => "sqlite",
            DbBackend::Postgres => "postgres",
            DbBackend::MySql => "mysql",
            _ => "sea_orm",
        }
    }

    fn is_read_only(&self) -> bool {
        self.0.read_only
    }

    fn now_ms(&self) -> i64 {
        self.0.hub.now_ms()
    }

    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()> {
        let conn = self.clone_read_conn()?;
        let opts = self.read_tx_options();
        let txn = block_on(conn.begin_with_options(opts))?;
        let reader = SeaOrmTx(&txn);
        let outcome = f(&reader);
        match outcome {
            Ok(()) => {
                block_on(txn.commit())?;
                Ok(())
            }
            Err(err) => {
                let _ = block_on(txn.rollback());
                Err(err)
            }
        }
    }

    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()> {
        if self.0.read_only {
            return Err(Error::Invalid("sea-orm storage is open read-only".into()));
        }
        let _write_guard = block_on(self.0.write_lock.lock());
        let conn = self.clone_write_conn()?;
        self.0.hub.record_request();

        let opts = self.write_tx_options();
        let txn = block_on(conn.begin_with_options(opts))?;
        let now = self.now_ms();
        let outcome = {
            let view = SeaOrmTx(&txn);
            let db_tx = DbTx::new(&txn);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&view, &view, Some(&db_tx), now)))
        };

        match outcome {
            Ok(Ok(write_outcome)) => {
                if let Err(err) = block_on(txn.commit()) {
                    self.0.hub.record_failure();
                    return Err(Error::Commit(err.to_string()));
                }
                self.0.hub.record_commit_and_publish(write_outcome.events, write_outcome.tasks_changed);
                Ok(())
            }
            Ok(Err(err)) => {
                let _ = block_on(txn.rollback());
                self.0.hub.record_failure();
                Err(err)
            }
            Err(panic) => {
                let _ = block_on(txn.rollback());
                self.0.hub.record_failure();
                std::panic::resume_unwind(panic);
            }
        }
    }

    fn read_dyn_async<'a>(&'a self, op: &'a mut dyn ReadAsyncOp<'a>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let conn = self.clone_read_conn()?;
            let txn = conn.begin_with_options(self.read_tx_options()).await?;
            let outcome = {
                let reader = SeaOrmTx(&txn);
                std::panic::AssertUnwindSafe(op.call(&reader)).catch_unwind().await
            };
            match outcome {
                Ok(Ok(())) => {
                    txn.commit().await?;
                    Ok(())
                }
                Ok(Err(err)) => {
                    let _ = txn.rollback().await;
                    Err(err)
                }
                Err(panic) => {
                    let _ = txn.rollback().await;
                    std::panic::resume_unwind(panic);
                }
            }
        })
    }

    fn write_dyn_async<'a>(&'a self, op: &'a mut dyn WriteAsyncOp<'a>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if self.0.read_only {
                return Err(Error::Invalid("sea-orm storage is open read-only".into()));
            }
            let _write_guard = self.0.write_lock.lock().await;
            let conn = self.clone_write_conn()?;
            self.0.hub.record_request();

            let txn = conn.begin_with_options(self.write_tx_options()).await?;
            let now = self.now_ms();
            let outcome = {
                let view = SeaOrmTx(&txn);
                let db_tx = DbTx::new(&txn);
                std::panic::AssertUnwindSafe(op.call(&view, &view, Some(&db_tx), now)).catch_unwind().await
            };

            match outcome {
                Ok(Ok(write_outcome)) => {
                    if let Err(err) = txn.commit().await {
                        self.0.hub.record_failure();
                        return Err(Error::Commit(err.to_string()));
                    }
                    self.0.hub.record_commit_and_publish(write_outcome.events, write_outcome.tasks_changed);
                    Ok(())
                }
                Ok(Err(err)) => {
                    let _ = txn.rollback().await;
                    self.0.hub.record_failure();
                    Err(err)
                }
                Err(panic) => {
                    let _ = txn.rollback().await;
                    self.0.hub.record_failure();
                    std::panic::resume_unwind(panic);
                }
            }
        })
    }

    fn stats(&self) -> CommitStats {
        self.0.hub.stats()
    }

    fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        self.0.hub.subscribe_documents()
    }

    fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        self.0.hub.subscribe_tasks()
    }

    fn close(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Ok(());
        }
        let _write_guard = block_on(self.0.write_lock.lock());
        if self.0.hub.is_closed() {
            return Ok(());
        }
        self.0.hub.mark_closed();
        let read_conn = self.0.read_conn.lock().unwrap_or_else(|e| e.into_inner()).take();
        let write_conn = self.0.write_conn.lock().unwrap_or_else(|e| e.into_inner()).take();
        if self.0.owns_conns {
            block_on(async move {
                if let Some(conn) = read_conn {
                    let _ = conn.close().await;
                }
                if let Some(conn) = write_conn {
                    let _ = conn.close().await;
                }
            });
        }
        Ok(())
    }
}

impl SeaOrmStorage {
    fn read_tx_options(&self) -> TransactionOptions {
        match self.0.backend {
            DbBackend::Postgres => TransactionOptions {
                access_mode: Some(AccessMode::ReadOnly),
                ..Default::default()
            },
            _ => TransactionOptions::default(),
        }
    }

    fn write_tx_options(&self) -> TransactionOptions {
        match self.0.backend {
            DbBackend::Sqlite => TransactionOptions {
                sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
                ..Default::default()
            },
            _ => TransactionOptions::default(),
        }
    }
}

struct SeaOrmTx<'a>(&'a DatabaseTransaction);

impl SeaOrmTx<'_> {
    /// Wraps each write operation in a nested savepoint on PostgreSQL so a caught SQL
    /// constraint error (e.g. duplicate `create_conversation`) does not abort the outer tx (`25P02`).
    fn write_op<T>(&self, f: impl for<'c> AsyncFnOnce(&'c DatabaseTransaction) -> Result<T>) -> Result<T> {
        block_on(self.write_op_async(f))
    }

    async fn write_op_async<T>(&self, f: impl for<'c> AsyncFnOnce(&'c DatabaseTransaction) -> Result<T>) -> Result<T> {
        if self.0.get_database_backend() == DbBackend::Postgres {
            let sp = self.0.begin().await?;
            match f(&sp).await {
                Ok(val) => {
                    sp.commit().await?;
                    Ok(val)
                }
                Err(err) => {
                    let _ = sp.rollback().await;
                    Err(err)
                }
            }
        } else {
            f(self.0).await
        }
    }
}

impl StorageRead for SeaOrmTx<'_> {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        block_on(ops::document(self.0, scope, id, kind))
    }

    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        block_on(ops::documents_by_kind(self.0, scope, kind))
    }

    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        block_on(ops::documents_by_scope(self.0, scope, id))
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        block_on(ops::conversation(self.0, id))
    }

    fn conversations(&self) -> Result<Vec<Conversation>> {
        block_on(ops::conversations(self.0))
    }

    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>> {
        block_on(ops::conversations_by_owner_task(self.0, owner_task_id))
    }

    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
        block_on(ops::entries_from(self.0, conv, from_seq))
    }

    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
        block_on(ops::entries_within(self.0, conv, first_seq, last_seq))
    }

    fn submission(&self, id: &str) -> Result<Option<Submission>> {
        block_on(ops::submission(self.0, id))
    }

    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>> {
        block_on(ops::submission_by_request(self.0, conv, request_id))
    }

    fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        block_on(ops::submissions(self.0, conv))
    }

    fn task(&self, id: &str) -> Result<Option<Task>> {
        block_on(ops::task(self.0, id))
    }

    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        block_on(ops::task_by_dedup(self.0, owner, key))
    }

    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>> {
        block_on(ops::tasks_by_conversation(self.0, conv))
    }

    fn children(&self, owner: &str) -> Result<Vec<Task>> {
        block_on(ops::children(self.0, owner))
    }

    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        block_on(ops::tasks_by_status(self.0, status))
    }

    fn active_tasks(&self) -> Result<Vec<Task>> {
        block_on(ops::active_tasks(self.0))
    }

    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        block_on(ops::signals(self.0, task_id, include_consumed))
    }

    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
        block_on(ops::signal_by_key(self.0, task_id, name, key))
    }

    fn document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str) -> BoxFuture<'a, Result<Option<Document>>> {
        Box::pin(ops::document(self.0, scope, id, kind))
    }

    fn documents_by_kind_async<'a>(&'a self, scope: &'a str, kind: &'a str) -> BoxFuture<'a, Result<Vec<Document>>> {
        Box::pin(ops::documents_by_kind(self.0, scope, kind))
    }

    fn documents_by_scope_async<'a>(&'a self, scope: &'a str, id: &'a str) -> BoxFuture<'a, Result<Vec<Document>>> {
        Box::pin(ops::documents_by_scope(self.0, scope, id))
    }

    fn conversation_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Conversation>>> {
        Box::pin(ops::conversation(self.0, id))
    }

    fn conversations_async(&self) -> BoxFuture<'_, Result<Vec<Conversation>>> {
        Box::pin(ops::conversations(self.0))
    }

    fn conversations_by_owner_task_async<'a>(&'a self, owner_task_id: &'a str) -> BoxFuture<'a, Result<Vec<Conversation>>> {
        Box::pin(ops::conversations_by_owner_task(self.0, owner_task_id))
    }

    fn entries_from_async<'a>(&'a self, conv: &'a str, from_seq: i64) -> BoxFuture<'a, Result<Vec<Entry>>> {
        Box::pin(ops::entries_from(self.0, conv, from_seq))
    }

    fn entries_within_async<'a>(&'a self, conv: &'a str, first_seq: i64, last_seq: i64) -> BoxFuture<'a, Result<Vec<Entry>>> {
        Box::pin(ops::entries_within(self.0, conv, first_seq, last_seq))
    }

    fn submission_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Submission>>> {
        Box::pin(ops::submission(self.0, id))
    }

    fn submission_by_request_async<'a>(&'a self, conv: &'a str, request_id: &'a str) -> BoxFuture<'a, Result<Option<Submission>>> {
        Box::pin(ops::submission_by_request(self.0, conv, request_id))
    }

    fn submissions_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<Vec<Submission>>> {
        Box::pin(ops::submissions(self.0, conv))
    }

    fn task_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Task>>> {
        Box::pin(ops::task(self.0, id))
    }

    fn task_by_dedup_async<'a>(&'a self, owner: &'a str, key: &'a str) -> BoxFuture<'a, Result<Option<Task>>> {
        Box::pin(ops::task_by_dedup(self.0, owner, key))
    }

    fn tasks_by_conversation_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<Vec<Task>>> {
        Box::pin(ops::tasks_by_conversation(self.0, conv))
    }

    fn children_async<'a>(&'a self, owner: &'a str) -> BoxFuture<'a, Result<Vec<Task>>> {
        Box::pin(ops::children(self.0, owner))
    }

    fn tasks_by_status_async(&self, status: TaskStatus) -> BoxFuture<'_, Result<Vec<Task>>> {
        Box::pin(ops::tasks_by_status(self.0, status))
    }

    fn active_tasks_async(&self) -> BoxFuture<'_, Result<Vec<Task>>> {
        Box::pin(ops::active_tasks(self.0))
    }

    fn signals_async<'a>(&'a self, task_id: &'a str, include_consumed: bool) -> BoxFuture<'a, Result<Vec<Signal>>> {
        Box::pin(ops::signals(self.0, task_id, include_consumed))
    }

    fn signal_by_key_async<'a>(&'a self, task_id: &'a str, name: &'a str, key: &'a str) -> BoxFuture<'a, Result<Option<Signal>>> {
        Box::pin(ops::signal_by_key(self.0, task_id, name, key))
    }
}

impl StorageWrite for SeaOrmTx<'_> {
    fn put_document(&self, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64> {
        self.write_op(async |tx| ops::put_document(tx, scope, id, kind, state, now_ms).await)
    }

    fn delete_document(&self, scope: &str, id: &str, kind: &str) -> Result<()> {
        self.write_op(async |tx| ops::delete_document(tx, scope, id, kind).await)
    }

    fn insert_conversation(&self, conv: &Conversation) -> Result<()> {
        self.write_op(async |tx| ops::insert_conversation(tx, conv).await)
    }

    fn advance_sequence(&self, conv: &str, now_ms: i64) -> Result<Option<i64>> {
        self.write_op(async |tx| ops::advance_sequence(tx, conv, now_ms).await)
    }

    fn insert_entry(&self, entry: &Entry) -> Result<()> {
        self.write_op(async |tx| ops::insert_entry(tx, entry).await)
    }

    fn set_head(&self, conv: &str, head_seq: i64) -> Result<()> {
        self.write_op(async |tx| ops::set_head(tx, conv, head_seq).await)
    }

    fn reset_head(&self, conv: &str) -> Result<()> {
        self.write_op(async |tx| ops::reset_head(tx, conv).await)
    }

    fn insert_submission(&self, sub: &Submission) -> Result<()> {
        self.write_op(async |tx| ops::insert_submission(tx, sub).await)
    }

    fn set_submission_status(&self, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()> {
        self.write_op(async |tx| ops::set_submission_status(tx, id, status, now_ms).await)
    }

    fn settle_submission(&self, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()> {
        self.write_op(async |tx| ops::settle_submission(tx, id, status, result, now_ms).await)
    }

    fn insert_task(&self, task: &Task) -> Result<()> {
        self.write_op(async |tx| ops::insert_task(tx, task).await)
    }

    fn update_task(&self, task: &Task, now_ms: i64) -> Result<bool> {
        self.write_op(async |tx| ops::update_task(tx, task, now_ms).await)
    }

    fn insert_signal(&self, signal: &Signal) -> Result<Signal> {
        self.write_op(async |tx| ops::insert_signal(tx, signal).await)
    }

    fn consume_first_signal(&self, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>> {
        self.write_op(async |tx| ops::consume_first_signal(tx, task_id, name, now_ms).await)
    }

    fn put_document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str, state: &'a Value, now_ms: i64) -> BoxFuture<'a, Result<i64>> {
        Box::pin(self.write_op_async(async move |tx| ops::put_document(tx, scope, id, kind, state, now_ms).await))
    }

    fn delete_document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::delete_document(tx, scope, id, kind).await))
    }

    fn insert_conversation_async<'a>(&'a self, conv: &'a Conversation) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::insert_conversation(tx, conv).await))
    }

    fn advance_sequence_async<'a>(&'a self, conv: &'a str, now_ms: i64) -> BoxFuture<'a, Result<Option<i64>>> {
        Box::pin(self.write_op_async(async move |tx| ops::advance_sequence(tx, conv, now_ms).await))
    }

    fn insert_entry_async<'a>(&'a self, entry: &'a Entry) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::insert_entry(tx, entry).await))
    }

    fn set_head_async<'a>(&'a self, conv: &'a str, head_seq: i64) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::set_head(tx, conv, head_seq).await))
    }

    fn reset_head_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::reset_head(tx, conv).await))
    }

    fn insert_submission_async<'a>(&'a self, sub: &'a Submission) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::insert_submission(tx, sub).await))
    }

    fn set_submission_status_async<'a>(&'a self, id: &'a str, status: SubmissionStatus, now_ms: i64) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::set_submission_status(tx, id, status, now_ms).await))
    }

    fn settle_submission_async<'a>(&'a self, id: &'a str, status: SubmissionStatus, result: &'a Value, now_ms: i64) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::settle_submission(tx, id, status, result, now_ms).await))
    }

    fn insert_task_async<'a>(&'a self, task: &'a Task) -> BoxFuture<'a, Result<()>> {
        Box::pin(self.write_op_async(async move |tx| ops::insert_task(tx, task).await))
    }

    fn update_task_async<'a>(&'a self, task: &'a Task, now_ms: i64) -> BoxFuture<'a, Result<bool>> {
        Box::pin(self.write_op_async(async move |tx| ops::update_task(tx, task, now_ms).await))
    }

    fn insert_signal_async<'a>(&'a self, signal: &'a Signal) -> BoxFuture<'a, Result<Signal>> {
        Box::pin(self.write_op_async(async move |tx| ops::insert_signal(tx, signal).await))
    }

    fn consume_first_signal_async<'a>(&'a self, task_id: &'a str, name: &'a str, now_ms: i64) -> BoxFuture<'a, Result<Option<Signal>>> {
        Box::pin(self.write_op_async(async move |tx| ops::consume_first_signal(tx, task_id, name, now_ms).await))
    }
}
