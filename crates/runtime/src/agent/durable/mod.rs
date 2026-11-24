//! Persistent conversations, submissions, wakeups, pluggable storage backends, and phase execution.
pub mod conformance;
mod conversation;
pub mod entities;
pub mod export;
pub mod graph;
pub mod migration;
mod rows;
mod scheduler;
mod sqlite;
pub mod storage;
mod store;
mod task;
pub mod telemetry;

pub use export::{ExportManifest, ExportOptions};
pub use graph::{TaskGraph, TaskGraphNode};
pub use rows::*;
pub use scheduler::*;
pub use sqlite::Sqlite;
pub use storage::{
    DbTx, JsonlOptions, JsonlStorage, MemoryStorage, SeaOrmStorage, SqliteStorage, StorageBackend, StorageRead, StorageWrite, WriteCallback, WriteOutcome,
};
pub use store::{Read, Store, Tx};
pub use telemetry::{JsonlTelemetrySink, MemoryTelemetrySink, NoopTelemetrySink, TelemetryEvent, TelemetrySink, read_telemetry_jsonl};

use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Db(#[from] sea_orm::DbErr),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("missing durable record {0}")]
    Missing(String),
    #[error("durable store is closed")]
    Closed,
    #[error("transaction commit failed: {0}")]
    Commit(String),
    #[error("waiting for task timed out")]
    Timeout,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("wall clock before epoch").as_millis() as i64
}

fn id() -> String {
    uuid::Uuid::now_v7().to_string()
}
