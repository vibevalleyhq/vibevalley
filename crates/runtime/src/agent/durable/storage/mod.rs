//! Pluggable storage backend contract (`StorageBackend`) for durable state.

pub mod jsonl;
pub mod live;
pub mod memory;
mod ops;
pub mod sea_orm;

pub use jsonl::{JsonlOptions, JsonlStorage};
pub use memory::MemoryStorage;
pub use sea_orm::{DbTx, SeaOrmStorage};

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::{CommitStats, Conversation, Document, DocumentEvent, Entry, Result, Signal, Submission, SubmissionStatus, Task, TaskStatus};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Default, Clone)]
pub struct WriteOutcome {
    pub events: Vec<DocumentEvent>,
    pub tasks_changed: bool,
}

/// Read-only storage operations executed inside a read or write transaction.
pub trait StorageRead: Sync {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>>;
    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>>;
    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>>;

    fn conversation(&self, id: &str) -> Result<Option<Conversation>>;
    fn conversations(&self) -> Result<Vec<Conversation>>;
    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>>;
    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>>;
    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>>;

    fn submission(&self, id: &str) -> Result<Option<Submission>>;
    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>>;
    fn submissions(&self, conv: &str) -> Result<Vec<Submission>>;

    fn task(&self, id: &str) -> Result<Option<Task>>;
    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>>;
    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>>;
    fn children(&self, owner: &str) -> Result<Vec<Task>>;
    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>>;
    fn active_tasks(&self) -> Result<Vec<Task>>;

    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>>;
    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>>;

    fn document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str) -> BoxFuture<'a, Result<Option<Document>>>;
    fn documents_by_kind_async<'a>(&'a self, scope: &'a str, kind: &'a str) -> BoxFuture<'a, Result<Vec<Document>>>;
    fn documents_by_scope_async<'a>(&'a self, scope: &'a str, id: &'a str) -> BoxFuture<'a, Result<Vec<Document>>>;

    fn conversation_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Conversation>>>;
    fn conversations_async(&self) -> BoxFuture<'_, Result<Vec<Conversation>>>;
    fn conversations_by_owner_task_async<'a>(&'a self, owner_task_id: &'a str) -> BoxFuture<'a, Result<Vec<Conversation>>>;
    fn entries_from_async<'a>(&'a self, conv: &'a str, from_seq: i64) -> BoxFuture<'a, Result<Vec<Entry>>>;
    fn entries_within_async<'a>(&'a self, conv: &'a str, first_seq: i64, last_seq: i64) -> BoxFuture<'a, Result<Vec<Entry>>>;

    fn submission_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Submission>>>;
    fn submission_by_request_async<'a>(&'a self, conv: &'a str, request_id: &'a str) -> BoxFuture<'a, Result<Option<Submission>>>;
    fn submissions_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<Vec<Submission>>>;

    fn task_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Task>>>;
    fn task_by_dedup_async<'a>(&'a self, owner: &'a str, key: &'a str) -> BoxFuture<'a, Result<Option<Task>>>;
    fn tasks_by_conversation_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<Vec<Task>>>;
    fn children_async<'a>(&'a self, owner: &'a str) -> BoxFuture<'a, Result<Vec<Task>>>;
    fn tasks_by_status_async(&self, status: TaskStatus) -> BoxFuture<'_, Result<Vec<Task>>>;
    fn active_tasks_async(&self) -> BoxFuture<'_, Result<Vec<Task>>>;

    fn signals_async<'a>(&'a self, task_id: &'a str, include_consumed: bool) -> BoxFuture<'a, Result<Vec<Signal>>>;
    fn signal_by_key_async<'a>(&'a self, task_id: &'a str, name: &'a str, key: &'a str) -> BoxFuture<'a, Result<Option<Signal>>>;
}

