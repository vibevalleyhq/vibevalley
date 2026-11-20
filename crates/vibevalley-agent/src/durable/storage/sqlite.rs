//! SQLite `StorageBackend` with WAL mode, read-only reader pool, and group-commit savepoints.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use pollster::block_on;
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{ConnectOptions, Connection, SqliteConnection};

use super::live::DocKey;
use super::{StorageBackend, StorageRead, StorageWrite, WriteCallback};
use crate::durable::{
    CommitStats, Conversation, Document, DocumentEvent, Entry, Error, Result, Signal, Sqlite, Submission, SubmissionStatus, Task, TaskStatus, WaitMode, now_ms,
    queries as q, sqlite::optional,
};

type Ack = flume::Sender<std::result::Result<(), String>>;

struct Deferred {
    state: Value,
    mem_pending: bool,
    updated_at_ms: i64,
}

struct Database {
    conn: SqliteConnection,
    waiting: Vec<Ack>,
    events: Vec<DocumentEvent>,
    tasks_changed: bool,
    docs: Vec<flume::Sender<DocumentEvent>>,
    tasks: Vec<flume::Sender<()>>,
    live: HashMap<DocKey, Deferred>,
    published: HashMap<DocKey, Document>,
    mem_at: Option<i64>,
    disk_at: Option<i64>,
    timer_active: bool,
    stats: CommitStats,
}

fn batch(conn: &mut SqliteConnection, sql: &'static str) -> sqlx::Result<()> {
    block_on(sqlx::raw_sql(sql).execute(conn)).map(|_| ())
}

