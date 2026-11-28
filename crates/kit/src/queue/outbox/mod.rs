//! Domain-agnostic transactional outbox primitives (`OutboxStore`, `MemoryOutbox`,
//! `SqlOutbox`, dead-letter DTOs, retry policy, and shared conformance tests).

pub mod dead_letter;
pub mod memory;
#[cfg(feature = "db-sql")]
pub mod sql;

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::core::RetryPolicy;

pub use dead_letter::{DeadLetterSummary, OutboxDeadLetter};
pub use memory::MemoryOutbox;
#[cfg(feature = "db-sql")]
pub use sql::{DEFAULT_OUTBOX_TABLE, OutboxLeaseMode, SqlOutbox, enqueue_outbox_sql, ensure_outbox_table_sql};

pub const OUTBOX_STATUS_PENDING: &str = "pending";
pub const OUTBOX_STATUS_PROCESSING: &str = "processing";
pub const OUTBOX_STATUS_DONE: &str = "done";
pub const OUTBOX_STATUS_FAILED: &str = "failed";

/// Boxed `Send` future returned by [`OutboxStore`] trait methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Lifecycle status of a durable outbox record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxStatus {
    Pending,
    Processing,
    Done,
    Failed,
}

impl OutboxStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => OUTBOX_STATUS_PENDING,
            Self::Processing => OUTBOX_STATUS_PROCESSING,
            Self::Done => OUTBOX_STATUS_DONE,
            Self::Failed => OUTBOX_STATUS_FAILED,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            OUTBOX_STATUS_PENDING => Some(Self::Pending),
            OUTBOX_STATUS_PROCESSING => Some(Self::Processing),
            OUTBOX_STATUS_DONE => Some(Self::Done),
            OUTBOX_STATUS_FAILED => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Stored outbox item row returned by [`OutboxStore`] operations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxItem {
    pub id: i64,
    pub topic: String,
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
    pub available_at: i64,
    pub created_at: i64,
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<i64>,
}

/// Exponential backoff retry policy for outbox delivery failures backed by [`RetryPolicy`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxRetryPolicy {
    pub max_attempts: i64,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for OutboxRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 8,
            base_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(60),
        }
    }
}

impl OutboxRetryPolicy {
    pub const fn new(max_attempts: i64, base_backoff: Duration, max_backoff: Duration) -> Self {
        Self {
            max_attempts,
            base_backoff,
            max_backoff,
        }
    }

    pub const fn is_exhausted(&self, attempts: i64) -> bool {
        attempts >= self.max_attempts
    }

    /// Computes exponential backoff delay for one-based `attempts` (`attempts >= 1`).
    pub fn backoff_delay(&self, attempts: i64) -> Duration {
        let steps = attempts.saturating_sub(1).clamp(0, 20) as usize;
        RetryPolicy::new(0, self.base_backoff, self.max_backoff).delay_for(steps, None)
    }

    /// Computes the next `available_at` Unix millisecond timestamp for a failed attempt.
    pub fn next_available_at(&self, current_ms: i64, attempts: i64) -> i64 {
        let delay_ms = self.backoff_delay(attempts).as_millis().min(i64::MAX as u128) as i64;
        current_ms.saturating_add(delay_ms)
    }
}

/// Errors produced by [`OutboxStore`] implementations.
#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    #[error("invalid outbox table identifier `{0}`")]
    InvalidTableName(String),

    #[error("outbox store error: {0}")]
    Store(String),

    #[cfg(feature = "db-sql")]
    #[error("outbox SQL error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Domain-agnostic durable outbox storage port implemented by [`MemoryOutbox`] and [`SqlOutbox`].
