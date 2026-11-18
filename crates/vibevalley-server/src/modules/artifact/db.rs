//! The artifact tables in `server.db` and their queries (VibeValley
//! `db/queries/artifact*.sql`, `0001_schema.up.sql`). Messages are joined
//! from the chat's `channel_message` without a foreign key: a message gone
//! reads as no message.

use rusqlite::{Connection, OptionalExtension, Row, params};
use vibevalley_protocol::{Block, BlockAttrs, BlockOpResult, BlockType, Suggestion, SuggestionChange, SuggestionStatus, TextSpan};

pub const SCHEMA: &str = "
create table if not exists artifact (
  id          text primary key,
  title       text not null,
  body        text not null check (body in ('blocks', 'html')),
  display     text check ((body = 'html') = (display is not null) and (display is null or display in ('page', 'slides', 'motion'))),
  channel_id  text,
  message_id  text,
  issue       text,
  by_id       text not null,
  by_name     text not null,
  version     integer not null,
  seq         integer not null default 0,
  created_at  integer not null,
  updated_at  integer not null
);
create index if not exists artifact_by_channel on artifact (channel_id, updated_at);
create index if not exists artifact_by_issue on artifact (issue, updated_at);
create table if not exists artifact_version (
  artifact_id text not null references artifact (id) on delete cascade,
  version     integer not null,
  attachment_id text not null,
  size        integer not null,
  note        text,
  by_id       text not null,
  by_name     text not null,
  message_id  text,
  created_at  integer not null,
  primary key (artifact_id, version)
);
create table if not exists artifact_block (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  parent_id   text,
  order_key   text not null,
  type        text not null check (type in ('paragraph', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code', 'divider', 'image', 'issue_ref', 'memory_item')),
  attrs       text not null default '{}',
  spans       text not null default '[]',
  rev         integer not null,
  deleted     integer not null default 0,
  updated_by  text not null,
  updated_at  integer not null
);
create index if not exists artifact_block_by_artifact on artifact_block (artifact_id, order_key, id);
create table if not exists artifact_block_revision (
  id         text primary key,
  block_id   text not null references artifact_block (id) on delete cascade,
  rev        integer not null,
  spans      text not null,
  actor      text not null,
  kind       text not null check (kind in ('normal', 'conflict')),
  created_at integer not null
);
create index if not exists artifact_block_revision_by_block on artifact_block_revision (block_id, rev);
create table if not exists artifact_change (
  artifact_id text not null references artifact (id) on delete cascade,
  seq         integer not null,
  batch_id    text not null unique,
  actor       text not null,
  block_ids   text not null,
  results     text not null,
  created_at  integer not null,
  primary key (artifact_id, seq)
);
create table if not exists artifact_suggestion (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  block_id    text not null references artifact_block (id) on delete cascade,
  author      text not null,
  at_rev      integer not null,
  change      text not null,
  status      text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at  integer not null,
  resolved_at integer,
  resolved_by text
);
create index if not exists artifact_suggestion_by_artifact on artifact_suggestion (artifact_id, created_at);
";

pub type Q<T> = rusqlite::Result<T>;

/// An artifact's row, with the channel and number of the message that
/// first announced it.
#[derive(Debug, Clone)]
pub struct ArtifactRow {
    pub id: String,
    pub title: String,
    pub body: String,
    pub display: Option<String>,
    pub channel_id: Option<String>,
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

const ROW: &str = "select a.id, a.title, a.body, a.display, a.channel_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id, m.number
  from artifact a left join channel_message m on m.id = a.message_id";

fn artifact_row(r: &Row) -> Q<ArtifactRow> {
    Ok(ArtifactRow {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        display: r.get(3)?,
        channel_id: r.get(4)?,
        issue: r.get(5)?,
        by_id: r.get(6)?,
        by_name: r.get(7)?,
        version: r.get(8)?,
        seq: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        said_channel: r.get(12)?,
        said_number: r.get(13)?,
    })
}

pub fn artifact(db: &Connection, id: &str) -> Q<Option<ArtifactRow>> {
    db.query_row(&format!("{ROW} where a.id = ?1"), [id], artifact_row).optional()
}

fn rows(db: &Connection, sql: &str, p: impl rusqlite::Params) -> Q<Vec<ArtifactRow>> {
    let mut stmt = db.prepare(sql)?;
    stmt.query_map(p, artifact_row)?.collect()
}

pub fn artifacts_in_channel(db: &Connection, channel: &str) -> Q<Vec<ArtifactRow>> {
    rows(db, &format!("{ROW} where a.channel_id = ?1 order by a.updated_at desc, a.id"), [channel])
}

pub fn artifacts_for_issue(db: &Connection, issue: &str) -> Q<Vec<ArtifactRow>> {
    rows(db, &format!("{ROW} where a.issue = ?1 order by a.updated_at desc, a.id"), [issue])
}

pub fn artifacts(db: &Connection, limit: i64) -> Q<Vec<ArtifactRow>> {
    rows(db, &format!("{ROW} order by a.updated_at desc, a.id limit ?1"), [limit])
}

pub struct NewArtifact<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub display: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub issue: Option<&'a str>,
    pub by_id: &'a str,
    pub by_name: &'a str,
    pub version: i64,
    pub created_at: i64,
}

pub fn add_artifact(db: &Connection, a: &NewArtifact) -> Q<()> {
    db.execute(
        "insert into artifact (id, title, body, display, channel_id, issue, by_id, by_name, version, seq, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
        params![
            a.id,
            a.title,
            a.body,
            a.display,
            a.channel_id,
            a.issue,
            a.by_id,
            a.by_name,
            a.version,
            a.created_at
        ],
    )
    .map(drop)
}

pub fn artifact_said(db: &Connection, id: &str, message: &str) -> Q<()> {
    db.execute("update artifact set message_id = ?2 where id = ?1", params![id, message]).map(drop)
}

pub fn artifact_versioned(db: &Connection, id: &str, version: i64, at: i64) -> Q<()> {
    db.execute("update artifact set version = ?2, updated_at = ?3 where id = ?1", params![id, version, at])
        .map(drop)
}

pub fn artifact_accepted(db: &Connection, id: &str, seq: i64, at: i64) -> Q<()> {
    db.execute("update artifact set seq = ?2, updated_at = ?3 where id = ?1", params![id, seq, at])
        .map(drop)
}

pub fn artifact_renamed(db: &Connection, id: &str, title: &str, at: i64) -> Q<()> {
    db.execute("update artifact set title = ?2, updated_at = ?3 where id = ?1", params![id, title, at])
        .map(drop)
}

pub fn artifact_shown(db: &Connection, id: &str, display: &str, at: i64) -> Q<()> {
    db.execute(
        "update artifact set display = ?2, updated_at = ?3 where id = ?1 and body = 'html'",
        params![id, display, at],
    )
    .map(drop)
}

pub fn delete_artifact(db: &Connection, id: &str) -> Q<()> {
    db.execute("delete from artifact where id = ?1", [id]).map(drop)
}

// ----- versions -----

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

pub struct NewVersion<'a> {
    pub artifact_id: &'a str,
    pub version: i64,
    pub attachment_id: &'a str,
    pub size: i64,
    pub note: Option<&'a str>,
    pub by_id: &'a str,
    pub by_name: &'a str,
    pub created_at: i64,
}

pub fn add_version(db: &Connection, v: &NewVersion) -> Q<()> {
    db.execute(
        "insert into artifact_version (artifact_id, version, attachment_id, size, note, by_id, by_name, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![v.artifact_id, v.version, v.attachment_id, v.size, v.note, v.by_id, v.by_name, v.created_at],
    )
    .map(drop)
}

pub fn version_announced(db: &Connection, artifact: &str, version: i64, message: &str) -> Q<()> {
    db.execute(
        "update artifact_version set message_id = ?3 where artifact_id = ?1 and version = ?2",
        params![artifact, version, message],
    )
    .map(drop)
}

const VERSION: &str = "select v.version, v.attachment_id, v.size, v.note, v.by_id, v.by_name, v.created_at, m.channel_id, m.number
  from artifact_version v left join channel_message m on m.id = v.message_id";

fn version_row(r: &Row) -> Q<VersionRow> {
    Ok(VersionRow {
        version: r.get(0)?,
        attachment_id: r.get(1)?,
        size: r.get(2)?,
        note: r.get(3)?,
        by_id: r.get(4)?,
        by_name: r.get(5)?,
        created_at: r.get(6)?,
        message_channel: r.get(7)?,
        message_number: r.get(8)?,
    })
}

pub fn versions(db: &Connection, artifact: &str) -> Q<Vec<VersionRow>> {
    let mut stmt = db.prepare(&format!("{VERSION} where v.artifact_id = ?1 order by v.version"))?;
    stmt.query_map([artifact], version_row)?.collect()
}

pub fn version(db: &Connection, artifact: &str, version: i64) -> Q<Option<VersionRow>> {
    db.query_row(
        &format!("{VERSION} where v.artifact_id = ?1 and v.version = ?2"),
        params![artifact, version],
        version_row,
    )
    .optional()
}

// ----- blocks -----

fn json<T: serde::de::DeserializeOwned>(text: &str, what: &str) -> Q<T> {
    serde_json::from_str(text).map_err(|e| rusqlite::Error::InvalidColumnName(format!("{what}: {e}")))
}

pub fn text<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("JSON")
}

