//! Dual-backend persistence for notes (`note`, `note_version`, `note_change`,
//! `note_suggestion`, `note_collab`, `note_link`), media library items
//! (`media_library_item`), and media jobs (`media_job`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Condition, Expr, Func, LikeExpr, OnConflict, Order, Query, SelectStatement, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Update,
};
use vibevalley_protocol::{
    Attachment, LibraryFileKind, LibraryItem, LibraryListRequest, LibraryOrigin, LibrarySort, LinkEntityKind, LinkRelation, NoteLink, NoteLinkListResult,
    NoteLinkRef, NoteType, Suggestion,
};

use super::{batch_chunk_rows, with_write_tx};
use crate::db::column::{db_json, read_db_json, read_db_word};
use crate::db::entity::{attachment, issue, media_job, media_library_item, note, note_change, note_collab, note_link, note_suggestion, note_version};
use crate::db::{Database, DbResult, Tx};

const NOTE_LINK_BATCH_ROWS: usize = batch_chunk_rows(8);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NoteRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) note_type: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) sort_order: i64,
    pub(crate) channel_id: Option<String>,
    pub(crate) message_id: Option<String>,
    pub(crate) issue: Option<String>,
    pub(crate) by_id: String,
    pub(crate) by_name: String,
    pub(crate) version: i64,
    pub(crate) seq: i64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl From<note::Model> for NoteRow {
    fn from(r: note::Model) -> Self {
        Self {
            id: r.id,
            title: r.title,
            note_type: r.note_type,
            parent_id: r.parent_id,
            sort_order: r.sort_order,
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
pub(crate) struct NewNote {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) note_type: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) sort_order: i64,
    pub(crate) channel_id: Option<String>,
    pub(crate) issue: Option<String>,
    pub(crate) by_id: String,
    pub(crate) by_name: String,
    pub(crate) version: i64,
    pub(crate) created_at: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct NewVersion {
    pub(crate) note_id: String,
    pub(crate) version: i64,
    pub(crate) storage_id: String,
    pub(crate) size: i64,
    pub(crate) note: Option<String>,
    pub(crate) by_id: String,
    pub(crate) by_name: String,
    pub(crate) created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VersionRow {
    pub(crate) version: i64,
    pub(crate) storage_id: String,
    pub(crate) size: i64,
    pub(crate) note: Option<String>,
    pub(crate) by_id: String,
    pub(crate) by_name: String,
    pub(crate) message_id: Option<String>,
    pub(crate) created_at: i64,
}

impl From<note_version::Model> for VersionRow {
    fn from(r: note_version::Model) -> Self {
        Self {
            version: r.version,
            storage_id: r.storage_id,
            size: r.size,
            note: r.note,
            by_id: r.by_id,
            by_name: r.by_name,
            message_id: r.message_id,
            created_at: r.created_at,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FileChangeRow {
    pub(crate) seq: i64,
    pub(crate) frontiers: Option<String>,
    pub(crate) actor: String,
    pub(crate) paths: Vec<String>,
    pub(crate) deleted: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredSuggestion {
    pub(crate) wire: Suggestion,
    pub(crate) origin: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CollabSnapshotRow {
    pub(crate) note_id: String,
    pub(crate) snapshot: Vec<u8>,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MediaJobRow {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) phase: String,
    pub(crate) data: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
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

fn decode_stored_suggestion(row: note_suggestion::Model) -> DbResult<StoredSuggestion> {
    Ok(StoredSuggestion {
        wire: Suggestion {
            id: row.id,
            note_id: row.note_id,
            path: row.path,
            author: row.author,
            base_rev: row.at_rev,
            base_hash: row.base_hash,
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
    })
}

async fn get_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<NoteRow>> {
    Ok(note::Entity::find_by_id(id.to_owned()).one(db).await?.map(NoteRow::from))
}

async fn update_note_field_impl<C: ConnectionTrait, V: Into<sea_orm::Value>>(db: &C, id: &str, col: note::Column, val: V, at: i64) -> DbResult<()> {
    Update::many(note::Entity)
        .col_expr(col, Expr::value(val))
        .col_expr(note::Column::UpdatedAt, Expr::value(at))
        .filter(note::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

fn exclude_issue_body_notes() -> SimpleExpr {
    let sub = Query::select()
        .column(issue::Column::BodyNoteId)
        .from(issue::Entity)
        .and_where(issue::Column::BodyNoteId.is_not_null())
        .to_owned();
    note::Column::Id.not_in_subquery(sub)
}

async fn list_notes_impl<C: ConnectionTrait>(db: &C, filter: Option<(note::Column, &str)>, limit: Option<u64>) -> DbResult<Vec<NoteRow>> {
    let mut query = note::Entity::find().filter(exclude_issue_body_notes());
    if let Some((col, val)) = filter {
        query = query.filter(col.eq(val));
    }
    query = query
        .order_by_asc(note::Column::SortOrder)
        .order_by_desc(note::Column::UpdatedAt)
        .order_by_asc(note::Column::Id);
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    Ok(query.all(db).await?.into_iter().map(NoteRow::from).collect())
}

async fn add_impl<C: ConnectionTrait>(db: &C, params: NewNote) -> DbResult<()> {
    note::ActiveModel {
        id: Set(params.id),
        title: Set(params.title),
        note_type: Set(params.note_type),
        parent_id: Set(params.parent_id),
        sort_order: Set(params.sort_order),
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
    note_version::ActiveModel {
        note_id: Set(params.note_id),
        version: Set(params.version),
        storage_id: Set(params.storage_id),
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
    super::update_col_by_id::<note::Entity, _, _>(db, note::Column::Id, id, note::Column::MessageId, Some(message.to_owned())).await
}

async fn set_version_message_id_impl<C: ConnectionTrait>(db: &C, note_id: &str, version: i64, message: &str) -> DbResult<()> {
    Update::many(note_version::Entity)
        .col_expr(note_version::Column::MessageId, Expr::value(Some(message.to_owned())))
        .filter(note_version::Column::NoteId.eq(note_id))
        .filter(note_version::Column::Version.eq(version))
        .exec(db)
        .await?;
    Ok(())
}

async fn versions_impl<C: ConnectionTrait>(db: &C, note_id: &str) -> DbResult<Vec<VersionRow>> {
    let rows = note_version::Entity::find()
        .filter(note_version::Column::NoteId.eq(note_id))
        .order_by_asc(note_version::Column::Version)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(VersionRow::from).collect())
}

async fn version_impl<C: ConnectionTrait>(db: &C, note_id: &str, version: i64) -> DbResult<Option<VersionRow>> {
    Ok(note_version::Entity::find_by_id((note_id.to_owned(), version))
        .one(db)
        .await?
        .map(VersionRow::from))
}

async fn add_suggestion_impl<C: ConnectionTrait>(db: &C, s: &StoredSuggestion) -> DbResult<()> {
    note_suggestion::ActiveModel {
        id: Set(s.wire.id.clone()),
        note_id: Set(s.wire.note_id.clone()),
        path: Set(s.wire.path.clone()),
        author: Set(s.wire.author.clone()),
        origin: Set(s.origin.clone()),
        at_rev: Set(s.wire.base_rev),
        base_hash: Set(s.wire.base_hash.clone()),
        change: Set(db_json(&s.wire.change)?),
        cursor_start: Set(s.wire.cursor_start.clone()),
        cursor_end: Set(s.wire.cursor_end.clone()),
        start_offset: Set(s.wire.start_offset.map(i64::from)),
        end_offset: Set(s.wire.end_offset.map(i64::from)),
        status: Set("open".into()),
        created_at: Set(s.wire.created_at),
        resolved_at: Set(None),
        resolved_by: Set(None),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn resolve_suggestion_impl<C: ConnectionTrait>(db: &C, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
    Update::many(note_suggestion::Entity)
        .col_expr(note_suggestion::Column::Status, Expr::value(status))
        .col_expr(note_suggestion::Column::ResolvedAt, Expr::value(Some(at)))
        .col_expr(note_suggestion::Column::ResolvedBy, Expr::value(Some(by.to_owned())))
        .filter(note_suggestion::Column::Id.eq(id))
        .filter(note_suggestion::Column::Status.eq("open"))
        .exec(db)
        .await?;
    Ok(())
}

async fn stored_suggestion_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<StoredSuggestion>> {
    note_suggestion::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(decode_stored_suggestion)
        .transpose()
}

async fn stored_suggestions_impl<C: ConnectionTrait>(db: &C, note_id: &str, limit: i64) -> DbResult<Vec<StoredSuggestion>> {
    note_suggestion::Entity::find()
        .filter(note_suggestion::Column::NoteId.eq(note_id))
        .order_by_asc(note_suggestion::Column::CreatedAt)
        .order_by_asc(note_suggestion::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(decode_stored_suggestion)
        .collect()
}

async fn collab_snapshot_impl<C: ConnectionTrait>(db: &C, note_id: &str) -> DbResult<Option<Vec<u8>>> {
    Ok(note_collab::Entity::find_by_id(note_id.to_owned()).one(db).await?.map(|m| m.snapshot))
}

async fn list_collab_snapshots_impl<C: ConnectionTrait>(db: &C, limit: i64) -> DbResult<Vec<CollabSnapshotRow>> {
    Ok(note_collab::Entity::find()
        .order_by_desc(note_collab::Column::UpdatedAt)
        .order_by_asc(note_collab::Column::NoteId)
        .limit(u64::try_from(limit.clamp(1, i64::MAX)).unwrap_or(64))
        .all(db)
        .await?
        .into_iter()
        .map(|m| CollabSnapshotRow {
            note_id: m.note_id,
            snapshot: m.snapshot,
            updated_at: m.updated_at,
        })
        .collect())
}

async fn upsert_collab_snapshot_impl<C: ConnectionTrait>(db: &C, note_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
    let model = note_collab::ActiveModel {
        note_id: Set(note_id.into()),
        snapshot: Set(snapshot.to_vec()),
        updated_at: Set(updated_at),
    };
    note_collab::Entity::insert(model)
        .on_conflict(
            OnConflict::column(note_collab::Column::NoteId)
                .update_columns([note_collab::Column::Snapshot, note_collab::Column::UpdatedAt])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments, reason = "records an atomic note_change row with optional frontiers and path lists")]
async fn add_file_change_impl<C: ConnectionTrait>(
    db: &C,
    note_id: &str,
    seq: i64,
    actor: &str,
    frontiers: Option<&str>,
    paths: &[String],
    deleted: &[String],
    created_at: i64,
) -> DbResult<()> {
    note_change::ActiveModel {
        note_id: Set(note_id.into()),
        seq: Set(seq),
        kind: Set("files".into()),
        batch_id: Set(frontiers.map(str::to_owned)),
        actor: Set(actor.into()),
        targets: Set(db_json(&paths)?),
        payload: Set(db_json(&deleted)?),
        created_at: Set(created_at),
    }
    .insert(db)
    .await?;
    Ok(())
}

async fn file_changes_after_impl<C: ConnectionTrait>(db: &C, note_id: &str, seq: i64, limit: i64) -> DbResult<Vec<FileChangeRow>> {
    note_change::Entity::find()
        .filter(note_change::Column::NoteId.eq(note_id))
        .filter(note_change::Column::Kind.eq("files"))
        .filter(note_change::Column::Seq.gt(seq))
        .order_by_asc(note_change::Column::Seq)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(db)
        .await?
        .into_iter()
        .map(|r| {
            Ok(FileChangeRow {
                seq: r.seq,
                frontiers: r.batch_id,
                actor: r.actor,
                paths: read_db_json(r.targets)?,
                deleted: read_db_json(r.payload)?,
            })
        })
        .collect()
}

fn parse_link_kind(raw: &str) -> LinkEntityKind {
    match raw {
        "issue" => LinkEntityKind::Issue,
        _ => LinkEntityKind::Note,
    }
}

fn parse_link_relation(raw: &str) -> LinkRelation {
    match raw {
        "embed" => LinkRelation::Embed,
        _ => LinkRelation::Link,
    }
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
pub(crate) struct NoteService {
    db: Arc<Database>,
}

impl NoteService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn get(&self, id: &str) -> DbResult<Option<NoteRow>> {
        get_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn list_in_channel(&self, channel_id: &str) -> DbResult<Vec<NoteRow>> {
        list_notes_impl(self.db.read_conn(), Some((note::Column::ChannelId, channel_id)), None).await
    }

    pub(crate) async fn list_for_issue(&self, issue_id: &str) -> DbResult<Vec<NoteRow>> {
        list_notes_impl(self.db.read_conn(), Some((note::Column::Issue, issue_id)), None).await
    }

    pub(crate) async fn list_children(&self, parent_id: Option<&str>) -> DbResult<Vec<NoteRow>> {
        let mut query = note::Entity::find();
        query = match parent_id {
            Some(pid) => query.filter(note::Column::ParentId.eq(pid)),
            None => query.filter(note::Column::ParentId.is_null()).filter(exclude_issue_body_notes()),
        };
        let rows = query
            .order_by_asc(note::Column::SortOrder)
            .order_by_desc(note::Column::UpdatedAt)
            .order_by_asc(note::Column::Id)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(NoteRow::from).collect())
    }

    pub(crate) async fn list(&self, limit: i64) -> DbResult<Vec<NoteRow>> {
        list_notes_impl(self.db.read_conn(), None, Some(u64::try_from(limit).unwrap_or(0))).await
    }

    pub(crate) async fn add_in_tx(&self, tx: &Tx, params: NewNote) -> DbResult<()> {
        add_impl(tx, params).await
    }

    pub(crate) async fn add_version_in_tx(&self, tx: &Tx, params: NewVersion) -> DbResult<()> {
        add_version_impl(tx, params).await
    }

    pub(crate) async fn set_message_id(&self, id: &str, message_id: &str) -> DbResult<()> {
        set_message_id_impl(self.db.write_conn(), id, message_id).await
    }

    pub(crate) async fn set_version_in_tx(&self, tx: &Tx, id: &str, version: i64, at: i64) -> DbResult<()> {
        update_note_field_impl(tx, id, note::Column::Version, version, at).await
    }

    pub(crate) async fn set_seq_in_tx(&self, tx: &Tx, id: &str, seq: i64, at: i64) -> DbResult<()> {
        update_note_field_impl(tx, id, note::Column::Seq, seq, at).await
    }

    pub(crate) async fn rename_in_tx(&self, tx: &Tx, id: &str, title: &str, at: i64) -> DbResult<()> {
        update_note_field_impl(tx, id, note::Column::Title, title, at).await
    }

    pub(crate) async fn set_issue_in_tx(&self, tx: &Tx, id: &str, issue: Option<&str>, at: i64) -> DbResult<()> {
        update_note_field_impl(tx, id, note::Column::Issue, issue.map(str::to_owned), at).await
    }

    pub(crate) async fn set_parent_order_in_tx(&self, tx: &Tx, id: &str, parent_id: Option<&str>, sort_order: i64, at: i64) -> DbResult<Result<(), String>> {
        if let Some(pid) = parent_id {
            if pid == id {
                return Ok(Err("note cannot be its own parent".to_owned()));
            }
            let Some(parent_row) = get_impl(tx, pid).await? else {
                return Ok(Err(format!("parent note {pid} not found")));
            };
            let mut cursor = parent_row.parent_id;
            let mut visited: HashSet<String> = HashSet::from([pid.to_owned()]);
            while let Some(anc) = cursor {
                if anc == id {
                    return Ok(Err("cannot move note under one of its descendants".to_owned()));
                }
                if !visited.insert(anc.clone()) {
                    break;
                }
                cursor = get_impl(tx, &anc).await?.and_then(|r| r.parent_id);
            }
        }
        Update::many(note::Entity)
            .col_expr(note::Column::ParentId, Expr::value(parent_id.map(str::to_owned)))
            .col_expr(note::Column::SortOrder, Expr::value(sort_order))
            .col_expr(note::Column::UpdatedAt, Expr::value(at))
            .filter(note::Column::Id.eq(id))
            .exec(tx)
            .await?;
        Ok(Ok(()))
    }

    pub(crate) async fn delete(&self, id: &str) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            // Re-parent direct children to root before deleting so the hierarchy never leaves dangling parents.
            Update::many(note::Entity)
                .col_expr(note::Column::ParentId, Expr::val(Option::<String>::None))
                .filter(note::Column::ParentId.eq(id))
                .exec(tx)
                .await?;
            note_link::Entity::delete_many()
                .filter(
                    Condition::any()
                        .add(
                            Condition::all()
                                .add(note_link::Column::SourceKind.eq("note"))
                                .add(note_link::Column::SourceId.eq(id)),
                        )
                        .add(
                            Condition::all()
                                .add(note_link::Column::TargetKind.eq("note"))
                                .add(note_link::Column::TargetId.eq(id)),
                        ),
                )
                .exec(tx)
                .await?;
            super::delete_by_id::<note::Entity, _>(tx, id).await?;
            Ok(())
        })
        .await
    }

    /// Replaces all outgoing `note_link` edges for `(source_kind, source_id)` with `links`.
    pub(crate) async fn replace_links_for_source(&self, source_kind: LinkEntityKind, source_id: &str, links: &[NoteLinkRef], created_at: i64) -> DbResult<()> {
        let sk = source_kind.as_str().to_owned();
        let sid = source_id.to_owned();
        with_write_tx(&self.db, async |tx| {
            note_link::Entity::delete_many()
                .filter(note_link::Column::SourceKind.eq(&sk))
                .filter(note_link::Column::SourceId.eq(&sid))
                .exec(tx)
                .await?;
            let filtered: Vec<&NoteLinkRef> = links
                .iter()
                // Skip trivial self-links.
                .filter(|link| !(link.kind == source_kind && link.id == sid))
                .collect();
            for chunk in filtered.chunks(NOTE_LINK_BATCH_ROWS) {
                let models = chunk.iter().map(|link| note_link::ActiveModel {
                    id: Set(format!("lnk_{}", uuid::Uuid::now_v7().simple())),
                    source_kind: Set(sk.clone()),
                    source_id: Set(sid.clone()),
                    target_kind: Set(link.kind.as_str().to_owned()),
                    target_id: Set(link.id.clone()),
                    relation: Set(link.relation.as_str().to_owned()),
                    title: Set(link.title.clone()),
                    created_at: Set(created_at),
                });
                note_link::Entity::insert_many(models).exec_without_returning(tx).await?;
            }
            Ok(())
        })
        .await
    }

    pub(crate) async fn list_links_for_entity(&self, entity_kind: LinkEntityKind, entity_id: &str) -> DbResult<NoteLinkListResult> {
        let kind_str = entity_kind.as_str();
        let outgoing_rows = note_link::Entity::find()
            .filter(note_link::Column::SourceKind.eq(kind_str))
            .filter(note_link::Column::SourceId.eq(entity_id))
            .order_by_asc(note_link::Column::CreatedAt)
            .all(self.db.read_conn())
            .await?;
        let backlink_rows = note_link::Entity::find()
            .filter(note_link::Column::TargetKind.eq(kind_str))
            .filter(note_link::Column::TargetId.eq(entity_id))
            .order_by_asc(note_link::Column::CreatedAt)
            .all(self.db.read_conn())
            .await?;

        let mut needed_note_ids: HashSet<String> = HashSet::new();
        let mut needed_issue_ids: HashSet<String> = HashSet::new();
        let mut needed_issue_nums: HashSet<i64> = HashSet::new();
        for row in &outgoing_rows {
            match parse_link_kind(&row.target_kind) {
                LinkEntityKind::Note => {
                    needed_note_ids.insert(row.target_id.clone());
                }
                LinkEntityKind::Issue => {
                    needed_issue_ids.insert(row.target_id.clone());
                    if let Ok(num) = row.target_id.parse::<i64>() {
                        needed_issue_nums.insert(num);
                    }
                }
            }
        }
        for row in &backlink_rows {
            match parse_link_kind(&row.source_kind) {
                LinkEntityKind::Note => {
                    needed_note_ids.insert(row.source_id.clone());
                }
                LinkEntityKind::Issue => {
                    needed_issue_ids.insert(row.source_id.clone());
                    if let Ok(num) = row.source_id.parse::<i64>() {
                        needed_issue_nums.insert(num);
                    }
                }
            }
        }

        let mut resolved_notes: HashMap<String, (String, Option<NoteType>)> = HashMap::with_capacity(needed_note_ids.len());
        let note_id_list: Vec<String> = needed_note_ids.into_iter().collect();
        for chunk in note_id_list.chunks(super::MAX_SQL_BIND_PARAMS) {
            let rows: Vec<(String, String, String)> = note::Entity::find()
                .select_only()
                .columns([note::Column::Id, note::Column::Title, note::Column::NoteType])
                .filter(note::Column::Id.is_in(chunk.iter().cloned()))
                .into_tuple()
                .all(self.db.read_conn())
                .await?;
            for (id, title, note_type) in rows {
                resolved_notes.insert(id, (title, NoteType::parse(&note_type)));
            }
        }

        let mut resolved_issues: HashMap<String, (String, i64)> = HashMap::with_capacity(needed_issue_ids.len());
        let mut issue_by_num: HashMap<String, String> = HashMap::with_capacity(needed_issue_nums.len());
        let issue_id_list: Vec<String> = needed_issue_ids.into_iter().collect();
        for chunk in issue_id_list.chunks(super::MAX_SQL_BIND_PARAMS) {
            let rows: Vec<(String, String, i64)> = issue::Entity::find()
                .select_only()
                .columns([issue::Column::Id, issue::Column::Title, issue::Column::Number])
                .filter(issue::Column::Id.is_in(chunk.iter().cloned()))
                .into_tuple()
                .all(self.db.read_conn())
                .await?;
            for (id, title, number) in rows {
                issue_by_num.insert(number.to_string(), format!("#{number} {title}"));
                resolved_issues.insert(id, (title, number));
            }
        }
        let missing_nums: Vec<i64> = needed_issue_nums.into_iter().filter(|n| !issue_by_num.contains_key(&n.to_string())).collect();
        for chunk in missing_nums.chunks(super::MAX_SQL_BIND_PARAMS) {
            let rows: Vec<(String, String, i64)> = issue::Entity::find()
                .select_only()
                .columns([issue::Column::Id, issue::Column::Title, issue::Column::Number])
                .filter(issue::Column::Number.is_in(chunk.iter().copied()))
                .into_tuple()
                .all(self.db.read_conn())
                .await?;
            for (id, title, number) in rows {
                issue_by_num.insert(number.to_string(), format!("#{number} {title}"));
                resolved_issues.insert(id, (title, number));
            }
        }

        let resolve_meta = |kind: LinkEntityKind, id: &str, stored_title: Option<String>| -> (Option<String>, Option<NoteType>) {
            match kind {
                LinkEntityKind::Note => match resolved_notes.get(id) {
                    Some((t, nt)) => (Some(t.clone()), *nt),
                    None => (stored_title, None),
                },
                LinkEntityKind::Issue => {
                    let resolved = resolved_issues
                        .get(id)
                        .map(|(t, n)| format!("#{n} {t}"))
                        .or_else(|| issue_by_num.get(id).cloned())
                        .or(stored_title);
                    (resolved, None)
                }
            }
        };

        let to_wire = |r: note_link::Model, for_target: bool| -> NoteLink {
            let sk = parse_link_kind(&r.source_kind);
            let tk = parse_link_kind(&r.target_kind);
            let (title, note_type) = if for_target {
                resolve_meta(tk, &r.target_id, r.title)
            } else {
                resolve_meta(sk, &r.source_id, r.title)
            };
            NoteLink {
                id: r.id,
                source_kind: sk,
                source_id: r.source_id,
                target_kind: tk,
                target_id: r.target_id,
                relation: parse_link_relation(&r.relation),
                title,
                note_type,
                created_at: r.created_at,
            }
        };

        Ok(NoteLinkListResult {
            outgoing: outgoing_rows.into_iter().map(|r| to_wire(r, true)).collect(),
            backlinks: backlink_rows.into_iter().map(|r| to_wire(r, false)).collect(),
        })
    }

    pub(crate) async fn set_version_message_id(&self, note_id: &str, version: i64, message_id: &str) -> DbResult<()> {
        set_version_message_id_impl(self.db.write_conn(), note_id, version, message_id).await
    }

    pub(crate) async fn versions(&self, note_id: &str) -> DbResult<Vec<VersionRow>> {
        versions_impl(self.db.read_conn(), note_id).await
    }

    pub(crate) async fn version(&self, note_id: &str, version: i64) -> DbResult<Option<VersionRow>> {
        version_impl(self.db.read_conn(), note_id, version).await
    }

    pub(crate) async fn add_suggestion(&self, suggestion: &StoredSuggestion) -> DbResult<()> {
        add_suggestion_impl(self.db.write_conn(), suggestion).await
    }

    pub(crate) async fn resolve_suggestion(&self, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
        resolve_suggestion_impl(self.db.write_conn(), id, status, at, by).await
    }

    pub(crate) async fn resolve_suggestion_in_tx(&self, tx: &Tx, id: &str, status: &str, at: i64, by: &str) -> DbResult<()> {
        resolve_suggestion_impl(tx, id, status, at, by).await
    }

    pub(crate) async fn stored_suggestion(&self, id: &str) -> DbResult<Option<StoredSuggestion>> {
        stored_suggestion_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn stored_suggestions(&self, note_id: &str, limit: i64) -> DbResult<Vec<StoredSuggestion>> {
        stored_suggestions_impl(self.db.read_conn(), note_id, limit).await
    }

    pub(crate) async fn collab_snapshot(&self, note_id: &str) -> DbResult<Option<Vec<u8>>> {
        collab_snapshot_impl(self.db.read_conn(), note_id).await
    }

    pub(crate) async fn list_collab_snapshots(&self, limit: i64) -> DbResult<Vec<CollabSnapshotRow>> {
        list_collab_snapshots_impl(self.db.read_conn(), limit).await
    }

    pub(crate) async fn upsert_collab_snapshot(&self, note_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
        upsert_collab_snapshot_impl(self.db.write_conn(), note_id, snapshot, updated_at).await
    }

    pub(crate) async fn upsert_collab_snapshot_in_tx(&self, tx: &Tx, note_id: &str, snapshot: &[u8], updated_at: i64) -> DbResult<()> {
        upsert_collab_snapshot_impl(tx, note_id, snapshot, updated_at).await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn add_file_change_in_tx(
        &self,
        tx: &Tx,
        note_id: &str,
        seq: i64,
        actor: &str,
        frontiers: Option<&str>,
        paths: &[String],
        deleted: &[String],
        created_at: i64,
    ) -> DbResult<()> {
        add_file_change_impl(tx, note_id, seq, actor, frontiers, paths, deleted, created_at).await
    }

    pub(crate) async fn file_changes_after(&self, note_id: &str, seq: i64, limit: i64) -> DbResult<Vec<FileChangeRow>> {
        file_changes_after_impl(self.db.read_conn(), note_id, seq, limit).await
    }

    // --- Media library ---

    pub(crate) async fn find_library_item(&self, attachment_id: &str) -> DbResult<Option<LibraryItem>> {
        let mut query = library_item_select();
        query.and_where(Expr::col((media_library_item::Entity, media_library_item::Column::AttachmentId)).eq(attachment_id));
        let conn = self.db.read_conn();
        let row = LibraryQueryRow::find_by_statement(conn.get_database_backend().build(&query)).one(conn).await?;
        Ok(row.map(library_item_from_row))
    }

    /// Inserts or updates a library item; a later arrival on an active item only advances `last_at`.
    pub(crate) async fn keep_library_item(&self, attachment_id: &str, origin: &LibraryOrigin, at: i64) -> DbResult<()> {
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
    pub(crate) async fn record_generated_library_item(&self, attachment_id: &str, source_job_id: &str, origin: &LibraryOrigin, at: i64) -> DbResult<()> {
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

    pub(crate) async fn list_library_items(&self, req: &LibraryListRequest, limit: u64) -> DbResult<Vec<LibraryItem>> {
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
        let conn = self.db.read_conn();
        let backend = conn.get_database_backend();
        let text = req.text.as_deref().unwrap_or("").trim().to_lowercase();
        if !text.is_empty() {
            if backend == sea_orm::DatabaseBackend::Sqlite
                && let Some(phrase) = super::fts5_trigram_phrase(&text)
            {
                let fts = Alias::new("attachment_fts");
                query
                    .join(
                        sea_orm::sea_query::JoinType::InnerJoin,
                        fts.clone(),
                        Expr::col((fts, Alias::new("rowid"))).equals((attachment::Entity, Alias::new("rowid"))),
                    )
                    .and_where(Expr::cust_with_values("attachment_fts MATCH ?", [sea_orm::Value::from(phrase)]));
            } else {
                let pattern = format!("%{}%", super::escape_like(&text));
                query.and_where(Expr::expr(Func::lower(Expr::col((attachment::Entity, attachment::Column::Name)))).like(LikeExpr::new(pattern).escape('\\')));
            }
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

        let rows = self
            .db
            .query_metrics()
            .observe(
                "note.list_library_items",
                "SELECT media_library_item JOIN attachment",
                LibraryQueryRow::find_by_statement(backend.build(&query)).all(conn),
            )
            .await?;
        Ok(rows.into_iter().map(library_item_from_row).collect())
    }

    /// Soft-removes generated items (`source_job_id IS NOT NULL`) so they are not re-recorded,
    /// and hard-deletes uploaded/fetched items.
    pub(crate) async fn remove_library_item(&self, attachment_id: &str, at: i64) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            Update::many(media_library_item::Entity)
                .col_expr(media_library_item::Column::RemovedAt, Expr::value(Some(at)))
                .filter(media_library_item::Column::AttachmentId.eq(attachment_id))
                .filter(media_library_item::Column::SourceJobId.is_not_null())
                .exec(tx)
                .await?;
            media_library_item::Entity::delete_many()
                .filter(media_library_item::Column::AttachmentId.eq(attachment_id))
                .filter(media_library_item::Column::SourceJobId.is_null())
                .exec(tx)
                .await?;
            Ok(())
        })
        .await
    }

    // --- Media jobs ---

    pub(crate) async fn find_media_job(&self, id: &str) -> DbResult<Option<MediaJobRow>> {
        find_media_job_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn find_media_job_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<MediaJobRow>> {
        find_media_job_impl(tx, id).await
    }

    pub(crate) async fn list_recent_media_jobs(&self, limit: u64) -> DbResult<Vec<MediaJobRow>> {
        let rows = media_job::Entity::find()
            .order_by_desc(media_job::Column::CreatedAt)
            .order_by_asc(media_job::Column::Id)
            .limit(limit)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(MediaJobRow::from).collect())
    }

    pub(crate) async fn list_media_jobs_by_phases(&self, phases: &[&str], ascending: bool) -> DbResult<Vec<MediaJobRow>> {
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

    pub(crate) async fn count_media_jobs_in_phases_in_tx(&self, tx: &Tx, phases: &[&str]) -> DbResult<u64> {
        count_media_jobs_in_phases_impl(tx, phases).await
    }

    #[cfg(test)]
    pub(crate) async fn save_media_job(&self, row: &MediaJobRow) -> DbResult<()> {
        save_media_job_impl(self.db.write_conn(), row).await
    }

    pub(crate) async fn save_media_job_in_tx(&self, tx: &Tx, row: &MediaJobRow) -> DbResult<()> {
        save_media_job_impl(tx, row).await
    }
}
