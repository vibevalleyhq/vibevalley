use super::sessions::Extra;
use crate::modules::infra::column::{json, optional, read_json, read_word, word};
use std::collections::HashMap;
use vibevalley_protocol::{Run, Session, SessionEvent, SessionPermissionMode, SessionSubagents};
use vibevalley_runtime::agent::durable::Sqlite;

use crate::db::generated::work_session as queries;

pub const SCHEMA: &str = crate::db::schema::WORK_SESSION;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionConfig {
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<SessionPermissionMode>,
}

pub fn put_subagents(db: &Sqlite<'_>, summary: &SessionSubagents) -> sqlx::Result<()> {
    let params = queries::PutSubagentsParams {
        id: summary.run.clone(),
        subagent_summary: Some(json(summary)?),
    };
    db.query(async |c| queries::put_subagents(c, params).await)
}

fn read(r: queries::ListSessionsRow) -> sqlx::Result<Session> {
    Ok(Session {
        id: r.id,
        controller: read_word(r.controller)?,
        role: r.role.map(read_word).transpose()?,
        name: r.name,
        profile: r.profile,
        runtime: r.runtime,
        brief: r.brief,
        cwd: r.cwd,
        policy: read_json(r.policy)?,
        bindings: read_json(r.bindings)?,
        hired_at: r.hired_at,
        runs: r.runs,
        last_run: r.last_run.map(read_json).transpose()?,
        spent: r.spent.map(read_json).transpose()?,
        subagents: r.subagents.map(read_json).transpose()?,
        tool_connections: r.tool_connections.map(read_json).transpose()?,
        machine: r.machine,
        phase: read_json(r.phase)?,
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
        controller: word(&s.controller)?,
        role: s.role.as_ref().map(word).transpose()?,
        name: s.name.clone(),
        profile: s.profile.clone(),
        runtime: s.runtime.clone(),
        brief: s.brief.clone(),
        cwd: s.cwd.clone(),
        policy: json(&s.policy)?,
        bindings: json(&s.bindings)?,
        hired_at: s.hired_at,
        runs: s.runs,
        last_run: s.last_run.as_ref().map(json).transpose()?,
        spent: s.spent.as_ref().map(json).transpose()?,
        tool_connections: s.tool_connections.as_ref().map(json).transpose()?,
        machine: s.machine.clone(),
        phase: json(&s.phase)?,
        departed: i64::from(departed),
    };
    db.query(async |c| queries::put_session(c, params).await)
}

pub fn config(db: &Sqlite<'_>, id: &str) -> sqlx::Result<Option<SessionConfig>> {
    optional(db.query(async |c| queries::get_session_config(c, queries::GetSessionConfigParams { id: id.into() }).await))?
        .map(|row| {
            Ok(SessionConfig {
                title: row.title,
                model: row.model,
                effort: row.effort,
                permission_mode: row.permission_mode.map(read_word).transpose()?,
            })
        })
        .transpose()
}

pub fn put_config(db: &Sqlite<'_>, id: &str, cfg: &SessionConfig) -> sqlx::Result<()> {
    let params = queries::PutSessionConfigParams {
        id: id.into(),
        title: cfg.title.clone(),
        model: cfg.model.clone(),
        effort: cfg.effort.clone(),
        permission_mode: cfg.permission_mode.as_ref().map(word).transpose()?,
    };
    db.query(async |c| queries::put_session_config(c, params).await)
}

pub async fn upsert_events(c: &mut sqlx::SqliteConnection, session_id: &str, events: &[SessionEvent]) -> sqlx::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    for e in events {
        let params = queries::UpsertSessionEventParams {
            session_id: session_id.to_string(),
            seq: e.seq,
            run_id: e.run.clone(),
            payload: json(e)?,
        };
        queries::upsert_session_event(&mut *c, params).await?;
    }
    Ok(())
}

pub async fn delete_events(c: &mut sqlx::SqliteConnection, session_id: &str) -> sqlx::Result<()> {
    queries::delete_session_events(
        c,
        queries::DeleteSessionEventsParams {
            session_id: session_id.to_string(),
        },
    )
    .await
}

pub async fn max_event_seq(c: &mut sqlx::SqliteConnection, session_id: &str) -> sqlx::Result<i64> {
    queries::max_session_event_seq(
        c,
        queries::MaxSessionEventSeqParams {
            session_id: session_id.to_string(),
        },
    )
    .await
    .map(|r| r.max_seq)
}

pub async fn list_events_tail(c: &mut sqlx::SqliteConnection, session_id: &str, run_id: &str, limit: i64) -> sqlx::Result<Vec<SessionEvent>> {
    let mut rows = queries::list_session_events_tail(
        c,
        queries::ListSessionEventsTailParams {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            limit,
        },
    )
    .await?
    .into_iter()
    .map(|r| read_json(r.payload))
    .collect::<sqlx::Result<Vec<_>>>()?;
    rows.reverse();
    Ok(rows)
}

pub async fn list_events_before(
    c: &mut sqlx::SqliteConnection,
    session_id: &str,
    run_id: &str,
    before_seq: i64,
    limit: i64,
) -> sqlx::Result<Vec<SessionEvent>> {
    let mut rows = queries::list_session_events_before(
        c,
        queries::ListSessionEventsBeforeParams {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            before_seq,
            limit,
        },
    )
    .await?
    .into_iter()
    .map(|r| read_json(r.payload))
    .collect::<sqlx::Result<Vec<_>>>()?;
    rows.reverse();
    Ok(rows)
}

pub async fn list_events_after(c: &mut sqlx::SqliteConnection, session_id: &str, run_id: &str, after_seq: i64, limit: i64) -> sqlx::Result<Vec<SessionEvent>> {
    queries::list_session_events_after(
        c,
        queries::ListSessionEventsAfterParams {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            after_seq,
            limit,
        },
    )
    .await?
    .into_iter()
    .map(|r| read_json(r.payload))
    .collect()
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
        id: session.into(),
        agent_session: e.agent_session.clone(),
        base: e.base.clone(),
        run: e.run.clone(),
    };
    db.query(async |c| queries::put_session_extra(c, params).await)
}

pub fn remove_extra(db: &Sqlite<'_>, session: &str) -> sqlx::Result<()> {
    db.query(async |c| queries::delete_session_extra(c, queries::DeleteSessionExtraParams { id: session.into() }).await)
}

pub fn clear_run(db: &Sqlite<'_>, session: &str, run: &str) -> sqlx::Result<()> {
    db.query(async |c| {
        queries::clear_session_run(
            c,
            queries::ClearSessionRunParams {
                id: session.into(),
                run: Some(run.into()),
            },
        )
        .await
    })
}

pub fn active_run(db: &Sqlite<'_>, session: &str, run: &str, root: &str) -> sqlx::Result<bool> {
    let params = queries::FindActiveRunParams {
        id: session.into(),
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
