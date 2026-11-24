//! Storage for artifacts and their references to optional channel messages.

use sea_orm::sea_query::{Expr, OnConflict, Order, Query, SelectStatement};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Update,
};
use vibevalley_protocol::{Block, BlockOpResult, Suggestion, TextSpan};

use crate::db::entities::collab_channel::channel_message;
use crate::db::entities::content_artifact::{
    artifact, artifact_block, artifact_block_revision, artifact_change, artifact_collab, artifact_entry, artifact_suggestion, artifact_version,
};
use crate::modules::content::{json, read_json, read_word, word, write_tx};

pub type Q<T> = Result<T, DbErr>;
pub type EntryRow = artifact_entry::Model;

#[derive(Clone, Debug, FromQueryResult)]
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
    pub said_channel: Option<String>,
    pub said_number: Option<i64>,
}

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

#[derive(Clone, Debug, FromQueryResult)]
pub struct VersionRow {
    pub version: i64,
    pub attachment_id: String,
    pub size: i64,
    pub note: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub created_at: i64,
    pub message_channel: Option<String>,
    pub message_number: Option<i64>,
}

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

fn artifact_select() -> SelectStatement {
    Query::select()
        .column((artifact::Entity, artifact::Column::Id))
        .column((artifact::Entity, artifact::Column::Title))
        .column((artifact::Entity, artifact::Column::Body))
        .column((artifact::Entity, artifact::Column::ArtifactType))
        .column((artifact::Entity, artifact::Column::IsDefault))
        .column((artifact::Entity, artifact::Column::Display))
        .column((artifact::Entity, artifact::Column::ChannelId))
        .column((artifact::Entity, artifact::Column::MessageId))
        .column((artifact::Entity, artifact::Column::Issue))
        .column((artifact::Entity, artifact::Column::ById))
        .column((artifact::Entity, artifact::Column::ByName))
        .column((artifact::Entity, artifact::Column::Version))
        .column((artifact::Entity, artifact::Column::Seq))
        .column((artifact::Entity, artifact::Column::CreatedAt))
        .column((artifact::Entity, artifact::Column::UpdatedAt))
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)), "said_channel")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Number)), "said_number")
        .from(artifact::Entity)
        .left_join(
            channel_message::Entity,
            Expr::col((channel_message::Entity, channel_message::Column::Id)).equals((artifact::Entity, artifact::Column::MessageId)),
        )
        .to_owned()
}

fn version_select(artifact_id: &str) -> SelectStatement {
    Query::select()
        .column((artifact_version::Entity, artifact_version::Column::Version))
        .column((artifact_version::Entity, artifact_version::Column::AttachmentId))
        .column((artifact_version::Entity, artifact_version::Column::Size))
        .column((artifact_version::Entity, artifact_version::Column::Note))
        .column((artifact_version::Entity, artifact_version::Column::ById))
        .column((artifact_version::Entity, artifact_version::Column::ByName))
        .column((artifact_version::Entity, artifact_version::Column::CreatedAt))
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)), "message_channel")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Number)), "message_number")
        .from(artifact_version::Entity)
        .left_join(
            channel_message::Entity,
            Expr::col((channel_message::Entity, channel_message::Column::Id)).equals((artifact_version::Entity, artifact_version::Column::MessageId)),
        )
        .and_where(Expr::col((artifact_version::Entity, artifact_version::Column::ArtifactId)).eq(artifact_id))
        .to_owned()
}

pub async fn artifact<C: ConnectionTrait>(db: &C, id: &str) -> Q<Option<ArtifactRow>> {
    let mut query = artifact_select();
    query.and_where(Expr::col((artifact::Entity, artifact::Column::Id)).eq(id));
    ArtifactRow::find_by_statement(db.get_database_backend().build(&query)).one(db).await
}

pub async fn default_design_system_artifact<C: ConnectionTrait>(db: &C) -> Q<Option<ArtifactRow>> {
    let mut query = artifact_select();
    query
        .and_where(Expr::col((artifact::Entity, artifact::Column::ArtifactType)).eq("design-system"))
        .and_where(Expr::col((artifact::Entity, artifact::Column::IsDefault)).eq(true))
        .limit(1);
    ArtifactRow::find_by_statement(db.get_database_backend().build(&query)).one(db).await
}

