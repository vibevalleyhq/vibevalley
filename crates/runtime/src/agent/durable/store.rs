//! Backend-agnostic durable store facade (`Store`, `Read`, `Tx`).

use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::storage::{
    BoxFuture, DbTx, JsonlOptions, JsonlStorage, MemoryStorage, ReadAsyncOp, SeaOrmStorage, StorageBackend, StorageRead, StorageWrite, WriteAsyncOp,
    WriteOutcome,
};
use super::telemetry::{NoopTelemetrySink, TelemetryEvent, TelemetrySink};
use super::{CommitStats, Document, DocumentEvent, Error, Result};

pub struct Read<'a> {
    pub(crate) ops: &'a dyn StorageRead,
}

pub struct Tx<'a> {
    pub(crate) read: Read<'a>,
    pub(crate) write: &'a dyn StorageWrite,
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

    pub async fn connect(url: &str) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::connect(url).await?)))
    }

    pub async fn connect_with_clock(url: &str, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::connect_with_clock(url, clock).await?)))
    }

    pub async fn from_sea_orm_conns(
        write: sea_orm::DatabaseConnection,
        read: Option<sea_orm::DatabaseConnection>,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::from_sea_orm_conns(write, read, clock).await?)))
    }

    pub async fn open(path: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::open_sqlite(path).await?)))
    }

    pub async fn open_read_only(path: &Path) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::open_sqlite_read_only(path).await?)))
    }

    pub async fn open_any_read_only(path: &Path) -> Result<Self> {
        if path.is_dir() {
            Self::jsonl_read_only(path)
        } else {
            Self::open_read_only(path).await
        }
    }

    pub async fn open_with_clock(path: Option<&Path>, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::open_sqlite_with_clock(path, clock).await?)))
    }

    pub async fn sqlite_memory() -> Result<Self> {
        Ok(Self::from_backend(Arc::new(SeaOrmStorage::sqlite_memory().await?)))
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

    pub async fn read_async<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'call, 'tx> FnOnce(&'call Read<'tx>) -> BoxFuture<'call, Result<T>> + Send,
        T: Send,
    {
        struct Op<'env, F, T> {
            f: Option<F>,
            out: &'env mut Option<T>,
        }
        impl<'env, T, F> ReadAsyncOp<'env> for Op<'env, F, T>
        where
            F: for<'call, 'tx> FnOnce(&'call Read<'tx>) -> BoxFuture<'call, Result<T>> + Send,
            T: Send,
        {
            fn call<'tx>(&'tx mut self, ops: &'tx dyn StorageRead) -> BoxFuture<'tx, Result<()>>
            where
                'env: 'tx,
            {
                let fun = self.f.take().expect("read_dyn_async calls closure once");
                let out = &mut *self.out;
                Box::pin(async move {
                    let read = Read { ops };
                    let val = fun(&read).await?;
                    *out = Some(val);
                    Ok(())
                })
            }
        }
        let mut out = None;
        let mut op = Op { f: Some(f), out: &mut out };
        self.backend.read_dyn_async(&mut op).await?;
        Ok(out.expect("read_dyn_async completed without value"))
    }

    pub async fn read_with_async<C, T, F>(&self, ctx: C, f: F) -> Result<T>
    where
        C: Send + Sync,
        F: for<'call, 'tx> FnOnce(&'call Read<'tx>, &'call C) -> BoxFuture<'call, Result<T>> + Send,
        T: Send,
    {
        struct Op<'env, C, F, T> {
            ctx: C,
            f: Option<F>,
            out: &'env mut Option<T>,
        }
        impl<'env, C, T, F> ReadAsyncOp<'env> for Op<'env, C, F, T>
        where
            C: Send + Sync,
            F: for<'call, 'tx> FnOnce(&'call Read<'tx>, &'call C) -> BoxFuture<'call, Result<T>> + Send,
            T: Send,
        {
            fn call<'tx>(&'tx mut self, ops: &'tx dyn StorageRead) -> BoxFuture<'tx, Result<()>>
            where
                'env: 'tx,
            {
                let fun = self.f.take().expect("read_dyn_async calls closure once");
                let ctx = &self.ctx;
                let out = &mut *self.out;
                Box::pin(async move {
                    let read = Read { ops };
                    let val = fun(&read, ctx).await?;
                    *out = Some(val);
                    Ok(())
                })
            }
        }
        let mut out = None;
        let mut op = Op {
            ctx,
            f: Some(f),
            out: &mut out,
        };
        self.backend.read_dyn_async(&mut op).await?;
        Ok(out.expect("read_dyn_async completed without value"))
    }

    pub async fn write_async<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'call, 'tx> FnOnce(&'call mut Tx<'tx>) -> BoxFuture<'call, Result<T>> + Send,
        T: Send,
    {
        struct Op<'env, F, T> {
            f: Option<F>,
            out: &'env mut Option<T>,
            telemetry: &'env mut Vec<TelemetryEvent>,
        }
        impl<'env, T, F> WriteAsyncOp<'env> for Op<'env, F, T>
        where
            F: for<'call, 'tx> FnOnce(&'call mut Tx<'tx>) -> BoxFuture<'call, Result<T>> + Send,
            T: Send,
        {
            fn call<'tx>(
                &'tx mut self,
                ops: &'tx dyn StorageRead,
                write: &'tx dyn StorageWrite,
                db_tx: Option<&'tx DbTx<'tx>>,
                now_ms: i64,
            ) -> BoxFuture<'tx, Result<WriteOutcome>>
            where
                'env: 'tx,
            {
                let fun = self.f.take().expect("write_dyn_async calls closure once");
                self.telemetry.clear();
                let out = &mut *self.out;
                let telemetry = &mut *self.telemetry;
                Box::pin(async move {
                    let mut tx = Tx {
                        read: Read { ops },
                        write,
                        db_tx,
                        now_ms,
                        events: Vec::new(),
                        tasks_changed: false,
                        telemetry_events: Vec::new(),
                    };
                    let val = fun(&mut tx).await?;
                    *out = Some(val);
                    *telemetry = tx.telemetry_events;
                    Ok(WriteOutcome {
                        events: tx.events,
                        tasks_changed: tx.tasks_changed,
                    })
                })
            }
        }
        let mut out = None;
        let mut staged_telemetry = Vec::new();
        let mut op = Op {
            f: Some(f),
            out: &mut out,
            telemetry: &mut staged_telemetry,
        };
        self.backend.write_dyn_async(&mut op).await?;
        for event in staged_telemetry {
            self.emit_telemetry(event);
        }
        Ok(out.expect("write_dyn_async completed without value"))
    }

    pub async fn write_with_async<C, T, F>(&self, ctx: C, f: F) -> Result<T>
    where
        C: Send + Sync,
        F: for<'call, 'tx> FnOnce(&'call mut Tx<'tx>, &'call C) -> BoxFuture<'call, Result<T>> + Send,
        T: Send,
    {
        struct Op<'env, C, F, T> {
            ctx: C,
            f: Option<F>,
            out: &'env mut Option<T>,
            telemetry: &'env mut Vec<TelemetryEvent>,
        }
        impl<'env, C, T, F> WriteAsyncOp<'env> for Op<'env, C, F, T>
        where
            C: Send + Sync,
            F: for<'call, 'tx> FnOnce(&'call mut Tx<'tx>, &'call C) -> BoxFuture<'call, Result<T>> + Send,
            T: Send,
        {
            fn call<'tx>(
                &'tx mut self,
                ops: &'tx dyn StorageRead,
                write: &'tx dyn StorageWrite,
                db_tx: Option<&'tx DbTx<'tx>>,
                now_ms: i64,
            ) -> BoxFuture<'tx, Result<WriteOutcome>>
            where
                'env: 'tx,
            {
                let fun = self.f.take().expect("write_dyn_async calls closure once");
                self.telemetry.clear();
                let ctx = &self.ctx;
                let out = &mut *self.out;
                let telemetry = &mut *self.telemetry;
                Box::pin(async move {
                    let mut tx = Tx {
                        read: Read { ops },
                        write,
                        db_tx,
                        now_ms,
                        events: Vec::new(),
                        tasks_changed: false,
                        telemetry_events: Vec::new(),
                    };
                    let val = fun(&mut tx, ctx).await?;
                    *out = Some(val);
                    *telemetry = tx.telemetry_events;
                    Ok(WriteOutcome {
                        events: tx.events,
                        tasks_changed: tx.tasks_changed,
                    })
                })
            }
        }
        let mut out = None;
        let mut staged_telemetry = Vec::new();
        let mut op = Op {
            ctx,
            f: Some(f),
            out: &mut out,
            telemetry: &mut staged_telemetry,
        };
        self.backend.write_dyn_async(&mut op).await?;
        for event in staged_telemetry {
            self.emit_telemetry(event);
        }
        Ok(out.expect("write_dyn_async completed without value"))
    }

    pub fn stats(&self) -> CommitStats {
        self.backend.stats()
    }

    pub fn subscribe_documents(&self) -> Result<mpsc::UnboundedReceiver<DocumentEvent>> {
        self.backend.subscribe_documents()
    }

    /// A coalesced hint after committed task or signal writes; subscribe before reading state.
    pub fn subscribe_tasks(&self) -> Result<mpsc::Receiver<()>> {
        self.backend.subscribe_tasks()
    }

    pub async fn close(&self) -> Result<()> {
        self.backend.close().await
    }
}

