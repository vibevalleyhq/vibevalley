//! Derived status and stage are rebuilt from issues and sessions, never persisted.

use rusqlite::{Connection, OptionalExtension, params};
use vibevalley_protocol::{Issue, Millis};

use crate::modules::column::{Reading, json, json_or_none, word, word_or_none};

pub const SCHEMA: &str = "
create table if not exists issue (
  id           text primary key,
  number       integer not null unique,
  title        text not null,
  description  text not null,
  repo         text,
  priority     text not null,
  rank         integer,
  deliver      text not null,
  parent       text,
  cron         text,
  created_at   integer not null,
  queued_at    integer,
  closed_at    integer,
  reviewed_at  integer,
  canceled     text,
  delivered    text,
  mandate      text not null,
  constraints  text,
  conflict     text,
  pull_request text,
  last_run     text,
  answer       text,
  blocked_by   text not null,
  criteria     text not null,
  checks       text not null,
  findings     text not null,
  questions    text not null,
  assignments  text not null
);
create index if not exists issue_parent on issue (parent);
create table if not exists issue_word (
  seq        integer primary key autoincrement,
  issue      text not null,
  text       text not null,
  created_at integer not null
);
create index if not exists issue_word_waiting on issue_word (issue, seq);
create table if not exists issue_counter (
  id          integer primary key check (id = 1),
  last_number integer not null
);
";

const COLUMNS: &str = "id, number, title, description, repo, priority, rank, deliver, parent, cron, created_at, queued_at, closed_at, \
     reviewed_at, canceled, delivered, mandate, constraints, conflict, pull_request, last_run, answer, blocked_by, criteria, checks, \
     findings, questions, assignments";

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Issue> {
    let mut r = Reading::of(row);
    let id: String = r.get()?;
    let number: i64 = r.get()?;
    let title: String = r.get()?;
    let description: String = r.get()?;
    let repo: Option<String> = r.get()?;
    let priority = r.word()?;
    let rank: Option<i64> = r.get()?;
    let deliver = r.word()?;
    let parent: Option<String> = r.get()?;
    let cron: Option<String> = r.get()?;
    let created_at: Millis = r.get()?;
    let mut issue = Issue::new(id, number, title, created_at);
    issue.description = description;
    issue.repo = repo;
    issue.priority = priority;
    issue.rank = rank;
    issue.deliver = deliver;
    issue.parent = parent;
    issue.cron = cron;
    issue.queued_at = r.get()?;
    issue.closed_at = r.get()?;
    issue.reviewed_at = r.get()?;
    issue.canceled = r.word_or_none()?;
    issue.delivered = r.word_or_none()?;
    issue.mandate = r.json()?;
    issue.constraints = r.json_or_none()?;
    issue.conflict = r.json_or_none()?;
    issue.pull_request = r.json_or_none()?;
    issue.last_run = r.json_or_none()?;
    issue.answer = r.json_or_none()?;
    issue.blocked_by = r.json()?;
    issue.criteria = r.json()?;
    issue.checks = r.json()?;
    issue.findings = r.json()?;
    issue.questions = r.json()?;
    issue.assignments = r.json()?;
    Ok(issue)
}

pub fn all(db: &Connection) -> rusqlite::Result<Vec<Issue>> {
    let mut q = db.prepare_cached(&format!("select {COLUMNS} from issue order by number"))?;
    let rows = q.query_map([], read)?;
    rows.collect()
}

pub fn put(db: &Connection, t: &Issue) -> rusqlite::Result<()> {
    db.prepare_cached(&format!(
        "insert or replace into issue ({COLUMNS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, \
         ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)"
    ))?
    .execute(params![
        t.id,
        t.number,
        t.title,
        t.description,
        t.repo,
        word(&t.priority)?,
        t.rank,
        word(&t.deliver)?,
        t.parent,
        t.cron,
        t.created_at,
        t.queued_at,
        t.closed_at,
        t.reviewed_at,
        word_or_none(&t.canceled)?,
        word_or_none(&t.delivered)?,
        json(&t.mandate)?,
        json_or_none(&t.constraints)?,
        json_or_none(&t.conflict)?,
        json_or_none(&t.pull_request)?,
        json_or_none(&t.last_run)?,
        json_or_none(&t.answer)?,
        json(&t.blocked_by)?,
        json(&t.criteria)?,
        json(&t.checks)?,
        json(&t.findings)?,
        json(&t.questions)?,
        json(&t.assignments)?,
    ])?;
    Ok(())
}

pub fn remove(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.execute("delete from issue_word where issue = ?1", [id])?;
    db.execute("delete from issue where id = ?1", [id])?;
    Ok(())
}

pub fn next_number(db: &Connection, at_least: i64) -> rusqlite::Result<i64> {
    let last: Option<i64> = db
        .query_row("select last_number from issue_counter where id = 1", [], |r| r.get(0))
        .optional()?;
    let next = last.unwrap_or(0).max(at_least) + 1;
    db.execute(
        "insert into issue_counter (id, last_number) values (1, ?1) on conflict (id) do update set last_number = excluded.last_number",
        [next],
    )?;
    Ok(next)
}

pub fn keep_words(db: &Connection, issue: &str, words: &str, at: Millis) -> rusqlite::Result<()> {
    db.execute(
        "insert into issue_word (issue, text, created_at) values (?1, ?2, ?3)",
        params![issue, words, at],
    )?;
    Ok(())
}

pub fn take_words(db: &Connection, issue: &str) -> rusqlite::Result<Vec<String>> {
    let kept = {
        let mut q = db.prepare_cached("select text from issue_word where issue = ?1 order by seq")?;
        let rows = q.query_map([issue], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    db.execute("delete from issue_word where issue = ?1", [issue])?;
    Ok(kept)
}