pub trait OutboxStore: Send + Sync {
    /// Enqueues an item immediately available at `now_ms`.
    fn enqueue<'a>(&'a self, topic: &'a str, payload_json: &'a str, now_ms: i64) -> BoxFuture<'a, Result<i64, OutboxError>> {
        self.enqueue_at(topic, payload_json, now_ms, now_ms)
    }

    /// Enqueues an item created at `created_at` and eligible for claim at `available_at`.
    fn enqueue_at<'a>(&'a self, topic: &'a str, payload_json: &'a str, created_at: i64, available_at: i64) -> BoxFuture<'a, Result<i64, OutboxError>>;

    /// Atomically claims up to `limit` due `pending` rows (`available_at <= now_ms`), transitioning
    /// them to `processing` and incrementing `attempts`.
    fn claim_pending<'a>(&'a self, now_ms: i64, limit: u64) -> BoxFuture<'a, Result<Vec<OutboxItem>, OutboxError>> {
        self.claim_with_lease(now_ms, limit, None)
    }

    /// Atomically claims up to `limit` due `pending` rows with an optional crash-recovery lease
    /// duration (`locked_until = now_ms + lease_ms`).
    fn claim_with_lease<'a>(&'a self, now_ms: i64, limit: u64, lease_ms: Option<i64>) -> BoxFuture<'a, Result<Vec<OutboxItem>, OutboxError>>;

    /// Requeues all rows left in `processing` (e.g. after an unclean process restart) back to `pending`.
    fn recover_processing<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>>;

    /// Requeues `processing` rows whose crash lease expired at or before `now_ms` back to `pending`.
    fn reclaim_expired_leases<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>>;

    /// Earliest `available_at` timestamp among `pending` items, if any.
    fn next_pending_at(&self) -> BoxFuture<'_, Result<Option<i64>, OutboxError>>;

    /// Marks an item delivered (`done`) and clears `last_error` and any lease.
    fn complete(&self, id: i64) -> BoxFuture<'_, Result<(), OutboxError>>;

    /// Returns an item to `pending` for retry at `available_at`, recording `error`.
    fn reschedule<'a>(&'a self, id: i64, available_at: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>>;

    /// Dead-letters an item as `failed`, recording `error`.
    fn fail<'a>(&'a self, id: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>>;

    /// Lists dead-lettered (`failed`) items newest-first, up to `limit`.
    fn list_failed(&self, limit: u64) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>>;

    /// Counts dead-lettered (`failed`) items.
    fn count_failed(&self) -> BoxFuture<'_, Result<u64, OutboxError>>;

    /// Requeues a single dead-lettered (`failed`) item back to `pending` with `attempts = 0`.
    fn replay_failed(&self, id: i64, now_ms: i64) -> BoxFuture<'_, Result<bool, OutboxError>>;

    /// Requeues all dead-lettered (`failed`) items back to `pending` with `attempts = 0`.
    fn replay_all_failed(&self, now_ms: i64) -> BoxFuture<'_, Result<u64, OutboxError>>;

    /// Deletes up to `limit` completed (`done`) items with `created_at < before_ms`.
    fn prune_done_batch(&self, before_ms: i64, limit: u64) -> BoxFuture<'_, Result<u64, OutboxError>>;

    /// Lists all items in ascending ID order (diagnostic / testing helper).
    fn list_all(&self) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>>;
}

