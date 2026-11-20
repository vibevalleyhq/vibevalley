//! Storage for artifacts and their references to optional channel messages.

use crate::modules::column::{json, optional, read_json, read_word, word};
use pollster::block_on;
use sqlx::{Result as Q, SqliteConnection};
use vibevalley_protocol::{Block, BlockOpResult, Suggestion, TextSpan};

#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;
pub use queries::{
    AddArtifactParams as NewArtifact, AddVersionParams as NewVersion, ArtifactEntriesRow as EntryRow, ArtifactRow, UpsertArtifactEntryParams as UpsertEntry,
    VersionRow,
};

pub const SCHEMA: &str = include_str!("sql/schema.sql");

pub fn artifact(db: &mut SqliteConnection, id: &str) -> Q<Option<ArtifactRow>> {
    optional(block_on(queries::artifact(db, queries::ArtifactParams { id: id.into() })))
}

pub fn default_design_system_artifact(db: &mut SqliteConnection) -> Q<Option<ArtifactRow>> {
    optional(block_on(queries::default_design_system_artifact(db)))
}

pub fn clear_default_design_system(db: &mut SqliteConnection, at: i64) -> Q<()> {
    block_on(queries::clear_default_design_system(
        db,
        queries::ClearDefaultDesignSystemParams { updated_at: at },
    ))
}

pub fn set_artifact_default(db: &mut SqliteConnection, id: &str, is_default: bool, at: i64) -> Q<()> {
    block_on(queries::set_artifact_default(
        db,
        queries::SetArtifactDefaultParams {
            id: id.into(),
            is_default: i64::from(is_default),
            updated_at: at,
        },
    ))
}

pub fn artifacts_in_channel(db: &mut SqliteConnection, channel: &str) -> Q<Vec<ArtifactRow>> {
    block_on(queries::artifacts_in_channel(
        db,
        queries::ArtifactsInChannelParams {
            channel_id: Some(channel.into()),
        },
    ))
}

pub fn artifacts_for_issue(db: &mut SqliteConnection, issue: &str) -> Q<Vec<ArtifactRow>> {
    block_on(queries::artifacts_for_issue(db, queries::ArtifactsForIssueParams { issue: Some(issue.into()) }))
}

pub fn artifacts(db: &mut SqliteConnection, limit: i64) -> Q<Vec<ArtifactRow>> {
    block_on(queries::artifacts(db, queries::ArtifactsParams { limit }))
}

pub fn add_artifact(db: &mut SqliteConnection, params: NewArtifact) -> Q<()> {
    block_on(queries::add_artifact(db, params))
}

pub fn add_version(db: &mut SqliteConnection, params: NewVersion) -> Q<()> {
    block_on(queries::add_version(db, params))
}

pub fn artifact_said(db: &mut SqliteConnection, id: &str, message: &str) -> Q<()> {
    block_on(queries::artifact_said(
        db,
        queries::ArtifactSaidParams {
            id: id.into(),
            message_id: Some(message.into()),
        },
    ))
}

pub fn artifact_versioned(db: &mut SqliteConnection, id: &str, version: i64, at: i64) -> Q<()> {
    block_on(queries::artifact_versioned(
        db,
        queries::ArtifactVersionedParams {
            id: id.into(),
            version,
            updated_at: at,
        },
    ))
}

pub fn artifact_accepted(db: &mut SqliteConnection, id: &str, seq: i64, at: i64) -> Q<()> {
    block_on(queries::artifact_accepted(
        db,
        queries::ArtifactAcceptedParams {
            id: id.into(),
            seq,
            updated_at: at,
        },
    ))
}

pub fn artifact_renamed(db: &mut SqliteConnection, id: &str, title: &str, at: i64) -> Q<()> {
    block_on(queries::artifact_renamed(
        db,
        queries::ArtifactRenamedParams {
            id: id.into(),
            title: title.into(),
            updated_at: at,
        },
    ))
}

pub fn artifact_shown(db: &mut SqliteConnection, id: &str, display: &str, at: i64) -> Q<()> {
    block_on(queries::artifact_shown(
        db,
        queries::ArtifactShownParams {
            id: id.into(),
            display: Some(display.into()),
            updated_at: at,
        },
    ))
}

