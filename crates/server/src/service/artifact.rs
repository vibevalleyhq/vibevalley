//! Dual-backend persistence for artifacts (`artifact`, `artifact_version`, `artifact_block`,
//! `artifact_block_revision`, `artifact_change`, `artifact_suggestion`, `artifact_entry`,
//! `artifact_collab`), media library items (`media_library_item`), and media jobs (`media_job`).

use std::sync::Arc;

use sea_orm::sea_query::{Alias, Condition, Expr, Func, LikeExpr, OnConflict, Order, Query, SelectStatement, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Update,
};
use vibevalley_protocol::{
    Attachment, Block, BlockOpResult, LibraryFileKind, LibraryItem, LibraryListRequest, LibraryOrigin, LibrarySort, Suggestion, TextSpan,
};

use crate::db::column::{db_json, db_word, read_db_json, read_db_word};
use crate::db::entity::{
    artifact, artifact_block, artifact_block_revision, artifact_change, artifact_collab, artifact_entry, artifact_suggestion, artifact_version, attachment,
    media_job, media_library_item,
};
use crate::db::{Database, DbResult, Tx, begin_write_tx, commit_tx, rollback_tx};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRow {
    pub id: String,
    pub title: String,
    pub body: String,
    pub artifact_type: Option<String>,
    pub is_default: bool,
    pub display: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub issue: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub version: i64,
    pub seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<artifact::Model> for ArtifactRow {
    fn from(r: artifact::Model) -> Self {
        Self {
            id: r.id,
            title: r.title,
            body: r.body,
            artifact_type: r.artifact_type,
            is_default: r.is_default,
            display: r.display,
            channel_id: r.channel_id,
            message_id: r.message_id,
            issue: r.issue,
            by_id: r.by_id,
            by_name: r.by_name,
            version: r.version,
            seq: r.seq,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NewArtifact {
    pub id: String,
    pub title: String,
    pub body: String,
    pub artifact_type: Option<String>,
    pub is_default: bool,
    pub display: Option<String>,
    pub channel_id: Option<String>,
    pub issue: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub version: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug)]
pub struct NewVersion {
    pub artifact_id: String,
    pub version: i64,
    pub attachment_id: String,
    pub size: i64,
    pub note: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionRow {
    pub version: i64,
    pub attachment_id: String,
    pub size: i64,
    pub note: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub message_id: Option<String>,
    pub created_at: i64,
}

impl From<artifact_version::Model> for VersionRow {
    fn from(r: artifact_version::Model) -> Self {
        Self {
            version: r.version,
            attachment_id: r.attachment_id,
            size: r.size,
            note: r.note,
            by_id: r.by_id,
            by_name: r.by_name,
            message_id: r.message_id,
            created_at: r.created_at,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryRow {
    pub artifact_id: String,
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub value: Option<String>,
    pub attachment_id: Option<String>,
    pub size: i64,
    pub rev: i64,
    pub updated_by: String,
    pub updated_at: i64,
}

impl From<artifact_entry::Model> for EntryRow {
    fn from(r: artifact_entry::Model) -> Self {
        Self {
            artifact_id: r.artifact_id,
            path: r.path,
            kind: r.kind,
            mime: r.mime,
            value: r.value,
            attachment_id: r.attachment_id,
            size: r.size,
            rev: r.rev,
            updated_by: r.updated_by,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpsertEntry {
    pub artifact_id: String,
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub value: Option<String>,
    pub attachment_id: Option<String>,
    pub size: i64,
    pub rev: i64,
    pub updated_by: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct ChangeRow {
    pub artifact_id: String,
    pub seq: i64,
    pub batch_id: String,
    pub block_ids: Vec<String>,
    pub results: Vec<BlockOpResult>,
}

pub struct NewChange<'a> {
    pub artifact_id: &'a str,
    pub seq: i64,
    pub batch_id: &'a str,
    pub actor: &'a str,
    pub block_ids: &'a [String],
    pub results: &'a [BlockOpResult],
    pub created_at: i64,
}

#[derive(Clone, Debug)]
pub struct EntryChangeRow {
    pub seq: i64,
    pub paths: Vec<String>,
    pub deleted: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct StoredSuggestion {
    pub wire: Suggestion,
    pub origin: Option<String>,
    pub anchor_text: Option<String>,
    pub replacement_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaJobRow {
    pub id: String,
    pub kind: String,
    pub phase: String,
    pub data: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<media_job::Model> for MediaJobRow {
    fn from(r: media_job::Model) -> Self {
        Self {
            id: r.id,
            kind: r.kind,
            phase: r.phase,
            data: r.data,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, FromQueryResult)]
struct LibraryQueryRow {
    attachment_id: String,
    origin: String,
    added_at: i64,
    last_at: i64,
    name: String,
    content_type: String,
    size: i64,
}

fn origin_kind(o: &LibraryOrigin) -> &'static str {
    match o {
        LibraryOrigin::Generated { .. } => "generated",
        LibraryOrigin::Uploaded { .. } => "uploaded",
        LibraryOrigin::Fetched { .. } => "fetched",
    }
}

fn library_item_from_row(row: LibraryQueryRow) -> LibraryItem {
    LibraryItem {
        attachment: Attachment {
            id: row.attachment_id,
            name: row.name,
            r#type: row.content_type,
            size: row.size,
        },
        origin: serde_json::from_str(&row.origin).unwrap_or(LibraryOrigin::Uploaded { channel: None, message: None }),
        added_at: row.added_at,
        last_at: row.last_at,
    }
}

fn library_item_select() -> SelectStatement {
    Query::select()
        .column((media_library_item::Entity, media_library_item::Column::AttachmentId))
        .column((media_library_item::Entity, media_library_item::Column::Origin))
        .column((media_library_item::Entity, media_library_item::Column::AddedAt))
        .column((media_library_item::Entity, media_library_item::Column::LastAt))
        .column((attachment::Entity, attachment::Column::Name))
        .expr_as(Expr::col((attachment::Entity, attachment::Column::ContentType)), "content_type")
        .column((attachment::Entity, attachment::Column::Size))
        .from(media_library_item::Entity)
        .inner_join(
            attachment::Entity,
            Expr::col((attachment::Entity, attachment::Column::Id)).equals((media_library_item::Entity, media_library_item::Column::AttachmentId)),
        )
        .and_where(Expr::col((media_library_item::Entity, media_library_item::Column::RemovedAt)).is_null())
        .to_owned()
}

fn media_type_condition(media_type: &str) -> SimpleExpr {
    let lower_type = Func::lower(Expr::col((attachment::Entity, attachment::Column::ContentType)));
    Condition::any()
        .add(Expr::expr(lower_type.clone()).eq(media_type))
        .add(Expr::expr(lower_type).like(format!("{media_type}/%")))
        .into()
}

fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn decode_change(row: artifact_change::Model) -> DbResult<ChangeRow> {
    Ok(ChangeRow {
        artifact_id: row.artifact_id,
        seq: row.seq,
        batch_id: row.batch_id.unwrap_or_default(),
        block_ids: read_db_json(row.targets)?,
        results: read_db_json(row.payload)?,
    })
}

fn decode_stored_suggestion(row: artifact_suggestion::Model) -> DbResult<StoredSuggestion> {
    Ok(StoredSuggestion {
        wire: Suggestion {
            id: row.id,
            artifact_id: row.artifact_id,
            block_id: row.block_id,
            author: row.author,
            base_rev: row.at_rev,
            change: read_db_json(row.change)?,
            status: read_db_word(row.status)?,
            created_at: row.created_at,
            resolved_at: row.resolved_at,
            resolved_by: row.resolved_by,
            cursor_start: row.cursor_start,
            cursor_end: row.cursor_end,
            start_offset: row.start_offset.and_then(|n| u32::try_from(n).ok()),
            end_offset: row.end_offset.and_then(|n| u32::try_from(n).ok()),
        },
        origin: row.origin,
        anchor_text: row.anchor_text,
        replacement_text: row.replacement_text,
    })
}

async fn get_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<ArtifactRow>> {
    Ok(artifact::Entity::find_by_id(id.to_owned()).one(db).await?.map(ArtifactRow::from))
}

async fn default_design_system_impl<C: ConnectionTrait>(db: &C) -> DbResult<Option<ArtifactRow>> {
    Ok(artifact::Entity::find()
        .filter(artifact::Column::ArtifactType.eq("design-system"))
        .filter(artifact::Column::IsDefault.eq(true))
        .limit(1)
        .one(db)
        .await?
        .map(ArtifactRow::from))
}

async fn clear_default_design_system_impl<C: ConnectionTrait>(db: &C, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::IsDefault, Expr::value(false))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::IsDefault.eq(true))
        .exec(db)
        .await?;
    Ok(())
}

async fn set_default_impl<C: ConnectionTrait>(db: &C, id: &str, is_default: bool, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::IsDefault, Expr::value(is_default))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn add_impl<C: ConnectionTrait>(db: &C, params: NewArtifact) -> DbResult<()> {
    artifact::ActiveModel {
        id: Set(params.id),
        title: Set(params.title),
        body: Set(params.body),
        artifact_type: Set(params.artifact_type),
        is_default: Set(params.is_default),
        display: Set(params.display),
        channel_id: Set(params.channel_id),
        message_id: Set(None),
        issue: Set(params.issue),
        by_id: Set(params.by_id),
        by_name: Set(params.by_name),
        version: Set(params.version),
        seq: Set(0),
        created_at: Set(params.created_at),
        updated_at: Set(params.created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn add_version_impl<C: ConnectionTrait>(db: &C, params: NewVersion) -> DbResult<()> {
    artifact_version::ActiveModel {
        artifact_id: Set(params.artifact_id),
        version: Set(params.version),
        attachment_id: Set(params.attachment_id),
        size: Set(params.size),
        note: Set(params.note),
        by_id: Set(params.by_id),
        by_name: Set(params.by_name),
        message_id: Set(None),
        created_at: Set(params.created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn set_message_id_impl<C: ConnectionTrait>(db: &C, id: &str, message: &str) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::MessageId, Expr::value(Some(message.to_owned())))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn set_version_impl<C: ConnectionTrait>(db: &C, id: &str, version: i64, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Version, Expr::value(version))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn set_seq_impl<C: ConnectionTrait>(db: &C, id: &str, seq: i64, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Seq, Expr::value(seq))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn rename_impl<C: ConnectionTrait>(db: &C, id: &str, title: &str, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Title, Expr::value(title))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn set_display_impl<C: ConnectionTrait>(db: &C, id: &str, display: &str, at: i64) -> DbResult<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Display, Expr::value(Some(display.to_owned())))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .filter(artifact::Column::Body.eq("html"))
        .exec(db)
        .await?;
    Ok(())
}

async fn delete_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<()> {
    artifact::Entity::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}

async fn set_version_message_id_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, version: i64, message: &str) -> DbResult<()> {
    Update::many(artifact_version::Entity)
        .col_expr(artifact_version::Column::MessageId, Expr::value(Some(message.to_owned())))
        .filter(artifact_version::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_version::Column::Version.eq(version))
        .exec(db)
        .await?;
    Ok(())
}

async fn versions_impl<C: ConnectionTrait>(db: &C, artifact_id: &str) -> DbResult<Vec<VersionRow>> {
    let rows = artifact_version::Entity::find()
        .filter(artifact_version::Column::ArtifactId.eq(artifact_id))
        .order_by_asc(artifact_version::Column::Version)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(VersionRow::from).collect())
}

async fn version_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, version: i64) -> DbResult<Option<VersionRow>> {
    Ok(artifact_version::Entity::find_by_id((artifact_id.to_owned(), version))
        .one(db)
        .await?
        .map(VersionRow::from))
}

async fn blocks_impl<C: ConnectionTrait>(db: &C, artifact_id: &str) -> DbResult<Vec<Block>> {
    let rows = artifact_block::Entity::find()
        .filter(artifact_block::Column::ArtifactId.eq(artifact_id))
        .order_by_asc(artifact_block::Column::OrderKey)
        .order_by_asc(artifact_block::Column::Id)
        .all(db)
        .await?;
    rows.into_iter()
        .map(|r| {
            Ok(vibevalley_core::artifact::ops::wire(Block {
                id: r.id,
                artifact_id: r.artifact_id,
                parent_id: r.parent_id,
                order_key: r.order_key,
                r#type: read_db_word(r.block_type)?,
                attrs: read_db_json(r.attrs)?,
                text: read_db_json::<Option<Vec<TextSpan>>>(r.spans)?.unwrap_or_default(),
                rev: r.rev,
                deleted: Some(r.deleted),
                updated_by: r.updated_by,
                updated: r.updated_at,
            }))
        })
        .collect()
}

async fn block_owner_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<String>> {
    Ok(artifact_block::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(artifact_block::Column::ArtifactId)
        .into_tuple()
        .one(db)
        .await?)
}

async fn put_block_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, b: &Block) -> DbResult<()> {
    let model = artifact_block::ActiveModel {
        id: Set(b.id.clone()),
        artifact_id: Set(artifact_id.into()),
        parent_id: Set(b.parent_id.clone()),
        order_key: Set(b.order_key.clone()),
        block_type: Set(db_word(&b.r#type)?),
        attrs: Set(db_json(&b.attrs)?),
        spans: Set(db_json(&b.text)?),
        rev: Set(b.rev),
        deleted: Set(b.deleted == Some(true)),
        updated_by: Set(b.updated_by.clone()),
        updated_at: Set(b.updated),
    };
    artifact_block::Entity::insert(model)
        .on_conflict(
            OnConflict::column(artifact_block::Column::Id)
                .update_columns([
                    artifact_block::Column::ParentId,
                    artifact_block::Column::OrderKey,
                    artifact_block::Column::BlockType,
                    artifact_block::Column::Attrs,
                    artifact_block::Column::Spans,
                    artifact_block::Column::Rev,
                    artifact_block::Column::Deleted,
                    artifact_block::Column::UpdatedBy,
                    artifact_block::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

async fn add_revision_impl<C: ConnectionTrait>(db: &C, block: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> DbResult<()> {
    artifact_block_revision::ActiveModel {
        id: Set(uuid::Uuid::now_v7().to_string()),
        block_id: Set(block.into()),
        rev: Set(rev),
        spans: Set(db_json(&spans)?),
        actor: Set(actor.into()),
        kind: Set(kind.into()),
        created_at: Set(at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn revision_impl<C: ConnectionTrait>(db: &C, block: &str, rev: i64) -> DbResult<Option<Vec<TextSpan>>> {
    let spans: Option<String> = artifact_block_revision::Entity::find()
        .select_only()
        .column(artifact_block_revision::Column::Spans)
        .filter(artifact_block_revision::Column::BlockId.eq(block))
        .filter(artifact_block_revision::Column::Rev.eq(rev))
        .filter(artifact_block_revision::Column::Kind.eq("normal"))
        .order_by_desc(artifact_block_revision::Column::CreatedAt)
        .into_tuple()
        .one(db)
        .await?;
    spans
        .map(|raw| read_db_json::<Option<Vec<TextSpan>>>(raw).map(Option::unwrap_or_default))
        .transpose()
}

async fn change_by_batch_impl<C: ConnectionTrait>(db: &C, batch: &str) -> DbResult<Option<ChangeRow>> {
    artifact_change::Entity::find()
        .filter(artifact_change::Column::BatchId.eq(batch))
        .filter(artifact_change::Column::Kind.eq("blocks"))
        .one(db)
        .await?
        .map(decode_change)
        .transpose()
}

async fn add_change_impl<C: ConnectionTrait>(db: &C, c: &NewChange<'_>) -> DbResult<()> {
    artifact_change::ActiveModel {
        artifact_id: Set(c.artifact_id.into()),
        seq: Set(c.seq),
        kind: Set("blocks".into()),
        batch_id: Set(Some(c.batch_id.into())),
        actor: Set(c.actor.into()),
        targets: Set(db_json(&c.block_ids)?),
        payload: Set(db_json(&c.results)?),
        created_at: Set(c.created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn changes_after_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<ChangeRow>> {
    artifact_change::Entity::find()
        .filter(artifact_change::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_change::Column::Kind.eq("blocks"))
        .filter(artifact_change::Column::Seq.gt(seq))
        .order_by_asc(artifact_change::Column::Seq)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(decode_change)
        .collect()
}

async fn add_suggestion_impl<C: ConnectionTrait>(db: &C, s: &StoredSuggestion) -> DbResult<()> {
    artifact_suggestion::ActiveModel {
        id: Set(s.wire.id.clone()),
        artifact_id: Set(s.wire.artifact_id.clone()),
        block_id: Set(s.wire.block_id.clone()),
        author: Set(s.wire.author.clone()),
        origin: Set(s.origin.clone()),
        at_rev: Set(s.wire.base_rev),
        change: Set(db_json(&s.wire.change)?),
        cursor_start: Set(s.wire.cursor_start.clone()),
        cursor_end: Set(s.wire.cursor_end.clone()),
        start_offset: Set(s.wire.start_offset.map(i64::from)),
        end_offset: Set(s.wire.end_offset.map(i64::from)),
        anchor_text: Set(s.anchor_text.clone()),
        replacement_text: Set(s.replacement_text.clone()),
        status: Set("open".into()),
        created_at: Set(s.wire.created_at),
        resolved_at: Set(None),
        resolved_by: Set(None),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn update_suggestion_impl<C: ConnectionTrait>(db: &C, s: &StoredSuggestion) -> DbResult<()> {
    Update::many(artifact_suggestion::Entity)
        .col_expr(artifact_suggestion::Column::AtRev, Expr::value(s.wire.base_rev))
        .col_expr(artifact_suggestion::Column::Change, Expr::value(db_json(&s.wire.change)?))
        .col_expr(artifact_suggestion::Column::CursorStart, Expr::value(s.wire.cursor_start.clone()))
        .col_expr(artifact_suggestion::Column::CursorEnd, Expr::value(s.wire.cursor_end.clone()))
        .col_expr(artifact_suggestion::Column::StartOffset, Expr::value(s.wire.start_offset.map(i64::from)))
        .col_expr(artifact_suggestion::Column::EndOffset, Expr::value(s.wire.end_offset.map(i64::from)))
        .col_expr(artifact_suggestion::Column::AnchorText, Expr::value(s.anchor_text.clone()))
        .col_expr(artifact_suggestion::Column::ReplacementText, Expr::value(s.replacement_text.clone()))
        .filter(artifact_suggestion::Column::Id.eq(&s.wire.id))
        .filter(artifact_suggestion::Column::Status.eq("open"))
        .exec(db)
        .await?;
    Ok(())
}

async fn resolve_suggestion_impl<C: ConnectionTrait>(db: &C, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
    Update::many(artifact_suggestion::Entity)
        .col_expr(artifact_suggestion::Column::Status, Expr::value(status))
        .col_expr(artifact_suggestion::Column::ResolvedAt, Expr::value(Some(at)))
        .col_expr(artifact_suggestion::Column::ResolvedBy, Expr::value(Some(by.to_owned())))
        .filter(artifact_suggestion::Column::Id.eq(id))
        .filter(artifact_suggestion::Column::Status.eq("open"))
        .exec(db)
        .await?;
    Ok(())
}

async fn stored_suggestion_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<StoredSuggestion>> {
    artifact_suggestion::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(decode_stored_suggestion)
        .transpose()
}

async fn stored_suggestions_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, limit: i64) -> DbResult<Vec<StoredSuggestion>> {
    artifact_suggestion::Entity::find()
        .filter(artifact_suggestion::Column::ArtifactId.eq(artifact_id))
        .order_by_asc(artifact_suggestion::Column::CreatedAt)
        .order_by_asc(artifact_suggestion::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(decode_stored_suggestion)
        .collect()
}

async fn collab_snapshot_impl<C: ConnectionTrait>(db: &C, artifact_id: &str) -> DbResult<Option<Vec<u8>>> {
    Ok(artifact_collab::Entity::find_by_id(artifact_id.to_owned()).one(db).await?.map(|m| m.snapshot))
}

async fn upsert_collab_snapshot_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
    let model = artifact_collab::ActiveModel {
        artifact_id: Set(artifact_id.into()),
        snapshot: Set(snapshot.to_vec()),
        updated_at: Set(updated_at),
    };
    artifact_collab::Entity::insert(model)
        .on_conflict(
            OnConflict::column(artifact_collab::Column::ArtifactId)
                .update_columns([artifact_collab::Column::Snapshot, artifact_collab::Column::UpdatedAt])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

async fn entries_impl<C: ConnectionTrait>(db: &C, artifact_id: &str) -> DbResult<Vec<EntryRow>> {
    let rows = artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .order_by_asc(artifact_entry::Column::Path)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(EntryRow::from).collect())
}

async fn entries_by_prefix_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, prefix: &str) -> DbResult<Vec<EntryRow>> {
    let rows = artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_entry::Column::Path.starts_with(prefix))
        .order_by_asc(artifact_entry::Column::Path)
        .all(db)
        .await?;
    Ok(rows.into_iter().filter(|r| r.path.starts_with(prefix)).map(EntryRow::from).collect())
}

async fn entry_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, path: &str) -> DbResult<Option<EntryRow>> {
    Ok(artifact_entry::Entity::find_by_id((artifact_id.to_owned(), path.to_owned()))
        .one(db)
        .await?
        .map(EntryRow::from))
}

async fn entry_count_impl<C: ConnectionTrait>(db: &C, artifact_id: &str) -> DbResult<i64> {
    let count = artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .count(db)
        .await?;
    Ok(count as i64)
}

async fn upsert_entry_impl<C: ConnectionTrait>(db: &C, params: UpsertEntry) -> DbResult<()> {
    let model = artifact_entry::ActiveModel {
        artifact_id: Set(params.artifact_id),
        path: Set(params.path),
        kind: Set(params.kind),
        mime: Set(params.mime),
        value: Set(params.value),
        attachment_id: Set(params.attachment_id),
        size: Set(params.size),
        rev: Set(params.rev),
        updated_by: Set(params.updated_by),
        updated_at: Set(params.updated_at),
    };
    artifact_entry::Entity::insert(model)
        .on_conflict(
            OnConflict::columns([artifact_entry::Column::ArtifactId, artifact_entry::Column::Path])
                .update_columns([
                    artifact_entry::Column::Kind,
                    artifact_entry::Column::Mime,
                    artifact_entry::Column::Value,
                    artifact_entry::Column::AttachmentId,
                    artifact_entry::Column::Size,
                    artifact_entry::Column::Rev,
                    artifact_entry::Column::UpdatedBy,
                    artifact_entry::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

async fn delete_entry_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, path: &str) -> DbResult<()> {
    artifact_entry::Entity::delete_by_id((artifact_id.to_owned(), path.to_owned())).exec(db).await?;
    Ok(())
}

async fn add_entry_change_impl<C: ConnectionTrait>(
    db: &C,
    artifact_id: &str,
    seq: i64,
    actor: &str,
    paths: &[String],
    deleted: &[String],
    created_at: i64,
) -> DbResult<()> {
    artifact_change::ActiveModel {
        artifact_id: Set(artifact_id.into()),
        seq: Set(seq),
        kind: Set("entries".into()),
        batch_id: Set(None),
        actor: Set(actor.into()),
        targets: Set(db_json(&paths)?),
        payload: Set(db_json(&deleted)?),
        created_at: Set(created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn entry_changes_after_impl<C: ConnectionTrait>(db: &C, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<EntryChangeRow>> {
    artifact_change::Entity::find()
        .filter(artifact_change::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_change::Column::Kind.eq("entries"))
        .filter(artifact_change::Column::Seq.gt(seq))
        .order_by_asc(artifact_change::Column::Seq)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(|r| {
            Ok(EntryChangeRow {
                seq: r.seq,
                paths: read_db_json(r.targets)?,
                deleted: read_db_json(r.payload)?,
            })
        })
        .collect()
}

async fn find_media_job_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<MediaJobRow>> {
    Ok(media_job::Entity::find_by_id(id.to_owned()).one(db).await?.map(MediaJobRow::from))
}

async fn count_media_jobs_in_phases_impl<C: ConnectionTrait>(db: &C, phases: &[&str]) -> DbResult<u64> {
    if phases.is_empty() {
        return Ok(0);
    }
    Ok(media_job::Entity::find()
        .filter(media_job::Column::Phase.is_in(phases.iter().copied()))
        .count(db)
        .await?)
}

async fn save_media_job_impl<C: ConnectionTrait>(db: &C, row: &MediaJobRow) -> DbResult<()> {
    let model = media_job::ActiveModel {
        id: Set(row.id.clone()),
        kind: Set(row.kind.clone()),
        phase: Set(row.phase.clone()),
        data: Set(row.data.clone()),
        created_at: Set(row.created_at),
        updated_at: Set(row.updated_at),
    };
    media_job::Entity::insert(model)
        .on_conflict(
            OnConflict::column(media_job::Column::Id)
                .update_columns([media_job::Column::Phase, media_job::Column::Data, media_job::Column::UpdatedAt])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

#[derive(Clone)]
pub struct ArtifactService {
    db: Arc<Database>,
}

impl ArtifactService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub async fn get(&self, id: &str) -> DbResult<Option<ArtifactRow>> {
        get_impl(self.db.read_conn(), id).await
    }

    pub async fn get_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<ArtifactRow>> {
        get_impl(tx, id).await
    }

    pub async fn default_design_system(&self) -> DbResult<Option<ArtifactRow>> {
        default_design_system_impl(self.db.read_conn()).await
    }

    pub async fn default_design_system_in_tx(&self, tx: &Tx) -> DbResult<Option<ArtifactRow>> {
        default_design_system_impl(tx).await
    }

    pub async fn clear_default_design_system(&self, at: i64) -> DbResult<()> {
        clear_default_design_system_impl(self.db.write_conn(), at).await
    }

    pub async fn clear_default_design_system_in_tx(&self, tx: &Tx, at: i64) -> DbResult<()> {
        clear_default_design_system_impl(tx, at).await
    }

    pub async fn set_default(&self, id: &str, is_default: bool, at: i64) -> DbResult<()> {
        set_default_impl(self.db.write_conn(), id, is_default, at).await
    }

    pub async fn set_default_in_tx(&self, tx: &Tx, id: &str, is_default: bool, at: i64) -> DbResult<()> {
        set_default_impl(tx, id, is_default, at).await
    }

    pub async fn list_in_channel(&self, channel_id: &str) -> DbResult<Vec<ArtifactRow>> {
        let rows = artifact::Entity::find()
            .filter(artifact::Column::ChannelId.eq(channel_id))
            .order_by_desc(artifact::Column::UpdatedAt)
            .order_by_asc(artifact::Column::Id)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(ArtifactRow::from).collect())
    }

    pub async fn list_for_issue(&self, issue_id: &str) -> DbResult<Vec<ArtifactRow>> {
        let rows = artifact::Entity::find()
            .filter(artifact::Column::Issue.eq(issue_id))
            .order_by_desc(artifact::Column::UpdatedAt)
            .order_by_asc(artifact::Column::Id)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(ArtifactRow::from).collect())
    }

    pub async fn list(&self, limit: i64) -> DbResult<Vec<ArtifactRow>> {
        let rows = artifact::Entity::find()
            .order_by_desc(artifact::Column::UpdatedAt)
            .order_by_asc(artifact::Column::Id)
            .limit(u64::try_from(limit).unwrap_or(0))
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(ArtifactRow::from).collect())
    }

    pub async fn add(&self, params: NewArtifact) -> DbResult<()> {
        add_impl(self.db.write_conn(), params).await
    }

    pub async fn add_in_tx(&self, tx: &Tx, params: NewArtifact) -> DbResult<()> {
        add_impl(tx, params).await
    }

    pub async fn add_version(&self, params: NewVersion) -> DbResult<()> {
        add_version_impl(self.db.write_conn(), params).await
    }

    pub async fn add_version_in_tx(&self, tx: &Tx, params: NewVersion) -> DbResult<()> {
        add_version_impl(tx, params).await
    }

    pub async fn set_message_id(&self, id: &str, message_id: &str) -> DbResult<()> {
        set_message_id_impl(self.db.write_conn(), id, message_id).await
    }

    pub async fn set_message_id_in_tx(&self, tx: &Tx, id: &str, message_id: &str) -> DbResult<()> {
        set_message_id_impl(tx, id, message_id).await
    }

    pub async fn set_version(&self, id: &str, version: i64, at: i64) -> DbResult<()> {
        set_version_impl(self.db.write_conn(), id, version, at).await
    }

    pub async fn set_version_in_tx(&self, tx: &Tx, id: &str, version: i64, at: i64) -> DbResult<()> {
        set_version_impl(tx, id, version, at).await
    }

    pub async fn set_seq(&self, id: &str, seq: i64, at: i64) -> DbResult<()> {
        set_seq_impl(self.db.write_conn(), id, seq, at).await
    }

    pub async fn set_seq_in_tx(&self, tx: &Tx, id: &str, seq: i64, at: i64) -> DbResult<()> {
        set_seq_impl(tx, id, seq, at).await
    }

    pub async fn rename(&self, id: &str, title: &str, at: i64) -> DbResult<()> {
        rename_impl(self.db.write_conn(), id, title, at).await
    }

    pub async fn rename_in_tx(&self, tx: &Tx, id: &str, title: &str, at: i64) -> DbResult<()> {
        rename_impl(tx, id, title, at).await
    }

    pub async fn set_display(&self, id: &str, display: &str, at: i64) -> DbResult<()> {
        set_display_impl(self.db.write_conn(), id, display, at).await
    }

    pub async fn set_display_in_tx(&self, tx: &Tx, id: &str, display: &str, at: i64) -> DbResult<()> {
        set_display_impl(tx, id, display, at).await
    }

    pub async fn delete(&self, id: &str) -> DbResult<()> {
        delete_impl(self.db.write_conn(), id).await
    }

    pub async fn delete_in_tx(&self, tx: &Tx, id: &str) -> DbResult<()> {
        delete_impl(tx, id).await
    }

    pub async fn set_version_message_id(&self, artifact_id: &str, version: i64, message_id: &str) -> DbResult<()> {
        set_version_message_id_impl(self.db.write_conn(), artifact_id, version, message_id).await
    }

    pub async fn set_version_message_id_in_tx(&self, tx: &Tx, artifact_id: &str, version: i64, message_id: &str) -> DbResult<()> {
        set_version_message_id_impl(tx, artifact_id, version, message_id).await
    }

    pub async fn versions(&self, artifact_id: &str) -> DbResult<Vec<VersionRow>> {
        versions_impl(self.db.read_conn(), artifact_id).await
    }

    pub async fn versions_in_tx(&self, tx: &Tx, artifact_id: &str) -> DbResult<Vec<VersionRow>> {
        versions_impl(tx, artifact_id).await
    }

    pub async fn version(&self, artifact_id: &str, version: i64) -> DbResult<Option<VersionRow>> {
        version_impl(self.db.read_conn(), artifact_id, version).await
    }

    pub async fn version_in_tx(&self, tx: &Tx, artifact_id: &str, version: i64) -> DbResult<Option<VersionRow>> {
        version_impl(tx, artifact_id, version).await
    }

    pub async fn blocks(&self, artifact_id: &str) -> DbResult<Vec<Block>> {
        blocks_impl(self.db.read_conn(), artifact_id).await
    }

    pub async fn blocks_in_tx(&self, tx: &Tx, artifact_id: &str) -> DbResult<Vec<Block>> {
        blocks_impl(tx, artifact_id).await
    }

    pub async fn block_owner(&self, id: &str) -> DbResult<Option<String>> {
        block_owner_impl(self.db.read_conn(), id).await
    }

    pub async fn block_owner_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<String>> {
        block_owner_impl(tx, id).await
    }

    pub async fn put_block(&self, artifact_id: &str, block: &Block) -> DbResult<()> {
        put_block_impl(self.db.write_conn(), artifact_id, block).await
    }

    pub async fn put_block_in_tx(&self, tx: &Tx, artifact_id: &str, block: &Block) -> DbResult<()> {
        put_block_impl(tx, artifact_id, block).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_revision(&self, block_id: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> DbResult<()> {
        add_revision_impl(self.db.write_conn(), block_id, rev, spans, actor, kind, at).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_revision_in_tx(&self, tx: &Tx, block_id: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> DbResult<()> {
        add_revision_impl(tx, block_id, rev, spans, actor, kind, at).await
    }

    pub async fn revision(&self, block_id: &str, rev: i64) -> DbResult<Option<Vec<TextSpan>>> {
        revision_impl(self.db.read_conn(), block_id, rev).await
    }

    pub async fn revision_in_tx(&self, tx: &Tx, block_id: &str, rev: i64) -> DbResult<Option<Vec<TextSpan>>> {
        revision_impl(tx, block_id, rev).await
    }

    pub async fn prune_history(&self, before: i64) -> DbResult<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let outcome: DbResult<()> = async {
            artifact_change::Entity::delete_many()
                .filter(artifact_change::Column::CreatedAt.lt(before))
                .exec(&tx)
                .await?;
            artifact_block_revision::Entity::delete_many()
                .filter(artifact_block_revision::Column::CreatedAt.lt(before))
                .exec(&tx)
                .await?;
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => commit_tx(tx).await,
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    pub async fn change_by_batch(&self, batch_id: &str) -> DbResult<Option<ChangeRow>> {
        change_by_batch_impl(self.db.read_conn(), batch_id).await
    }

    pub async fn change_by_batch_in_tx(&self, tx: &Tx, batch_id: &str) -> DbResult<Option<ChangeRow>> {
        change_by_batch_impl(tx, batch_id).await
    }

    pub async fn add_change(&self, change: &NewChange<'_>) -> DbResult<()> {
        add_change_impl(self.db.write_conn(), change).await
    }

    pub async fn add_change_in_tx(&self, tx: &Tx, change: &NewChange<'_>) -> DbResult<()> {
        add_change_impl(tx, change).await
    }

    pub async fn changes_after(&self, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<ChangeRow>> {
        changes_after_impl(self.db.read_conn(), artifact_id, seq, limit).await
    }

    pub async fn changes_after_in_tx(&self, tx: &Tx, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<ChangeRow>> {
        changes_after_impl(tx, artifact_id, seq, limit).await
    }

    pub async fn add_suggestion(&self, suggestion: &StoredSuggestion) -> DbResult<()> {
        add_suggestion_impl(self.db.write_conn(), suggestion).await
    }

    pub async fn add_suggestion_in_tx(&self, tx: &Tx, suggestion: &StoredSuggestion) -> DbResult<()> {
        add_suggestion_impl(tx, suggestion).await
    }

    pub async fn update_suggestion(&self, suggestion: &StoredSuggestion) -> DbResult<()> {
        update_suggestion_impl(self.db.write_conn(), suggestion).await
    }

    pub async fn update_suggestion_in_tx(&self, tx: &Tx, suggestion: &StoredSuggestion) -> DbResult<()> {
        update_suggestion_impl(tx, suggestion).await
    }

    pub async fn resolve_suggestion(&self, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
        resolve_suggestion_impl(self.db.write_conn(), id, status, at, by).await
    }

    pub async fn resolve_suggestion_in_tx(&self, tx: &Tx, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
        resolve_suggestion_impl(tx, id, status, at, by).await
    }

    pub async fn stored_suggestion(&self, id: &str) -> DbResult<Option<StoredSuggestion>> {
        stored_suggestion_impl(self.db.read_conn(), id).await
    }

    pub async fn stored_suggestion_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<StoredSuggestion>> {
        stored_suggestion_impl(tx, id).await
    }

    pub async fn stored_suggestions(&self, artifact_id: &str, limit: i64) -> DbResult<Vec<StoredSuggestion>> {
        stored_suggestions_impl(self.db.read_conn(), artifact_id, limit).await
    }

    pub async fn stored_suggestions_in_tx(&self, tx: &Tx, artifact_id: &str, limit: i64) -> DbResult<Vec<StoredSuggestion>> {
        stored_suggestions_impl(tx, artifact_id, limit).await
    }

    pub async fn suggestion(&self, id: &str) -> DbResult<Option<Suggestion>> {
        Ok(self.stored_suggestion(id).await?.map(|s| s.wire))
    }

    pub async fn suggestions(&self, artifact_id: &str, limit: i64) -> DbResult<Vec<Suggestion>> {
        Ok(self.stored_suggestions(artifact_id, limit).await?.into_iter().map(|s| s.wire).collect())
    }

    pub async fn collab_snapshot(&self, artifact_id: &str) -> DbResult<Option<Vec<u8>>> {
        collab_snapshot_impl(self.db.read_conn(), artifact_id).await
    }

    pub async fn collab_snapshot_in_tx(&self, tx: &Tx, artifact_id: &str) -> DbResult<Option<Vec<u8>>> {
        collab_snapshot_impl(tx, artifact_id).await
    }

    pub async fn upsert_collab_snapshot(&self, artifact_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
        upsert_collab_snapshot_impl(self.db.write_conn(), artifact_id, snapshot, updated_at).await
    }

    pub async fn upsert_collab_snapshot_in_tx(&self, tx: &Tx, artifact_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
        upsert_collab_snapshot_impl(tx, artifact_id, snapshot, updated_at).await
    }

    pub async fn entries(&self, artifact_id: &str) -> DbResult<Vec<EntryRow>> {
        entries_impl(self.db.read_conn(), artifact_id).await
    }

    pub async fn entries_in_tx(&self, tx: &Tx, artifact_id: &str) -> DbResult<Vec<EntryRow>> {
        entries_impl(tx, artifact_id).await
    }

    pub async fn entries_by_prefix(&self, artifact_id: &str, prefix: &str) -> DbResult<Vec<EntryRow>> {
        entries_by_prefix_impl(self.db.read_conn(), artifact_id, prefix).await
    }

    pub async fn entries_by_prefix_in_tx(&self, tx: &Tx, artifact_id: &str, prefix: &str) -> DbResult<Vec<EntryRow>> {
        entries_by_prefix_impl(tx, artifact_id, prefix).await
    }

    pub async fn entry(&self, artifact_id: &str, path: &str) -> DbResult<Option<EntryRow>> {
        entry_impl(self.db.read_conn(), artifact_id, path).await
    }

    pub async fn entry_in_tx(&self, tx: &Tx, artifact_id: &str, path: &str) -> DbResult<Option<EntryRow>> {
        entry_impl(tx, artifact_id, path).await
    }

    pub async fn entry_count(&self, artifact_id: &str) -> DbResult<i64> {
        entry_count_impl(self.db.read_conn(), artifact_id).await
    }

    pub async fn entry_count_in_tx(&self, tx: &Tx, artifact_id: &str) -> DbResult<i64> {
        entry_count_impl(tx, artifact_id).await
    }

    pub async fn upsert_entry(&self, params: UpsertEntry) -> DbResult<()> {
        upsert_entry_impl(self.db.write_conn(), params).await
    }

    pub async fn upsert_entry_in_tx(&self, tx: &Tx, params: UpsertEntry) -> DbResult<()> {
        upsert_entry_impl(tx, params).await
    }

    pub async fn delete_entry(&self, artifact_id: &str, path: &str) -> DbResult<()> {
        delete_entry_impl(self.db.write_conn(), artifact_id, path).await
    }

    pub async fn delete_entry_in_tx(&self, tx: &Tx, artifact_id: &str, path: &str) -> DbResult<()> {
        delete_entry_impl(tx, artifact_id, path).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_entry_change(&self, artifact_id: &str, seq: i64, actor: &str, paths: &[String], deleted: &[String], created_at: i64) -> DbResult<()> {
        add_entry_change_impl(self.db.write_conn(), artifact_id, seq, actor, paths, deleted, created_at).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_entry_change_in_tx(
        &self,
        tx: &Tx,
        artifact_id: &str,
        seq: i64,
        actor: &str,
        paths: &[String],
        deleted: &[String],
        created_at: i64,
    ) -> DbResult<()> {
        add_entry_change_impl(tx, artifact_id, seq, actor, paths, deleted, created_at).await
    }

    pub async fn entry_changes_after(&self, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<EntryChangeRow>> {
        entry_changes_after_impl(self.db.read_conn(), artifact_id, seq, limit).await
    }

    pub async fn entry_changes_after_in_tx(&self, tx: &Tx, artifact_id: &str, seq: i64, limit: i64) -> DbResult<Vec<EntryChangeRow>> {
        entry_changes_after_impl(tx, artifact_id, seq, limit).await
    }

    // --- Media library ---

    pub async fn find_library_item(&self, attachment_id: &str) -> DbResult<Option<LibraryItem>> {
        let mut query = library_item_select();
        query.and_where(Expr::col((media_library_item::Entity, media_library_item::Column::AttachmentId)).eq(attachment_id));
        let conn = self.db.read_conn();
        let row = LibraryQueryRow::find_by_statement(conn.get_database_backend().build(&query)).one(conn).await?;
        Ok(row.map(library_item_from_row))
    }

    /// Inserts or updates a library item; a later arrival on an active item only advances `last_at`.
    pub async fn keep_library_item(&self, attachment_id: &str, origin: &LibraryOrigin, at: i64) -> DbResult<()> {
        let model = media_library_item::ActiveModel {
            attachment_id: Set(attachment_id.into()),
            kind: Set(origin_kind(origin).into()),
            origin: Set(db_json(origin)?),
            added_at: Set(at),
            last_at: Set(at),
            source_job_id: Set(None),
            removed_at: Set(None),
        };
        let excluded = Alias::new("excluded");
        let was_removed = Expr::col((media_library_item::Entity, media_library_item::Column::RemovedAt)).is_not_null();
        let existing_kind = Expr::col((media_library_item::Entity, media_library_item::Column::Kind));
        let excluded_kind = Expr::col((excluded.clone(), media_library_item::Column::Kind));
        let existing_origin = Expr::col((media_library_item::Entity, media_library_item::Column::Origin));
        let excluded_origin = Expr::col((excluded.clone(), media_library_item::Column::Origin));
        let existing_last = Expr::col((media_library_item::Entity, media_library_item::Column::LastAt));
        let excluded_last = Expr::col((excluded, media_library_item::Column::LastAt));
        let on_conflict = OnConflict::column(media_library_item::Column::AttachmentId)
            .value(
                media_library_item::Column::Kind,
                Expr::case(was_removed.clone(), excluded_kind).finally(existing_kind),
            )
            .value(
                media_library_item::Column::Origin,
                Expr::case(was_removed, excluded_origin).finally(existing_origin),
            )
            .value(
                media_library_item::Column::LastAt,
                Expr::case(existing_last.clone().gte(excluded_last.clone()), existing_last).finally(excluded_last),
            )
            .value(media_library_item::Column::RemovedAt, Expr::val(Option::<i64>::None))
            .to_owned();
        media_library_item::Entity::insert(model)
            .on_conflict(on_conflict)
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    /// Records a media job's output attachment once per `(attachment_id, source_job_id)`.
    pub async fn record_generated_library_item(&self, attachment_id: &str, source_job_id: &str, origin: &LibraryOrigin, at: i64) -> DbResult<()> {
        let model = media_library_item::ActiveModel {
            attachment_id: Set(attachment_id.into()),
            kind: Set(origin_kind(origin).into()),
            origin: Set(db_json(origin)?),
            added_at: Set(at),
            last_at: Set(at),
            source_job_id: Set(Some(source_job_id.into())),
            removed_at: Set(None),
        };
        media_library_item::Entity::insert(model)
            .on_conflict_do_nothing()
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn list_library_items(&self, req: &LibraryListRequest, limit: u64) -> DbResult<Vec<LibraryItem>> {
        let mut query = library_item_select();
        if let Some(kind) = req.origin {
            query.and_where(Expr::col((media_library_item::Entity, media_library_item::Column::Kind)).eq(kind.as_str()));
        }
        if let Some(media_type) = req.r#type {
            match media_type {
                LibraryFileKind::Other => {
                    let known = Condition::any()
                        .add(media_type_condition("image"))
                        .add(media_type_condition("audio"))
                        .add(media_type_condition("video"));
                    query.and_where(known.not().into());
                }
                LibraryFileKind::Image | LibraryFileKind::Audio | LibraryFileKind::Video => {
                    query.and_where(media_type_condition(media_type.as_str()));
                }
            }
        }
        let text = req.text.as_deref().unwrap_or("").trim().to_lowercase();
        if !text.is_empty() {
            let pattern = format!("%{}%", escape_like(&text));
            query.and_where(Expr::expr(Func::lower(Expr::col((attachment::Entity, attachment::Column::Name)))).like(LikeExpr::new(pattern).escape('\\')));
        }
        match req.sort.unwrap_or(LibrarySort::Recent) {
            LibrarySort::Name => {
                query.order_by_expr(Func::lower(Expr::col((attachment::Entity, attachment::Column::Name))).into(), Order::Asc);
            }
            LibrarySort::Size => {
                query.order_by((attachment::Entity, attachment::Column::Size), Order::Desc);
            }
            LibrarySort::Recent => {}
        }
        query
            .order_by((media_library_item::Entity, media_library_item::Column::LastAt), Order::Desc)
            .order_by((media_library_item::Entity, media_library_item::Column::AttachmentId), Order::Asc)
            .limit(limit);

        let conn = self.db.read_conn();
        let rows = LibraryQueryRow::find_by_statement(conn.get_database_backend().build(&query)).all(conn).await?;
        Ok(rows.into_iter().map(library_item_from_row).collect())
    }

    /// Soft-removes generated items (`source_job_id IS NOT NULL`) so they are not re-recorded,
    /// and hard-deletes uploaded/fetched items.
    pub async fn remove_library_item(&self, attachment_id: &str, at: i64) -> DbResult<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let outcome: DbResult<()> = async {
            Update::many(media_library_item::Entity)
                .col_expr(media_library_item::Column::RemovedAt, Expr::value(Some(at)))
                .filter(media_library_item::Column::AttachmentId.eq(attachment_id))
                .filter(media_library_item::Column::SourceJobId.is_not_null())
                .exec(&tx)
                .await?;
            media_library_item::Entity::delete_many()
                .filter(media_library_item::Column::AttachmentId.eq(attachment_id))
                .filter(media_library_item::Column::SourceJobId.is_null())
                .exec(&tx)
                .await?;
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => commit_tx(tx).await,
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    // --- Media jobs ---

    pub async fn find_media_job(&self, id: &str) -> DbResult<Option<MediaJobRow>> {
        find_media_job_impl(self.db.read_conn(), id).await
    }

    pub async fn find_media_job_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<MediaJobRow>> {
        find_media_job_impl(tx, id).await
    }

    pub async fn list_recent_media_jobs(&self, limit: u64) -> DbResult<Vec<MediaJobRow>> {
        let rows = media_job::Entity::find()
            .order_by_desc(media_job::Column::CreatedAt)
            .order_by_asc(media_job::Column::Id)
            .limit(limit)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(MediaJobRow::from).collect())
    }

    pub async fn list_media_jobs_by_phases(&self, phases: &[&str], ascending: bool) -> DbResult<Vec<MediaJobRow>> {
        if phases.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = media_job::Entity::find().filter(media_job::Column::Phase.is_in(phases.iter().copied()));
        if ascending {
            query = query.order_by_asc(media_job::Column::CreatedAt).order_by_asc(media_job::Column::Id);
        }
        let rows = query.all(self.db.read_conn()).await?;
        Ok(rows.into_iter().map(MediaJobRow::from).collect())
    }

    pub async fn count_media_jobs_in_phases(&self, phases: &[&str]) -> DbResult<u64> {
        count_media_jobs_in_phases_impl(self.db.read_conn(), phases).await
    }

    pub async fn count_media_jobs_in_phases_in_tx(&self, tx: &Tx, phases: &[&str]) -> DbResult<u64> {
        count_media_jobs_in_phases_impl(tx, phases).await
    }

    pub async fn save_media_job(&self, row: &MediaJobRow) -> DbResult<()> {
        save_media_job_impl(self.db.write_conn(), row).await
    }

    pub async fn save_media_job_in_tx(&self, tx: &Tx, row: &MediaJobRow) -> DbResult<()> {
        save_media_job_impl(tx, row).await
    }
}
