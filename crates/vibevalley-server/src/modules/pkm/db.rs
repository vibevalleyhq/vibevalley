//! The notes' tables in `server.db` (VibeValley `db/queries/pkm_{change,
//! comment,term}.sql`, `0001_schema.up.sql`). The term index is matched in
//! Rust: Postgres' `term_vector @@ term_query(words, prefix)` and `ts_rank`
//! have no SQLite counterpart.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use vibevalley_protocol::{PkmComment, PkmCommentStatus};

pub const SCHEMA: &str = "
create table if not exists pkm_comment (
  id          text primary key,
  page        text not null,
  block       text not null,
  span        text,
  author      text not null,
  body        text not null,
  status      text not null default 'open' check (status in ('open', 'suggested', 'accepted', 'rejected')),
  suggested   text,
  rationale   text,
  created_at  integer not null,
  resolved_at integer
);
create index if not exists pkm_comment_by_block on pkm_comment (block, created_at);
create index if not exists pkm_comment_by_page on pkm_comment (page, created_at);
create table if not exists pkm_term (
  block  text not null,
  page   text not null,
  terms  text not null
);
create index if not exists pkm_term_by_page on pkm_term (page);
create table if not exists pkm_change (
  seq          integer primary key autoincrement,
  at           integer not null,
  what         text not null,
  page         text not null,
  before_file  text,
  after_file   text not null,
  before_text  text,
  after_text   text not null
);
";

pub type R<T> = rusqlite::Result<T>;

pub struct Change {
    pub seq: i64,
    pub what: String,
    pub page: String,
    pub before_file: Option<String>,
    pub after_file: String,
    pub before_text: Option<String>,
}

pub struct NewChange<'a> {
    pub at: i64,
    pub what: &'a str,
    pub page: &'a str,
    pub before_file: Option<&'a str>,
    pub after_file: &'a str,
    pub before_text: Option<&'a str>,
    pub after_text: &'a str,
}

pub fn add_change(db: &Connection, c: &NewChange) -> R<()> {
    db.execute(
        "insert into pkm_change (at, what, page, before_file, after_file, before_text, after_text) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![c.at, c.what, c.page, c.before_file, c.after_file, c.before_text, c.after_text],
    )?;
    Ok(())
}

pub fn last_change(db: &Connection) -> R<Option<Change>> {
    db.query_row(
        "select seq, what, page, before_file, after_file, before_text from pkm_change order by seq desc limit 1",
        [],
        |r| {
            Ok(Change {
                seq: r.get(0)?,
                what: r.get(1)?,
                page: r.get(2)?,
                before_file: r.get(3)?,
                after_file: r.get(4)?,
                before_text: r.get(5)?,
            })
        },
    )
    .optional()
}

pub fn drop_change(db: &Connection, seq: i64) -> R<()> {
    db.execute("delete from pkm_change where seq = ?1", [seq])?;
    Ok(())
}

pub fn trim_changes(db: &Connection, keep: i64) -> R<()> {
    db.execute("delete from pkm_change where seq <= (select max(seq) from pkm_change) - ?1", [keep])?;
    Ok(())
}

const COMMENT: &str = "select id, page, block, span, author, body, status, suggested, rationale, created_at, resolved_at from pkm_comment";

fn comment_of(r: &Row) -> R<PkmComment> {
    let status: String = r.get(6)?;
    Ok(PkmComment {
        id: r.get(0)?,
        page: r.get(1)?,
        block: r.get(2)?,
        span: r.get(3)?,
        by: r.get(4)?,
        body: r.get(5)?,
        status: match status.as_str() {
            "suggested" => PkmCommentStatus::Suggested,
            "accepted" => PkmCommentStatus::Accepted,
            "rejected" => PkmCommentStatus::Rejected,
            _ => PkmCommentStatus::Open,
        },
        suggested: r.get(7)?,
        rationale: r.get(8)?,
        created: r.get(9)?,
        resolved: r.get(10)?,
    })
}

/// The remarks not yet resolved, on one page or all.
pub fn open_comments(db: &Connection, page: Option<&str>) -> R<Vec<PkmComment>> {
    let mut stmt = db.prepare(&format!(
        "{COMMENT} where status in ('open', 'suggested') and (?1 is null or page = ?1) order by created_at, id"
    ))?;
    stmt.query_map([page], comment_of)?.collect()
}

pub fn comment(db: &Connection, id: &str) -> R<Option<PkmComment>> {
    db.query_row(&format!("{COMMENT} where id = ?1"), [id], comment_of).optional()
}

pub fn newest_on(db: &Connection, block: &str) -> R<Option<PkmComment>> {
    db.query_row(
        &format!("{COMMENT} where block = ?1 order by created_at desc, id desc limit 1"),
        [block],
        comment_of,
    )
    .optional()
}

