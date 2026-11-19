//! Persistent conversations, submissions, wakeups and phase execution.
mod conversation;
#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;
mod sqlite;
pub use sqlite::Sqlite;
mod rows;
mod scheduler;
mod store;
mod task;
pub use rows::*;
pub use scheduler::*;
pub use store::{Read, Store, Tx};

use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
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
