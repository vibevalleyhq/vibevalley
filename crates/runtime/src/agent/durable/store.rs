//! Backend-agnostic durable store facade (`Store`, `Read`, `Tx`).

use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde_json::{Value, json};

use super::storage::{DbTx, JsonlOptions, JsonlStorage, MemoryStorage, SeaOrmStorage, SqliteStorage, StorageBackend, StorageRead, StorageWrite, WriteOutcome};
use super::telemetry::{NoopTelemetrySink, TelemetryEvent, TelemetrySink};
use super::{CommitStats, Document, DocumentEvent, Error, Result, Sqlite};

pub struct Read<'a> {
    pub(crate) ops: &'a dyn StorageRead,
}

pub struct Tx<'a> {
    pub(crate) read: Read<'a>,
    pub(crate) write: &'a dyn StorageWrite,
    pub(crate) sqlite: Option<&'a Sqlite<'a>>,
    pub(crate) db_tx: Option<&'a DbTx<'a>>,
    pub now_ms: i64,
    pub(crate) events: Vec<DocumentEvent>,
    pub(crate) tasks_changed: bool,
    pub(crate) telemetry_events: Vec<TelemetryEvent>,
}

impl<'a> Deref for Tx<'a> {
    type Target = Read<'a>;
    fn deref(&self) -> &Self::Target {
        &self.read
    }
}

#[derive(Clone)]
pub struct Store {
    backend: Arc<dyn StorageBackend>,
    telemetry: Arc<RwLock<Arc<dyn TelemetrySink>>>,
}

impl Store {
    pub fn from_backend(backend: Arc<dyn StorageBackend>) -> Self {
        Self {
            backend,
            telemetry: Arc::new(RwLock::new(Arc::new(NoopTelemetrySink))),
        }
    }