pub struct Remark {
    pub id: String,
    pub page: String,
    pub block: String,
    pub span: Option<String>,
    pub author: String,
    pub body: String,
    pub created_at: i64,
}

/// A remark read from a file: its words follow the file while it is open;
/// one resolved stays as it was.
pub fn keep_remark(db: &Connection, r: &Remark) -> R<()> {
    db.execute(
        "insert into pkm_comment (id, page, block, span, author, body, status, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)
         on conflict (id) do update set body = excluded.body, page = excluded.page where pkm_comment.status = 'open'",
        params![r.id, r.page, r.block, r.span, r.author, r.body, r.created_at],
    )?;
    Ok(())
}

pub struct Suggestion<'a> {
    pub id: &'a str,
    pub page: &'a str,
    pub block: &'a str,
    pub author: &'a str,
    pub body: &'a str,
    pub suggested: &'a str,
    pub rationale: &'a str,
    pub created_at: i64,
}

pub fn add_suggestion(db: &Connection, s: &Suggestion) -> R<()> {
    db.execute(
        "insert into pkm_comment (id, page, block, author, body, status, suggested, rationale, created_at)
         values (?1, ?2, ?3, ?4, ?5, 'suggested', ?6, ?7, ?8)",
        params![s.id, s.page, s.block, s.author, s.body, s.suggested, s.rationale, s.created_at],
    )?;
    Ok(())
}

pub fn suggest(db: &Connection, id: &str, suggested: &str, rationale: &str) -> R<()> {
    db.execute(
        "update pkm_comment set status = 'suggested', suggested = ?2, rationale = ?3 where id = ?1",
        params![id, suggested, rationale],
    )?;
    Ok(())
}

pub fn resolve(db: &Connection, id: &str, status: &str, at: i64) -> R<()> {
    db.execute("update pkm_comment set status = ?2, resolved_at = ?3 where id = ?1", params![id, status, at])?;
    Ok(())
}

pub fn remarked_blocks(db: &Connection) -> R<Vec<String>> {
    let mut stmt = db.prepare("select distinct block from pkm_comment where status in ('open', 'suggested')")?;
    stmt.query_map([], |r| r.get(0))?.collect()
}

pub fn move_page(db: &Connection, from: &str, to: &str) -> R<()> {
    db.execute("update pkm_comment set page = ?2 where page = ?1", params![from, to])?;
    Ok(())
}

/// A block rewritten as accepted answers every remark still open on it.
pub fn resolve_on(db: &Connection, block: &str, at: i64) -> R<()> {
    db.execute(
        "update pkm_comment set status = 'accepted', resolved_at = ?2 where block = ?1 and status in ('open', 'suggested')",
        params![block, at],
    )?;
    Ok(())
}

pub fn clear_page_terms(db: &Connection, page: &str) -> R<()> {
    db.execute("delete from pkm_term where page = ?1", [page])?;
    Ok(())
}

pub fn clear_all_terms(db: &Connection) -> R<()> {
    db.execute("delete from pkm_term", [])?;
    Ok(())
}

/// A page's blocks as `(block, terms)`, in one transaction with clearing
/// the page's old rows.
pub fn set_page_terms(db: &Connection, page: &str, rows: &[(String, String)]) -> R<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute("delete from pkm_term where page = ?1", [page])?;
    {
        let mut stmt = tx.prepare("insert into pkm_term (block, page, terms) values (?1, ?2, ?3)")?;
        for (block, terms) in rows {
            stmt.execute(params![block, page, terms])?;
        }
    }
    tx.commit()
}

/// `ts_rank` of a position-less vector against an OR of prefix words: each
/// (word, term it begins) pair adds this, the sum divided by the words.
const RANK_PER_MATCH: f64 = 0.1 / 1.644_934_066_848_226_4;

/// The best 500 blocks that share a word (a word matches the terms it
/// begins), best first: block → score.
pub fn match_terms(db: &Connection, words: &[String]) -> R<HashMap<String, f64>> {
    let words: Vec<&String> = words.iter().filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return Ok(HashMap::new());
    }
    let mut stmt = db.prepare("select block, terms from pkm_term")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut scored: Vec<(String, f64)> = vec![];
    for row in rows {
        let (block, terms) = row?;
        let hits: usize = terms
            .split(' ')
            .filter(|t| !t.is_empty())
            .map(|t| words.iter().filter(|w| t.starts_with(w.as_str())).count())
            .sum();
        if hits > 0 {
            scored.push((block, RANK_PER_MATCH * hits as f64 / words.len() as f64));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(500);
    Ok(scored.into_iter().collect())
}
