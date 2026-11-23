//! Storage for artifacts and their references to optional channel messages.

use crate::modules::infra::column::{json, optional, read_json, read_word, word};
use sqlx::{Connection, Result as Q, SqliteConnection};
use vibevalley_protocol::{Block, BlockOpResult, Suggestion, TextSpan};

use crate::db::generated::content_artifact as queries;
pub use queries::{
    AddArtifactParams as NewArtifact, AddVersionParams as NewVersion, ArtifactEntriesRow as EntryRow, ArtifactRow, UpsertArtifactEntryParams as UpsertEntry,
    VersionRow,
};

pub async fn artifact(db: &mut SqliteConnection, id: &str) -> Q<Option<ArtifactRow>> {
    optional(queries::artifact(db, queries::ArtifactParams { id: id.into() }).await)
}

pub async fn default_design_system_artifact(db: &mut SqliteConnection) -> Q<Option<ArtifactRow>> {
    optional(queries::default_design_system_artifact(db).await)
}

pub async fn clear_default_design_system(db: &mut SqliteConnection, at: i64) -> Q<()> {
    queries::clear_default_design_system(db, queries::ClearDefaultDesignSystemParams { updated_at: at }).await
}

pub async fn set_artifact_default(db: &mut SqliteConnection, id: &str, is_default: bool, at: i64) -> Q<()> {
    queries::set_artifact_default(
        db,
        queries::SetArtifactDefaultParams {
            id: id.into(),
            is_default: i64::from(is_default),
            updated_at: at,
        },
    )
    .await
}

pub async fn artifacts_in_channel(db: &mut SqliteConnection, channel: &str) -> Q<Vec<ArtifactRow>> {
    queries::artifacts_in_channel(
        db,
        queries::ArtifactsInChannelParams {
            channel_id: Some(channel.into()),
        },
    )
    .await
}

pub async fn artifacts_for_issue(db: &mut SqliteConnection, issue: &str) -> Q<Vec<ArtifactRow>> {
    queries::artifacts_for_issue(db, queries::ArtifactsForIssueParams { issue: Some(issue.into()) }).await
}

pub async fn artifacts(db: &mut SqliteConnection, limit: i64) -> Q<Vec<ArtifactRow>> {
    queries::artifacts(db, queries::ArtifactsParams { limit }).await
}

pub async fn add_artifact(db: &mut SqliteConnection, params: NewArtifact) -> Q<()> {
    queries::add_artifact(db, params).await
}

pub async fn add_version(db: &mut SqliteConnection, params: NewVersion) -> Q<()> {
    queries::add_version(db, params).await
}

pub async fn artifact_said(db: &mut SqliteConnection, id: &str, message: &str) -> Q<()> {
    queries::artifact_said(
        db,
        queries::ArtifactSaidParams {
            id: id.into(),
            message_id: Some(message.into()),
        },
    )
    .await
}

pub async fn artifact_versioned(db: &mut SqliteConnection, id: &str, version: i64, at: i64) -> Q<()> {
    queries::artifact_versioned(
        db,
        queries::ArtifactVersionedParams {
            id: id.into(),
            version,
            updated_at: at,
        },
    )
    .await
}

pub async fn artifact_accepted(db: &mut SqliteConnection, id: &str, seq: i64, at: i64) -> Q<()> {
    queries::artifact_accepted(
        db,
        queries::ArtifactAcceptedParams {
            id: id.into(),
            seq,
            updated_at: at,
        },
    )
    .await
}

pub async fn artifact_renamed(db: &mut SqliteConnection, id: &str, title: &str, at: i64) -> Q<()> {
    queries::artifact_renamed(
        db,
        queries::ArtifactRenamedParams {
            id: id.into(),
            title: title.into(),
            updated_at: at,
        },
    )
    .await
}

pub async fn artifact_shown(db: &mut SqliteConnection, id: &str, display: &str, at: i64) -> Q<()> {
    queries::artifact_shown(
        db,
        queries::ArtifactShownParams {
            id: id.into(),
            display: Some(display.into()),
            updated_at: at,
        },
    )
    .await
}