/// Shared contract assertions proving semantic parity across [`OutboxStore`] implementations.
pub async fn assert_outbox_conformance(store: &dyn OutboxStore) {
    assert_eq!(store.next_pending_at().await.unwrap(), None);
    assert_eq!(store.count_failed().await.unwrap(), 0);
    assert!(store.claim_pending(1_000, 10).await.unwrap().is_empty());

    let id1 = store.enqueue("topic.a", r#"{"n":1}"#, 1_000).await.unwrap();
    let id2 = store.enqueue_at("topic.b", r#"{"n":2}"#, 1_000, 2_000).await.unwrap();
    assert!(id2 > id1);
    assert_eq!(store.next_pending_at().await.unwrap(), Some(1_000));

    // Only id1 is due at t=1_000; claim with a 500ms crash lease.
    let claimed = store.claim_with_lease(1_000, 10, Some(500)).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, id1);
    assert_eq!(claimed[0].attempts, 1);
    assert_eq!(claimed[0].status, OUTBOX_STATUS_PROCESSING);

    // Lease not expired yet at 1_499; expires at 1_500.
    assert_eq!(store.reclaim_expired_leases(1_499).await.unwrap(), 0);
    assert_eq!(store.reclaim_expired_leases(1_500).await.unwrap(), 1);

    // Reclaim & reschedule with exponential backoff policy.
    let policy = OutboxRetryPolicy::new(3, Duration::from_millis(100), Duration::from_millis(500));
    let reclaimed = store.claim_pending(1_500, 10).await.unwrap();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].id, id1);
    assert_eq!(reclaimed[0].attempts, 2);

    let retry_at = policy.next_available_at(1_500, reclaimed[0].attempts);
    assert_eq!(retry_at, 1_700);
    store.reschedule(id1, retry_at, "transient 503").await.unwrap();
    assert!(store.claim_pending(1_699, 10).await.unwrap().is_empty());

    let retry_claim = store.claim_pending(1_700, 10).await.unwrap();
    assert_eq!(retry_claim.len(), 1);
    assert_eq!(retry_claim[0].attempts, 3);
    assert!(policy.is_exhausted(retry_claim[0].attempts));
    store.fail(id1, "permanent failure").await.unwrap();

    // Dead-letter inspection and single-item replay.
    assert_eq!(store.count_failed().await.unwrap(), 1);
    let failed = store.list_failed(10).await.unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].id, id1);
    assert_eq!(failed[0].last_error.as_deref(), Some("permanent failure"));

    assert!(store.replay_failed(id1, 1_800).await.unwrap());
    assert!(!store.replay_failed(id1, 1_800).await.unwrap());
    assert_eq!(store.count_failed().await.unwrap(), 0);

    let after_replay = store.claim_pending(2_000, 10).await.unwrap();
    let ids: Vec<i64> = after_replay.iter().map(|r| r.id).collect();
    assert_eq!(ids, vec![id1, id2]);
    assert_eq!(after_replay[0].attempts, 1);

    // Unclean restart recovery requeues all processing rows.
    assert_eq!(store.recover_processing(2_100).await.unwrap(), 2);
    let final_claim = store.claim_pending(2_100, 10).await.unwrap();
    assert_eq!(final_claim.len(), 2);
    store.complete(id1).await.unwrap();
    store.fail(id2, "keep in dlq").await.unwrap();

    // TTL pruning only deletes `done` rows older than cutoff; `failed` survives.
    assert_eq!(store.prune_done_batch(1_000, 10).await.unwrap(), 0);
    assert_eq!(store.prune_done_batch(1_001, 10).await.unwrap(), 1);
    let remaining = store.list_all().await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, id2);
    assert_eq!(remaining[0].status, OUTBOX_STATUS_FAILED);

    // replay_all_failed restores remaining dead-letter item.
    assert_eq!(store.replay_all_failed(3_000).await.unwrap(), 1);
    assert_eq!(store.count_failed().await.unwrap(), 0);
}

#[cfg(test)]
mod conformance_tests {
    use super::*;

    #[tokio::test]
    async fn memory_outbox_satisfies_conformance_contract() {
        let store = MemoryOutbox::new();
        assert_outbox_conformance(&store).await;
    }

    #[cfg(feature = "db-sql")]
    #[tokio::test]
    async fn sql_outbox_sqlite_locked_until_and_compat_modes_satisfy_conformance_contract() {
        use crate::db::engine::{SqlPool, SqlitePoolConfig, connect_sqlite_pool};

        // 1. Native `locked_until` column schema.
        let pool1 = connect_sqlite_pool(&SqlitePoolConfig::in_memory()).await.unwrap();
        let store1 = SqlOutbox::new(SqlPool::Sqlite(pool1.clone()));
        store1.ensure_schema().await.unwrap();
        assert_outbox_conformance(&store1).await;
        pool1.close().await;

        // 2. Existing 8-column `outbox_item` schema (reusing `available_at` as lease deadline).
        let pool2 = connect_sqlite_pool(&SqlitePoolConfig::in_memory()).await.unwrap();
        sqlx::query(
            "CREATE TABLE outbox_item (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                available_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_error TEXT
            )",
        )
        .execute(&pool2)
        .await
        .unwrap();
        let store2 = SqlOutbox::with_options(
            SqlPool::Sqlite(pool2.clone()),
            SqlPool::Sqlite(pool2.clone()),
            DEFAULT_OUTBOX_TABLE,
            OutboxLeaseMode::AvailableAtColumn,
        )
        .unwrap();
        assert_outbox_conformance(&store2).await;
        pool2.close().await;
    }
}