pub async fn clear_default_design_system<C: ConnectionTrait>(db: &C, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::IsDefault, Expr::value(false))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::IsDefault.eq(true))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn set_artifact_default<C: ConnectionTrait>(db: &C, id: &str, is_default: bool, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::IsDefault, Expr::value(is_default))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn artifacts_in_channel<C: ConnectionTrait>(db: &C, channel: &str) -> Q<Vec<ArtifactRow>> {
    let mut query = artifact_select();
    query
        .and_where(Expr::col((artifact::Entity, artifact::Column::ChannelId)).eq(channel))
        .order_by((artifact::Entity, artifact::Column::UpdatedAt), Order::Desc)
        .order_by((artifact::Entity, artifact::Column::Id), Order::Asc);
    ArtifactRow::find_by_statement(db.get_database_backend().build(&query)).all(db).await
}

pub async fn artifacts_for_issue<C: ConnectionTrait>(db: &C, issue: &str) -> Q<Vec<ArtifactRow>> {
    let mut query = artifact_select();
    query
        .and_where(Expr::col((artifact::Entity, artifact::Column::Issue)).eq(issue))
        .order_by((artifact::Entity, artifact::Column::UpdatedAt), Order::Desc)
        .order_by((artifact::Entity, artifact::Column::Id), Order::Asc);
    ArtifactRow::find_by_statement(db.get_database_backend().build(&query)).all(db).await
}

pub async fn artifacts<C: ConnectionTrait>(db: &C, limit: i64) -> Q<Vec<ArtifactRow>> {
    let mut query = artifact_select();
    query
        .order_by((artifact::Entity, artifact::Column::UpdatedAt), Order::Desc)
        .order_by((artifact::Entity, artifact::Column::Id), Order::Asc)
        .limit(u64::try_from(limit).unwrap_or(0));
    ArtifactRow::find_by_statement(db.get_database_backend().build(&query)).all(db).await
}

pub async fn add_artifact<C: ConnectionTrait>(db: &C, params: NewArtifact) -> Q<()> {
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

pub async fn add_version<C: ConnectionTrait>(db: &C, params: NewVersion) -> Q<()> {
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

pub async fn artifact_said<C: ConnectionTrait>(db: &C, id: &str, message: &str) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::MessageId, Expr::value(Some(message.to_owned())))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn artifact_versioned<C: ConnectionTrait>(db: &C, id: &str, version: i64, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Version, Expr::value(version))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn artifact_accepted<C: ConnectionTrait>(db: &C, id: &str, seq: i64, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Seq, Expr::value(seq))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn artifact_renamed<C: ConnectionTrait>(db: &C, id: &str, title: &str, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Title, Expr::value(title))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn artifact_shown<C: ConnectionTrait>(db: &C, id: &str, display: &str, at: i64) -> Q<()> {
    Update::many(artifact::Entity)
        .col_expr(artifact::Column::Display, Expr::value(Some(display.to_owned())))
        .col_expr(artifact::Column::UpdatedAt, Expr::value(at))
        .filter(artifact::Column::Id.eq(id))
        .filter(artifact::Column::Body.eq("html"))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn delete_artifact<C: ConnectionTrait>(db: &C, id: &str) -> Q<()> {
    artifact::Entity::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}

pub async fn version_announced<C: ConnectionTrait>(db: &C, artifact_id: &str, version: i64, message: &str) -> Q<()> {
    Update::many(artifact_version::Entity)
        .col_expr(artifact_version::Column::MessageId, Expr::value(Some(message.to_owned())))
        .filter(artifact_version::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_version::Column::Version.eq(version))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn resolve_suggestion<C: ConnectionTrait>(db: &C, id: &str, status: &str, at: i64, by: &str) -> Q<()> {
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

pub async fn versions<C: ConnectionTrait>(db: &C, artifact_id: &str) -> Q<Vec<VersionRow>> {
    let mut query = version_select(artifact_id);
    query.order_by((artifact_version::Entity, artifact_version::Column::Version), Order::Asc);
    VersionRow::find_by_statement(db.get_database_backend().build(&query)).all(db).await
}

pub async fn version<C: ConnectionTrait>(db: &C, artifact_id: &str, version: i64) -> Q<Option<VersionRow>> {
    let mut query = version_select(artifact_id);
    query.and_where(Expr::col((artifact_version::Entity, artifact_version::Column::Version)).eq(version));
    VersionRow::find_by_statement(db.get_database_backend().build(&query)).one(db).await
}

pub async fn blocks<C: ConnectionTrait>(db: &C, artifact_id: &str) -> Q<Vec<Block>> {
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
                r#type: read_word(r.block_type)?,
                attrs: read_json(r.attrs)?,
                text: read_json::<Option<Vec<TextSpan>>>(r.spans)?.unwrap_or_default(),
                rev: r.rev,
                deleted: Some(r.deleted),
                updated_by: r.updated_by,
                updated: r.updated_at,
            }))
        })
        .collect()
}