    pub fn from_sqlite_pools(write_pool: sqlx::SqlitePool, read_pool: Option<sqlx::SqlitePool>) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SqliteStorage::from_pools(write_pool, read_pool, super::now_ms)?)))
    }

    pub fn connect(url: &str) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::connect(url)?)))
    }

    pub fn connect_with_clock(url: &str, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::connect_with_clock(url, clock)?)))
    }

    pub fn from_sea_orm_conns(
        write: sea_orm::DatabaseConnection,
        read: Option<sea_orm::DatabaseConnection>,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::from_sea_orm_conns(write, read, clock)?)))
    }

    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SqliteStorage::open(path)?)))
    }

    pub fn open_read_only(path: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SqliteStorage::open_read_only(path)?)))
    }

    pub fn open_any_read_only(path: &Path) -> Result<Self> {
        if path.is_dir() {
            Self::jsonl_read_only(path)
        } else {
            Self::open_read_only(path)
        }
    }

    pub fn open_with_clock(path: Option<&Path>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SqliteStorage::open_with_clock(path, clock)?)))
    }

    pub fn sqlite_memory() -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SqliteStorage::memory()?)))
    }

    pub fn memory() -> Result<Self> {
        Ok(Self::from_backend(Arc::new(MemoryStorage::new())))
    }

    pub fn memory_with_clock(clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(MemoryStorage::with_clock(clock))))
    }

    pub fn jsonl(dir: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(JsonlStorage::open(dir)?)))
    }

    pub fn jsonl_with_options(dir: &Path, opts: JsonlOptions) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(JsonlStorage::open_with_options(dir, opts)?)))
    }

    pub fn jsonl_with_clock(dir: &Path, opts: JsonlOptions, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(JsonlStorage::open_with_clock(dir, opts, clock)?)))
    }

    pub fn jsonl_read_only(dir: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(JsonlStorage::open_read_only(dir)?)))
    }

    pub fn set_telemetry(&self, sink: Arc<dyn TelemetrySink>) {
        *self.telemetry.write().unwrap_or_else(|e| e.into_inner()) = sink;
    }

    pub(crate) fn emit_telemetry(&self, event: TelemetryEvent) {
        let sink = self.telemetry.read().unwrap_or_else(|e| e.into_inner()).clone();
        sink.record(&event);
    }

    pub fn backend_kind(&self) -> &'static str {
        self.backend.kind()
    }

    pub fn is_read_only(&self) -> bool {
        self.backend.is_read_only()
    }

    pub fn now_ms(&self) -> i64 {
        self.backend.now_ms()
    }

    pub fn read<T>(&self, f: impl FnOnce(&Read<'_>) -> Result<T>) -> Result<T> {
        let mut f = Some(f);
        let mut out = None;
        self.backend.read_dyn(&mut |ops| {
            let fun = f.take().expect("read_dyn calls closure once");
            let val = fun(&Read { ops })?;
            out = Some(val);
            Ok(())
        })?;
        Ok(out.expect("read_dyn completed without value"))
    }

    pub fn write<T>(&self, f: impl FnOnce(&mut Tx<'_>) -> Result<T>) -> Result<T> {
        let mut f = Some(f);
        let mut out = None;
        let mut staged_telemetry = Vec::new();
        self.backend.write_dyn(&mut |ops, write, sqlite, db_tx, now_ms| {
            let fun = f.take().expect("write_dyn calls closure once");
            staged_telemetry.clear();
            let mut tx = Tx {
                read: Read { ops },
                write,
                sqlite,
                db_tx,
                now_ms,
                events: Vec::new(),
                tasks_changed: false,
                telemetry_events: Vec::new(),
            };
            let val = fun(&mut tx)?;
            out = Some(val);
            staged_telemetry = tx.telemetry_events;
            Ok(WriteOutcome {
                events: tx.events,
                tasks_changed: tx.tasks_changed,
            })
        })?;
        for event in staged_telemetry {
            self.emit_telemetry(event);
        }
        Ok(out.expect("write_dyn completed without value"))
    }

    pub fn stats(&self) -> CommitStats {
        self.backend.stats()
    }

    pub fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        self.backend.subscribe_documents()
    }

    /// A coalesced hint after committed task or signal writes; subscribe before reading state.
    pub fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        self.backend.subscribe_tasks()
    }

    pub fn close(&self) -> Result<()> {
        self.backend.close()
    }
}

impl Read<'_> {
    pub fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        self.ops.document(scope, id, kind)
    }

    pub fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        self.ops.documents_by_kind(scope, kind)
    }

    pub fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        self.ops.documents_by_scope(scope, id)
    }
}

impl<'a> Tx<'a> {
    pub(crate) fn record_telemetry(&mut self, event: TelemetryEvent) {
        self.telemetry_events.push(event);
    }

    /// Returns the underlying SQLite connection when running on `SqliteStorage`.
    pub fn sqlite_connection(&self) -> Option<&Sqlite<'a>> {
        self.sqlite
    }

    /// Returns the active SeaORM transaction when running on `SeaOrmStorage`.
    pub fn db_tx(&self) -> Option<&DbTx<'a>> {
        self.db_tx
    }

    /// Domain writes through this view join the current SeaORM operation transaction.
    /// Panics if the `Store` is not backed by `SeaOrmStorage`.
    pub fn transaction(&self) -> &sea_orm::DatabaseTransaction {
        self.db_tx().expect("Tx::transaction() requires a SeaOrmStorage-backed Store").inner()
    }

    /// Domain writes through this view join the current operation's savepoint.
    /// Panics if the `Store` is not backed by SQLite.
    pub fn connection(&self) -> &Sqlite<'a> {
        self.sqlite_connection().expect("Tx::connection() requires a SQLite-backed Store")
    }

    pub fn put_document(&mut self, scope: &str, id: &str, kind: &str, state: &Value) -> Result<Document> {
        if [scope, id, kind].contains(&"") {
            return Err(Error::Invalid("document key is empty".into()));
        }
        let rev = self.write.put_document(scope, id, kind, state, self.now_ms)?;
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
            self.write.delete_document(scope, id, kind)?;
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