fn block_row(r: &Row) -> Q<Block> {
    let kind: String = r.get(4)?;
    let attrs: String = r.get(5)?;
    let spans: String = r.get(6)?;
    let deleted: bool = r.get(8)?;
    Ok(crate_wire(Block {
        id: r.get(0)?,
        artifact_id: r.get(1)?,
        parent_id: r.get(2)?,
        order_key: r.get(3)?,
        r#type: json::<BlockType>(&format!("\"{kind}\""), "artifact_block.type")?,
        attrs: json::<BlockAttrs>(&attrs, "artifact_block.attrs")?,
        text: json::<Option<Vec<TextSpan>>>(&spans, "artifact_block.spans")?.unwrap_or_default(),
        rev: r.get(7)?,
        deleted: Some(deleted),
        updated_by: r.get(9)?,
        updated: r.get(10)?,
    }))
}

fn crate_wire(b: Block) -> Block {
    vibevalley_artifact::ops::wire(b)
}

/// One artifact's blocks, tombstones too.
pub fn blocks(db: &Connection, artifact: &str) -> Q<Vec<Block>> {
    let mut stmt = db.prepare(
        "select id, artifact_id, parent_id, order_key, type, attrs, spans, rev, deleted, updated_by, updated_at
         from artifact_block where artifact_id = ?1 order by order_key, id",
    )?;
    stmt.query_map([artifact], block_row)?.collect()
}

