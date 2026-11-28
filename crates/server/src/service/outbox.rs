//! Dual-backend persistence for transactional outbox rows (`outbox_item`) backed by
//! `vibevalley_kit::queue::outbox::SqlOutbox` (zero SeaORM entity).

use std::sync::Arc;

use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use vibevalley_kit::db::DbBackendKind;
pub(crate) use vibevalley_kit::queue::outbox::OutboxItem;
use vibevalley_kit::queue::outbox::{DEFAULT_OUTBOX_TABLE, OutboxStore as _, enqueue_outbox_sql};
#[cfg(test)]
pub(crate) use vibevalley_kit::queue::outbox::{OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING};
use vibevalley_protocol::ApiError;

use crate::db::{Database, DbError, Tx};

#[derive(Clone)]
pub(crate) struct OutboxService {
    db: Arc<Database>,
}

impl OutboxService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Enqueues an outbox item standalone on the write pool.
    pub(crate) async fn enqueue(&self, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        self.db
            .sql_outbox()
            .enqueue(topic, payload_json, now_ms)
            .await
            .map_err(|e| DbError::from(e).into())
    }

    /// Enqueues an outbox item standalone scheduled for `available_at` (ms).
    pub(crate) async fn enqueue_at(&self, topic: &str, payload_json: &str, created_at: i64, available_at: i64) -> Result<i64, ApiError> {
        self.db
            .sql_outbox()
            .enqueue_at(topic, payload_json, created_at, available_at)
            .await
            .map_err(|e| DbError::from(e).into())
    }

    /// Single-roundtrip parameterized SQL enqueue inside an open SeaORM write transaction.
    pub(crate) async fn enqueue_in_tx(&self, tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        let raw_backend = tx.get_database_backend();
        let kit_backend = match raw_backend {
            DatabaseBackend::Postgres => DbBackendKind::Postgres,
            _ => DbBackendKind::Sqlite,
        };
        let sql = enqueue_outbox_sql(kit_backend, DEFAULT_OUTBOX_TABLE).map_err(DbError::from)?;
        let stmt = Statement::from_sql_and_values(raw_backend, sql, [topic.into(), payload_json.into(), now_ms.into(), now_ms.into()]);
        let row = tx
            .query_one_raw(stmt)
            .await
            .map_err(DbError::from)?
            .ok_or_else(|| DbError::custom("outbox_item insert returned no row"))?;
        let id: i64 = row.try_get_by_index(0).map_err(DbError::from)?;
        Ok(id)
    }

    /// Requeues any rows left in `processing` from an unclean shutdown back to `pending`.
    pub(crate) async fn recover_processing(&self, now_ms: i64) -> Result<u64, ApiError> {
        self.db.sql_outbox().recover_processing(now_ms).await.map_err(|e| DbError::from(e).into())
    }

    /// Atomically claims up to `limit` due `pending` outbox rows, marking them `processing`
    /// and incrementing `attempts`.
    pub(crate) async fn claim_pending(&self, now_ms: i64, limit: u64) -> Result<Vec<OutboxItem>, ApiError> {
        self.db.sql_outbox().claim_pending(now_ms, limit).await.map_err(|e| DbError::from(e).into())
    }

    /// Earliest `available_at` timestamp among `pending` items, if any.
    pub(crate) async fn next_pending_at(&self) -> Result<Option<i64>, ApiError> {
        self.db.sql_outbox().next_pending_at().await.map_err(|e| DbError::from(e).into())
    }

    /// Marks an outbox item delivered (`done`) and clears `last_error`.
    pub(crate) async fn complete(&self, id: i64) -> Result<(), ApiError> {
        self.db.sql_outbox().complete(id).await.map_err(|e| DbError::from(e).into())
    }

    /// Returns an outbox item to `pending` for retry at `available_at`, recording `error`.
    pub(crate) async fn reschedule(&self, id: i64, available_at: i64, error: &str) -> Result<(), ApiError> {
        self.db
            .sql_outbox()
            .reschedule(id, available_at, error)
            .await
            .map_err(|e| DbError::from(e).into())
    }

    /// Dead-letters an outbox item as `failed`, recording `error`.
    pub(crate) async fn fail(&self, id: i64, error: &str) -> Result<(), ApiError> {
        self.db.sql_outbox().fail(id, error).await.map_err(|e| DbError::from(e).into())
    }

    /// Lists dead-lettered (`failed`) outbox items newest first, up to `limit`.
    pub(crate) async fn list_failed(&self, limit: u64) -> Result<Vec<OutboxItem>, ApiError> {
        self.db.sql_outbox().list_failed(limit).await.map_err(|e| DbError::from(e).into())
    }

    /// Counts dead-lettered (`failed`) outbox items.
    pub(crate) async fn count_failed(&self) -> Result<u64, ApiError> {
        self.db.sql_outbox().count_failed().await.map_err(|e| DbError::from(e).into())
    }

    /// Requeues a single dead-lettered (`failed`) item back to `pending` with `attempts = 0`.
    pub(crate) async fn replay_failed(&self, id: i64, now_ms: i64) -> Result<bool, ApiError> {
        self.db.sql_outbox().replay_failed(id, now_ms).await.map_err(|e| DbError::from(e).into())
    }

    /// Requeues all dead-lettered (`failed`) items back to `pending` with `attempts = 0`.
    pub(crate) async fn replay_all_failed(&self, now_ms: i64) -> Result<u64, ApiError> {
        self.db.sql_outbox().replay_all_failed(now_ms).await.map_err(|e| DbError::from(e).into())
    }

    /// Deletes up to `limit` completed (`done`) outbox rows older than `before_ms`.
    pub(crate) async fn prune_done_batch(&self, before_ms: i64, limit: u64) -> Result<u64, ApiError> {
        self.db
            .sql_outbox()
            .prune_done_batch(before_ms, limit)
            .await
            .map_err(|e| DbError::from(e).into())
    }

    /// Lists all outbox items in insertion order.
    #[cfg(test)]
    pub(crate) async fn list(&self) -> Result<Vec<OutboxItem>, ApiError> {
        self.db.sql_outbox().list_all().await.map_err(|e| DbError::from(e).into())
    }
}
