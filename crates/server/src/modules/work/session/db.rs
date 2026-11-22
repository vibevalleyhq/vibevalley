use super::sessions::Extra;
use crate::modules::infra::column::{json, optional, read_json, read_word, word};
use std::collections::HashMap;
use vibevalley_protocol::{Run, Session, SessionSubagents};
use vibevalley_runtime::agent::durable::Sqlite;

use crate::db::generated::work_session as queries;

pub const SCHEMA: &str = include_str!("sql/schema.sql");

pub fn put_subagents(db: &Sqlite<'_>, summary: &SessionSubagents) -> sqlx::Result<()> {
    let params = queries::PutSubagentsParams {
        run: summary.run.clone(),
        summary: json(summary)?,
    };
    db.query(async |c| queries::put_subagents(c, params).await)
}

fn read(r: queries::ListSessionsRow) -> sqlx::Result<Session> {
    Ok(Session {
        id: r.id,
        name: r.name,
        agent: r.agent,
        runtime: r.runtime,
        brief: r.brief,
        repo: r.repo,
        branch: r.branch,
        worktree: r.worktree,
        channel: r.channel,
        issue: r.issue,
        machine: r.machine,
        hired_at: r.hired_at,
        runs: r.runs,
        role: read_word(r.role)?,
        phase: read_json(r.phase)?,
        last_run: r.last_run.map(read_json).transpose()?,
        spent: r.spent.map(read_json).transpose()?,
        tool_connections: r.tool_connections.map(read_json).transpose()?,
        refining: r.refining != 0,
        subagents: r.subagents.map(read_json).transpose()?,
    })
}

pub fn all(db: &Sqlite<'_>) -> sqlx::Result<Vec<Session>> {
    db.query(async |c| queries::list_sessions(c).await)?.into_iter().map(read).collect()
}

pub fn past(db: &Sqlite<'_>, id: &str) -> sqlx::Result<Option<Session>> {
    optional(db.query(async |c| queries::get_past_session(c, queries::GetPastSessionParams { id: id.into() }).await))?
        .map(read)
        .transpose()
}

pub fn put(db: &Sqlite<'_>, s: &Session, departed: bool) -> sqlx::Result<()> {
    let params = queries::PutSessionParams {
        id: s.id.clone(),
        name: s.name.clone(),
        agent: s.agent.clone(),
        runtime: s.runtime.clone(),
        brief: s.brief.clone(),
        repo: s.repo.clone(),
        branch: s.branch.clone(),
        worktree: s.worktree.clone(),
        channel: s.channel.clone(),
        issue: s.issue.clone(),
        machine: s.machine.clone(),
        hired_at: s.hired_at,
        runs: s.runs,
        role: word(&s.role)?,
        phase: json(&s.phase)?,
        last_run: s.last_run.as_ref().map(json).transpose()?,
        spent: s.spent.as_ref().map(json).transpose()?,
        tool_connections: s.tool_connections.as_ref().map(json).transpose()?,
        refining: i64::from(s.refining),
        departed: i64::from(departed),
    };
    db.query(async |c| queries::put_session(c, params).await)
}

pub fn extras(db: &Sqlite<'_>) -> sqlx::Result<HashMap<String, Extra>> {
    let rows = db.query(async |c| queries::list_session_extras(c).await)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.session,
                Extra {
                    agent_session: r.agent_session,
                    base: r.base,
                    run: r.run,
                },
            )
        })
        .collect())
}

pub fn put_extra(db: &Sqlite<'_>, session: &str, e: &Extra) -> sqlx::Result<()> {
    let params = queries::PutSessionExtraParams {
        session: session.into(),
        agent_session: e.agent_session.clone(),
        base: e.base.clone(),
        run: e.run.clone(),
    };
    db.query(async |c| queries::put_session_extra(c, params).await)
}

pub fn remove_extra(db: &Sqlite<'_>, session: &str) -> sqlx::Result<()> {
    db.query(async |c| queries::delete_session_extra(c, queries::DeleteSessionExtraParams { session: session.into() }).await)
}

pub fn clear_run(db: &Sqlite<'_>, session: &str, run: &str) -> sqlx::Result<()> {
    db.query(async |c| {
        queries::clear_session_run(
            c,
            queries::ClearSessionRunParams {
                session: session.into(),
                run: Some(run.into()),
            },
        )
        .await
    })
}

pub fn active_run(db: &Sqlite<'_>, session: &str, run: &str, root: &str) -> sqlx::Result<bool> {
    let params = queries::FindActiveRunParams {
        session: session.into(),
        run: Some(run.into()),
        agent_session: Some(root.into()),
    };
    db.query(async |c| queries::find_active_run(c, params).await).map(|row| row.active > 0)
}

fn read_run(r: queries::GetRunRow) -> sqlx::Result<Run> {
    Ok(Run {
        id: r.id,
        session: r.session,
        issue: r.issue,
        summary: r.summary,
        started_at: r.started_at,
        ended_at: r.ended_at,
        triggered_by: read_json(r.triggered_by)?,
        heard: read_json(r.heard)?,
        outcome: r.outcome.map(read_word).transpose()?,
        spent: r.spent.map(read_json).transpose()?,
        subagents: r.subagents.map(read_json).transpose()?,
        needs_reconciliation: r.reconciliation.is_some(),
    })
}

pub fn run(db: &Sqlite<'_>, id: &str) -> sqlx::Result<Option<Run>> {
    optional(db.query(async |c| queries::get_run(c, queries::GetRunParams { id: id.into() }).await))?
        .map(read_run)
        .transpose()
}

pub fn runs(db: &Sqlite<'_>, issue: &str) -> sqlx::Result<Vec<Run>> {
    db.query(async |c| queries::list_runs(c, queries::ListRunsParams { issue: Some(issue.into()) }).await)?
        .into_iter()
        .map(read_run)
        .collect()
}

pub fn put_run(db: &Sqlite<'_>, r: &Run) -> sqlx::Result<()> {
    let params = queries::PutRunParams {
        id: r.id.clone(),
        session: r.session.clone(),
        issue: r.issue.clone(),
        summary: r.summary.clone(),
        started_at: r.started_at,
        ended_at: r.ended_at,
        triggered_by: json(&r.triggered_by)?,
        heard: json(&r.heard)?,
        outcome: r.outcome.as_ref().map(word).transpose()?,
        spent: r.spent.as_ref().map(json).transpose()?,
    };
    db.query(async |c| queries::put_run(c, params).await)
}

pub fn next(db: &Sqlite<'_>, name: &str, at_least: i64) -> sqlx::Result<i64> {
    db.query(async |c| {
        let last =
            optional(queries::read_session_counter(&mut *c, queries::ReadSessionCounterParams { name: name.into() }).await)?.map_or(0, |r| r.last_number);
        let next = last.max(at_least) + 1;
        queries::write_session_counter(
            c,
            queries::WriteSessionCounterParams {
                name: name.into(),
                last_number: next,
            },
        )
        .await?;
        Ok(next)
    })
}
