use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Alias, Condition, Expr, Func, JoinType, OnConflict, Order, Query, SelectStatement, SubQueryStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait,
    QueryFilter, QuerySelect, Update,
};
use vibevalley_protocol::{Millis, Run, Session, SessionEvent, SessionPermissionMode, SessionSubagents};
use vibevalley_runtime::agent::durable::entities::durable_document;
use vibevalley_runtime::agent::durable::{BoxFuture, Store as DurableStore, Tx};

use super::sessions::Extra;
use crate::db::column::{db_json as json, db_word as word, read_db_json as read_json, read_db_word as read_word};
use crate::db::entities::work_session::{session, session_event, session_run};
use crate::work::ledger::{ReopenInterrupt, Result as LedgerResult, SessionPersistence};

pub struct SqliteSessionStore;

impl SessionPersistence for SqliteSessionStore {
    fn all<'a>(&'a self, db: &'a DatabaseConnection) -> BoxFuture<'a, Result<Vec<Session>, DbErr>> {
        Box::pin(all(db))
    }

    fn get<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, Result<Option<Session>, DbErr>> {
        Box::pin(get(db, id))
    }

    fn past<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, Result<Option<Session>, DbErr>> {
        Box::pin(past(db, id))
    }

    fn put<'a>(&'a self, tx: &'a DatabaseTransaction, s: &'a Session, departed: bool) -> BoxFuture<'a, Result<(), DbErr>> {
        Box::pin(put(tx, s, departed))
    }

    fn put_subagents<'a>(&'a self, tx: &'a DatabaseTransaction, summary: &'a SessionSubagents) -> BoxFuture<'a, Result<(), DbErr>> {
        Box::pin(put_subagents(tx, summary))
    }

    fn active_run<'a>(&'a self, tx: &'a DatabaseTransaction, session_id: &'a str, run_id: &'a str, root: &'a str) -> BoxFuture<'a, Result<bool, DbErr>> {
        Box::pin(active_run(tx, session_id, run_id, root))
    }

    fn run<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, Result<Option<Run>, DbErr>> {
        Box::pin(run(db, id))
    }

    fn recoverable_ids<'a>(
        &'a self,
        db: &'a DatabaseConnection,
        durable: &'a DurableStore,
        stored: &'a [Session],
    ) -> BoxFuture<'a, LedgerResult<HashSet<String>>> {
        Box::pin(async move {
            let all_extras = extras(db).await?;
            let mut out = HashSet::new();
            for s in stored {
                if s.phase.is_working()
                    && !s.is_refining()
                    && s.runtime == vibevalley_runtime::agent::runtime::ID
                    && let Some(extra) = all_extras.get(&s.id)
                    && let (Some(run_id), Some(vendor)) = (extra.run.as_deref(), extra.agent_session.as_deref())
                {
                    let conv = vibevalley_runtime::agent::harness::worker_conversation(vendor);
                    let req = format!("work:{run_id}");
                    if durable
                        .read_with_async((conv.as_str(), req.as_str()), |tx, &(conv, req)| {
                            Box::pin(tx.submission_by_request_async(conv, req))
                        })
                        .await?
                        .is_some()
                    {
                        out.insert(s.id.clone());
                    }
                }
            }
            Ok(out)
        })
    }

    fn interrupt_on_reopen<'a, 'tx>(
        &'a self,
        tx: &'a mut Tx<'tx>,
        s: &'a Session,
        at: Millis,
        summary: &'a str,
    ) -> BoxFuture<'a, vibevalley_runtime::agent::durable::Result<Option<ReopenInterrupt>>>
    where
        'tx: 'a,
    {
        Box::pin(async move {
            let all_extras = extras(tx.transaction()).await?;
            Ok(super::delivery::interrupt_on_reopen(tx, s, all_extras.get(&s.id), at, summary)
                .await?
                .map(|(run_id, needs_reconciliation)| ReopenInterrupt { run_id, needs_reconciliation }))
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionConfig {
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<SessionPermissionMode>,
}

#[derive(FromQueryResult)]
struct SessionRow {
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
    subagents: Option<String>,
}

fn read(r: SessionRow) -> Result<Session, DbErr> {
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

fn session_select(departed: bool, id: Option<&str>) -> SelectStatement {
    let r_alias = Alias::new("r");
    let latest_subagents = Query::select()
        .column((r_alias.clone(), session_run::Column::SubagentSummary))
        .from_as(session_run::Entity, r_alias.clone())
        .and_where(Expr::col((r_alias.clone(), session_run::Column::Session)).equals((session::Entity, session::Column::Id)))
        .order_by((r_alias.clone(), session_run::Column::StartedAt), Order::Desc)
        .order_by_expr(
            Expr::expr(Func::char_length(Expr::col((r_alias.clone(), session_run::Column::Id)))),
            Order::Desc,
        )
        .order_by((r_alias, session_run::Column::Id), Order::Desc)
        .limit(1)
        .to_owned();

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
    .expr_as(Expr::from(SubQueryStatement::SelectStatement(latest_subagents)), Alias::new("subagents"))
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

pub async fn put_subagents<C: ConnectionTrait>(db: &C, summary: &SessionSubagents) -> Result<(), DbErr> {
    Update::many(session_run::Entity)
        .col_expr(session_run::Column::SubagentSummary, Expr::value(Some(json(summary)?)))
        .filter(session_run::Column::Id.eq(&summary.run))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn all<C: ConnectionTrait>(db: &C) -> Result<Vec<Session>, DbErr> {
    let stmt = session_select(false, None);
    let rows = db.query_all(&stmt).await?;
    rows.into_iter().map(|row| SessionRow::from_query_result(&row, "").and_then(read)).collect()
}

pub async fn get<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Session>, DbErr> {
    let stmt = session_select(false, Some(id));
    db.query_one(&stmt)
        .await?
        .map(|row| SessionRow::from_query_result(&row, "").and_then(read))
        .transpose()
}

pub async fn past<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Session>, DbErr> {
    let stmt = session_select(true, Some(id));
    db.query_one(&stmt)
        .await?
        .map(|row| SessionRow::from_query_result(&row, "").and_then(read))
        .transpose()
}

pub async fn put<C: ConnectionTrait>(db: &C, s: &Session, departed: bool) -> Result<(), DbErr> {
    let model = session::ActiveModel {
        id: Set(s.id.clone()),
        controller: Set(word(&s.controller)?),
        role: Set(s.role.as_ref().map(word).transpose()?),
        name: Set(s.name.clone()),
        profile: Set(s.profile.clone()),
        runtime: Set(s.runtime.clone()),
        brief: Set(s.brief.clone()),
        cwd: Set(s.cwd.clone()),
        policy: Set(json(&s.policy)?),
        bindings: Set(json(&s.bindings)?),
        hired_at: Set(s.hired_at),
        runs: Set(s.runs),
        last_run: Set(s.last_run.as_ref().map(json).transpose()?),
        spent: Set(s.spent.as_ref().map(json).transpose()?),
        tool_connections: Set(s.tool_connections.as_ref().map(json).transpose()?),
        machine: Set(s.machine.clone()),
        phase: Set(json(&s.phase)?),
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

#[cfg(test)]
pub async fn config<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<SessionConfig>, DbErr> {
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
            permission_mode: permission_mode.map(read_word).transpose()?,
        })
    })
    .transpose()
}

pub async fn configs<C: ConnectionTrait>(db: &C) -> Result<HashMap<String, SessionConfig>, DbErr> {
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
                    permission_mode: permission_mode.map(read_word).transpose()?,
                },
            );
        }
    }
    Ok(out)
}