pub fn delete_artifact(db: &mut SqliteConnection, id: &str) -> Q<()> {
    block_on(queries::delete_artifact(db, queries::DeleteArtifactParams { id: id.into() }))
}

pub fn version_announced(db: &mut SqliteConnection, artifact: &str, version: i64, message: &str) -> Q<()> {
    block_on(queries::version_announced(
        db,
        queries::VersionAnnouncedParams {
            artifact_id: artifact.into(),
            version,
            message_id: Some(message.into()),
        },
    ))
}

pub fn resolve_suggestion(db: &mut SqliteConnection, id: &str, status: &str, at: i64, by: &str) -> Q<()> {
    block_on(queries::resolve_suggestion(
        db,
        queries::ResolveSuggestionParams {
            id: id.into(),
            status: status.into(),
            resolved_at: Some(at),
            resolved_by: Some(by.into()),
        },
    ))
}

pub fn versions(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<VersionRow>> {
    block_on(queries::versions(db, queries::VersionsParams { artifact_id: artifact.into() }))
}

pub fn version(db: &mut SqliteConnection, artifact: &str, version: i64) -> Q<Option<VersionRow>> {
    optional(block_on(queries::version(
        db,
        queries::VersionParams {
            artifact_id: artifact.into(),
            version,
        },
    )))
}

pub fn blocks(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<Block>> {
    let rows = block_on(queries::blocks(db, queries::BlocksParams { artifact_id: artifact.into() }))?;
    rows.into_iter()
        .map(|r| {
            Ok(vibevalley_artifact::ops::wire(Block {
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

pub fn block_owner(db: &mut SqliteConnection, id: &str) -> Q<Option<String>> {
    Ok(optional(block_on(queries::block_owner(db, queries::BlockOwnerParams { id: id.into() })))?.map(|row| row.artifact_id))
}

pub fn put_block(db: &mut SqliteConnection, artifact: &str, b: &Block) -> Q<()> {
    block_on(queries::put_block(
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
    ))
}

pub fn add_revision(db: &mut SqliteConnection, block: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> Q<()> {
    block_on(queries::add_revision(
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
    ))
}
pub fn revision(db: &mut SqliteConnection, block: &str, rev: i64) -> Q<Option<Vec<TextSpan>>> {
    let row = optional(block_on(queries::revision(db, queries::RevisionParams { block_id: block.into(), rev })))?;
    row.map(|r| read_json::<Option<Vec<TextSpan>>>(r.spans).map(Option::unwrap_or_default))
        .transpose()
}
pub fn prune(db: &mut SqliteConnection, before: i64) -> Q<()> {
    block_on(async {
        use sqlx::Connection;
        let mut tx = db.begin().await?;
        queries::prune_changes(&mut *tx, queries::PruneChangesParams { created_at: before }).await?;
        queries::prune_revisions(&mut *tx, queries::PruneRevisionsParams { created_at: before }).await?;
        queries::prune_artifact_entry_changes(&mut *tx, queries::PruneArtifactEntryChangesParams { created_at: before }).await?;
        tx.commit().await
    })
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
        batch_id: row.batch_id,
        block_ids: read_json(row.block_ids)?,
        results: read_json(row.results)?,
    })
}
pub fn change_by_batch(db: &mut SqliteConnection, batch: &str) -> Q<Option<ChangeRow>> {
    optional(block_on(queries::change_by_batch(db, queries::ChangeByBatchParams { batch_id: batch.into() })))?
        .map(change)
        .transpose()
}
pub fn add_change(db: &mut SqliteConnection, c: &NewChange) -> Q<()> {
    block_on(queries::add_change(
        db,
        queries::AddChangeParams {
            artifact_id: c.artifact_id.into(),
            seq: c.seq,
            batch_id: c.batch_id.into(),
            actor: c.actor.into(),
            block_ids: json(&c.block_ids)?,
            results: json(&c.results)?,
            created_at: c.created_at,
        },
    ))
}
pub fn changes_after(db: &mut SqliteConnection, artifact: &str, seq: i64, n: i64) -> Q<Vec<ChangeRow>> {
    block_on(queries::changes_after(
        db,
        queries::ChangesAfterParams {
            artifact_id: artifact.into(),
            seq,
            limit: n,
        },
    ))?
    .into_iter()
    .map(change)
    .collect()
}

fn decode_suggestion(row: queries::SuggestionRow) -> Q<Suggestion> {
    Ok(Suggestion {
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
    })
}
pub fn add_suggestion(db: &mut SqliteConnection, s: &Suggestion) -> Q<()> {
    block_on(queries::add_suggestion(
        db,
        queries::AddSuggestionParams {
            id: s.id.clone(),
            artifact_id: s.artifact_id.clone(),
            block_id: s.block_id.clone(),
            author: s.author.clone(),
            at_rev: s.base_rev,
            change: json(&s.change)?,
            created_at: s.created_at,
        },
    ))
}
pub fn suggestion(db: &mut SqliteConnection, id: &str) -> Q<Option<Suggestion>> {
    optional(block_on(queries::suggestion(db, queries::SuggestionParams { id: id.into() })))?
        .map(decode_suggestion)
        .transpose()
}
pub fn suggestions(db: &mut SqliteConnection, artifact: &str, limit: i64) -> Q<Vec<Suggestion>> {
    block_on(queries::suggestions(
        db,
        queries::SuggestionsParams {
            artifact_id: artifact.into(),
            limit,
        },
    ))?
    .into_iter()
    .map(decode_suggestion)
    .collect()
}

pub fn entries(db: &mut SqliteConnection, artifact: &str) -> Q<Vec<EntryRow>> {
    block_on(queries::artifact_entries(db, queries::ArtifactEntriesParams { artifact_id: artifact.into() }))
}

pub fn entries_by_prefix(db: &mut SqliteConnection, artifact: &str, prefix: &str) -> Q<Vec<EntryRow>> {
    let rows = block_on(queries::artifact_entries_by_prefix(
        db,
        queries::ArtifactEntriesByPrefixParams {
            artifact_id: artifact.into(),
            path: format!("{prefix}%"),
        },
    ))?;
    Ok(rows.into_iter().filter(|r| r.path.starts_with(prefix)).collect())
}

pub fn entry(db: &mut SqliteConnection, artifact: &str, path: &str) -> Q<Option<EntryRow>> {
    optional(block_on(queries::artifact_entry(
        db,
        queries::ArtifactEntryParams {
            artifact_id: artifact.into(),
            path: path.into(),
        },
    )))
}

pub fn entry_count(db: &mut SqliteConnection, artifact: &str) -> Q<i64> {
    Ok(block_on(queries::artifact_entry_count(
        db,
        queries::ArtifactEntryCountParams { artifact_id: artifact.into() },
    ))?
    .n)
}

pub fn upsert_entry(db: &mut SqliteConnection, params: UpsertEntry) -> Q<()> {
    block_on(queries::upsert_artifact_entry(db, params))
}

pub fn delete_entry(db: &mut SqliteConnection, artifact: &str, path: &str) -> Q<()> {
    block_on(queries::delete_artifact_entry(
        db,
        queries::DeleteArtifactEntryParams {
            artifact_id: artifact.into(),
            path: path.into(),
        },
    ))
}

pub struct EntryChangeRow {
    pub seq: i64,
    pub paths: Vec<String>,
    pub deleted: Vec<String>,
}

pub fn add_entry_change(db: &mut SqliteConnection, artifact: &str, seq: i64, actor: &str, paths: &[String], deleted: &[String], created_at: i64) -> Q<()> {
    block_on(queries::add_artifact_entry_change(
        db,
        queries::AddArtifactEntryChangeParams {
            artifact_id: artifact.into(),
            seq,
            actor: actor.into(),
            paths: json(&paths)?,
            deleted: json(&deleted)?,
            created_at,
        },
    ))
}

pub fn entry_changes_after(db: &mut SqliteConnection, artifact: &str, seq: i64, limit: i64) -> Q<Vec<EntryChangeRow>> {
    block_on(queries::artifact_entry_changes_after(
        db,
        queries::ArtifactEntryChangesAfterParams {
            artifact_id: artifact.into(),
            seq,
            limit,
        },
    ))?
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