pub fn block_owner(db: &Connection, id: &str) -> Q<Option<String>> {
    db.query_row("select artifact_id from artifact_block where id = ?1", [id], |r| r.get(0))
        .optional()
}

pub fn put_block(db: &Connection, artifact: &str, b: &Block) -> Q<()> {
    let kind = serde_json::to_value(b.r#type).expect("JSON");
    db.execute(
        "insert into artifact_block (id, artifact_id, parent_id, order_key, type, attrs, spans, rev, deleted, updated_by, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         on conflict (id) do update set parent_id = excluded.parent_id, order_key = excluded.order_key, type = excluded.type,
           attrs = excluded.attrs, spans = excluded.spans, rev = excluded.rev, deleted = excluded.deleted,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at",
        params![
            b.id,
            artifact,
            b.parent_id,
            b.order_key,
            kind.as_str(),
            text(&b.attrs),
            text(&b.text),
            b.rev,
            b.deleted == Some(true),
            b.updated_by,
            b.updated
        ],
    )
    .map(drop)
}

pub fn add_revision(db: &Connection, block: &str, rev: i64, spans: &[TextSpan], actor: &str, kind: &str, at: i64) -> Q<()> {
    db.execute(
        "insert into artifact_block_revision (id, block_id, rev, spans, actor, kind, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![uuid::Uuid::now_v7().to_string(), block, rev, text(&spans), actor, kind, at],
    )
    .map(drop)
}

pub fn revision(db: &Connection, block: &str, rev: i64) -> Q<Option<Vec<TextSpan>>> {
    let spans: Option<String> = db
        .query_row(
            "select spans from artifact_block_revision where block_id = ?1 and rev = ?2 and kind = 'normal'
             order by created_at desc limit 1",
            params![block, rev],
            |r| r.get(0),
        )
        .optional()?;
    spans
        .map(|s| json::<Option<Vec<TextSpan>>>(&s, "artifact_block_revision.spans").map(Option::unwrap_or_default))
        .transpose()
}

pub fn prune(db: &Connection, before: i64) -> Q<()> {
    db.execute("delete from artifact_change where created_at < ?1", [before])?;
    db.execute("delete from artifact_block_revision where created_at < ?1", [before]).map(drop)
}

// ----- batches -----

pub struct ChangeRow {
    pub artifact_id: String,
    pub seq: i64,
    pub batch_id: String,
    pub block_ids: Vec<String>,
    pub results: Vec<BlockOpResult>,
}

fn change_row(r: &Row) -> Q<ChangeRow> {
    let ids: String = r.get(3)?;
    let results: String = r.get(4)?;
    Ok(ChangeRow {
        artifact_id: r.get(0)?,
        seq: r.get(1)?,
        batch_id: r.get(2)?,
        block_ids: json(&ids, "artifact_change.block_ids")?,
        results: json(&results, "artifact_change.results")?,
    })
}

pub fn change_by_batch(db: &Connection, batch: &str) -> Q<Option<ChangeRow>> {
    db.query_row(
        "select artifact_id, seq, batch_id, block_ids, results from artifact_change where batch_id = ?1",
        [batch],
        change_row,
    )
    .optional()
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

pub fn add_change(db: &Connection, c: &NewChange) -> Q<()> {
    db.execute(
        "insert into artifact_change (artifact_id, seq, batch_id, actor, block_ids, results, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![c.artifact_id, c.seq, c.batch_id, c.actor, text(&c.block_ids), text(&c.results), c.created_at],
    )
    .map(drop)
}

pub fn changes_after(db: &Connection, artifact: &str, seq: i64, n: i64) -> Q<Vec<ChangeRow>> {
    let mut stmt = db.prepare(
        "select artifact_id, seq, batch_id, block_ids, results from artifact_change
         where artifact_id = ?1 and seq > ?2 order by seq limit ?3",
    )?;
    stmt.query_map(params![artifact, seq, n], change_row)?.collect()
}

// ----- suggestions -----

fn suggestion_row(r: &Row) -> Q<Suggestion> {
    let change: String = r.get(5)?;
    let status: String = r.get(6)?;
    Ok(Suggestion {
        id: r.get(0)?,
        artifact_id: r.get(1)?,
        block_id: r.get(2)?,
        author: r.get(3)?,
        base_rev: r.get(4)?,
        change: json::<SuggestionChange>(&change, "artifact_suggestion.change")?,
        status: json::<SuggestionStatus>(&format!("\"{status}\""), "artifact_suggestion.status")?,
        created_at: r.get(7)?,
        resolved_at: r.get(8)?,
        resolved_by: r.get(9)?,
    })
}

const SUGGESTION: &str = "select id, artifact_id, block_id, author, at_rev, change, status, created_at, resolved_at, resolved_by from artifact_suggestion";

/// An open one; its status and resolution are not read.
pub fn add_suggestion(db: &Connection, s: &Suggestion) -> Q<()> {
    db.execute(
        "insert into artifact_suggestion (id, artifact_id, block_id, author, at_rev, change, status, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)",
        params![s.id, s.artifact_id, s.block_id, s.author, s.base_rev, text(&s.change), s.created_at],
    )
    .map(drop)
}

pub fn suggestion(db: &Connection, id: &str) -> Q<Option<Suggestion>> {
    db.query_row(&format!("{SUGGESTION} where id = ?1"), [id], suggestion_row).optional()
}

pub fn suggestions(db: &Connection, artifact: &str, n: i64) -> Q<Vec<Suggestion>> {
    let mut stmt = db.prepare(&format!("{SUGGESTION} where artifact_id = ?1 order by created_at, id limit ?2"))?;
    stmt.query_map(params![artifact, n], suggestion_row)?.collect()
}

pub fn resolve_suggestion(db: &Connection, id: &str, status: &str, at: i64, by: &str) -> Q<()> {
    db.execute(
        "update artifact_suggestion set status = ?2, resolved_at = ?3, resolved_by = ?4 where id = ?1 and status = 'open'",
        params![id, status, at, by],
    )
    .map(drop)
}