pub async fn put_config<C: ConnectionTrait>(db: &C, id: &str, cfg: &SessionConfig) -> Result<(), DbErr> {
    let permission_mode = cfg.permission_mode.as_ref().map(word).transpose()?;
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

pub async fn upsert_events<C: ConnectionTrait>(db: &C, session_id: &str, events: &[SessionEvent]) -> Result<(), DbErr> {
    if events.is_empty() {
        return Ok(());
    }
    let on_conflict = OnConflict::columns([session_event::Column::SessionId, session_event::Column::Seq])
        .value(
            session_event::Column::RunId,
            Expr::expr(Func::coalesce([
                Expr::col((Alias::new("excluded"), session_event::Column::RunId)),
                Expr::col((session_event::Entity, session_event::Column::RunId)),
            ])),
        )
        .update_column(session_event::Column::Payload)
        .to_owned();
    for e in events {
        let model = session_event::ActiveModel {
            session_id: Set(session_id.to_owned()),
            seq: Set(e.seq),
            run_id: Set(e.run.clone()),
            payload: Set(json(e)?),
        };
        session_event::Entity::insert(model).on_conflict(on_conflict.clone()).exec(db).await?;
    }
    Ok(())
}

pub async fn delete_events<C: ConnectionTrait>(db: &C, session_id: &str) -> Result<(), DbErr> {
    session_event::Entity::delete_many()
        .filter(session_event::Column::SessionId.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn max_event_seq<C: ConnectionTrait>(db: &C, session_id: &str) -> Result<i64, DbErr> {
    let row = session_event::Entity::find()
        .select_only()
        .expr_as(Func::coalesce([Expr::col(session_event::Column::Seq).max(), Expr::val(-1i64)]), "max_seq")
        .filter(session_event::Column::SessionId.eq(session_id))
        .into_tuple::<i64>()
        .one(db)
        .await?;
    Ok(row.unwrap_or(-1))
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

pub async fn list_events_tail<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str, limit: i64) -> Result<Vec<SessionEvent>, DbErr> {
    let mut rows = sea_orm::QueryOrder::order_by_desc(event_payload_query(session_id, run_id), session_event::Column::Seq)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple::<String>()
        .all(db)
        .await?
        .into_iter()
        .map(read_json)
        .collect::<Result<Vec<_>, DbErr>>()?;
    rows.reverse();
    Ok(rows)
}

pub async fn list_events_before<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str, before_seq: i64, limit: i64) -> Result<Vec<SessionEvent>, DbErr> {
    let mut rows = sea_orm::QueryOrder::order_by_desc(
        event_payload_query(session_id, run_id).filter(session_event::Column::Seq.lt(before_seq)),
        session_event::Column::Seq,
    )
    .limit(u64::try_from(limit).unwrap_or(0))
    .into_tuple::<String>()
    .all(db)
    .await?
    .into_iter()
    .map(read_json)
    .collect::<Result<Vec<_>, DbErr>>()?;
    rows.reverse();
    Ok(rows)
}

pub async fn list_events_after<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str, after_seq: i64, limit: i64) -> Result<Vec<SessionEvent>, DbErr> {
    sea_orm::QueryOrder::order_by_asc(
        event_payload_query(session_id, run_id).filter(session_event::Column::Seq.gt(after_seq)),
        session_event::Column::Seq,
    )
    .limit(u64::try_from(limit).unwrap_or(0))
    .into_tuple::<String>()
    .all(db)
    .await?
    .into_iter()
    .map(read_json)
    .collect()
}

pub async fn extras<C: ConnectionTrait>(db: &C) -> Result<HashMap<String, Extra>, DbErr> {
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
        .map(|(id, agent_session, base, run)| (id, Extra { agent_session, base, run }))
        .collect())
}

