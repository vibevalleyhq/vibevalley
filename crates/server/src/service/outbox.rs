//! Dual-backend persistence for transactional outbox rows (`outbox_item`).

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, QueryFilter, QueryOrder, QuerySelect};
use vibevalley_protocol::ApiError;

use super::with_write_tx;
use crate::db::entity::outbox_item;
use crate::db::{Database, DbError, Tx};

pub(crate) const OUTBOX_STATUS_PENDING: &str = "pending";
pub(crate) const OUTBOX_STATUS_PROCESSING: &str = "processing";
pub(crate) const OUTBOX_STATUS_DONE: &str = "done";
pub(crate) const OUTBOX_STATUS_FAILED: &str = "failed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutboxItem {
    pub(crate) id: i64,
    pub(crate) topic: String,
    pub(crate) payload_json: String,
    pub(crate) status: String,
    pub(crate) attempts: i64,
    pub(crate) available_at: i64,
    pub(crate) created_at: i64,
    pub(crate) last_error: Option<String>,
}

impl From<outbox_item::Model> for OutboxItem {
    fn from(model: outbox_item::Model) -> Self {
        Self {
            id: model.id,
            topic: model.topic,
            payload_json: model.payload_json,
            status: model.status,
            attempts: model.attempts,
            available_at: model.available_at,
            created_at: model.created_at,
            last_error: model.last_error,
        }
    }
}

async fn insert_impl<C: ConnectionTrait>(conn: &C, topic: &str, payload_json: &str, created_at: i64, available_at: i64) -> Result<i64, ApiError> {
    let saved = outbox_item::ActiveModel {
        topic: Set(topic.to_owned()),
        payload_json: Set(payload_json.to_owned()),
        status: Set(OUTBOX_STATUS_PENDING.to_owned()),
        attempts: Set(0),
        available_at: Set(available_at),
        created_at: Set(created_at),
        last_error: Set(None),
        ..Default::default()
    }
    .insert(conn)
    .await
    .map_err(DbError::from)?;
    Ok(saved.id)
}

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
        insert_impl(self.db.write_conn(), topic, payload_json, now_ms, now_ms).await
    }

    /// Enqueues an outbox item standalone scheduled for `available_at` (ms).
    pub(crate) async fn enqueue_at(&self, topic: &str, payload_json: &str, created_at: i64, available_at: i64) -> Result<i64, ApiError> {
        insert_impl(self.db.write_conn(), topic, payload_json, created_at, available_at).await
    }

    /// Enqueues an outbox item inside an open write transaction.
    pub(crate) async fn enqueue_in_tx(&self, tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        insert_impl(tx, topic, payload_json, now_ms, now_ms).await
    }

    /// Requeues any rows left in `processing` from an unclean shutdown back to `pending`.
    pub(crate) async fn recover_processing(&self, now_ms: i64) -> Result<u64, ApiError> {
        let res = outbox_item::Entity::update_many()
            .col_expr(outbox_item::Column::Status, Expr::value(OUTBOX_STATUS_PENDING))
            .col_expr(outbox_item::Column::AvailableAt, Expr::value(now_ms))
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PROCESSING))
            .exec(self.db.write_conn())
            .await
            .map_err(DbError::from)?;
        Ok(res.rows_affected)
    }

    /// Atomically claims up to `limit` due `pending` outbox rows, marking them `processing`
    /// and incrementing `attempts`.
    pub(crate) async fn claim_pending(&self, now_ms: i64, limit: u64) -> Result<Vec<OutboxItem>, ApiError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        with_write_tx(&self.db, async |tx| {
            let candidates = outbox_item::Entity::find()
                .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PENDING))
                .filter(outbox_item::Column::AvailableAt.lte(now_ms))
                .order_by_asc(outbox_item::Column::AvailableAt)
                .order_by_asc(outbox_item::Column::Id)
                .limit(limit)
                .all(tx)
                .await
                .map_err(DbError::from)?;
            if candidates.is_empty() {
                return Ok(Vec::new());
            }
            let ids: Vec<i64> = candidates.into_iter().map(|row| row.id).collect();
            let mut claimed = outbox_item::Entity::update_many()
                .col_expr(outbox_item::Column::Status, Expr::value(OUTBOX_STATUS_PROCESSING))
                .col_expr(outbox_item::Column::Attempts, Expr::col(outbox_item::Column::Attempts).add(1i64))
                .filter(outbox_item::Column::Id.is_in(ids))
                .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PENDING))
                .exec_with_returning(tx)
                .await
                .map_err(DbError::from)?;
            claimed.sort_by_key(|row| (row.available_at, row.id));
            Ok(claimed.into_iter().map(OutboxItem::from).collect())
        })
        .await
    }

    /// Earliest `available_at` timestamp among `pending` items, if any.
    pub(crate) async fn next_pending_at(&self) -> Result<Option<i64>, ApiError> {
        let row = outbox_item::Entity::find()
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PENDING))
            .order_by_asc(outbox_item::Column::AvailableAt)
            .order_by_asc(outbox_item::Column::Id)
            .limit(1)
            .one(self.db.read_conn())
            .await
            .map_err(DbError::from)?;
        Ok(row.map(|m| m.available_at))
    }

    async fn finish_with(&self, id: i64, status: &str, available_at: Option<i64>, error: Option<&str>) -> Result<(), ApiError> {
        let mut update = outbox_item::Entity::update_many()
            .col_expr(outbox_item::Column::Status, Expr::value(status))
            .col_expr(outbox_item::Column::LastError, Expr::value(error.map(str::to_owned)))
            .filter(outbox_item::Column::Id.eq(id));
        if let Some(at) = available_at {
            update = update.col_expr(outbox_item::Column::AvailableAt, Expr::value(at));
        }
        update.exec(self.db.write_conn()).await.map_err(DbError::from)?;
        Ok(())
    }

    /// Marks an outbox item delivered (`done`) and clears `last_error`.
    pub(crate) async fn complete(&self, id: i64) -> Result<(), ApiError> {
        self.finish_with(id, OUTBOX_STATUS_DONE, None, None).await
    }

    /// Returns an outbox item to `pending` for retry at `available_at`, recording `error`.
    pub(crate) async fn reschedule(&self, id: i64, available_at: i64, error: &str) -> Result<(), ApiError> {
        self.finish_with(id, OUTBOX_STATUS_PENDING, Some(available_at), Some(error)).await
    }

    /// Dead-letters an outbox item as `failed`, recording `error`.
    pub(crate) async fn fail(&self, id: i64, error: &str) -> Result<(), ApiError> {
        self.finish_with(id, OUTBOX_STATUS_FAILED, None, Some(error)).await
    }

    /// Lists all outbox items in insertion order.
    #[cfg(test)]
    pub(crate) async fn list(&self) -> Result<Vec<OutboxItem>, ApiError> {
        let rows = outbox_item::Entity::find()
            .order_by_asc(outbox_item::Column::Id)
            .all(self.db.read_conn())
            .await
            .map_err(DbError::from)?;
        Ok(rows.into_iter().map(OutboxItem::from).collect())
    }
}
