//! Dual-backend persistence for transactional outbox rows (`outbox_item`).

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::Value;
use vibevalley_protocol::ApiError;

use crate::db::entity::outbox_item;
use crate::db::{Database, DbError, Tx, begin_write_tx, commit_tx, rollback_tx};

pub const OUTBOX_STATUS_PENDING: &str = "pending";
pub const OUTBOX_STATUS_PROCESSING: &str = "processing";
pub const OUTBOX_STATUS_DONE: &str = "done";
pub const OUTBOX_STATUS_FAILED: &str = "failed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxItem {
    pub id: i64,
    pub topic: String,
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
    pub available_at: i64,
    pub created_at: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutboxCounts {
    pub pending: u64,
    pub processing: u64,
    pub done: u64,
    pub failed: u64,
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

async fn insert_impl<C: ConnectionTrait>(conn: &C, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
    let saved = outbox_item::ActiveModel {
        topic: Set(topic.to_owned()),
        payload_json: Set(payload_json.to_owned()),
        status: Set(OUTBOX_STATUS_PENDING.to_owned()),
        attempts: Set(0),
        available_at: Set(now_ms),
        created_at: Set(now_ms),
        last_error: Set(None),
        ..Default::default()
    }
    .insert(conn)
    .await
    .map_err(DbError::from)?;
    Ok(saved.id)
}

#[derive(Clone)]
pub struct OutboxService {
    db: Arc<Database>,
}

impl OutboxService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Inserts an outbox item inside an open write transaction without needing an [`OutboxService`] receiver.
    pub async fn insert_in_tx(tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        insert_impl(tx, topic, payload_json, now_ms).await
    }

    /// Serializes `payload` and inserts an outbox item inside an open write transaction.
    pub async fn insert_value_in_tx(tx: &Tx, topic: &str, payload: &Value, now_ms: i64) -> Result<i64, ApiError> {
        let payload_json = serde_json::to_string(payload).map_err(|e| DbError::custom(format!("outbox payload serialize failed: {e}")))?;
        insert_impl(tx, topic, &payload_json, now_ms).await
    }

    /// Enqueues an outbox item standalone on the write pool.
    pub async fn enqueue(&self, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        insert_impl(self.db.write_conn(), topic, payload_json, now_ms).await
    }

    /// Serializes `payload` and enqueues an outbox item standalone on the write pool.
    pub async fn enqueue_value(&self, topic: &str, payload: &Value, now_ms: i64) -> Result<i64, ApiError> {
        let payload_json = serde_json::to_string(payload).map_err(|e| DbError::custom(format!("outbox payload serialize failed: {e}")))?;
        insert_impl(self.db.write_conn(), topic, &payload_json, now_ms).await
    }

    /// Enqueues an outbox item inside an open write transaction.
    pub async fn enqueue_in_tx(&self, tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        insert_impl(tx, topic, payload_json, now_ms).await
    }

    /// Serializes `payload` and enqueues an outbox item inside an open write transaction.
    pub async fn enqueue_value_in_tx(&self, tx: &Tx, topic: &str, payload: &Value, now_ms: i64) -> Result<i64, ApiError> {
        Self::insert_value_in_tx(tx, topic, payload, now_ms).await
    }

    /// Requeues any rows left in `processing` from an unclean shutdown back to `pending`.
    pub async fn recover_processing(&self, now_ms: i64) -> Result<u64, ApiError> {
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
    pub async fn claim_pending(&self, now_ms: i64, limit: u64) -> Result<Vec<OutboxItem>, ApiError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let outcome: Result<Vec<OutboxItem>, ApiError> = async {
            let candidates = outbox_item::Entity::find()
                .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PENDING))
                .filter(outbox_item::Column::AvailableAt.lte(now_ms))
                .order_by_asc(outbox_item::Column::AvailableAt)
                .order_by_asc(outbox_item::Column::Id)
                .limit(limit)
                .all(&tx)
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
                .exec_with_returning(&tx)
                .await
                .map_err(DbError::from)?;
            claimed.sort_by_key(|row| (row.available_at, row.id));
            Ok(claimed.into_iter().map(OutboxItem::from).collect())
        }
        .await;
        match outcome {
            Ok(rows) => {
                commit_tx(tx).await?;
                Ok(rows)
            }
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    /// Earliest `available_at` timestamp among `pending` items, if any.
    pub async fn next_pending_at(&self) -> Result<Option<i64>, ApiError> {
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

    /// Marks an outbox item delivered (`done`) and clears `last_error`.
    pub async fn complete(&self, id: i64) -> Result<(), ApiError> {
        outbox_item::Entity::update_many()
            .col_expr(outbox_item::Column::Status, Expr::value(OUTBOX_STATUS_DONE))
            .col_expr(outbox_item::Column::LastError, Expr::value(Option::<String>::None))
            .filter(outbox_item::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await
            .map_err(DbError::from)?;
        Ok(())
    }

    /// Returns an outbox item to `pending` for retry at `available_at`, recording `error`.
    pub async fn reschedule(&self, id: i64, available_at: i64, error: &str) -> Result<(), ApiError> {
        outbox_item::Entity::update_many()
            .col_expr(outbox_item::Column::Status, Expr::value(OUTBOX_STATUS_PENDING))
            .col_expr(outbox_item::Column::AvailableAt, Expr::value(available_at))
            .col_expr(outbox_item::Column::LastError, Expr::value(Some(error.to_owned())))
            .filter(outbox_item::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await
            .map_err(DbError::from)?;
        Ok(())
    }

    /// Dead-letters an outbox item as `failed`, recording `error`.
    pub async fn fail(&self, id: i64, error: &str) -> Result<(), ApiError> {
        outbox_item::Entity::update_many()
            .col_expr(outbox_item::Column::Status, Expr::value(OUTBOX_STATUS_FAILED))
            .col_expr(outbox_item::Column::LastError, Expr::value(Some(error.to_owned())))
            .filter(outbox_item::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await
            .map_err(DbError::from)?;
        Ok(())
    }

    /// Fetches one outbox item by primary key.
    pub async fn get(&self, id: i64) -> Result<Option<OutboxItem>, ApiError> {
        let row = outbox_item::Entity::find_by_id(id).one(self.db.read_conn()).await.map_err(DbError::from)?;
        Ok(row.map(OutboxItem::from))
    }

    /// Lists all outbox items in insertion order.
    pub async fn list(&self) -> Result<Vec<OutboxItem>, ApiError> {
        let rows = outbox_item::Entity::find()
            .order_by_asc(outbox_item::Column::Id)
            .all(self.db.read_conn())
            .await
            .map_err(DbError::from)?;
        Ok(rows.into_iter().map(OutboxItem::from).collect())
    }

    /// Counts outbox items grouped by status.
    pub async fn count_by_status(&self) -> Result<OutboxCounts, ApiError> {
        let conn = self.db.read_conn();
        let pending = outbox_item::Entity::find()
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PENDING))
            .count(conn)
            .await
            .map_err(DbError::from)?;
        let processing = outbox_item::Entity::find()
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_PROCESSING))
            .count(conn)
            .await
            .map_err(DbError::from)?;
        let done = outbox_item::Entity::find()
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_DONE))
            .count(conn)
            .await
            .map_err(DbError::from)?;
        let failed = outbox_item::Entity::find()
            .filter(outbox_item::Column::Status.eq(OUTBOX_STATUS_FAILED))
            .count(conn)
            .await
            .map_err(DbError::from)?;
        Ok(OutboxCounts {
            pending,
            processing,
            done,
            failed,
        })
    }
}
