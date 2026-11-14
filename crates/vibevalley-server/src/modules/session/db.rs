use super::sessions::Extra;
use crate::modules::column::{Reading, json, json_or_none, word, word_or_none};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use vibevalley_protocol::{Run, Session};

pub const SCHEMA: &str = "
create table if not exists session (
  id text primary key,
  role text not null,
  name text not null,
  agent text not null,
  runtime text not null,
  brief text not null,
  repo text,
  branch text,
  worktree text,
  hired_at integer not null,
  runs integer not null,
  last_run text,
  spent text,
  channel text,
  issue text,
  refining integer not null,
  tool_connections text,
  machine text,
  phase text not null,
  departed integer not null default 0
);
create index if not exists session_issue on session (issue);
create table if not exists session_extra (
  session text primary key, agent_session text, base text, run text
);
create table if not exists session_run (
  id text primary key, session text not null, issue text,
  triggered_by text not null, heard text not null, started_at integer not null,
  ended_at integer, outcome text, summary text not null, spent text
);
create index if not exists session_run_issue on session_run (issue, started_at);
create table if not exists session_counter (
  name text primary key, last_number integer not null
);
";

const COLUMNS: &str = "id, role, name, agent, runtime, brief, repo, branch, worktree, hired_at, runs, last_run, spent, channel, issue, refining, tool_connections, machine, phase";
fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let mut r = Reading::of(row);
    Ok(Session {
        id: r.get()?,
        role: r.word()?,
        name: r.get()?,
        agent: r.get()?,
        runtime: r.get()?,
        brief: r.get()?,
        repo: r.get()?,
        branch: r.get()?,
        worktree: r.get()?,
        hired_at: r.get()?,
        runs: r.get()?,
        last_run: r.json_or_none()?,
        spent: r.json_or_none()?,
        channel: r.get()?,
        issue: r.get()?,
        refining: r.get()?,
        tool_connections: r.json_or_none()?,
        machine: r.get()?,
        phase: r.json()?,
    })
}

pub fn all(db: &Connection) -> rusqlite::Result<Vec<Session>> {
    let mut q = db.prepare_cached(&format!("select {COLUMNS} from session where departed = 0 order by hired_at, id"))?;
    q.query_map([], read)?.collect()
}

pub fn past(db: &Connection, id: &str) -> rusqlite::Result<Option<Session>> {
    db.query_row(&format!("select {COLUMNS} from session where id = ?1 and departed = 1"), [id], read)
        .optional()
}

pub fn put(db: &Connection, s: &Session, departed: bool) -> rusqlite::Result<()> {
    db.execute(&format!("insert or replace into session ({COLUMNS}, departed) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"), params![
        s.id,
        word(&s.role)?,
        s.name,
        s.agent,
        s.runtime,
        s.brief,
        s.repo,
        s.branch,
        s.worktree,
        s.hired_at,
        s.runs,
        json_or_none(&s.last_run)?,
        json_or_none(&s.spent)?,
        s.channel,
        s.issue,
        s.refining,
        json_or_none(&s.tool_connections)?,
        s.machine,
        json(&s.phase)?,
        departed,
    ])?;
    Ok(())
}

pub fn extras(db: &Connection) -> rusqlite::Result<HashMap<String, Extra>> {
    let mut q = db.prepare_cached("select session, agent_session, base, run from session_extra")?;
    q.query_map([], |r| {
        Ok((
            r.get(0)?,
            Extra {
                agent_session: r.get(1)?,
                base: r.get(2)?,
                run: r.get(3)?,
            },
        ))
    })?
    .collect()
}

pub fn put_extra(db: &Connection, session: &str, extra: &Extra) -> rusqlite::Result<()> {
    db.execute(
        "insert or replace into session_extra (session, agent_session, base, run) values (?1, ?2, ?3, ?4)",
        params![session, extra.agent_session, extra.base, extra.run],
    )?;
    Ok(())
}

pub fn remove_extra(db: &Connection, session: &str) -> rusqlite::Result<()> {
    db.execute("delete from session_extra where session = ?1", [session])?;
    Ok(())
}

fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let mut r = Reading::of(row);
    Ok(Run {
        id: r.get()?,
        session: r.get()?,
        issue: r.get()?,
        triggered_by: r.json()?,
        heard: r.json()?,
        started_at: r.get()?,
        ended_at: r.get()?,
        outcome: r.word_or_none()?,
        summary: r.get()?,
        spent: r.json_or_none()?,
    })
}

pub fn run(db: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    db.query_row(
        "select id, session, issue, triggered_by, heard, started_at, ended_at, outcome, summary, spent from session_run where id = ?1",
        [id],
        read_run,
    )
    .optional()
}

pub fn runs(db: &Connection, issue: &str) -> rusqlite::Result<Vec<Run>> {
    let mut q = db.prepare_cached("select id, session, issue, triggered_by, heard, started_at, ended_at, outcome, summary, spent from session_run where issue = ?1 order by started_at, cast(substr(id, 2) as integer)")?;
    q.query_map([issue], read_run)?.collect()
}

pub fn put_run(db: &Connection, r: &Run) -> rusqlite::Result<()> {
    db.execute("insert or replace into session_run (id, session, issue, triggered_by, heard, started_at, ended_at, outcome, summary, spent) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![r.id, r.session, r.issue, json(&r.triggered_by)?, json(&r.heard)?, r.started_at, r.ended_at, word_or_none(&r.outcome)?, r.summary, json_or_none(&r.spent)?])?;
    Ok(())
}

pub fn next(db: &Connection, name: &str, at_least: i64) -> rusqlite::Result<i64> {
    let last: Option<i64> = db
        .query_row("select last_number from session_counter where name = ?1", [name], |r| r.get(0))
        .optional()?;
    let next = last.unwrap_or(0).max(at_least) + 1;
    db.execute(
        "insert or replace into session_counter (name, last_number) values (?1, ?2)",
        params![name, next],
    )?;
    Ok(next)
}
