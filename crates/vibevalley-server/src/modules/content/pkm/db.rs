//! Markdown files hold the pages. SQLite stores comments, search terms and undo history.

use crate::modules::infra::column::optional;
use pollster::block_on;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashMap;
use vibevalley_protocol::{PkmComment, PkmCommentStatus};

#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;
pub(super) use queries::{AddChangeParams as NewChange, AddSuggestionParams as Suggestion, KeepRemarkParams as Remark};
pub const SCHEMA: &str = include_str!("sql/schema.sql");

pub fn add_change(db: &mut SqliteConnection, change: NewChange) -> sqlx::Result<()> {
    block_on(queries::add_change(db, change))
}

pub fn last_change(db: &mut SqliteConnection) -> sqlx::Result<Option<queries::PreviousChangeRow>> {
    optional(block_on(queries::previous_change(db)))
}

pub fn drop_change(db: &mut SqliteConnection, seq: i64) -> sqlx::Result<()> {
    block_on(queries::drop_change(db, queries::DropChangeParams { seq }))
}

pub fn trim_changes(db: &mut SqliteConnection, keep: i64) -> sqlx::Result<()> {
    block_on(queries::trim_changes(db, queries::TrimChangesParams { keep }))
}

fn comment_of(row: queries::OpenCommentsRow) -> PkmComment {
    PkmComment {
        id: row.id,
        page: row.page,
        block: row.block,
        span: row.span,
        by: row.author,
        body: row.body,
        status: match row.status.as_str() {
            "suggested" => PkmCommentStatus::Suggested,
            "accepted" => PkmCommentStatus::Accepted,
            "rejected" => PkmCommentStatus::Rejected,
            _ => PkmCommentStatus::Open,
        },
        suggested: row.suggested,
        rationale: row.rationale,
        created: row.created_at,
        resolved: row.resolved_at,
    }
}

pub fn open_comments(db: &mut SqliteConnection, page: Option<&str>) -> sqlx::Result<Vec<PkmComment>> {
    Ok(
        block_on(queries::open_comments(db, queries::OpenCommentsParams { page: page.map(str::to_owned) }))?
            .into_iter()
            .map(comment_of)
            .collect(),
    )
}

pub fn comment(db: &mut SqliteConnection, id: &str) -> sqlx::Result<Option<PkmComment>> {
    Ok(optional(block_on(queries::find_comment(db, queries::FindCommentParams { id: id.into() })))?.map(comment_of))
}

pub fn newest_on(db: &mut SqliteConnection, block: &str) -> sqlx::Result<Option<PkmComment>> {
    Ok(optional(block_on(queries::latest_block_comment(
        db,
        queries::LatestBlockCommentParams { block: block.into() },
    )))?
    .map(comment_of))
}

pub fn keep_remark(db: &mut SqliteConnection, remark: Remark) -> sqlx::Result<()> {
    block_on(queries::keep_remark(db, remark))
}
pub fn add_suggestion(db: &mut SqliteConnection, suggestion: Suggestion) -> sqlx::Result<()> {
    block_on(queries::add_suggestion(db, suggestion))
}
pub fn suggest(db: &mut SqliteConnection, id: &str, suggested: &str, rationale: &str) -> sqlx::Result<()> {
    block_on(queries::suggest(
        db,
        queries::SuggestParams {
            id: id.into(),
            suggested: Some(suggested.into()),
            rationale: Some(rationale.into()),
        },
    ))
}
pub fn resolve(db: &mut SqliteConnection, id: &str, status: &str, at: i64) -> sqlx::Result<()> {
    block_on(queries::resolve_comment(
        db,
        queries::ResolveCommentParams {
            id: id.into(),
            status: status.into(),
            resolved_at: Some(at),
        },
    ))
}
pub fn remarked_blocks(db: &mut SqliteConnection) -> sqlx::Result<Vec<String>> {
    Ok(block_on(queries::remarked_blocks(db))?.into_iter().map(|r| r.block).collect())
}
pub fn move_page(db: &mut SqliteConnection, from: &str, to: &str) -> sqlx::Result<()> {
    block_on(queries::move_page_comments(
        db,
        queries::MovePageCommentsParams {
            old_page: from.into(),
            new_page: to.into(),
        },
    ))
}
pub fn resolve_on(db: &mut SqliteConnection, block: &str, at: i64) -> sqlx::Result<()> {
    block_on(queries::accept_block_comments(
        db,
        queries::AcceptBlockCommentsParams {
            block: block.into(),
            resolved_at: Some(at),
        },
    ))
}
pub fn clear_page_terms(db: &mut SqliteConnection, page: &str) -> sqlx::Result<()> {
    block_on(queries::clear_page_terms(db, queries::ClearPageTermsParams { page: page.into() }))
}
pub fn clear_all_terms(db: &mut SqliteConnection) -> sqlx::Result<()> {
    block_on(queries::clear_all_terms(db))
}

pub fn set_page_terms(db: &mut SqliteConnection, page: &str, rows: &[(String, String)]) -> sqlx::Result<()> {
    block_on(async {
        let mut tx = db.begin().await?;
        queries::clear_page_terms(&mut *tx, queries::ClearPageTermsParams { page: page.into() }).await?;
        for (block, terms) in rows {
            queries::add_term(
                &mut *tx,
                queries::AddTermParams {
                    block: block.clone(),
                    page: page.into(),
                    terms: terms.clone(),
                },
            )
            .await?;
        }
        tx.commit().await
    })
}

/// `ts_rank` of a position-less vector against an OR of prefix words: each
/// (word, term it begins) pair adds this, the sum divided by the words.
const RANK_PER_MATCH: f64 = 0.1 / 1.644_934_066_848_226_4;

/// The best 500 blocks that share a word (a word matches the terms it
/// begins), best first: block → score.
pub fn match_terms(db: &mut SqliteConnection, words: &[String]) -> sqlx::Result<HashMap<String, f64>> {
    let words: Vec<&String> = words.iter().filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = block_on(queries::all_terms(db))?;
    let mut scored: Vec<(String, f64)> = vec![];
    for row in rows {
        let terms = row.terms;
        let hits: usize = terms
            .split(' ')
            .filter(|t| !t.is_empty())
            .map(|t| words.iter().filter(|w| t.starts_with(w.as_str())).count())
            .sum();
        if hits > 0 {
            scored.push((row.block, RANK_PER_MATCH * hits as f64 / words.len() as f64));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(500);
    Ok(scored.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::base::open_sqlx_db;

    #[test]
    fn pkm_term_enforces_pk_and_upserts_duplicate_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = block_on(async {
            let mut c = open_sqlx_db(dir.path()).await?;
            sqlx::raw_sql(SCHEMA).execute(&mut c).await?;
            Ok::<_, sqlx::Error>(c)
        })
        .unwrap();
        let rows = vec![("b1".into(), "alpha beta".into()), ("b1".into(), "alpha beta gamma".into())];
        set_page_terms(&mut db, "notes", &rows).unwrap();
        let hits = match_terms(&mut db, &["gamma".into()]).unwrap();
        assert!(hits.contains_key("b1"));
        let all = block_on(queries::all_terms(&mut db)).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].terms, "alpha beta gamma");
    }
}