impl Database {
    fn flush(&mut self) -> Result<()> {
        if self.waiting.is_empty() {
            return Ok(());
        }
        self.stats.batches += 1;
        let outcome = batch(&mut self.conn, "COMMIT");
        if outcome.is_err() {
            let _ = batch(&mut self.conn, "ROLLBACK");
        }
        let receipt = outcome.as_ref().map(|_| ()).map_err(ToString::to_string);
        if outcome.is_ok() {
            self.stats.committed_ops += self.waiting.len() as u64;
            for e in std::mem::take(&mut self.events) {
                if e.document.doc_kind == "pi.live" {
                    let key = (e.document.scope_kind.clone(), e.document.scope_id.clone(), e.document.doc_kind.clone());
                    self.live.remove(&key);
                    self.published.remove(&key);
                }
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

    fn live_flush(&mut self, now: i64, force: bool) -> Result<()> {
        self.flush()?;
        if force || self.mem_at.is_some_and(|v| v <= now) {
            self.mem_at = None;
            let mut events = vec![];
            for (key, live) in &mut self.live {
                if !live.mem_pending {
                    continue;
                }
                let rev = if let Some(prev) = self.published.get(key) {
                    prev.rev
                } else {
                    let s = Sqlite::new(&mut self.conn);
                    SqliteTx(&s).document(&key.0, &key.1, &key.2)?.map_or(0, |d| d.rev)
                } + 1;
                let doc = Document {
                    scope_kind: key.0.clone(),
                    scope_id: key.1.clone(),
                    doc_kind: key.2.clone(),
                    state: live.state.clone(),
                    updated_at_ms: live.updated_at_ms,
                    rev,
                };
                self.published.insert(key.clone(), doc.clone());
                live.mem_pending = false;
                events.push(DocumentEvent {
                    document: doc,
                    durable: false,
                    retired: false,
                });
            }
            self.stats.coalesced_live_memory += events.len() as u64;
            for event in events {
                self.publish(event);
            }
        }
        if force || self.disk_at.is_some_and(|v| v <= now) {
            let mut dbtx = block_on(self.conn.begin())?;
            let events = {
                let s = Sqlite::new(&mut dbtx);
                let conn = SqliteTx(&s);
                let mut events = Vec::with_capacity(self.live.len());
                for ((scope, id, kind), d) in &self.live {
                    let rev = conn.put_document(scope, id, kind, &d.state, now)?;
                    let document = Document {
                        scope_kind: scope.clone(),
                        scope_id: id.clone(),
                        doc_kind: kind.clone(),
                        rev,
                        state: d.state.clone(),
                        updated_at_ms: now,
                    };
                    events.push(DocumentEvent {
                        document,
                        retired: false,
                        durable: true,
                    });
                }
                events
            };
            block_on(dbtx.commit())?;
            self.stats.coalesced_live_disk += events.len() as u64;
            self.disk_at = None;
            self.live.clear();
            self.published.clear();
            for event in events {
                self.publish(event);
            }
        }
        Ok(())
    }
}

struct SqliteInner {
    db: Mutex<Database>,
    reader: Option<Mutex<SqliteConnection>>,
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
            let _ = db.live_flush((self.clock)(), true);
        }
    }
}

#[derive(Clone)]
pub struct SqliteStorage(Arc<SqliteInner>);

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_clock(Some(path), now_ms)
    }

    pub fn open_read_only(path: &Path) -> Result<Self> {
        if !path.is_file() {
            return Err(Error::Invalid(format!("sqlite database does not exist: {}", path.display())));
        }
        let options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(Duration::from_secs(5));
        let conn = block_on(options.connect())?;
        Ok(Self(Arc::new(SqliteInner {
            reader: None,
            read_only: true,
            closed: AtomicBool::new(false),
            db: Mutex::new(Database {
                conn,
                waiting: vec![],
                events: vec![],
                tasks_changed: false,
                docs: vec![],
                tasks: vec![],
                live: HashMap::new(),
                published: HashMap::new(),
                mem_at: None,
                disk_at: None,
                timer_active: false,
                stats: CommitStats::default(),
            }),
            clock: Arc::new(now_ms),
        })))
    }

    pub fn memory() -> Result<Self> {
        Self::open_with_clock(None, now_ms)
    }

    pub fn open_with_clock(path: Option<&Path>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let options = SqliteConnectOptions::new().busy_timeout(Duration::from_secs(5));
        let write = match path {
            Some(file) => options.clone().filename(file).create_if_missing(true),
            None => options.clone().in_memory(true),
        };
        let mut conn = block_on(write.journal_mode(SqliteJournalMode::Wal).synchronous(SqliteSynchronous::Normal).connect())?;
        batch(&mut conn, include_str!("../schema.sql"))?;
        let reader = path
            .map(|file| block_on(options.filename(file).read_only(true).connect()).map(Mutex::new))
            .transpose()?;
        Ok(Self(Arc::new(SqliteInner {
            reader,
            read_only: false,
            closed: AtomicBool::new(false),
            db: Mutex::new(Database {
                conn,
                waiting: vec![],
                events: vec![],
                tasks_changed: false,
                docs: vec![],
                tasks: vec![],
                live: HashMap::new(),
                published: HashMap::new(),
                mem_at: None,
                disk_at: None,
                timer_active: false,
                stats: CommitStats::default(),
            }),
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
        if let Some(reader) = &self.0.reader {
            let mut conn = reader.lock().unwrap_or_else(|p| p.into_inner());
            if self.0.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            let mut tx = block_on(conn.begin())?;
            let s = Sqlite::new(&mut tx);
            let read = SqliteTx(&s);
            f(&read)?;
            block_on(tx.commit())?;
            return Ok(());
        }
        let mut db = self.lock()?;
        db.flush()?;
        let mut tx = block_on(db.conn.begin())?;
        let s = Sqlite::new(&mut tx);
        let read = SqliteTx(&s);
        f(&read)?;
        block_on(tx.commit())?;
        Ok(())
    }

    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()> {
        if self.0.read_only {
            return Err(Error::Invalid("sqlite storage is open read-only".into()));
        }
        let (ack, done) = flume::bounded(1);
        let leader = {
            let mut db = self.lock()?;
            db.stats.requests += 1;
            let leader = db.waiting.is_empty();
            let start = if leader {
                "BEGIN IMMEDIATE; SAVEPOINT operation"
            } else {
                "SAVEPOINT operation"
            };
            if let Err(error) = batch(&mut db.conn, start) {
                if leader {
                    let _ = batch(&mut db.conn, "ROLLBACK");
                }
                return Err(error.into());
            }
            let now = self.now_ms();
            let conn_wrap = Sqlite::new(&mut db.conn);
            let tx = SqliteTx(&conn_wrap);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&tx, &tx, Some(&conn_wrap), now)));
            match outcome {
                Ok(Ok(write_outcome)) => {
                    batch(&mut db.conn, "RELEASE operation")?;
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
                    let rollback = if leader { "ROLLBACK" } else { "ROLLBACK TO operation; RELEASE operation" };
                    batch(&mut db.conn, rollback)?;
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

    fn put_deferred(&self, scope: &str, id: &str, kind: &str, state: Value) -> Result<()> {
        if self.0.read_only {
            return Err(Error::Invalid("sqlite storage is open read-only".into()));
        }
        if scope.is_empty() || id.is_empty() || kind != "pi.live" {
            return Err(Error::Invalid("only a scoped pi.live document can be deferred".into()));
        }
        let mut db = self.lock()?;
        db.flush()?;
        let now = self.now_ms();
        db.live.insert(
            (scope.into(), id.into(), kind.into()),
            Deferred {
                state,
                mem_pending: true,
                updated_at_ms: now,
            },
        );
        db.mem_at.get_or_insert(now + 100);
        db.disk_at.get_or_insert(now + 1000);
        if !db.timer_active {
            db.timer_active = true;
            let weak = Arc::downgrade(&self.0);
            std::thread::spawn(move || {
                loop {
                    let Some(s) = weak.upgrade().map(SqliteStorage) else {
                        return;
                    };
                    let Ok(mut db) = s.lock() else {
                        return;
                    };
                    let now = s.now_ms();
                    // A transient write failure leaves the documents pending for the next disk deadline.
                    if db.live_flush(now, false).is_err() {
                        db.disk_at = Some(now + 1000);
                    }
                    let until = db.mem_at.into_iter().chain(db.disk_at).min();
                    let Some(until) = until else {
                        db.timer_active = false;
                        return;
                    };
                    drop(db);
                    drop(s);
                    std::thread::sleep(Duration::from_millis((until - now).clamp(1, 100) as u64));
                }
            });
        }
        Ok(())
    }

    fn flush_due(&self) -> Result<()> {
        if self.0.read_only {
            return Ok(());
        }
        self.lock()?.live_flush(self.now_ms(), false)
    }

    fn flush_deferred(&self) -> Result<()> {
        if self.0.read_only {
            return Ok(());
        }
        self.lock()?.live_flush(self.now_ms(), true)
    }

    fn live_document(&self, scope: &str, id: &str) -> Result<Option<Document>> {
        let mut db = self.lock()?;
        db.flush()?;
        let key = (scope.to_owned(), id.to_owned(), "pi.live".to_owned());
        if let Some(doc) = db.published.get(&key) {
            return Ok(Some(doc.clone()));
        }
        let s = Sqlite::new(&mut db.conn);
        SqliteTx(&s).document(scope, id, "pi.live")
    }

    fn close(&self) -> Result<()> {
        let mut db = self.0.db.lock().unwrap();
        if self.0.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.0.read_only {
            db.live_flush(self.now_ms(), true)?;
        }
        self.0.closed.store(true, Ordering::Release);
        db.docs.clear();
        db.tasks.clear();
        Ok(())
    }
}

struct SqliteTx<'b, 'a>(&'b Sqlite<'a>);

impl StorageRead for SqliteTx<'_, '_> {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        optional(self.0.query(async |db| {
            q::get_document(
                db,
                q::GetDocumentParams {
                    scope_kind: scope.into(),
                    scope_id: id.into(),
                    doc_kind: kind.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }

    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        self.0
            .query(async |db| {
                q::documents_by_kind(
                    db,
                    q::DocumentsByKindParams {
                        scope_kind: scope.into(),
                        doc_kind: kind.into(),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        self.0
            .query(async |db| {
                q::documents_by_scope(
                    db,
                    q::DocumentsByScopeParams {
                        scope_kind: scope.into(),
                        scope_id: id.into(),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        optional(
            self.0
                .query(async |db| q::get_conversation(db, q::GetConversationParams { id: id.into() }).await),
        )?
        .map(TryInto::try_into)
        .transpose()
    }

    fn conversations(&self) -> Result<Vec<Conversation>> {
        self.0
            .query(async |db| q::list_conversations(db).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>> {
        self.0
            .query(async |db| {
                q::conversations_by_owner(
                    db,
                    q::ConversationsByOwnerParams {
                        owner_task_id: owner_task_id.into(),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
        self.0
            .query(async |db| {
                q::entries_from(
                    db,
                    q::EntriesFromParams {
                        conversation_id: conv.into(),
                        seq: from_seq,
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
        self.0
            .query(async |db| {
                q::entries_within(
                    db,
                    q::EntriesWithinParams {
                        conversation_id: conv.into(),
                        first_seq,
                        last_seq,
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn submission(&self, id: &str) -> Result<Option<Submission>> {
        optional(self.0.query(async |db| q::get_submission(db, q::GetSubmissionParams { id: id.into() }).await))?
            .map(TryInto::try_into)
            .transpose()
    }

    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>> {
        optional(self.0.query(async |db| {
            q::submission_by_request(
                db,
                q::SubmissionByRequestParams {
                    conversation_id: conv.into(),
                    request_id: request_id.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }

    fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        self.0
            .query(async |db| q::submissions(db, q::SubmissionsParams { conversation_id: conv.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn task(&self, id: &str) -> Result<Option<Task>> {
        optional(self.0.query(async |db| q::get_task(db, q::GetTaskParams { id: id.into() }).await))?
            .map(TryInto::try_into)
            .transpose()
    }

    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        optional(self.0.query(async |db| {
            q::task_by_dedup(
                db,
                q::TaskByDedupParams {
                    owner_task_id: owner.into(),
                    dedup_key: key.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }

    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>> {
        self.0
            .query(async |db| q::conversation_tasks(db, q::ConversationTasksParams { conversation_id: conv.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn children(&self, owner: &str) -> Result<Vec<Task>> {
        self.0
            .query(async |db| q::child_tasks(db, q::ChildTasksParams { owner_task_id: owner.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        self.0
            .query(async |db| {
                q::tasks_by_status(
                    db,
                    q::TasksByStatusParams {
                        status: status.as_str().into(),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn active_tasks(&self) -> Result<Vec<Task>> {
        self.0.query(async |db| q::active_tasks(db).await)?.into_iter().map(TryInto::try_into).collect()
    }

    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        self.0
            .query(async |db| {
                q::task_signals(
                    db,
                    q::TaskSignalsParams {
                        task_id: task_id.into(),
                        include_consumed: i64::from(include_consumed),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }

    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
        optional(self.0.query(async |db| {
            q::signal_by_key(
                db,
                q::SignalByKeyParams {
                    task_id: task_id.into(),
                    signal_name: name.into(),
                    signal_key: key.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }
}

impl StorageWrite for SqliteTx<'_, '_> {
    fn put_document(&self, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64> {
        Ok(self
            .0
            .query(async |db| {
                q::put_document(
                    db,
                    q::PutDocumentParams {
                        scope_kind: scope.into(),
                        scope_id: id.into(),
                        doc_kind: kind.into(),
                        state_json: state.to_string(),
                        updated_at_ms: now_ms,
                    },
                )
                .await
            })?
            .rev)
    }

    fn delete_document(&self, scope: &str, id: &str, kind: &str) -> Result<()> {
        self.0.query(async |db| {
            q::delete_document(
                db,
                q::DeleteDocumentParams {
                    scope_kind: scope.into(),
                    scope_id: id.into(),
                    doc_kind: kind.into(),
                },
            )
            .await
        })?;
        Ok(())
    }

    fn insert_conversation(&self, conv: &Conversation) -> Result<()> {
        if conv.parent_id.is_empty() && conv.head_seq == 1 && conv.next_seq == 1 && conv.fork_entry_seq == 0 {
            self.0.query(async |db| {
                q::insert_conversation(
                    db,
                    q::InsertConversationParams {
                        id: conv.id.clone(),
                        provider_affinity: conv.provider_affinity.clone(),
                        owner_task_id: conv.owner_task_id.clone(),
                        created_at_ms: conv.created_at_ms,
                    },
                )
                .await
            })?;
        } else {
            self.0.query(async |db| {
                q::fork_conversation(
                    db,
                    q::ForkConversationParams {
                        id: conv.id.clone(),
                        owner_task_id: conv.owner_task_id.clone(),
                        parent_id: conv.parent_id.clone(),
                        fork_entry_seq: conv.fork_entry_seq,
                        head_seq: conv.head_seq,
                        next_seq: conv.next_seq,
                        provider_affinity: conv.provider_affinity.clone(),
                        created_at_ms: conv.created_at_ms,
                    },
                )
                .await
            })?;
        }
        Ok(())
    }

    fn advance_sequence(&self, conv: &str, now_ms: i64) -> Result<Option<i64>> {
        Ok(optional(self.0.query(async |db| {
            q::advance_sequence(
                db,
                q::AdvanceSequenceParams {
                    updated_at_ms: now_ms,
                    id: conv.into(),
                },
            )
            .await
        }))?
        .map(|row| row.next_seq))
    }

    fn insert_entry(&self, entry: &Entry) -> Result<()> {
        self.0.query(async |db| {
            q::insert_entry(
                db,
                q::InsertEntryParams {
                    conversation_id: entry.conversation_id.clone(),
                    seq: entry.seq,
                    kind: entry.kind.clone(),
                    payload_json: entry.payload.to_string(),
                    created_at_ms: entry.created_at_ms,
                },
            )
            .await
        })?;
        Ok(())
    }

    fn set_head(&self, conv: &str, head_seq: i64) -> Result<()> {
        self.0.query(async |db| q::set_head(db, q::SetHeadParams { head_seq, id: conv.into() }).await)?;
        Ok(())
    }

    fn reset_head(&self, conv: &str) -> Result<()> {
        self.0.query(async |db| q::reset_head(db, q::ResetHeadParams { id: conv.into() }).await)?;
        Ok(())
    }

    fn insert_submission(&self, sub: &Submission) -> Result<()> {
        self.0.query(async |db| {
            q::insert_submission(
                db,
                q::InsertSubmissionParams {
                    id: sub.id.clone(),
                    conversation_id: sub.conversation_id.clone(),
                    request_id: sub.request_id.clone(),
                    kind: sub.kind.clone(),
                    payload_json: sub.payload.to_string(),
                    notify_task_id: sub.notify_task_id.clone(),
                    created_at_ms: sub.created_at_ms,
                },
            )
            .await
        })?;
        Ok(())
    }

    fn set_submission_status(&self, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()> {
        self.0.query(async |db| {
            q::set_submission_status(
                db,
                q::SetSubmissionStatusParams {
                    status: status.as_str().into(),
                    updated_at_ms: now_ms,
                    id: id.into(),
                },
            )
            .await
        })?;
        Ok(())
    }

    fn settle_submission(&self, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()> {
        self.0.query(async |db| {
            q::settle_submission(
                db,
                q::SettleSubmissionParams {
                    status: status.as_str().into(),
                    result_json: result.to_string(),
                    updated_at_ms: now_ms,
                    id: id.into(),
                },
            )
            .await
        })?;
        Ok(())
    }

    fn insert_task(&self, t: &Task) -> Result<()> {
        self.0.query(async |db| {
            q::insert_task(
                db,
                q::InsertTaskParams {
                    id: t.id.clone(),
                    conversation_id: t.conversation_id.clone(),
                    owner_task_id: t.owner_task_id.clone(),
                    dedup_key: t.dedup_key.clone(),
                    kind: t.kind.clone(),
                    is_model_task: i64::from(t.is_model_task),
                    status: t.status.as_str().into(),
                    terminal_reason: t.terminal_reason.clone(),
                    restart_count: i64::from(t.restart_count),
                    restart_limit: i64::from(t.restart_limit),
                    phase_name: t.phase_name.clone(),
                    checkpoint_json: t.checkpoint.to_string(),
                    wake_until_ms: t.wake_until_ms,
                    wait_mode: t.wait_mode.map_or("", WaitMode::as_str).into(),
                    wait_task_ids_json: json!(t.wait_task_ids).to_string(),
                    wait_signal_name: t.wait_signal_name.clone(),
                    memo_json: t.memo.to_string(),
                    result_json: t.result.to_string(),
                    error_text: t.error_text.clone(),
                    created_at_ms: t.created_at_ms,
                    updated_at_ms: t.updated_at_ms,
                },
            )
            .await
        })?;
        Ok(())
    }

    fn update_task(&self, t: &Task, now_ms: i64) -> Result<bool> {
        let rows = self.0.query(async |db| {
            q::update_task(
                db,
                q::UpdateTaskParams {
                    status: t.status.as_str().into(),
                    terminal_reason: t.terminal_reason.clone(),
                    restart_count: i64::from(t.restart_count),
                    restart_limit: i64::from(t.restart_limit),
                    phase_name: t.phase_name.clone(),
                    checkpoint_json: t.checkpoint.to_string(),
                    wake_until_ms: t.wake_until_ms,
                    wait_mode: t.wait_mode.map_or("", WaitMode::as_str).into(),
                    wait_task_ids_json: json!(t.wait_task_ids).to_string(),
                    wait_signal_name: t.wait_signal_name.clone(),
                    memo_json: t.memo.to_string(),
                    result_json: t.result.to_string(),
                    error_text: t.error_text.clone(),
                    updated_at_ms: now_ms,
                    id: t.id.clone(),
                },
            )
            .await
        })?;
        Ok(rows > 0)
    }

    fn insert_signal(&self, signal: &Signal) -> Result<Signal> {
        self.0
            .query(async |db| {
                q::insert_signal(
                    db,
                    q::InsertSignalParams {
                        id: signal.id.clone(),
                        task_id: signal.task_id.clone(),
                        signal_name: signal.signal_name.clone(),
                        signal_key: signal.signal_key.clone(),
                        payload_json: signal.payload.to_string(),
                        created_at_ms: signal.created_at_ms,
                    },
                )
                .await
            })?
            .try_into()
    }

    fn consume_first_signal(&self, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>> {
        optional(self.0.query(async |db| {
            q::consume_signal(
                db,
                q::ConsumeSignalParams {
                    consumed_at_ms: now_ms,
                    task_id: task_id.into(),
                    signal_name: name.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }
}

impl TryFrom<q::GetDocumentRow> for Document {
    type Error = Error;
    fn try_from(row: q::GetDocumentRow) -> Result<Self> {
        Ok(Self {
            scope_kind: row.scope_kind,
            scope_id: row.scope_id,
            doc_kind: row.doc_kind,
            rev: row.rev,
            state: serde_json::from_str(&row.state_json)?,
            updated_at_ms: row.updated_at_ms,
        })
    }
}

impl TryFrom<q::GetConversationRow> for Conversation {
    type Error = Error;
    fn try_from(r: q::GetConversationRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            owner_task_id: r.owner_task_id,
            parent_id: r.parent_id,
            fork_entry_seq: r.fork_entry_seq,
            head_seq: r.head_seq,
            next_seq: r.next_seq,
            provider_affinity: r.provider_affinity,
            metadata: serde_json::from_str(&r.metadata_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<q::EntriesFromRow> for Entry {
    type Error = Error;
    fn try_from(r: q::EntriesFromRow) -> Result<Self> {
        Ok(Self {
            conversation_id: r.conversation_id,
            seq: r.seq,
            kind: r.kind,
            payload: serde_json::from_str(&r.payload_json)?,
            created_at_ms: r.created_at_ms,
        })
    }
}

impl TryFrom<q::GetSubmissionRow> for Submission {
    type Error = Error;
    fn try_from(r: q::GetSubmissionRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            request_id: r.request_id,
            kind: r.kind,
            status: r.status.parse()?,
            payload: serde_json::from_str(&r.payload_json)?,
            notify_task_id: r.notify_task_id,
            result: serde_json::from_str(&r.result_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<q::GetTaskRow> for Task {
    type Error = Error;
    fn try_from(r: q::GetTaskRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            owner_task_id: r.owner_task_id,
            dedup_key: r.dedup_key,
            kind: r.kind,
            is_model_task: r.is_model_task != 0,
            status: r.status.parse()?,
            terminal_reason: r.terminal_reason,
            restart_count: r.restart_count.try_into().map_err(|_| Error::Invalid("invalid restart count".into()))?,
            restart_limit: r.restart_limit.try_into().map_err(|_| Error::Invalid("invalid restart limit".into()))?,
            phase_name: r.phase_name,
            checkpoint: serde_json::from_str(&r.checkpoint_json)?,
            wake_until_ms: r.wake_until_ms,
            wait_mode: if r.wait_mode.is_empty() { None } else { Some(r.wait_mode.parse()?) },
            wait_task_ids: serde_json::from_str(&r.wait_task_ids_json)?,
            wait_signal_name: r.wait_signal_name,
            memo: serde_json::from_str(&r.memo_json)?,
            result: serde_json::from_str(&r.result_json)?,
            error_text: r.error_text,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<q::TaskSignalsRow> for Signal {
    type Error = Error;
    fn try_from(r: q::TaskSignalsRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            task_id: r.task_id,
            signal_name: r.signal_name,
            signal_key: r.signal_key,
            payload: serde_json::from_str(&r.payload_json)?,
            consumed: r.consumed != 0,
            consumed_at_ms: r.consumed_at_ms,
            created_at_ms: r.created_at_ms,
        })
    }
}