pub async fn delete_artifact(db: &mut SqliteConnection, id: &str) -> Q<()> {
    queries::delete_artifact(db, queries::DeleteArtifactParams { id: id.into() }).await
}

pub async fn version_announced(db: &mut SqliteConnection, artifact: &str, version: i64, message: &str) -> Q<()> {
    queries::version_announced(
        db,
        queries::VersionAnnouncedParams {
            artifact_id: artifact.into(),
            version,
            message_id: Some(message.into()),
        },
    )
    .await
}

pub async fn resolve_suggestion(db: &mut SqliteConnection, id: &str, status: &str, at: i64, by: &str) -> Q<()> {
    queries::resolve_suggestion(
        db,
        queries::ResolveSuggestionParams {
            id: id.into(),
            status: status.into(),
            resolved_at: Some(at),
            resolved_by: Some(by.into()),
        },
    )
    .await
}

pub async fn versions(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<VersionRow>> {
    queries::versions(db, queries::VersionsParams { artifact_id: artifact.into() }).await
}

pub async fn version(db: &mut SqliteConnection, artifact: &str, version: i64) -> Q<Option<VersionRow>> {
    optional(
        queries::version(
            db,
            queries::VersionParams {
                artifact_id: artifact.into(),
                version,
            },
        )
        .await,
    )
}

pub async fn blocks(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<Block>> {
    let rows = queries::blocks(db, queries::BlocksParams { artifact_id: artifact.into() }).await?;
    rows.into_iter()
        .map(|r| {
            Ok(vibevalley_core::artifact::ops::wire(Block {
                id: r.id,
                artifact_id: r.artifact_id,
                parent_id: r.parent_id,
                order_key: r.order_key,
                r#type: read_word(r.r#type)?,
                attrs: read_json(r.attrs)?,
                text: read_json::<Option<Vec<TextSpan>>>(r.spans)?.unwrap_or_default(),
                rev: r.rev,
                deleted: Some(r.deleted != 0),
                updated_by: r.updated_by,
                updated: r.updated_at,
            }))
        })
        .collect()
}

pub async fn block_owner(db: &mut SqliteConnection, id: &str) -> Q<Option<String>> {
    Ok(optional(queries::block_owner(db, queries::BlockOwnerParams { id: id.into() }).await)?.map(|row| row.artifact_id))
}

pub async fn put_block(db: &mut SqliteConnection, artifact: &str, b: &Block) -> Q<()> {
    queries::put_block(
        db,
        queries::PutBlockParams {
            id: b.id.clone(),
            artifact_id: artifact.into(),
            parent_id: b.parent_id.clone(),
            order_key: b.order_key.clone(),
            r#type: word(&b.r#type)?,
            attrs: json(&b.attrs)?,
            spans: json(&b.text)?,
            rev: b.rev,
            deleted: i64::from(b.deleted == Some(true)),
            updated_by: b.updated_by.clone(),
            updated_at: b.updated,
        },
    )
    .await
}

pub async fn add_revision(db: &mut SqliteConnection, block: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> Q<()> {
    queries::add_revision(
        db,
        queries::AddRevisionParams {
            id: uuid::Uuid::now_v7().to_string(),
            block_id: block.into(),
            rev,
            spans: json(&spans)?,
            actor: actor.into(),
            kind: kind.into(),
            created_at: at,
        },
    )
    .await
}

pub async fn revision(db: &mut SqliteConnection, block: &str, rev: i64) -> Q<Option<Vec<TextSpan>>> {
    let row = optional(queries::revision(db, queries::RevisionParams { block_id: block.into(), rev }).await)?;
    row.map(|r| read_json::<Option<Vec<TextSpan>>>(r.spans).map(Option::unwrap_or_default))
        .transpose()
}

pub async fn prune(db: &mut SqliteConnection, before: i64) -> Q<()> {
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    queries::prune_changes(&mut *tx, queries::PruneChangesParams { created_at: before }).await?;
    queries::prune_revisions(&mut *tx, queries::PruneRevisionsParams { created_at: before }).await?;
    tx.commit().await
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

fn change(row: queries::ChangeByBatchRow) -> Q<ChangeRow> {
    Ok(ChangeRow {
        artifact_id: row.artifact_id,
        seq: row.seq,
        batch_id: row.batch_id.unwrap_or_default(),
        block_ids: read_json(row.block_ids)?,
        results: read_json(row.results)?,
    })
}

pub async fn change_by_batch(db: &mut SqliteConnection, batch: &str) -> Q<Option<ChangeRow>> {
    optional(queries::change_by_batch(db, queries::ChangeByBatchParams { batch_id: Some(batch.into()) }).await)?
        .map(change)
        .transpose()
}

pub async fn add_change(db: &mut SqliteConnection, c: &NewChange<'_>) -> Q<()> {
    queries::add_change(
        db,
        queries::AddChangeParams {
            artifact_id: c.artifact_id.into(),
            seq: c.seq,
            batch_id: Some(c.batch_id.into()),
            actor: c.actor.into(),
            targets: json(&c.block_ids)?,
            payload: json(&c.results)?,
            created_at: c.created_at,
        },
    )
    .await
}

pub async fn changes_after(db: &mut SqliteConnection, artifact: &str, seq: i64, n: i64) -> Q<Vec<ChangeRow>> {
    queries::changes_after(
        db,
        queries::ChangesAfterParams {
            artifact_id: artifact.into(),
            seq,
            limit: n,
        },
    )
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

fn decode_stored_suggestion(row: queries::SuggestionRow) -> Q<StoredSuggestion> {
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

pub async fn add_suggestion(db: &mut SqliteConnection, s: &StoredSuggestion) -> Q<()> {
    queries::add_suggestion(
        db,
        queries::AddSuggestionParams {
            id: s.wire.id.clone(),
            artifact_id: s.wire.artifact_id.clone(),
            block_id: s.wire.block_id.clone(),
            author: s.wire.author.clone(),
            origin: s.origin.clone(),
            at_rev: s.wire.base_rev,
            change: json(&s.wire.change)?,
            cursor_start: s.wire.cursor_start.clone(),
            cursor_end: s.wire.cursor_end.clone(),
            start_offset: s.wire.start_offset.map(i64::from),
            end_offset: s.wire.end_offset.map(i64::from),
            anchor_text: s.anchor_text.clone(),
            replacement_text: s.replacement_text.clone(),
            created_at: s.wire.created_at,
        },
    )
    .await
}

pub async fn update_suggestion(db: &mut SqliteConnection, s: &StoredSuggestion) -> Q<()> {
    queries::update_suggestion(
        db,
        queries::UpdateSuggestionParams {
            id: s.wire.id.clone(),
            at_rev: s.wire.base_rev,
            change: json(&s.wire.change)?,
            cursor_start: s.wire.cursor_start.clone(),
            cursor_end: s.wire.cursor_end.clone(),
            start_offset: s.wire.start_offset.map(i64::from),
            end_offset: s.wire.end_offset.map(i64::from),
            anchor_text: s.anchor_text.clone(),
            replacement_text: s.replacement_text.clone(),
        },
    )
    .await
}

pub async fn stored_suggestion(db: &mut SqliteConnection, id: &str) -> Q<Option<StoredSuggestion>> {
    optional(queries::suggestion(db, queries::SuggestionParams { id: id.into() }).await)?
        .map(decode_stored_suggestion)
        .transpose()
}

pub async fn stored_suggestions(db: &mut SqliteConnection, artifact: &str, limit: i64) -> Q<Vec<StoredSuggestion>> {
    queries::suggestions(
        db,
        queries::SuggestionsParams {
            artifact_id: artifact.into(),
            limit,
        },
    )
    .await?
    .into_iter()
    .map(decode_stored_suggestion)
    .collect()
}

pub async fn suggestion(db: &mut SqliteConnection, id: &str) -> Q<Option<Suggestion>> {
    Ok(stored_suggestion(db, id).await?.map(|s| s.wire))
}

pub async fn suggestions(db: &mut SqliteConnection, artifact: &str, limit: i64) -> Q<Vec<Suggestion>> {
    Ok(stored_suggestions(db, artifact, limit).await?.into_iter().map(|s| s.wire).collect())
}

pub async fn artifact_collab(db: &mut SqliteConnection, artifact: &str) -> Q<Option<Vec<u8>>> {
    Ok(optional(queries::artifact_collab(db, queries::ArtifactCollabParams { artifact_id: artifact.into() }).await)?.map(|row| row.snapshot))
}

pub async fn upsert_artifact_collab(db: &mut SqliteConnection, artifact: &str, snapshot: &[u8], updated_at: i64) -> Q<()> {
    queries::upsert_artifact_collab(
        db,
        queries::UpsertArtifactCollabParams {
            artifact_id: artifact.into(),
            snapshot: snapshot.to_vec(),
            updated_at,
        },
    )
    .await
}

pub async fn entries(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<EntryRow>> {
    queries::artifact_entries(db, queries::ArtifactEntriesParams { artifact_id: artifact.into() }).await
}

pub async fn entries_by_prefix(db: &mut SqliteConnection, artifact: &str, prefix: &str) -> Q<Vec<EntryRow>> {
    let rows = queries::artifact_entries_by_prefix(
        db,
        queries::ArtifactEntriesByPrefixParams {
            artifact_id: artifact.into(),
            path: format!("{prefix}%"),
        },
    )
    .await?;
    Ok(rows.into_iter().filter(|r| r.path.starts_with(prefix)).collect())
}

pub async fn entry(db: &mut SqliteConnection, artifact: &str, path: &str) -> Q<Option<EntryRow>> {
    optional(
        queries::artifact_entry(
            db,
            queries::ArtifactEntryParams {
                artifact_id: artifact.into(),
                path: path.into(),
            },
        )
        .await,
    )
}

pub async fn entry_count(db: &mut SqliteConnection, artifact: &str) -> Q<i64> {
    Ok(
        queries::artifact_entry_count(db, queries::ArtifactEntryCountParams { artifact_id: artifact.into() })
            .await?
            .n,
    )
}

pub async fn upsert_entry(db: &mut SqliteConnection, params: UpsertEntry) -> Q<()> {
    queries::upsert_artifact_entry(db, params).await
}

pub async fn delete_entry(db: &mut SqliteConnection, artifact: &str, path: &str) -> Q<()> {
    queries::delete_artifact_entry(
        db,
        queries::DeleteArtifactEntryParams {
            artifact_id: artifact.into(),
            path: path.into(),
        },
    )
    .await
}

pub struct EntryChangeRow {
    pub seq: i64,
    pub paths: Vec<String>,
    pub deleted: Vec<String>,
}

pub async fn add_entry_change(
    db: &mut SqliteConnection,
    artifact: &str,
    seq: i64,
    actor: &str,
    paths: &[String],
    deleted: &[String],
    created_at: i64,
) -> Q<()> {
    queries::add_artifact_entry_change(
        db,
        queries::AddArtifactEntryChangeParams {
            artifact_id: artifact.into(),
            seq,
            actor: actor.into(),
            targets: json(&paths)?,
            payload: json(&deleted)?,
            created_at,
        },
    )
    .await
}

pub async fn entry_changes_after(db: &mut SqliteConnection, artifact: &str, seq: i64, limit: i64) -> Q<Vec<EntryChangeRow>> {
    queries::artifact_entry_changes_after(
        db,
        queries::ArtifactEntryChangesAfterParams {
            artifact_id: artifact.into(),
            seq,
            limit,
        },
    )
    .await?
    .into_iter()
    .map(|r| {
        Ok(EntryChangeRow {
            seq: r.seq,
            paths: read_json(r.paths)?,
            deleted: read_json(r.deleted)?,
        })
    })
    .collect()
}
