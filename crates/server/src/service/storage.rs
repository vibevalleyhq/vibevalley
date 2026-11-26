//! Dual-backend persistence for content-addressed attachments (`attachment`),
//! staged media inputs (`media_input`), and job input pins (`media_input_pin`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Expr, Func, Query};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, QueryFilter, QueryOrder, QuerySelect,
    Update,
};
use vibevalley_protocol::{Attachment, MediaInput, MediaInputPhase, MediaInputRequest};

use super::with_write_tx;
use crate::db::entity::{attachment, media_input, media_input_pin};
use crate::db::{Database, DbError, DbResult, Tx};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MediaInputQuota {
    pub(crate) bytes: i64,
    pub(crate) entries: i64,
}

#[derive(FromQueryResult)]
struct QuotaRow {
    bytes: i64,
    entries: i64,
}

fn attachment_from_model(row: attachment::Model) -> Attachment {
    Attachment {
        id: row.id,
        name: row.name,
        r#type: row.content_type,
        size: row.size,
    }
}

fn media_input_from_model(row: media_input::Model, can_delete: bool) -> DbResult<MediaInput> {
    let meta: MediaInputRequest = serde_json::from_str(&row.metadata).map_err(|e| DbError::custom(e.to_string()))?;
    let phase = MediaInputPhase::ALL
        .into_iter()
        .find(|p| p.as_str() == row.phase)
        .ok_or_else(|| DbError::custom(format!("unknown media_input phase `{}`", row.phase)))?;
    Ok(MediaInput {
        id: row.id,
        kind: meta.kind,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        phase,
        hash: row.hash,
        created_at: row.created_at,
        expires_at: row.expires_at,
        can_delete,
    })
}

async fn find_media_input_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<Option<MediaInput>> {
    let Some(row) = media_input::Entity::find_by_id(id.to_owned()).one(conn).await? else {
        return Ok(None);
    };
    let free = media_input_pin::Entity::find()
        .filter(media_input_pin::Column::InputId.eq(id))
        .one(conn)
        .await?
        .is_none();
    media_input_from_model(row, free).map(Some)
}

async fn list_media_inputs_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<MediaInput>> {
    let rows = media_input::Entity::find()
        .order_by_desc(media_input::Column::CreatedAt)
        .order_by_asc(media_input::Column::Id)
        .all(conn)
        .await?;
    let pins: Vec<String> = media_input_pin::Entity::find()
        .select_only()
        .column(media_input_pin::Column::InputId)
        .distinct()
        .into_tuple()
        .all(conn)
        .await?;
    let pinned: HashSet<String> = pins.into_iter().collect();
    rows.into_iter()
        .map(|row| {
            let free = !pinned.contains(&row.id);
            media_input_from_model(row, free)
        })
        .collect()
}

async fn media_input_quota_impl<C: ConnectionTrait>(conn: &C) -> DbResult<MediaInputQuota> {
    let stmt = Query::select()
        .expr_as(
            Expr::expr(Func::coalesce([Expr::col(media_input::Column::Size).sum(), Expr::val(0i64)])).cast_as(Alias::new("BIGINT")),
            "bytes",
        )
        .expr_as(Expr::col(media_input::Column::Id).count(), "entries")
        .from(media_input::Entity)
        .to_owned();
    let quota = QuotaRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .unwrap_or(QuotaRow { bytes: 0, entries: 0 });
    Ok(MediaInputQuota {
        bytes: quota.bytes,
        entries: quota.entries,
    })
}

async fn create_media_input_impl<C: ConnectionTrait>(conn: &C, id: &str, req: &MediaInputRequest, created_at: i64, expires_at: i64) -> DbResult<MediaInput> {
    let metadata = serde_json::to_string(req).map_err(|e| DbError::custom(e.to_string()))?;
    media_input::ActiveModel {
        id: Set(id.to_owned()),
        metadata: Set(metadata),
        size: Set(req.size),
        phase: Set(MediaInputPhase::Reserved.as_str().to_owned()),
        hash: Set(None),
        created_at: Set(created_at),
        expires_at: Set(expires_at),
    }
    .insert(conn)
    .await?;
    find_media_input_impl(conn, id)
        .await?
        .ok_or_else(|| DbError::not_found(format!("media_input {id} missing after insert")))
}

async fn pin_media_input_impl<C: ConnectionTrait>(conn: &C, input_id: &str, holder: &str) -> DbResult<()> {
    let model = media_input_pin::ActiveModel {
        input_id: Set(input_id.to_owned()),
        holder: Set(holder.to_owned()),
    };
    media_input_pin::Entity::insert(model)
        .on_conflict_do_nothing_on([media_input_pin::Column::InputId, media_input_pin::Column::Holder])
        .exec(conn)
        .await?;
    Ok(())
}

#[derive(Clone)]
pub(crate) struct StorageService {
    db: Arc<Database>,
}

impl StorageService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn insert_attachment(&self, id: &str, name: &str, content_type: &str, size: i64, created_at: i64) -> DbResult<()> {
        let model = attachment::ActiveModel {
            id: Set(id.to_owned()),
            name: Set(name.to_owned()),
            content_type: Set(content_type.to_owned()),
            size: Set(size),
            created_at: Set(created_at),
        };
        attachment::Entity::insert(model)
            .on_conflict_do_nothing_on([attachment::Column::Id])
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn find_attachment(&self, id: &str) -> DbResult<Option<Attachment>> {
        Ok(attachment::Entity::find_by_id(id.to_owned())
            .one(self.db.read_conn())
            .await?
            .map(attachment_from_model))
    }

