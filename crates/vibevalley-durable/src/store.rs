use crate::{CommitStats, Document, DocumentEvent, Error, Result, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ops::Deref,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

pub struct Read<'a> {
    pub(crate) conn: &'a Connection,
}
pub struct Tx<'a> {
    pub(crate) read: Read<'a>,
    pub now_ms: i64,
    events: Vec<DocumentEvent>,
    pub(crate) tasks_changed: bool,
}
impl<'a> Deref for Tx<'a> {
    type Target = Read<'a>;
    fn deref(&self) -> &Self::Target {
        &self.read
    }
}

type Ack = flume::Sender<std::result::Result<(), String>>;
type DocKey = (String, String, String);
struct Deferred {
    state: Value,
    mem_pending: bool,
    updated_at_ms: i64,
}
struct Database {
    conn: Connection,
    closed: bool,
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

impl Database {
    fn flush(&mut self) -> Result<()> {
        if self.waiting.is_empty() {
            return Ok(());
        }
        self.stats.batches += 1;
        let outcome = self.conn.execute_batch("COMMIT");
        if outcome.is_err() {
            let _ = self.conn.execute_batch("ROLLBACK");
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
                let rev = self
                    .published
                    .get(key)
                    .map(|d| d.rev)
                    .unwrap_or(Read { conn: &self.conn }.document(&key.0, &key.1, &key.2)?.map_or(0, |d| d.rev))
                    + 1;
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
            let dbtx = self.conn.transaction()?;
            let mut tx = Tx {
                read: Read { conn: &dbtx },
                now_ms: now,
                events: vec![],
                tasks_changed: false,
            };
            for ((scope, id, kind), d) in &self.live {
                tx.put_document(scope, id, kind, &d.state)?;
            }
            let events = tx.events;
            dbtx.commit()?;
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

struct Inner {
    db: Mutex<Database>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        if let Ok(db) = self.db.get_mut()
            && !db.closed
        {
            let _ = db.live_flush((self.clock)(), true);
        }
    }
}

#[derive(Clone)]
pub struct Store(Arc<Inner>);
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::from_connection(Connection::open(path)?, now_ms)
    }
    pub fn memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, now_ms)
    }
    pub fn from_connection(conn: Connection, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(Self(Arc::new(Inner {
            db: Mutex::new(Database {
                conn,
                closed: false,
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
    pub fn now_ms(&self) -> i64 {
        (self.0.clock)()
    }
    fn lock(&self) -> Result<MutexGuard<'_, Database>> {
        let db = self.0.db.lock().unwrap_or_else(|e| e.into_inner());
        if db.closed {
            return Err(Error::Closed);
        }
        Ok(db)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Read<'_>) -> Result<T>) -> Result<T> {
        let mut db = self.lock()?;
        db.flush()?;
        let tx = db.conn.transaction()?;
        let result = f(&Read { conn: &tx })?;
        tx.commit()?;
        Ok(result)
    }

    pub fn write<T>(&self, f: impl FnOnce(&mut Tx<'_>) -> Result<T>) -> Result<T> {
        let (ack, done) = flume::bounded(1);
        let (result, leader) = {
            let mut db = self.lock()?;
            db.stats.requests += 1;
            let leader = db.waiting.is_empty();
            if leader {
                db.conn.execute_batch("BEGIN IMMEDIATE")?;
            }
            db.conn.execute_batch("SAVEPOINT operation")?;
            let mut tx = Tx {
                read: Read { conn: &db.conn },
                now_ms: self.now_ms(),
                events: vec![],
                tasks_changed: false,
            };
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut tx)));
            match outcome {
                Ok(Ok(result)) => {
                    let events = tx.events;
                    let changed = tx.tasks_changed;
                    db.conn.execute_batch("RELEASE operation")?;
                    db.events.extend(events);
                    db.tasks_changed |= changed;
                    db.waiting.push(ack);
                    if db.waiting.len() >= 64 {
                        db.flush()?;
                    }
                    (result, leader)
                }
                other => {
                    db.stats.failed_ops += 1;
                    db.conn.execute_batch("ROLLBACK TO operation; RELEASE operation")?;
                    if leader {
                        db.conn.execute_batch("ROLLBACK")?;
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
        Ok(result)
    }

    pub fn stats(&self) -> CommitStats {
        self.0.db.lock().unwrap().stats
    }
    pub fn flush_deferred(&self) -> Result<()> {
        self.lock()?.live_flush(self.now_ms(), true)
    }
    pub fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        let (tx, rx) = flume::unbounded();
        self.lock()?.docs.push(tx);
        Ok(rx)
    }
    /// A coalesced hint after committed task or signal writes; subscribe before reading state.
    pub fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        let (tx, rx) = flume::bounded(1);
        self.lock()?.tasks.push(tx);
        Ok(rx)
    }
    pub fn put_deferred(&self, scope: &str, id: &str, kind: &str, state: Value) -> Result<()> {
        if scope.is_empty() || id.is_empty() || kind != "pi.live" {
            return Err(Error::Invalid("only a scoped pi.live document can be deferred".into()));
        }
        let mut db = self.lock()?;
        db.flush()?;
        db.live.insert(
            (scope.into(), id.into(), kind.into()),
            Deferred {
                state,
                mem_pending: true,
                updated_at_ms: self.now_ms(),
            },
        );
        let now = self.now_ms();
        db.mem_at.get_or_insert(now + 100);
        db.disk_at.get_or_insert(now + 1000);
        if !db.timer_active {
            db.timer_active = true;
            let inner = Arc::downgrade(&self.0);
            std::thread::spawn(move || {
                loop {
                    let Some(s) = inner.upgrade().map(Store) else {
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
    pub fn flush_due(&self) -> Result<()> {
        self.lock()?.live_flush(self.now_ms(), false)
    }
    pub fn live_document(&self, scope: &str, id: &str) -> Result<Option<Document>> {
        let mut db = self.lock()?;
        db.flush()?;
        let key = (scope.to_owned(), id.to_owned(), "pi.live".to_owned());
        if let Some(doc) = db.published.get(&key) {
            return Ok(Some(doc.clone()));
        }
        Read { conn: &db.conn }.document(scope, id, "pi.live")
    }
    pub fn close(&self) -> Result<()> {
        let mut db = self.0.db.lock().unwrap();
        if db.closed {
            return Ok(());
        }
        db.live_flush(self.now_ms(), true)?;
        db.closed = true;
        db.docs.clear();
        db.tasks.clear();
        Ok(())
    }
}

impl Read<'_> {
    pub fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        Ok(self
            .conn
            .query_row(
                "SELECT rev,state_json,updated_at_ms FROM durable_document WHERE scope_kind=? AND scope_id=? AND doc_kind=?",
                params![scope, id, kind],
                |r| {
                    Ok(Document {
                        scope_kind: scope.into(),
                        scope_id: id.into(),
                        doc_kind: kind.into(),
                        rev: r.get(0)?,
                        state: r.get(1)?,
                        updated_at_ms: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }
    pub fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        let mut q = self
            .conn
            .prepare("SELECT scope_id,rev,state_json,updated_at_ms FROM durable_document WHERE scope_kind=? AND doc_kind=? ORDER BY scope_id")?;
        Ok(q.query_map(params![scope, kind], |r| {
            Ok(Document {
                scope_kind: scope.into(),
                scope_id: r.get(0)?,
                doc_kind: kind.into(),
                rev: r.get(1)?,
                state: r.get(2)?,
                updated_at_ms: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        let mut q = self
            .conn
            .prepare("SELECT doc_kind,rev,state_json,updated_at_ms FROM durable_document WHERE scope_kind=? AND scope_id=? ORDER BY doc_kind")?;
        Ok(q.query_map(params![scope, id], |r| {
            Ok(Document {
                scope_kind: scope.into(),
                scope_id: id.into(),
                doc_kind: r.get(0)?,
                rev: r.get(1)?,
                state: r.get(2)?,
                updated_at_ms: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

impl Tx<'_> {
    pub fn put_document(&mut self, scope: &str, id: &str, kind: &str, state: &Value) -> Result<Document> {
        if [scope, id, kind].contains(&"") {
            return Err(Error::Invalid("document key is empty".into()));
        }
        let rev=self.conn.query_row("INSERT INTO durable_document(scope_kind,scope_id,doc_kind,rev,state_json,updated_at_ms) VALUES (?,?,?,1,?,?) ON CONFLICT(scope_kind,scope_id,doc_kind) DO UPDATE SET rev=rev+1,state_json=excluded.state_json,updated_at_ms=excluded.updated_at_ms RETURNING rev",params![scope,id,kind,state.to_string(),self.now_ms],|r|r.get(0))?;
        let document = Document {
            scope_kind: scope.into(),
            scope_id: id.into(),
            doc_kind: kind.into(),
            rev,
            state: state.clone(),
            updated_at_ms: self.now_ms,
        };
        self.events.push(DocumentEvent {
            document: document.clone(),
            retired: false,
            durable: true,
        });
        Ok(document)
    }
    pub fn delete_document(&mut self, scope: &str, id: &str, kind: &str) -> Result<()> {
        if let Some(mut doc) = self.document(scope, id, kind)? {
            self.conn.execute(
                "DELETE FROM durable_document WHERE scope_kind=? AND scope_id=? AND doc_kind=?",
                params![scope, id, kind],
            )?;
            doc.updated_at_ms = self.now_ms;
            self.events.push(DocumentEvent {
                document: doc,
                retired: true,
                durable: true,
            });
        }
        Ok(())
    }
    pub fn alert(&mut self, conversation: Option<&str>, value: &Value) -> Result<Document> {
        let (scope, id) = conversation.filter(|s| !s.is_empty()).map_or(("global", "inbox"), |c| ("conversation", c));
        let mut data = self.document(scope, id, "pi.inbox")?.map_or(json!({"items":[]}), |d| d.state);
        data["items"]
            .as_array_mut()
            .ok_or_else(|| Error::Invalid("inbox items must be an array".into()))?
            .push(value.clone());
        self.put_document(scope, id, "pi.inbox", &data)
    }
}
