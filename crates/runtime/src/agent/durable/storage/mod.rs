//! Pluggable storage backend contract (`StorageBackend`) for durable state.

pub mod jsonl;
pub mod live;
pub mod memory;
pub mod sqlite;

pub use jsonl::{JsonlOptions, JsonlStorage};
pub use memory::MemoryStorage;
pub use sqlite::SqliteStorage;

use serde_json::Value;

use super::{CommitStats, Conversation, Document, DocumentEvent, Entry, Result, Signal, Sqlite, Submission, SubmissionStatus, Task, TaskStatus};

#[derive(Debug, Default, Clone)]
pub struct WriteOutcome {
    pub events: Vec<DocumentEvent>,
    pub tasks_changed: bool,
}

/// Read-only storage operations executed inside a read or write transaction.
pub trait StorageRead {
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
}

/// Write operations executed atomically inside a durable transaction.
pub trait StorageWrite: StorageRead {
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
}

pub type WriteCallback<'a> = dyn for<'tx> FnMut(&'tx dyn StorageRead, &'tx dyn StorageWrite, Option<&'tx Sqlite<'tx>>, i64) -> Result<WriteOutcome> + 'a;

/// Pluggable backend implementing ACID transactions and pub/sub hints.
pub trait StorageBackend: Send + Sync {
    fn kind(&self) -> &'static str;
    fn is_read_only(&self) -> bool {
        false
    }
    fn now_ms(&self) -> i64;
    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()>;
    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()>;
    fn stats(&self) -> CommitStats;
    fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>>;
    fn subscribe_tasks(&self) -> Result<flume::Receiver<()>>;
    fn close(&self) -> Result<()>;
}
