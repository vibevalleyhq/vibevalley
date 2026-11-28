//! Dual-backend persistence for agent sessions (`session`), runs (`session_run`),
//! cursor-paged event trajectories (`session_event`), and durable delivery mailboxes (`session_mailbox`).

use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Condition, Expr, Func, OnConflict, Order, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Update,
};
use serde::{Deserialize, Serialize};
use vibevalley_core::{apply_session_telemetry, fold_session_telemetry};
use vibevalley_protocol::{Run, Session, SessionEvent, SessionPermissionMode, SessionSubagents, SessionTelemetry};

use super::{batch_chunk_rows, with_write_tx};
use crate::db::column::{db_json, db_word, read_db_json, read_db_word};
use crate::db::entity::{session, session_event, session_mailbox, session_run};
use crate::db::{Database, DbError, DbResult, Tx};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SessionConfig {
    pub(crate) title: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: Option<SessionPermissionMode>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionExtra {
    pub(crate) agent_session: Option<String>,
    pub(crate) base: Option<String>,
    #[serde(default)]
    pub(crate) run: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxSource {
    WorkspaceUser,
    ChannelDirect,
    ChannelOrchestrator,
    IssueComment,
    /// Durable passive context written for `wakes: false` deliveries; drained on next `wakes: true` turn.
    PassiveContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxStatus {
    Pending,
    Claimed,
    Done,
    Failed,
    Withdrawn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxEntry {
    pub id: i64,
    pub session_id: String,
    pub idempotency_key: String,
    pub source: MailboxSource,
    pub source_message_id: Option<String>,
    pub payload: String,
    pub status: MailboxStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub result: Option<String>,
}

#[derive(FromQueryResult)]
struct SessionQueryRow {
    id: String,
    controller: String,
    role: Option<String>,
    name: String,
    profile: Option<String>,
    runtime: String,
    brief: String,
    cwd: Option<String>,
    policy: String,
    bindings: String,
    hired_at: i64,
    runs: i64,
    last_run: Option<String>,
    spent: Option<String>,
    tool_connections: Option<String>,
    machine: Option<String>,
    phase: String,
}

#[derive(FromQueryResult)]
struct RunQueryRow {
    id: String,
    session: String,
    issue: Option<String>,
    triggered_by: String,
    heard: String,
    started_at: i64,
    ended_at: Option<i64>,
    outcome: Option<String>,
    summary: String,
    spent: Option<String>,
    subagents: Option<String>,
    needs_reconciliation: bool,
}

fn read_session(r: SessionQueryRow, subagents: Option<String>) -> DbResult<Session> {
    Ok(Session {
        id: r.id,
        controller: read_db_word(r.controller)?,
        role: r.role.map(read_db_word).transpose()?,
        name: r.name,
        profile: r.profile,
        runtime: r.runtime,
        brief: r.brief,
        cwd: r.cwd,
        policy: read_db_json(r.policy)?,
        bindings: read_db_json(r.bindings)?,
        hired_at: r.hired_at,
        runs: r.runs,
        last_run: r.last_run.map(read_db_json).transpose()?,
        spent: r.spent.map(read_db_json).transpose()?,
        subagents: subagents.map(read_db_json).transpose()?,
        tool_connections: r.tool_connections.map(read_db_json).transpose()?,
        telemetry: None,
        machine: r.machine,
        phase: read_db_json(r.phase)?,
    })
}

fn read_run(r: RunQueryRow) -> DbResult<Run> {
    Ok(Run {
        id: r.id,
        session: r.session,
        issue: r.issue,
        summary: r.summary,
        started_at: r.started_at,
        ended_at: r.ended_at,
        triggered_by: read_db_json(r.triggered_by)?,
        heard: read_db_json(r.heard)?,
        outcome: r.outcome.map(read_db_word).transpose()?,
        spent: r.spent.map(read_db_json).transpose()?,
        subagents: r.subagents.map(read_db_json).transpose()?,
        needs_reconciliation: r.needs_reconciliation,
    })
}

fn read_mailbox_row(r: session_mailbox::Model) -> DbResult<MailboxEntry> {
    Ok(MailboxEntry {
        id: r.id,
        session_id: r.session_id,
        idempotency_key: r.idempotency_key,
        source: read_db_word(r.source)?,
        source_message_id: r.source_message_id,
        payload: r.payload,
        status: read_db_word(r.status)?,
        created_at: r.created_at,
        updated_at: r.updated_at,
        result: r.result,
    })
}

fn session_select(departed: bool, id: Option<&str>) -> SelectStatement {
    let mut q = Query::select();
    q.columns([
        (session::Entity, session::Column::Id),
        (session::Entity, session::Column::Controller),
        (session::Entity, session::Column::Role),
        (session::Entity, session::Column::Name),
        (session::Entity, session::Column::Profile),
        (session::Entity, session::Column::Runtime),
        (session::Entity, session::Column::Brief),
        (session::Entity, session::Column::Cwd),
        (session::Entity, session::Column::Policy),
        (session::Entity, session::Column::Bindings),
        (session::Entity, session::Column::HiredAt),
        (session::Entity, session::Column::Runs),
        (session::Entity, session::Column::LastRun),
        (session::Entity, session::Column::Spent),
        (session::Entity, session::Column::ToolConnections),
        (session::Entity, session::Column::Machine),
        (session::Entity, session::Column::Phase),
    ])
    .from(session::Entity)
    .and_where(Expr::col((session::Entity, session::Column::Departed)).eq(departed));

    if let Some(id) = id {
        q.and_where(Expr::col((session::Entity, session::Column::Id)).eq(id));
    } else {
        q.order_by((session::Entity, session::Column::HiredAt), Order::Asc)
            .order_by((session::Entity, session::Column::Id), Order::Asc);
    }
    q
}

async fn latest_subagents_for_sessions_impl<C: ConnectionTrait>(db: &C, ids: &[String]) -> DbResult<HashMap<String, String>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    if ids.len() == 1 {
        let stmt = Query::select()
            .column(session_run::Column::SubagentSummary)
            .from(session_run::Entity)
            .and_where(session_run::Column::Session.eq(ids[0].as_str()))
            .order_by(session_run::Column::StartedAt, Order::Desc)
            .order_by_expr(Expr::expr(Func::char_length(Expr::col(session_run::Column::Id))), Order::Desc)
            .order_by(session_run::Column::Id, Order::Desc)
            .limit(1)
            .to_owned();
        let mut out = HashMap::new();
        if let Some(row) = db.query_one(&stmt).await?
            && let Some(summary) = row.try_get::<Option<String>>("", "subagent_summary")?
        {
            out.insert(ids[0].clone(), summary);
        }
        return Ok(out);
    }

    let mut out = HashMap::new();
    for chunk in ids.chunks(super::MAX_SQL_BIND_PARAMS) {
        let ranked = Alias::new("ranked");
        let inner = Query::select()
            .column(session_run::Column::Session)
            .column(session_run::Column::SubagentSummary)
            .expr_as(
                Expr::cust("ROW_NUMBER() OVER (PARTITION BY session ORDER BY started_at DESC, LENGTH(id) DESC, id DESC)"),
                "rn",
            )
            .from(session_run::Entity)
            .and_where(session_run::Column::Session.is_in(chunk.iter().cloned()))
            .to_owned();
        let stmt = Query::select()
            .column((ranked.clone(), Alias::new("session")))
            .column((ranked.clone(), Alias::new("subagent_summary")))
            .from_subquery(inner, ranked.clone())
            .and_where(Expr::col((ranked.clone(), Alias::new("rn"))).eq(1i64))
            .and_where(Expr::col((ranked, Alias::new("subagent_summary"))).is_not_null())
            .to_owned();
        for row in db.query_all(&stmt).await? {
            let session_id: String = row.try_get("", "session")?;
            let summary: String = row.try_get("", "subagent_summary")?;
            out.insert(session_id, summary);
        }
    }
    Ok(out)
}

fn run_select() -> SelectStatement {
    let r_alias = Alias::new("r");
    let mut q = Query::select();
    q.columns([
        (r_alias.clone(), session_run::Column::Id),
        (r_alias.clone(), session_run::Column::Session),
        (r_alias.clone(), session_run::Column::Issue),
        (r_alias.clone(), session_run::Column::TriggeredBy),
        (r_alias.clone(), session_run::Column::Heard),
        (r_alias.clone(), session_run::Column::StartedAt),
        (r_alias.clone(), session_run::Column::EndedAt),
        (r_alias.clone(), session_run::Column::Outcome),
        (r_alias.clone(), session_run::Column::Summary),
        (r_alias.clone(), session_run::Column::Spent),
    ])
    .expr_as(Expr::col((r_alias.clone(), session_run::Column::SubagentSummary)), Alias::new("subagents"))
    .column((r_alias.clone(), session_run::Column::NeedsReconciliation))
    .from_as(session_run::Entity, r_alias);
    q
}

fn event_payload_query(session_id: &str, run_id: &str) -> sea_orm::Select<session_event::Entity> {
    let mut query = session_event::Entity::find()
        .select_only()
        .column(session_event::Column::Payload)
        .filter(session_event::Column::SessionId.eq(session_id));
    if !run_id.is_empty() {
        query = query.filter(session_event::Column::RunId.eq(run_id));
    }
    query
}

async fn all_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<Session>> {
    let stmt = session_select(false, None);
    let rows = db.query_all(&stmt).await?;
    let parsed: Vec<SessionQueryRow> = rows
        .into_iter()
        .map(|row| SessionQueryRow::from_query_result(&row, "").map_err(DbError::from))
        .collect::<DbResult<_>>()?;
    let ids: Vec<String> = parsed.iter().map(|row| row.id.clone()).collect();
    let mut subagents = latest_subagents_for_sessions_impl(db, &ids).await?;
    parsed
        .into_iter()
        .map(|row| {
            let sub = subagents.remove(&row.id);
            read_session(row, sub)
        })
        .collect()
}

async fn find_by_departed_impl<C: ConnectionTrait>(db: &C, id: &str, departed: bool) -> DbResult<Option<Session>> {
    let stmt = session_select(departed, Some(id));
    let Some(row) = db.query_one(&stmt).await? else {
        return Ok(None);
    };
    let parsed = SessionQueryRow::from_query_result(&row, "").map_err(DbError::from)?;
    let mut subagents = latest_subagents_for_sessions_impl(db, std::slice::from_ref(&parsed.id)).await?;
    let sub = subagents.remove(&parsed.id);
    read_session(parsed, sub).map(Some)
}

async fn put_impl<C: ConnectionTrait>(db: &C, s: &Session, departed: bool) -> DbResult<()> {
    let model = session::ActiveModel {
        id: Set(s.id.clone()),
        controller: Set(db_word(&s.controller)?),
        role: Set(s.role.as_ref().map(db_word).transpose()?),
        name: Set(s.name.clone()),
        profile: Set(s.profile.clone()),
        runtime: Set(s.runtime.clone()),
        brief: Set(s.brief.clone()),
        cwd: Set(s.cwd.clone()),
        policy: Set(db_json(&s.policy)?),
        bindings: Set(db_json(&s.bindings)?),
        hired_at: Set(s.hired_at),
        runs: Set(s.runs),
        last_run: Set(s.last_run.as_ref().map(db_json).transpose()?),
        spent: Set(s.spent.as_ref().map(db_json).transpose()?),
        tool_connections: Set(s.tool_connections.as_ref().map(db_json).transpose()?),
        machine: Set(s.machine.clone()),
        phase: Set(db_json(&s.phase)?),
        departed: Set(departed),
        ..Default::default()
    };
    let on_conflict = OnConflict::column(session::Column::Id)
        .update_columns([
            session::Column::Controller,
            session::Column::Role,
            session::Column::Name,
            session::Column::Profile,
            session::Column::Runtime,
            session::Column::Brief,
            session::Column::Cwd,
            session::Column::Policy,
            session::Column::Bindings,
            session::Column::HiredAt,
            session::Column::Runs,
            session::Column::LastRun,
            session::Column::Spent,
            session::Column::ToolConnections,
            session::Column::Machine,
            session::Column::Phase,
            session::Column::Departed,
        ])
        .to_owned();
    session::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

async fn put_subagents_impl<C: ConnectionTrait>(db: &C, summary: &SessionSubagents) -> DbResult<()> {
    Update::many(session_run::Entity)
        .col_expr(session_run::Column::SubagentSummary, Expr::value(Some(db_json(summary)?)))
        .filter(session_run::Column::Id.eq(&summary.run))
        .exec(db)
        .await?;
    Ok(())
}

#[cfg(test)]
async fn config_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<SessionConfig>> {
    let row = session::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            session::Column::Title,
            session::Column::Model,
            session::Column::Effort,
            session::Column::PermissionMode,
        ])
        .into_tuple::<(Option<String>, Option<String>, Option<String>, Option<String>)>()
        .one(db)
        .await?;
    row.map(|(title, model, effort, permission_mode)| {
        Ok(SessionConfig {
            title,
            model,
            effort,
            permission_mode: permission_mode.map(read_db_word).transpose()?,
        })
    })
    .transpose()
}

async fn configs_impl<C: ConnectionTrait>(db: &C) -> DbResult<HashMap<String, SessionConfig>> {
    let rows = session::Entity::find()
        .select_only()
        .columns([
            session::Column::Id,
            session::Column::Title,
            session::Column::Model,
            session::Column::Effort,
            session::Column::PermissionMode,
        ])
        .into_tuple::<(String, Option<String>, Option<String>, Option<String>, Option<String>)>()
        .all(db)
        .await?;
    let mut out = HashMap::new();
    for (id, title, model, effort, permission_mode) in rows {
        if title.is_some() || model.is_some() || effort.is_some() || permission_mode.is_some() {
            out.insert(
                id,
                SessionConfig {
                    title,
                    model,
                    effort,
                    permission_mode: permission_mode.map(read_db_word).transpose()?,
                },
            );
        }
    }
    Ok(out)
}

async fn put_config_impl<C: ConnectionTrait>(db: &C, id: &str, cfg: &SessionConfig) -> DbResult<()> {
    let permission_mode = cfg.permission_mode.as_ref().map(db_word).transpose()?;
    Update::many(session::Entity)
        .col_expr(session::Column::Title, Expr::value(cfg.title.clone()))
        .col_expr(session::Column::Model, Expr::value(cfg.model.clone()))
        .col_expr(session::Column::Effort, Expr::value(cfg.effort.clone()))
        .col_expr(session::Column::PermissionMode, Expr::value(permission_mode))
        .filter(session::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn extras_impl<C: ConnectionTrait>(db: &C) -> DbResult<HashMap<String, SessionExtra>> {
    let rows = session::Entity::find()
        .select_only()
        .columns([session::Column::Id, session::Column::AgentSession, session::Column::Base, session::Column::Run])
        .filter(
            Condition::any()
                .add(session::Column::AgentSession.is_not_null())
                .add(session::Column::Base.is_not_null())
                .add(session::Column::Run.is_not_null()),
        )
        .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, agent_session, base, run)| (id, SessionExtra { agent_session, base, run }))
        .collect())
}

async fn put_extra_impl<C: ConnectionTrait>(db: &C, session_id: &str, extra: &SessionExtra) -> DbResult<()> {
    Update::many(session::Entity)
        .col_expr(session::Column::AgentSession, Expr::value(extra.agent_session.clone()))
        .col_expr(session::Column::Base, Expr::value(extra.base.clone()))
        .col_expr(session::Column::Run, Expr::value(extra.run.clone()))
        .filter(session::Column::Id.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

async fn remove_extra_impl<C: ConnectionTrait>(db: &C, session_id: &str) -> DbResult<()> {
    Update::many(session::Entity)
        .col_expr(session::Column::AgentSession, Expr::value(Option::<String>::None))
        .col_expr(session::Column::Base, Expr::value(Option::<String>::None))
        .col_expr(session::Column::Run, Expr::value(Option::<String>::None))
        .filter(session::Column::Id.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

async fn clear_run_impl<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str) -> DbResult<()> {
    Update::many(session::Entity)
        .col_expr(session::Column::Run, Expr::value(Option::<String>::None))
        .filter(session::Column::Id.eq(session_id))
        .filter(session::Column::Run.eq(run_id))
        .exec(db)
        .await?;
    Ok(())
}

async fn active_run_impl<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str, root: &str) -> DbResult<bool> {
    let count = session::Entity::find()
        .filter(session::Column::Id.eq(session_id))
        .filter(session::Column::Run.eq(run_id))
        .filter(session::Column::AgentSession.eq(root))
        .count(db)
        .await?;
    Ok(count > 0)
}

async fn run_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<Run>> {
    let mut stmt = run_select();
    stmt.and_where(Expr::col((Alias::new("r"), session_run::Column::Id)).eq(id));
    db.query_one(&stmt)
        .await?
        .map(|row| RunQueryRow::from_query_result(&row, "").map_err(DbError::from).and_then(read_run))
        .transpose()
}

async fn runs_impl<C: ConnectionTrait>(db: &C, issue: &str) -> DbResult<Vec<Run>> {
    let r_alias = Alias::new("r");
    let mut stmt = run_select();
    stmt.and_where(Expr::col((r_alias.clone(), session_run::Column::Issue)).eq(issue))
        .order_by((r_alias.clone(), session_run::Column::StartedAt), Order::Asc)
        .order_by_expr(Expr::expr(Func::char_length(Expr::col((r_alias.clone(), session_run::Column::Id)))), Order::Asc)
        .order_by((r_alias, session_run::Column::Id), Order::Asc);
    db.query_all(&stmt)
        .await?
        .into_iter()
        .map(|row| RunQueryRow::from_query_result(&row, "").map_err(DbError::from).and_then(read_run))
        .collect()
}

async fn put_run_impl<C: ConnectionTrait>(db: &C, r: &Run) -> DbResult<()> {
    let model = session_run::ActiveModel {
        id: Set(r.id.clone()),
        session: Set(r.session.clone()),
        issue: Set(r.issue.clone()),
        triggered_by: Set(db_json(&r.triggered_by)?),
        heard: Set(db_json(&r.heard)?),
        started_at: Set(r.started_at),
        ended_at: Set(r.ended_at),
        outcome: Set(r.outcome.as_ref().map(db_word).transpose()?),
        summary: Set(r.summary.clone()),
        spent: Set(r.spent.as_ref().map(db_json).transpose()?),
        needs_reconciliation: Set(r.needs_reconciliation),
        ..Default::default()
    };
    let on_conflict = OnConflict::column(session_run::Column::Id)
        .update_columns([
            session_run::Column::Session,
            session_run::Column::Issue,
            session_run::Column::TriggeredBy,
            session_run::Column::Heard,
            session_run::Column::StartedAt,
            session_run::Column::EndedAt,
            session_run::Column::Outcome,
            session_run::Column::Summary,
            session_run::Column::Spent,
            session_run::Column::NeedsReconciliation,
        ])
        .to_owned();
    session_run::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

const SESSION_EVENT_BATCH_ROWS: usize = batch_chunk_rows(5);
const TELEMETRY_EVENT_TYPES: [&str; 3] = ["llm/usage", "llm/retry", "run/error"];

async fn upsert_events_batch_impl<C: ConnectionTrait>(db: &C, writes: &[(String, Vec<SessionEvent>)]) -> DbResult<()> {
    let total_events: usize = writes.iter().map(|(_, events)| events.len()).sum();
    if total_events == 0 {
        return Ok(());
    }

    // Deduplicate `(session_id, seq)` within a batch while preserving `COALESCE(excluded.run_id, existing.run_id)`
    // semantics so PostgreSQL never hits "ON CONFLICT DO UPDATE command cannot affect row a second time".
    let mut index_by_key: HashMap<(&str, i64), usize> = HashMap::with_capacity(total_events);
    let mut rows: Vec<(&str, i64, Option<String>, String, String)> = Vec::with_capacity(total_events);
    for (session_id, events) in writes {
        for e in events {
            let event_type = db_word(&e.r#type)?;
            let payload = db_json(e)?;
            let key = (session_id.as_str(), e.seq);
            if let Some(&idx) = index_by_key.get(&key) {
                let existing = &mut rows[idx];
                if e.run.is_some() {
                    existing.2 = e.run.clone();
                }
                existing.3 = event_type;
                existing.4 = payload;
            } else {
                index_by_key.insert(key, rows.len());
                rows.push((session_id.as_str(), e.seq, e.run.clone(), event_type, payload));
            }
        }
    }

    let on_conflict = OnConflict::columns([session_event::Column::SessionId, session_event::Column::Seq])
        .value(
            session_event::Column::RunId,
            Expr::expr(Func::coalesce([
                Expr::col((Alias::new("excluded"), session_event::Column::RunId)),
                Expr::col((session_event::Entity, session_event::Column::RunId)),
            ])),
        )
        .update_columns([session_event::Column::EventType, session_event::Column::Payload])
        .to_owned();

    let mut iter = rows
        .into_iter()
        .map(|(session_id, seq, run_id, event_type, payload)| session_event::ActiveModel {
            session_id: Set(session_id.to_owned()),
            seq: Set(seq),
            run_id: Set(run_id),
            event_type: Set(Some(event_type)),
            payload: Set(payload),
        });
    loop {
        let chunk: Vec<session_event::ActiveModel> = iter.by_ref().take(SESSION_EVENT_BATCH_ROWS).collect();
        if chunk.is_empty() {
            break;
        }
        session_event::Entity::insert_many(chunk)
            .on_conflict(on_conflict.clone())
            .exec_without_returning(db)
            .await?;
    }
    Ok(())
}

async fn delete_events_impl<C: ConnectionTrait>(db: &C, session_id: &str) -> DbResult<()> {
    session_event::Entity::delete_many()
        .filter(session_event::Column::SessionId.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

async fn enqueue_mailbox_impl<C: ConnectionTrait>(
    db: &C,
    session_id: &str,
    idempotency_key: &str,
    source: MailboxSource,
    source_message_id: Option<&str>,
    payload: &str,
    at: i64,
) -> DbResult<MailboxEntry> {
    let model = session_mailbox::ActiveModel {
        session_id: Set(session_id.to_owned()),
        idempotency_key: Set(idempotency_key.to_owned()),
        source: Set(db_word(&source)?),
        source_message_id: Set(source_message_id.map(str::to_owned)),
        payload: Set(payload.to_owned()),
        status: Set("pending".to_owned()),
        created_at: Set(at),
        updated_at: Set(at),
        result: Set(None),
        ..Default::default()
    };
    session_mailbox::Entity::insert(model)
        .on_conflict_do_nothing_on([session_mailbox::Column::IdempotencyKey])
        .exec(db)
        .await?;
    let row = session_mailbox::Entity::find()
        .filter(session_mailbox::Column::IdempotencyKey.eq(idempotency_key))
        .one(db)
        .await?
        .ok_or_else(|| DbError::not_found(format!("mailbox entry {idempotency_key} missing")))?;
    read_mailbox_row(row)
}

async fn transition_mailbox_by_key_impl<C: ConnectionTrait>(db: &C, idempotency_key: &str, to_status: &str, at: i64) -> DbResult<bool> {
    let res = Update::many(session_mailbox::Entity)
        .col_expr(session_mailbox::Column::Status, Expr::value(to_status))
        .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
        .filter(session_mailbox::Column::IdempotencyKey.eq(idempotency_key))
        .filter(session_mailbox::Column::Status.eq("pending"))
        .exec(db)
        .await?;
    Ok(res.rows_affected > 0)
}

async fn withdraw_mailbox_by_message_impl<C: ConnectionTrait>(db: &C, message_id: &str, at: i64) -> DbResult<u64> {
    let res = Update::many(session_mailbox::Entity)
        .col_expr(session_mailbox::Column::Status, Expr::value("withdrawn"))
        .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
        .filter(session_mailbox::Column::SourceMessageId.eq(message_id))
        .filter(session_mailbox::Column::Status.eq("pending"))
        .exec(db)
        .await?;
    Ok(res.rows_affected)
}

async fn claim_next_mailbox_impl<C: ConnectionTrait>(db: &C, session_id: &str, at: i64) -> DbResult<Option<MailboxEntry>> {
    let next_id_subquery = Query::select()
        .column(session_mailbox::Column::Id)
        .from(session_mailbox::Entity)
        .and_where(session_mailbox::Column::SessionId.eq(session_id))
        .and_where(session_mailbox::Column::Status.eq("pending"))
        .order_by(session_mailbox::Column::Id, Order::Asc)
        .limit(1)
        .to_owned();
    let rows = Update::many(session_mailbox::Entity)
        .col_expr(session_mailbox::Column::Status, Expr::value("claimed"))
        .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
        .filter(session_mailbox::Column::Id.in_subquery(next_id_subquery))
        .filter(session_mailbox::Column::Status.eq("pending"))
        .exec_with_returning(db)
        .await?;
    rows.into_iter().next().map(read_mailbox_row).transpose()
}

async fn settle_mailbox_impl<C: ConnectionTrait>(db: &C, id: i64, ok: bool, result: Option<&str>, at: i64) -> DbResult<()> {
    let status = db_word(&if ok { MailboxStatus::Done } else { MailboxStatus::Failed })?;
    Update::many(session_mailbox::Entity)
        .col_expr(session_mailbox::Column::Status, Expr::value(status))
        .col_expr(session_mailbox::Column::Result, Expr::value(result.map(str::to_owned)))
        .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
        .filter(session_mailbox::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

async fn list_mailbox_impl<C: ConnectionTrait>(db: &C, session_id: &str) -> DbResult<Vec<MailboxEntry>> {
    session_mailbox::Entity::find()
        .filter(session_mailbox::Column::SessionId.eq(session_id))
        .order_by_asc(session_mailbox::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(read_mailbox_row)
        .collect()
}

async fn drain_passive_context_impl<C: ConnectionTrait>(db: &C, session_id: &str, at: i64) -> DbResult<Vec<MailboxEntry>> {
    let source = db_word(&MailboxSource::PassiveContext)?;
    let mut rows = Update::many(session_mailbox::Entity)
        .col_expr(session_mailbox::Column::Status, Expr::value("done"))
        .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
        .filter(session_mailbox::Column::SessionId.eq(session_id))
        .filter(session_mailbox::Column::Source.eq(source))
        .filter(session_mailbox::Column::Status.eq("pending"))
        .exec_with_returning(db)
        .await?;
    rows.sort_by_key(|r| r.id);
    rows.into_iter().map(read_mailbox_row).collect()
}

#[derive(Clone)]
pub(crate) struct SessionService {
    db: Arc<Database>,
}

impl SessionService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn all(&self) -> DbResult<Vec<Session>> {
        all_impl(self.db.read_conn()).await
    }

    pub(super) async fn all_in_tx(&self, tx: &Tx) -> DbResult<Vec<Session>> {
        all_impl(tx).await
    }

    pub(crate) async fn get(&self, id: &str) -> DbResult<Option<Session>> {
        find_by_departed_impl(self.db.read_conn(), id, false).await
    }

    pub(crate) async fn get_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<Session>> {
        find_by_departed_impl(tx, id, false).await
    }

    pub(crate) async fn past(&self, id: &str) -> DbResult<Option<Session>> {
        find_by_departed_impl(self.db.read_conn(), id, true).await
    }

    #[cfg(any(test, feature = "fake"))]
    pub(crate) async fn put(&self, session: &Session, departed: bool) -> DbResult<()> {
        put_impl(self.db.write_conn(), session, departed).await
    }

    pub(crate) async fn put_in_tx(&self, tx: &Tx, session: &Session, departed: bool) -> DbResult<()> {
        put_impl(tx, session, departed).await
    }

    pub(crate) async fn put_subagents_in_tx(&self, tx: &Tx, summary: &SessionSubagents) -> DbResult<()> {
        put_subagents_impl(tx, summary).await
    }

    #[cfg(test)]
    pub(crate) async fn config(&self, id: &str) -> DbResult<Option<SessionConfig>> {
        config_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn configs(&self) -> DbResult<HashMap<String, SessionConfig>> {
        configs_impl(self.db.read_conn()).await
    }

    pub(crate) async fn put_config(&self, id: &str, cfg: &SessionConfig) -> DbResult<()> {
        put_config_impl(self.db.write_conn(), id, cfg).await
    }

    pub(crate) async fn extras(&self) -> DbResult<HashMap<String, SessionExtra>> {
        extras_impl(self.db.read_conn()).await
    }

    pub(crate) async fn extras_in_tx(&self, tx: &Tx) -> DbResult<HashMap<String, SessionExtra>> {
        extras_impl(tx).await
    }

    pub(crate) async fn put_extra(&self, session_id: &str, extra: &SessionExtra) -> DbResult<()> {
        put_extra_impl(self.db.write_conn(), session_id, extra).await
    }

    pub(crate) async fn put_extra_in_tx(&self, tx: &Tx, session_id: &str, extra: &SessionExtra) -> DbResult<()> {
        put_extra_impl(tx, session_id, extra).await
    }

    pub(crate) async fn remove_extra(&self, session_id: &str) -> DbResult<()> {
        remove_extra_impl(self.db.write_conn(), session_id).await
    }

    pub(crate) async fn remove_extra_in_tx(&self, tx: &Tx, session_id: &str) -> DbResult<()> {
        remove_extra_impl(tx, session_id).await
    }

    pub(crate) async fn clear_run_in_tx(&self, tx: &Tx, session_id: &str, run_id: &str) -> DbResult<()> {
        clear_run_impl(tx, session_id, run_id).await
    }

    pub(crate) async fn active_run_in_tx(&self, tx: &Tx, session_id: &str, run_id: &str, root: &str) -> DbResult<bool> {
        active_run_impl(tx, session_id, run_id, root).await
    }

    pub(crate) async fn run(&self, id: &str) -> DbResult<Option<Run>> {
        run_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn run_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<Run>> {
        run_impl(tx, id).await
    }

    pub(crate) async fn runs(&self, issue_id: &str) -> DbResult<Vec<Run>> {
        runs_impl(self.db.read_conn(), issue_id).await
    }

    pub(crate) async fn put_run_in_tx(&self, tx: &Tx, run: &Run) -> DbResult<()> {
        put_run_impl(tx, run).await
    }

    /// Atomically persists batched dirty events across multiple sessions in one write transaction.
    pub(crate) async fn upsert_events_batch(&self, writes: &[(String, Vec<SessionEvent>)]) -> DbResult<()> {
        if writes.iter().all(|(_, events)| events.is_empty()) {
            return Ok(());
        }
        with_write_tx(&self.db, async |tx| upsert_events_batch_impl(tx, writes).await).await
    }

    pub(crate) async fn delete_events(&self, session_id: &str) -> DbResult<()> {
        delete_events_impl(self.db.write_conn(), session_id).await
    }

    pub(crate) async fn max_event_seq(&self, session_id: &str) -> DbResult<i64> {
        let row = session_event::Entity::find()
            .select_only()
            .expr_as(Func::coalesce([Expr::col(session_event::Column::Seq).max(), Expr::val(-1i64)]), "max_seq")
            .filter(session_event::Column::SessionId.eq(session_id))
            .into_tuple::<i64>()
            .one(self.db.read_conn())
            .await?;
        Ok(row.unwrap_or(-1))
    }

    async fn list_events_desc(&self, session_id: &str, run_id: &str, before_seq: Option<i64>, limit: i64) -> DbResult<Vec<SessionEvent>> {
        let mut query = event_payload_query(session_id, run_id);
        if let Some(seq) = before_seq {
            query = query.filter(session_event::Column::Seq.lt(seq));
        }
        let mut rows = query
            .order_by_desc(session_event::Column::Seq)
            .limit(u64::try_from(limit).unwrap_or(0))
            .into_tuple::<String>()
            .all(self.db.read_conn())
            .await?
            .into_iter()
            .map(read_db_json)
            .collect::<DbResult<Vec<_>>>()?;
        rows.reverse();
        Ok(rows)
    }

    pub(crate) async fn list_events_tail(&self, session_id: &str, run_id: &str, limit: i64) -> DbResult<Vec<SessionEvent>> {
        self.list_events_desc(session_id, run_id, None, limit).await
    }

    pub(crate) async fn list_events_before(&self, session_id: &str, run_id: &str, before_seq: i64, limit: i64) -> DbResult<Vec<SessionEvent>> {
        self.list_events_desc(session_id, run_id, Some(before_seq), limit).await
    }

    pub(crate) async fn list_events_after(&self, session_id: &str, run_id: &str, after_seq: i64, limit: i64) -> DbResult<Vec<SessionEvent>> {
        event_payload_query(session_id, run_id)
            .filter(session_event::Column::Seq.gt(after_seq))
            .order_by_asc(session_event::Column::Seq)
            .limit(u64::try_from(limit).unwrap_or(0))
            .into_tuple::<String>()
            .all(self.db.read_conn())
            .await?
            .into_iter()
            .map(read_db_json)
            .collect()
    }

    pub(crate) async fn telemetry_for_session(&self, session_id: &str) -> DbResult<Option<SessionTelemetry>> {
        let rows = self
            .db
            .query_metrics()
            .observe(
                "session.telemetry_for_session",
                "SELECT payload FROM session_event WHERE session_id = ? AND event_type IN (...)",
                session_event::Entity::find()
                    .select_only()
                    .column(session_event::Column::Payload)
                    .filter(session_event::Column::SessionId.eq(session_id))
                    .filter(session_event::Column::EventType.is_in(TELEMETRY_EVENT_TYPES))
                    .order_by_asc(session_event::Column::Seq)
                    .into_tuple::<String>()
                    .all(self.db.read_conn()),
            )
            .await?;
        let events = rows.into_iter().map(read_db_json).collect::<DbResult<Vec<SessionEvent>>>()?;
        Ok(fold_session_telemetry(&events))
    }

    pub(crate) async fn telemetry_by_session(&self) -> DbResult<HashMap<String, SessionTelemetry>> {
        let active_ids = Query::select()
            .column(session::Column::Id)
            .from(session::Entity)
            .and_where(Expr::col(session::Column::Departed).eq(false))
            .to_owned();
        let rows = self
            .db
            .query_metrics()
            .observe(
                "session.telemetry_by_session",
                "SELECT session_id, payload FROM session_event WHERE event_type IN (...)",
                session_event::Entity::find()
                    .select_only()
                    .columns([session_event::Column::SessionId, session_event::Column::Payload])
                    .filter(session_event::Column::SessionId.in_subquery(active_ids))
                    .filter(session_event::Column::EventType.is_in(TELEMETRY_EVENT_TYPES))
                    .order_by_asc(session_event::Column::SessionId)
                    .order_by_asc(session_event::Column::Seq)
                    .into_tuple::<(String, String)>()
                    .all(self.db.read_conn()),
            )
            .await?;

        let mut out: HashMap<String, SessionTelemetry> = HashMap::new();
        for (session_id, payload) in rows {
            let event: SessionEvent = read_db_json(payload)?;
            let mut candidate = out.get(&session_id).cloned().unwrap_or_default();
            if apply_session_telemetry(&mut candidate, &event) {
                out.insert(session_id, candidate);
            }
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn enqueue_mailbox(
        &self,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
        at: i64,
    ) -> DbResult<MailboxEntry> {
        enqueue_mailbox_impl(self.db.write_conn(), session_id, idempotency_key, source, source_message_id, payload, at).await
    }

    pub(crate) async fn withdraw_mailbox(&self, idempotency_key: &str, at: i64) -> DbResult<bool> {
        transition_mailbox_by_key_impl(self.db.write_conn(), idempotency_key, "withdrawn", at).await
    }

    pub(crate) async fn withdraw_mailbox_by_message(&self, message_id: &str, at: i64) -> DbResult<u64> {
        withdraw_mailbox_by_message_impl(self.db.write_conn(), message_id, at).await
    }

    pub(crate) async fn claim_next_mailbox(&self, session_id: &str, at: i64) -> DbResult<Option<MailboxEntry>> {
        claim_next_mailbox_impl(self.db.write_conn(), session_id, at).await
    }

    pub(crate) async fn claim_mailbox_by_key(&self, idempotency_key: &str, at: i64) -> DbResult<bool> {
        transition_mailbox_by_key_impl(self.db.write_conn(), idempotency_key, "claimed", at).await
    }

    pub(crate) async fn settle_mailbox(&self, id: i64, ok: bool, result: Option<&str>, at: i64) -> DbResult<()> {
        settle_mailbox_impl(self.db.write_conn(), id, ok, result, at).await
    }

    pub(crate) async fn list_mailbox(&self, session_id: &str) -> DbResult<Vec<MailboxEntry>> {
        list_mailbox_impl(self.db.read_conn(), session_id).await
    }

    pub(crate) async fn drain_passive_context(&self, session_id: &str, at: i64) -> DbResult<Vec<MailboxEntry>> {
        drain_passive_context_impl(self.db.write_conn(), session_id, at).await
    }

    /// Deletes up to `limit` settled mailbox rows (`status NOT IN ('pending', 'claimed')` and `updated_at < before_ms`).
    pub(crate) async fn prune_settled_mailbox_batch(&self, before_ms: i64, limit: u64) -> DbResult<u64> {
        if limit == 0 {
            return Ok(0);
        }
        with_write_tx(&self.db, async |tx| {
            let ids: Vec<i64> = session_mailbox::Entity::find()
                .select_only()
                .column(session_mailbox::Column::Id)
                .filter(session_mailbox::Column::Status.is_not_in(["pending", "claimed"]))
                .filter(session_mailbox::Column::UpdatedAt.lt(before_ms))
                .order_by_asc(session_mailbox::Column::Id)
                .limit(limit)
                .into_tuple()
                .all(tx)
                .await?;
            if ids.is_empty() {
                return Ok(0);
            }
            let mut deleted = 0u64;
            for chunk in ids.chunks(super::MAX_SQL_BIND_PARAMS) {
                let res = session_mailbox::Entity::delete_many()
                    .filter(session_mailbox::Column::Id.is_in(chunk.iter().copied()))
                    .exec(tx)
                    .await?;
                deleted += res.rows_affected;
            }
            Ok(deleted)
        })
        .await
    }

    pub(crate) async fn helper_modes(&self) -> DbResult<HashMap<String, String>> {
        let rows = session::Entity::find()
            .select_only()
            .columns([session::Column::Id, session::Column::HelperMode])
            .filter(session::Column::HelperMode.is_not_null())
            .into_tuple::<(String, Option<String>)>()
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().filter_map(|(id, mode)| mode.map(|m| (id, m))).collect())
    }

    pub(crate) async fn helper_mode(&self, session_id: &str) -> DbResult<Option<String>> {
        let row = session::Entity::find_by_id(session_id.to_owned())
            .select_only()
            .column(session::Column::HelperMode)
            .into_tuple::<Option<String>>()
            .one(self.db.read_conn())
            .await?;
        Ok(row.flatten())
    }

    pub(crate) async fn put_helper_mode_in_tx(&self, tx: &Tx, session_id: &str, mode: Option<&str>) -> DbResult<()> {
        super::update_col_by_id::<session::Entity, _, _>(tx, session::Column::Id, session_id, session::Column::HelperMode, mode.map(str::to_owned)).await
    }

    /// Deletes up to `limit` historical `session_event` rows for departed sessions whose
    /// most recent activity (`MAX(session_run.ended_at)` or `session.hired_at`) is `< before_ms`.
    pub(crate) async fn prune_departed_events_batch(&self, before_ms: i64, limit: u64) -> DbResult<u64> {
        if limit == 0 {
            return Ok(0);
        }
        with_write_tx(&self.db, async |tx| {
            let departed: Vec<(String, i64)> = session::Entity::find()
                .select_only()
                .columns([session::Column::Id, session::Column::HiredAt])
                .filter(session::Column::Departed.eq(true))
                .into_tuple()
                .all(tx)
                .await?;
            if departed.is_empty() {
                return Ok(0);
            }
            let departed_ids: Vec<String> = departed.iter().map(|(id, _)| id.clone()).collect();
            let mut latest_ended: HashMap<String, i64> = HashMap::new();
            for chunk in departed_ids.chunks(super::MAX_SQL_BIND_PARAMS) {
                let runs: Vec<(String, Option<i64>, i64)> = session_run::Entity::find()
                    .select_only()
                    .columns([session_run::Column::Session, session_run::Column::EndedAt, session_run::Column::StartedAt])
                    .filter(session_run::Column::Session.is_in(chunk.iter().cloned()))
                    .into_tuple()
                    .all(tx)
                    .await?;
                for (sid, ended_at, started_at) in runs {
                    let ts = ended_at.unwrap_or(started_at);
                    latest_ended.entry(sid).and_modify(|prev| *prev = std::cmp::Ord::max(*prev, ts)).or_insert(ts);
                }
            }
            let expired_ids: Vec<String> = departed
                .into_iter()
                .filter(|(sid, hired_at)| latest_ended.get(sid).copied().unwrap_or(*hired_at) < before_ms)
                .map(|(sid, _)| sid)
                .collect();
            if expired_ids.is_empty() {
                return Ok(0);
            }

            let mut remaining = usize::try_from(limit).unwrap_or(usize::MAX);
            let mut pairs: Vec<(String, i64)> = Vec::new();
            for chunk in expired_ids.chunks(super::MAX_SQL_BIND_PARAMS) {
                if remaining == 0 {
                    break;
                }
                let batch: Vec<(String, i64)> = session_event::Entity::find()
                    .select_only()
                    .columns([session_event::Column::SessionId, session_event::Column::Seq])
                    .filter(session_event::Column::SessionId.is_in(chunk.iter().cloned()))
                    .order_by_asc(session_event::Column::SessionId)
                    .order_by_asc(session_event::Column::Seq)
                    .limit(remaining as u64)
                    .into_tuple()
                    .all(tx)
                    .await?;
                remaining = remaining.saturating_sub(batch.len());
                pairs.extend(batch);
            }
            if pairs.is_empty() {
                return Ok(0);
            }
            let mut by_session: HashMap<String, Vec<i64>> = HashMap::new();
            for (sid, seq) in pairs {
                by_session.entry(sid).or_default().push(seq);
            }
            let mut deleted = 0u64;
            for (sid, seqs) in by_session {
                for seq_chunk in seqs.chunks(super::MAX_SQL_BIND_PARAMS - 1) {
                    let res = session_event::Entity::delete_many()
                        .filter(session_event::Column::SessionId.eq(&sid))
                        .filter(session_event::Column::Seq.is_in(seq_chunk.iter().copied()))
                        .exec(tx)
                        .await?;
                    deleted += res.rows_affected;
                }
            }
            Ok(deleted)
        })
        .await
    }
}