impl Read<'_> {
    pub async fn document_async(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        self.ops.document_async(scope, id, kind).await
    }

    pub async fn documents_by_kind_async(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        self.ops.documents_by_kind_async(scope, kind).await
    }

    pub async fn documents_by_scope_async(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        self.ops.documents_by_scope_async(scope, id).await
    }
}

impl<'a> Tx<'a> {
    pub(crate) fn record_telemetry(&mut self, event: TelemetryEvent) {
        self.telemetry_events.push(event);
    }

    /// Returns the active SeaORM transaction when running on `SeaOrmStorage`.
    pub fn db_tx(&self) -> Option<&DbTx<'a>> {
        self.db_tx
    }

    /// Domain writes through this view join the current SeaORM operation transaction.
    /// Panics if the `Store` is not backed by `SeaOrmStorage`.
    pub fn transaction(&self) -> &'a sea_orm::DatabaseTransaction {
        self.db_tx.expect("Tx::transaction() requires a SeaOrmStorage-backed Store").inner()
    }

    pub async fn put_document_async(&mut self, scope: &str, id: &str, kind: &str, state: &Value) -> Result<Document> {
        if [scope, id, kind].contains(&"") {
            return Err(Error::Invalid("document key is empty".into()));
        }
        let rev = self.write.put_document_async(scope, id, kind, state, self.now_ms).await?;
        Ok(self.record_put_document(scope, id, kind, state, rev))
    }

    fn record_put_document(&mut self, scope: &str, id: &str, kind: &str, state: &Value, rev: i64) -> Document {
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
        document
    }

    pub async fn delete_document_async(&mut self, scope: &str, id: &str, kind: &str) -> Result<()> {
        if let Some(doc) = self.document_async(scope, id, kind).await? {
            self.write.delete_document_async(scope, id, kind).await?;
            self.record_delete_document(doc);
        }
        Ok(())
    }

    fn record_delete_document(&mut self, mut doc: Document) {
        doc.updated_at_ms = self.now_ms;
        self.events.push(DocumentEvent {
            document: doc,
            retired: true,
            durable: true,
        });
    }

    pub async fn alert_async(&mut self, conversation: Option<&str>, value: &Value) -> Result<Document> {
        let (scope, id) = conversation.filter(|s| !s.is_empty()).map_or(("global", "inbox"), |c| ("conversation", c));
        let mut data = self.document_async(scope, id, "pi.inbox").await?.map_or(json!({"items":[]}), |d| d.state);
        data["items"]
            .as_array_mut()
            .ok_or_else(|| Error::Invalid("inbox items must be an array".into()))?
            .push(value.clone());
        self.put_document_async(scope, id, "pi.inbox", &data).await
    }
}