    /// Looks up all requested attachment ids in a single query, returning a map keyed by id.
    pub(crate) async fn find_attachments_map(&self, ids: &[String]) -> DbResult<HashMap<String, Attachment>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = attachment::Entity::find()
            .filter(attachment::Column::Id.is_in(ids.iter().cloned()))
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(|row| (row.id.clone(), attachment_from_model(row))).collect())
    }

    pub(crate) async fn find_media_input(&self, id: &str) -> DbResult<Option<MediaInput>> {
        find_media_input_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn find_media_input_write(&self, id: &str) -> DbResult<Option<MediaInput>> {
        find_media_input_impl(self.db.write_conn(), id).await
    }

    pub(crate) async fn find_media_input_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<MediaInput>> {
        find_media_input_impl(tx, id).await
    }

    pub(crate) async fn list_media_inputs(&self) -> DbResult<Vec<MediaInput>> {
        list_media_inputs_impl(self.db.read_conn()).await
    }

    pub(crate) async fn list_media_inputs_write(&self) -> DbResult<Vec<MediaInput>> {
        list_media_inputs_impl(self.db.write_conn()).await
    }

    /// Atomically checks quota (`entries < max_entries && bytes + req.size <= max_bytes`)
    /// and inserts a `reserved` media input row. Returns `Ok(None)` if quota would be exceeded.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn reserve_media_input(
        &self,
        id: &str,
        req: &MediaInputRequest,
        created_at: i64,
        expires_at: i64,
        max_entries: i64,
        max_bytes: i64,
    ) -> DbResult<Option<MediaInput>> {
        with_write_tx(&self.db, async |tx| {
            let quota = media_input_quota_impl(tx).await?;
            if quota.entries >= max_entries || quota.bytes + req.size > max_bytes {
                return Ok(None);
            }
            let created = create_media_input_impl(tx, id, req, created_at, expires_at).await?;
            Ok(Some(created))
        })
        .await
    }

    pub(crate) async fn set_media_input_phase(&self, id: &str, phase: MediaInputPhase) -> DbResult<()> {
        Update::many(media_input::Entity)
            .col_expr(media_input::Column::Phase, Expr::value(phase.as_str()))
            .filter(media_input::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn set_media_input_hash(&self, id: &str, hash: &str) -> DbResult<()> {
        Update::many(media_input::Entity)
            .col_expr(media_input::Column::Hash, Expr::value(Some(hash.to_owned())))
            .filter(media_input::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn mark_media_input_ready(&self, id: &str, expires_at: i64) -> DbResult<()> {
        Update::many(media_input::Entity)
            .col_expr(media_input::Column::Phase, Expr::value(MediaInputPhase::Ready.as_str()))
            .col_expr(media_input::Column::ExpiresAt, Expr::value(expires_at))
            .filter(media_input::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    /// Marks any `uploading` inputs interrupted by a crash as `failed`.
    pub(crate) async fn fail_uploading_media_inputs(&self) -> DbResult<u64> {
        let res = Update::many(media_input::Entity)
            .col_expr(media_input::Column::Phase, Expr::value(MediaInputPhase::Failed.as_str()))
            .filter(media_input::Column::Phase.eq(MediaInputPhase::Uploading.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(res.rows_affected)
    }

    /// Transitions an unpinned media input to `deleting`; returns `false` if pinned or missing.
    pub(crate) async fn mark_media_input_deleting_if_unpinned(&self, id: &str) -> DbResult<bool> {
        let pinned_subquery = Query::select()
            .expr(Expr::val(1))
            .from(media_input_pin::Entity)
            .and_where(Expr::col((media_input_pin::Entity, media_input_pin::Column::InputId)).equals((media_input::Entity, media_input::Column::Id)))
            .to_owned();
        let res = Update::many(media_input::Entity)
            .col_expr(media_input::Column::Phase, Expr::value(MediaInputPhase::Deleting.as_str()))
            .filter(media_input::Column::Id.eq(id))
            .filter(Expr::exists(pinned_subquery).not())
            .exec(self.db.write_conn())
            .await?;
        Ok(res.rows_affected > 0)
    }

    pub(crate) async fn delete_media_input(&self, id: &str) -> DbResult<()> {
        media_input::Entity::delete_by_id(id.to_owned()).exec(self.db.write_conn()).await?;
        Ok(())
    }

    /// Returns ids of unpinned media inputs that are expired or in `deleting` phase.
    pub(crate) async fn list_sweepable_media_input_ids(&self, now_ms: i64) -> DbResult<Vec<String>> {
        let pinned_subquery = Query::select()
            .expr(Expr::val(1))
            .from(media_input_pin::Entity)
            .and_where(Expr::col((media_input_pin::Entity, media_input_pin::Column::InputId)).equals((media_input::Entity, media_input::Column::Id)))
            .to_owned();
        let ids: Vec<String> = media_input::Entity::find()
            .select_only()
            .column(media_input::Column::Id)
            .filter(
                Condition::any()
                    .add(media_input::Column::ExpiresAt.lte(now_ms))
                    .add(media_input::Column::Phase.eq(MediaInputPhase::Deleting.as_str())),
            )
            .filter(Expr::exists(pinned_subquery).not())
            .into_tuple()
            .all(self.db.write_conn())
            .await?;
        Ok(ids)
    }

    pub(crate) async fn pin_media_input_in_tx(&self, tx: &Tx, input_id: &str, holder: &str) -> DbResult<()> {
        pin_media_input_impl(tx, input_id, holder).await
    }

    pub(crate) async fn release_media_input_pins(&self, holder: &str) -> DbResult<u64> {
        let res = media_input_pin::Entity::delete_many()
            .filter(media_input_pin::Column::Holder.eq(holder))
            .exec(self.db.write_conn())
            .await?;
        Ok(res.rows_affected)
    }
}