pub async fn block_owner<C: ConnectionTrait>(db: &C, id: &str) -> Q<Option<String>> {
    artifact_block::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(artifact_block::Column::ArtifactId)
        .into_tuple()
        .one(db)
        .await
}

pub async fn put_block<C: ConnectionTrait>(db: &C, artifact_id: &str, b: &Block) -> Q<()> {
    let model = artifact_block::ActiveModel {
        id: Set(b.id.clone()),
        artifact_id: Set(artifact_id.into()),
        parent_id: Set(b.parent_id.clone()),
        order_key: Set(b.order_key.clone()),
        block_type: Set(word(&b.r#type)?),
        attrs: Set(json(&b.attrs)?),
        spans: Set(json(&b.text)?),
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

pub async fn add_revision<C: ConnectionTrait>(db: &C, block: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> Q<()> {
    artifact_block_revision::ActiveModel {
        id: Set(uuid::Uuid::now_v7().to_string()),
        block_id: Set(block.into()),
        rev: Set(rev),
        spans: Set(json(&spans)?),
        actor: Set(actor.into()),
        kind: Set(kind.into()),
        created_at: Set(at),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub async fn revision<C: ConnectionTrait>(db: &C, block: &str, rev: i64) -> Q<Option<Vec<TextSpan>>> {
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
        .map(|raw| read_json::<Option<Vec<TextSpan>>>(raw).map(Option::unwrap_or_default))
        .transpose()
}

pub async fn prune(db: &DatabaseConnection, before: i64) -> Q<()> {
    write_tx(
        db,
        |e| e,
        |tx| {
            Box::pin(async move {
                artifact_change::Entity::delete_many()
                    .filter(artifact_change::Column::CreatedAt.lt(before))
                    .exec(tx)
                    .await?;
                artifact_block_revision::Entity::delete_many()
                    .filter(artifact_block_revision::Column::CreatedAt.lt(before))
                    .exec(tx)
                    .await?;
                Ok(())
            })
        },
    )
    .await
}

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

fn change(row: artifact_change::Model) -> Q<ChangeRow> {
    Ok(ChangeRow {
        artifact_id: row.artifact_id,
        seq: row.seq,
        batch_id: row.batch_id.unwrap_or_default(),
        block_ids: read_json(row.targets)?,
        results: read_json(row.payload)?,
    })
}

pub async fn change_by_batch<C: ConnectionTrait>(db: &C, batch: &str) -> Q<Option<ChangeRow>> {
    artifact_change::Entity::find()
        .filter(artifact_change::Column::BatchId.eq(batch))
        .filter(artifact_change::Column::Kind.eq("blocks"))
        .one(db)
        .await?
        .map(change)
        .transpose()
}

pub async fn add_change<C: ConnectionTrait>(db: &C, c: &NewChange<'_>) -> Q<()> {
    artifact_change::ActiveModel {
        artifact_id: Set(c.artifact_id.into()),
        seq: Set(c.seq),
        kind: Set("blocks".into()),
        batch_id: Set(Some(c.batch_id.into())),
        actor: Set(c.actor.into()),
        targets: Set(json(&c.block_ids)?),
        payload: Set(json(&c.results)?),
        created_at: Set(c.created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub async fn changes_after<C: ConnectionTrait>(db: &C, artifact_id: &str, seq: i64, n: i64) -> Q<Vec<ChangeRow>> {
    artifact_change::Entity::find()
        .filter(artifact_change::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_change::Column::Kind.eq("blocks"))
        .filter(artifact_change::Column::Seq.gt(seq))
        .order_by_asc(artifact_change::Column::Seq)
        .limit(u64::try_from(n).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(change)
        .collect()
}

pub struct StoredSuggestion {
    pub wire: Suggestion,
    pub origin: Option<String>,
    pub anchor_text: Option<String>,
    pub replacement_text: Option<String>,
}

fn decode_stored_suggestion(row: artifact_suggestion::Model) -> Q<StoredSuggestion> {
    Ok(StoredSuggestion {
        wire: Suggestion {
            id: row.id,
            artifact_id: row.artifact_id,
            block_id: row.block_id,
            author: row.author,
            base_rev: row.at_rev,
            change: read_json(row.change)?,
            status: read_word(row.status)?,
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

pub async fn add_suggestion<C: ConnectionTrait>(db: &C, s: &StoredSuggestion) -> Q<()> {
    artifact_suggestion::ActiveModel {
        id: Set(s.wire.id.clone()),
        artifact_id: Set(s.wire.artifact_id.clone()),
        block_id: Set(s.wire.block_id.clone()),
        author: Set(s.wire.author.clone()),
        origin: Set(s.origin.clone()),
        at_rev: Set(s.wire.base_rev),
        change: Set(json(&s.wire.change)?),
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

pub async fn update_suggestion<C: ConnectionTrait>(db: &C, s: &StoredSuggestion) -> Q<()> {
    Update::many(artifact_suggestion::Entity)
        .col_expr(artifact_suggestion::Column::AtRev, Expr::value(s.wire.base_rev))
        .col_expr(artifact_suggestion::Column::Change, Expr::value(json(&s.wire.change)?))
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

pub async fn stored_suggestion<C: ConnectionTrait>(db: &C, id: &str) -> Q<Option<StoredSuggestion>> {
    artifact_suggestion::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(decode_stored_suggestion)
        .transpose()
}

pub async fn stored_suggestions<C: ConnectionTrait>(db: &C, artifact_id: &str, limit: i64) -> Q<Vec<StoredSuggestion>> {
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

pub async fn suggestion<C: ConnectionTrait>(db: &C, id: &str) -> Q<Option<Suggestion>> {
    Ok(stored_suggestion(db, id).await?.map(|s| s.wire))
}

pub async fn suggestions<C: ConnectionTrait>(db: &C, artifact_id: &str, limit: i64) -> Q<Vec<Suggestion>> {
    Ok(stored_suggestions(db, artifact_id, limit).await?.into_iter().map(|s| s.wire).collect())
}

pub async fn artifact_collab<C: ConnectionTrait>(db: &C, artifact_id: &str) -> Q<Option<Vec<u8>>> {
    Ok(artifact_collab::Entity::find_by_id(artifact_id.to_owned()).one(db).await?.map(|m| m.snapshot))
}

pub async fn upsert_artifact_collab<C: ConnectionTrait>(db: &C, artifact_id: &str, snapshot: &[u8], updated_at: i64) -> Q<()> {
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

pub async fn entries<C: ConnectionTrait>(db: &C, artifact_id: &str) -> Q<Vec<EntryRow>> {
    artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .order_by_asc(artifact_entry::Column::Path)
        .all(db)
        .await
}

pub async fn entries_by_prefix<C: ConnectionTrait>(db: &C, artifact_id: &str, prefix: &str) -> Q<Vec<EntryRow>> {
    let rows = artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .filter(artifact_entry::Column::Path.starts_with(prefix))
        .order_by_asc(artifact_entry::Column::Path)
        .all(db)
        .await?;
    Ok(rows.into_iter().filter(|r| r.path.starts_with(prefix)).collect())
}

pub async fn entry<C: ConnectionTrait>(db: &C, artifact_id: &str, path: &str) -> Q<Option<EntryRow>> {
    artifact_entry::Entity::find_by_id((artifact_id.to_owned(), path.to_owned())).one(db).await
}

pub async fn entry_count<C: ConnectionTrait>(db: &C, artifact_id: &str) -> Q<i64> {
    let count = artifact_entry::Entity::find()
        .filter(artifact_entry::Column::ArtifactId.eq(artifact_id))
        .count(db)
        .await?;
    Ok(count as i64)
}

pub async fn upsert_entry<C: ConnectionTrait>(db: &C, params: UpsertEntry) -> Q<()> {
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

pub async fn delete_entry<C: ConnectionTrait>(db: &C, artifact_id: &str, path: &str) -> Q<()> {
    artifact_entry::Entity::delete_by_id((artifact_id.to_owned(), path.to_owned())).exec(db).await?;
    Ok(())
}

pub struct EntryChangeRow {
    pub seq: i64,
    pub paths: Vec<String>,
    pub deleted: Vec<String>,
}

pub async fn add_entry_change<C: ConnectionTrait>(
    db: &C,
    artifact_id: &str,
    seq: i64,
    actor: &str,
    paths: &[String],
    deleted: &[String],
    created_at: i64,
) -> Q<()> {
    artifact_change::ActiveModel {
        artifact_id: Set(artifact_id.into()),
        seq: Set(seq),
        kind: Set("entries".into()),
        batch_id: Set(None),
        actor: Set(actor.into()),
        targets: Set(json(&paths)?),
        payload: Set(json(&deleted)?),
        created_at: Set(created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub async fn entry_changes_after<C: ConnectionTrait>(db: &C, artifact_id: &str, seq: i64, limit: i64) -> Q<Vec<EntryChangeRow>> {
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
                paths: read_json(r.targets)?,
                deleted: read_json(r.payload)?,
            })
        })
        .collect()
}