/// Write operations executed atomically inside a durable transaction.
pub trait StorageWrite: StorageRead + Sync {
    fn put_document(&self, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64>;
    fn delete_document(&self, scope: &str, id: &str, kind: &str) -> Result<()>;

    fn insert_conversation(&self, conv: &Conversation) -> Result<()>;
    fn advance_sequence(&self, conv: &str, now_ms: i64) -> Result<Option<i64>>;
    fn insert_entry(&self, entry: &Entry) -> Result<()>;
    fn set_head(&self, conv: &str, head_seq: i64) -> Result<()>;
    fn reset_head(&self, conv: &str) -> Result<()>;

    fn insert_submission(&self, sub: &Submission) -> Result<()>;
    fn set_submission_status(&self, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()>;
    fn settle_submission(&self, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()>;

    fn insert_task(&self, task: &Task) -> Result<()>;
    fn update_task(&self, task: &Task, now_ms: i64) -> Result<bool>;

    fn insert_signal(&self, signal: &Signal) -> Result<Signal>;
    fn consume_first_signal(&self, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>>;

    fn put_document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str, state: &'a Value, now_ms: i64) -> BoxFuture<'a, Result<i64>>;
    fn delete_document_async<'a>(&'a self, scope: &'a str, id: &'a str, kind: &'a str) -> BoxFuture<'a, Result<()>>;

    fn insert_conversation_async<'a>(&'a self, conv: &'a Conversation) -> BoxFuture<'a, Result<()>>;
    fn advance_sequence_async<'a>(&'a self, conv: &'a str, now_ms: i64) -> BoxFuture<'a, Result<Option<i64>>>;
    fn insert_entry_async<'a>(&'a self, entry: &'a Entry) -> BoxFuture<'a, Result<()>>;
    fn set_head_async<'a>(&'a self, conv: &'a str, head_seq: i64) -> BoxFuture<'a, Result<()>>;
    fn reset_head_async<'a>(&'a self, conv: &'a str) -> BoxFuture<'a, Result<()>>;

    fn insert_submission_async<'a>(&'a self, sub: &'a Submission) -> BoxFuture<'a, Result<()>>;
    fn set_submission_status_async<'a>(&'a self, id: &'a str, status: SubmissionStatus, now_ms: i64) -> BoxFuture<'a, Result<()>>;
    fn settle_submission_async<'a>(&'a self, id: &'a str, status: SubmissionStatus, result: &'a Value, now_ms: i64) -> BoxFuture<'a, Result<()>>;

    fn insert_task_async<'a>(&'a self, task: &'a Task) -> BoxFuture<'a, Result<()>>;
    fn update_task_async<'a>(&'a self, task: &'a Task, now_ms: i64) -> BoxFuture<'a, Result<bool>>;

    fn insert_signal_async<'a>(&'a self, signal: &'a Signal) -> BoxFuture<'a, Result<Signal>>;
    fn consume_first_signal_async<'a>(&'a self, task_id: &'a str, name: &'a str, now_ms: i64) -> BoxFuture<'a, Result<Option<Signal>>>;
}

pub type WriteCallback<'a> = dyn for<'tx> FnMut(&'tx dyn StorageRead, &'tx dyn StorageWrite, Option<&'tx DbTx<'tx>>, i64) -> Result<WriteOutcome> + 'a;

pub trait ReadAsyncOp<'env>: Send {
    fn call<'tx>(&'tx mut self, ops: &'tx dyn StorageRead) -> BoxFuture<'tx, Result<()>>
    where
        'env: 'tx;
}

pub trait WriteAsyncOp<'env>: Send {
    fn call<'tx>(
        &'tx mut self,
        ops: &'tx dyn StorageRead,
        write: &'tx dyn StorageWrite,
        db_tx: Option<&'tx DbTx<'tx>>,
        now_ms: i64,
    ) -> BoxFuture<'tx, Result<WriteOutcome>>
    where
        'env: 'tx;
}

/// Pluggable backend implementing ACID transactions and pub/sub hints.
pub trait StorageBackend: Send + Sync {
    fn kind(&self) -> &'static str;
    fn is_read_only(&self) -> bool {
        false
    }
    fn now_ms(&self) -> i64;
    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()>;
    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()>;
    fn read_dyn_async<'a>(&'a self, op: &'a mut dyn ReadAsyncOp<'a>) -> BoxFuture<'a, Result<()>>;
    fn write_dyn_async<'a>(&'a self, op: &'a mut dyn WriteAsyncOp<'a>) -> BoxFuture<'a, Result<()>>;
    fn stats(&self) -> CommitStats;
    fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>>;
    fn subscribe_tasks(&self) -> Result<flume::Receiver<()>>;
    fn close(&self) -> Result<()>;
}