pub async fn put_extra<C: ConnectionTrait>(db: &C, session_id: &str, e: &Extra) -> Result<(), DbErr> {
    Update::many(session::Entity)
        .col_expr(session::Column::AgentSession, Expr::value(e.agent_session.clone()))
        .col_expr(session::Column::Base, Expr::value(e.base.clone()))
        .col_expr(session::Column::Run, Expr::value(e.run.clone()))
        .filter(session::Column::Id.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn remove_extra<C: ConnectionTrait>(db: &C, session_id: &str) -> Result<(), DbErr> {
    Update::many(session::Entity)
        .col_expr(session::Column::AgentSession, Expr::value(Option::<String>::None))
        .col_expr(session::Column::Base, Expr::value(Option::<String>::None))
        .col_expr(session::Column::Run, Expr::value(Option::<String>::None))
        .filter(session::Column::Id.eq(session_id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn clear_run<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str) -> Result<(), DbErr> {
    Update::many(session::Entity)
        .col_expr(session::Column::Run, Expr::value(Option::<String>::None))
        .filter(session::Column::Id.eq(session_id))
        .filter(session::Column::Run.eq(run_id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn active_run<C: ConnectionTrait>(db: &C, session_id: &str, run_id: &str, root: &str) -> Result<bool, DbErr> {
    let count = session::Entity::find()
        .filter(session::Column::Id.eq(session_id))
        .filter(session::Column::Run.eq(run_id))
        .filter(session::Column::AgentSession.eq(root))
        .count(db)
        .await?;
    Ok(count > 0)
}

#[derive(FromQueryResult)]
struct RunRow {
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
    reconciliation: Option<String>,
}

fn read_run(r: RunRow) -> Result<Run, DbErr> {
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

fn run_select() -> SelectStatement {
    let r_alias = Alias::new("r");
    let d_alias = Alias::new("d");
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
    .expr_as(Expr::col((d_alias.clone(), durable_document::Column::DocKind)), Alias::new("reconciliation"))
    .from_as(session_run::Entity, r_alias.clone())
    .join_as(
        JoinType::LeftJoin,
        durable_document::Entity,
        d_alias.clone(),
        Condition::all()
            .add(Expr::col((d_alias.clone(), durable_document::Column::ScopeKind)).eq("run"))
            .add(Expr::col((d_alias.clone(), durable_document::Column::ScopeId)).equals((r_alias.clone(), session_run::Column::Id)))
            .add(Expr::col((d_alias, durable_document::Column::DocKind)).eq("workspace.reconciliation")),
    );
    q
}

pub async fn run<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Run>, DbErr> {
    let mut stmt = run_select();
    stmt.and_where(Expr::col((Alias::new("r"), session_run::Column::Id)).eq(id));
    db.query_one(&stmt)
        .await?
        .map(|row| RunRow::from_query_result(&row, "").and_then(read_run))
        .transpose()
}

pub async fn runs<C: ConnectionTrait>(db: &C, issue: &str) -> Result<Vec<Run>, DbErr> {
    let r_alias = Alias::new("r");
    let mut stmt = run_select();
    stmt.and_where(Expr::col((r_alias.clone(), session_run::Column::Issue)).eq(issue))
        .order_by((r_alias.clone(), session_run::Column::StartedAt), Order::Asc)
        .order_by_expr(Expr::expr(Func::char_length(Expr::col((r_alias.clone(), session_run::Column::Id)))), Order::Asc)
        .order_by((r_alias, session_run::Column::Id), Order::Asc);
    db.query_all(&stmt)
        .await?
        .into_iter()
        .map(|row| RunRow::from_query_result(&row, "").and_then(read_run))
        .collect()
}

pub async fn put_run<C: ConnectionTrait>(db: &C, r: &Run) -> Result<(), DbErr> {
    let model = session_run::ActiveModel {
        id: Set(r.id.clone()),
        session: Set(r.session.clone()),
        issue: Set(r.issue.clone()),
        triggered_by: Set(json(&r.triggered_by)?),
        heard: Set(json(&r.heard)?),
        started_at: Set(r.started_at),
        ended_at: Set(r.ended_at),
        outcome: Set(r.outcome.as_ref().map(word).transpose()?),
        summary: Set(r.summary.clone()),
        spent: Set(r.spent.as_ref().map(json).transpose()?),
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
        ])
        .to_owned();
    session_run::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}
