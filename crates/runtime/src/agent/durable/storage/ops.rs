//! Shared SeaORM/SeaQuery operations for `StorageRead` and `StorageWrite`.
//!
//! Written once against `sea_orm::ConnectionTrait` so `SeaOrmStorage` (SQLite + PostgreSQL)
//! and the Wave 1–3 `SqliteStorage` transition bridge share the exact same query logic.

use sea_orm::sea_query::{Expr, Func, OnConflict, Order, Query, SubQueryStatement};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, QueryFilter, QueryOrder, Update};
use serde_json::{Value, json};

use crate::agent::durable::entities::{durable_conversation, durable_document, durable_entry, durable_signal, durable_submission, durable_task};
use crate::agent::durable::{Conversation, Document, Entry, Error, Result, Signal, Submission, SubmissionStatus, Task, TaskStatus, WaitMode};

impl TryFrom<durable_document::Model> for Document {
    type Error = Error;

    fn try_from(row: durable_document::Model) -> Result<Self> {
        Ok(Self {
            scope_kind: row.scope_kind,
            scope_id: row.scope_id,
            doc_kind: row.doc_kind,
            rev: row.rev,
            state: serde_json::from_str(&row.state_json)?,
            updated_at_ms: row.updated_at_ms,
        })
    }
}

impl TryFrom<durable_conversation::Model> for Conversation {
    type Error = Error;

    fn try_from(r: durable_conversation::Model) -> Result<Self> {
        Ok(Self {
            id: r.id,
            owner_task_id: r.owner_task_id,
            parent_id: r.parent_id,
            fork_entry_seq: r.fork_entry_seq,
            head_seq: r.head_seq,
            next_seq: r.next_seq,
            provider_affinity: r.provider_affinity,
            metadata: serde_json::from_str(&r.metadata_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<durable_entry::Model> for Entry {
    type Error = Error;

    fn try_from(r: durable_entry::Model) -> Result<Self> {
        Ok(Self {
            conversation_id: r.conversation_id,
            seq: r.seq,
            kind: r.kind,
            payload: serde_json::from_str(&r.payload_json)?,
            created_at_ms: r.created_at_ms,
        })
    }
}

impl TryFrom<durable_submission::Model> for Submission {
    type Error = Error;

    fn try_from(r: durable_submission::Model) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            request_id: r.request_id,
            kind: r.kind,
            status: r.status.parse()?,
            payload: serde_json::from_str(&r.payload_json)?,
            notify_task_id: r.notify_task_id,
            result: serde_json::from_str(&r.result_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<durable_task::Model> for Task {
    type Error = Error;

    fn try_from(r: durable_task::Model) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            owner_task_id: r.owner_task_id,
            dedup_key: r.dedup_key,
            kind: r.kind,
            is_model_task: r.is_model_task,
            status: r.status.parse()?,
            terminal_reason: r.terminal_reason,
            restart_count: r.restart_count.try_into().map_err(|_| Error::Invalid("invalid restart count".into()))?,
            restart_limit: r.restart_limit.try_into().map_err(|_| Error::Invalid("invalid restart limit".into()))?,
            phase_name: r.phase_name,
            checkpoint: serde_json::from_str(&r.checkpoint_json)?,
            wake_until_ms: r.wake_until_ms,
            wait_mode: if r.wait_mode.is_empty() { None } else { Some(r.wait_mode.parse()?) },
            wait_task_ids: serde_json::from_str(&r.wait_task_ids_json)?,
            wait_signal_name: r.wait_signal_name,
            memo: serde_json::from_str(&r.memo_json)?,
            result: serde_json::from_str(&r.result_json)?,
            error_text: r.error_text,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}

impl TryFrom<durable_signal::Model> for Signal {
    type Error = Error;

    fn try_from(r: durable_signal::Model) -> Result<Self> {
        Ok(Self {
            id: r.id,
            task_id: r.task_id,
            signal_name: r.signal_name,
            signal_key: r.signal_key,
            payload: serde_json::from_str(&r.payload_json)?,
            consumed: r.consumed,
            consumed_at_ms: r.consumed_at_ms,
            created_at_ms: r.created_at_ms,
        })
    }
}

pub(crate) async fn document<C: ConnectionTrait>(db: &C, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
    durable_document::Entity::find_by_id((scope.to_owned(), id.to_owned(), kind.to_owned()))
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn documents_by_kind<C: ConnectionTrait>(db: &C, scope: &str, kind: &str) -> Result<Vec<Document>> {
    durable_document::Entity::find()
        .filter(durable_document::Column::ScopeKind.eq(scope))
        .filter(durable_document::Column::DocKind.eq(kind))
        .order_by_asc(durable_document::Column::ScopeId)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn documents_by_scope<C: ConnectionTrait>(db: &C, scope: &str, id: &str) -> Result<Vec<Document>> {
    durable_document::Entity::find()
        .filter(durable_document::Column::ScopeKind.eq(scope))
        .filter(durable_document::Column::ScopeId.eq(id))
        .order_by_asc(durable_document::Column::DocKind)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn put_document<C: ConnectionTrait>(db: &C, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64> {
    let model = durable_document::ActiveModel {
        scope_kind: Set(scope.to_owned()),
        scope_id: Set(id.to_owned()),
        doc_kind: Set(kind.to_owned()),
        rev: Set(1),
        state_json: Set(state.to_string()),
        updated_at_ms: Set(now_ms),
    };
    let on_conflict = OnConflict::columns([
        durable_document::Column::ScopeKind,
        durable_document::Column::ScopeId,
        durable_document::Column::DocKind,
    ])
    .value(
        durable_document::Column::Rev,
        Expr::col((durable_document::Entity, durable_document::Column::Rev)).add(1),
    )
    .update_columns([durable_document::Column::StateJson, durable_document::Column::UpdatedAtMs])
    .to_owned();
    let saved = durable_document::Entity::insert(model).on_conflict(on_conflict).exec_with_returning(db).await?;
    Ok(saved.rev)
}

pub(crate) async fn delete_document<C: ConnectionTrait>(db: &C, scope: &str, id: &str, kind: &str) -> Result<()> {
    durable_document::Entity::delete_by_id((scope.to_owned(), id.to_owned(), kind.to_owned()))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn conversation<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Conversation>> {
    durable_conversation::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn conversations<C: ConnectionTrait>(db: &C) -> Result<Vec<Conversation>> {
    durable_conversation::Entity::find()
        .order_by_asc(durable_conversation::Column::CreatedAtMs)
        .order_by_asc(durable_conversation::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn conversations_by_owner_task<C: ConnectionTrait>(db: &C, owner_task_id: &str) -> Result<Vec<Conversation>> {
    durable_conversation::Entity::find()
        .filter(durable_conversation::Column::OwnerTaskId.eq(owner_task_id))
        .order_by_asc(durable_conversation::Column::CreatedAtMs)
        .order_by_asc(durable_conversation::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn entries_from<C: ConnectionTrait>(db: &C, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
    durable_entry::Entity::find()
        .filter(durable_entry::Column::ConversationId.eq(conv))
        .filter(durable_entry::Column::Seq.gte(from_seq))
        .order_by_asc(durable_entry::Column::Seq)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn entries_within<C: ConnectionTrait>(db: &C, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
    durable_entry::Entity::find()
        .filter(durable_entry::Column::ConversationId.eq(conv))
        .filter(durable_entry::Column::Seq.gte(first_seq))
        .filter(durable_entry::Column::Seq.lte(last_seq))
        .order_by_asc(durable_entry::Column::Seq)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn insert_conversation<C: ConnectionTrait>(db: &C, conv: &Conversation) -> Result<()> {
    durable_conversation::ActiveModel {
        id: Set(conv.id.clone()),
        owner_task_id: Set(conv.owner_task_id.clone()),
        parent_id: Set(conv.parent_id.clone()),
        fork_entry_seq: Set(conv.fork_entry_seq),
        head_seq: Set(conv.head_seq),
        next_seq: Set(conv.next_seq),
        provider_affinity: Set(conv.provider_affinity.clone()),
        metadata_json: Set(conv.metadata.to_string()),
        created_at_ms: Set(conv.created_at_ms),
        updated_at_ms: Set(conv.updated_at_ms),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub(crate) async fn advance_sequence<C: ConnectionTrait>(db: &C, conv: &str, now_ms: i64) -> Result<Option<i64>> {
    let rows = Update::many(durable_conversation::Entity)
        .col_expr(durable_conversation::Column::NextSeq, Expr::col(durable_conversation::Column::NextSeq).add(1))
        .col_expr(durable_conversation::Column::UpdatedAtMs, Expr::value(now_ms))
        .filter(durable_conversation::Column::Id.eq(conv))
        .exec_with_returning(db)
        .await?;
    Ok(rows.into_iter().next().map(|row| row.next_seq))
}

pub(crate) async fn insert_entry<C: ConnectionTrait>(db: &C, entry: &Entry) -> Result<()> {
    durable_entry::ActiveModel {
        conversation_id: Set(entry.conversation_id.clone()),
        seq: Set(entry.seq),
        kind: Set(entry.kind.clone()),
        payload_json: Set(entry.payload.to_string()),
        created_at_ms: Set(entry.created_at_ms),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub(crate) async fn set_head<C: ConnectionTrait>(db: &C, conv: &str, head_seq: i64) -> Result<()> {
    Update::many(durable_conversation::Entity)
        .col_expr(durable_conversation::Column::HeadSeq, Expr::value(head_seq))
        .filter(durable_conversation::Column::Id.eq(conv))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn reset_head<C: ConnectionTrait>(db: &C, conv: &str) -> Result<()> {
    Update::many(durable_conversation::Entity)
        .col_expr(durable_conversation::Column::HeadSeq, Expr::col(durable_conversation::Column::NextSeq))
        .filter(durable_conversation::Column::Id.eq(conv))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn submission<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Submission>> {
    durable_submission::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn submission_by_request<C: ConnectionTrait>(db: &C, conv: &str, request_id: &str) -> Result<Option<Submission>> {
    durable_submission::Entity::find()
        .filter(durable_submission::Column::ConversationId.eq(conv))
        .filter(durable_submission::Column::RequestId.eq(request_id))
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn submissions<C: ConnectionTrait>(db: &C, conv: &str) -> Result<Vec<Submission>> {
    durable_submission::Entity::find()
        .filter(durable_submission::Column::ConversationId.eq(conv))
        .order_by_asc(durable_submission::Column::CreatedAtMs)
        .order_by_asc(durable_submission::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn insert_submission<C: ConnectionTrait>(db: &C, sub: &Submission) -> Result<()> {
    durable_submission::ActiveModel {
        id: Set(sub.id.clone()),
        conversation_id: Set(sub.conversation_id.clone()),
        request_id: Set(sub.request_id.clone()),
        kind: Set(sub.kind.clone()),
        status: Set(SubmissionStatus::Queued.as_str().to_owned()),
        payload_json: Set(sub.payload.to_string()),
        notify_task_id: Set(sub.notify_task_id.clone()),
        result_json: Set(sub.result.to_string()),
        created_at_ms: Set(sub.created_at_ms),
        updated_at_ms: Set(sub.created_at_ms),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub(crate) async fn set_submission_status<C: ConnectionTrait>(db: &C, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()> {
    Update::many(durable_submission::Entity)
        .col_expr(durable_submission::Column::Status, Expr::value(status.as_str()))
        .col_expr(durable_submission::Column::UpdatedAtMs, Expr::value(now_ms))
        .filter(durable_submission::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn settle_submission<C: ConnectionTrait>(db: &C, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()> {
    Update::many(durable_submission::Entity)
        .col_expr(durable_submission::Column::Status, Expr::value(status.as_str()))
        .col_expr(durable_submission::Column::ResultJson, Expr::value(result.to_string()))
        .col_expr(durable_submission::Column::UpdatedAtMs, Expr::value(now_ms))
        .filter(durable_submission::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub(crate) async fn task<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Task>> {
    durable_task::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn task_by_dedup<C: ConnectionTrait>(db: &C, owner: &str, key: &str) -> Result<Option<Task>> {
    if key.is_empty() {
        return Ok(None);
    }
    durable_task::Entity::find()
        .filter(durable_task::Column::OwnerTaskId.eq(owner))
        .filter(durable_task::Column::DedupKey.eq(key))
        .filter(durable_task::Column::DedupKey.ne(""))
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn tasks_by_conversation<C: ConnectionTrait>(db: &C, conv: &str) -> Result<Vec<Task>> {
    durable_task::Entity::find()
        .filter(durable_task::Column::ConversationId.eq(conv))
        .order_by_asc(durable_task::Column::CreatedAtMs)
        .order_by_asc(durable_task::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn children<C: ConnectionTrait>(db: &C, owner: &str) -> Result<Vec<Task>> {
    durable_task::Entity::find()
        .filter(durable_task::Column::OwnerTaskId.eq(owner))
        .order_by_asc(durable_task::Column::CreatedAtMs)
        .order_by_asc(durable_task::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn tasks_by_status<C: ConnectionTrait>(db: &C, status: TaskStatus) -> Result<Vec<Task>> {
    durable_task::Entity::find()
        .filter(durable_task::Column::Status.eq(status.as_str()))
        .order_by_asc(durable_task::Column::CreatedAtMs)
        .order_by_asc(durable_task::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn active_tasks<C: ConnectionTrait>(db: &C) -> Result<Vec<Task>> {
    durable_task::Entity::find()
        .filter(durable_task::Column::Status.ne(TaskStatus::Terminal.as_str()))
        .order_by_asc(durable_task::Column::CreatedAtMs)
        .order_by_asc(durable_task::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn insert_task<C: ConnectionTrait>(db: &C, t: &Task) -> Result<()> {
    let restart_count = i32::try_from(t.restart_count).map_err(|_| Error::Invalid("restart_count out of range".into()))?;
    let restart_limit = i32::try_from(t.restart_limit).map_err(|_| Error::Invalid("restart_limit out of range".into()))?;
    durable_task::ActiveModel {
        id: Set(t.id.clone()),
        conversation_id: Set(t.conversation_id.clone()),
        owner_task_id: Set(t.owner_task_id.clone()),
        dedup_key: Set(t.dedup_key.clone()),
        kind: Set(t.kind.clone()),
        is_model_task: Set(t.is_model_task),
        status: Set(t.status.as_str().to_owned()),
        terminal_reason: Set(t.terminal_reason.clone()),
        restart_count: Set(restart_count),
        restart_limit: Set(restart_limit),
        phase_name: Set(t.phase_name.clone()),
        checkpoint_json: Set(t.checkpoint.to_string()),
        wake_until_ms: Set(t.wake_until_ms),
        wait_mode: Set(t.wait_mode.map_or("", WaitMode::as_str).to_owned()),
        wait_task_ids_json: Set(json!(t.wait_task_ids).to_string()),
        wait_signal_name: Set(t.wait_signal_name.clone()),
        memo_json: Set(t.memo.to_string()),
        result_json: Set(t.result.to_string()),
        error_text: Set(t.error_text.clone()),
        created_at_ms: Set(t.created_at_ms),
        updated_at_ms: Set(t.updated_at_ms),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub(crate) async fn update_task<C: ConnectionTrait>(db: &C, t: &Task, now_ms: i64) -> Result<bool> {
    let restart_count = i32::try_from(t.restart_count).map_err(|_| Error::Invalid("restart_count out of range".into()))?;
    let restart_limit = i32::try_from(t.restart_limit).map_err(|_| Error::Invalid("restart_limit out of range".into()))?;
    let res = Update::many(durable_task::Entity)
        .col_expr(durable_task::Column::Status, Expr::value(t.status.as_str()))
        .col_expr(durable_task::Column::TerminalReason, Expr::value(&t.terminal_reason))
        .col_expr(durable_task::Column::RestartCount, Expr::value(restart_count))
        .col_expr(durable_task::Column::RestartLimit, Expr::value(restart_limit))
        .col_expr(durable_task::Column::PhaseName, Expr::value(&t.phase_name))
        .col_expr(durable_task::Column::CheckpointJson, Expr::value(t.checkpoint.to_string()))
        .col_expr(durable_task::Column::WakeUntilMs, Expr::value(t.wake_until_ms))
        .col_expr(durable_task::Column::WaitMode, Expr::value(t.wait_mode.map_or("", WaitMode::as_str)))
        .col_expr(durable_task::Column::WaitTaskIdsJson, Expr::value(json!(t.wait_task_ids).to_string()))
        .col_expr(durable_task::Column::WaitSignalName, Expr::value(&t.wait_signal_name))
        .col_expr(durable_task::Column::MemoJson, Expr::value(t.memo.to_string()))
        .col_expr(durable_task::Column::ResultJson, Expr::value(t.result.to_string()))
        .col_expr(durable_task::Column::ErrorText, Expr::value(&t.error_text))
        .col_expr(durable_task::Column::UpdatedAtMs, Expr::value(now_ms))
        .filter(durable_task::Column::Id.eq(&t.id))
        .exec(db)
        .await?;
    Ok(res.rows_affected > 0)
}

pub(crate) async fn signals<C: ConnectionTrait>(db: &C, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
    let mut query = durable_signal::Entity::find().filter(durable_signal::Column::TaskId.eq(task_id));
    if !include_consumed {
        query = query.filter(durable_signal::Column::Consumed.eq(false));
    }
    query
        .order_by_asc(durable_signal::Column::InsertSeq)
        .all(db)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(crate) async fn signal_by_key<C: ConnectionTrait>(db: &C, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
    if key.is_empty() {
        return Ok(None);
    }
    durable_signal::Entity::find()
        .filter(durable_signal::Column::TaskId.eq(task_id))
        .filter(durable_signal::Column::SignalName.eq(name))
        .filter(durable_signal::Column::SignalKey.eq(key))
        .one(db)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub(crate) async fn insert_signal<C: ConnectionTrait>(db: &C, signal: &Signal) -> Result<Signal> {
    let next_seq_subquery = Query::select()
        .expr(Expr::expr(Func::coalesce([Expr::col(durable_signal::Column::InsertSeq).max(), Expr::val(0i64)])).add(1))
        .from(durable_signal::Entity)
        .to_owned();
    let stmt = Query::insert()
        .into_table(durable_signal::Entity)
        .columns([
            durable_signal::Column::Id,
            durable_signal::Column::TaskId,
            durable_signal::Column::SignalName,
            durable_signal::Column::SignalKey,
            durable_signal::Column::PayloadJson,
            durable_signal::Column::InsertSeq,
            durable_signal::Column::Consumed,
            durable_signal::Column::ConsumedAtMs,
            durable_signal::Column::CreatedAtMs,
        ])
        .values_panic([
            Expr::val(signal.id.clone()),
            Expr::val(signal.task_id.clone()),
            Expr::val(signal.signal_name.clone()),
            Expr::val(signal.signal_key.clone()),
            Expr::val(signal.payload.to_string()),
            Expr::from(SubQueryStatement::SelectStatement(next_seq_subquery)),
            Expr::val(false),
            Expr::val(0i64),
            Expr::val(signal.created_at_ms),
        ])
        .returning_all()
        .to_owned();
    let row = db
        .query_one(&stmt)
        .await?
        .ok_or_else(|| Error::Commit("insert_signal returned no row".into()))?;
    let model = durable_signal::Model::from_query_result(&row, "")?;
    model.try_into()
}

pub(crate) async fn consume_first_signal<C: ConnectionTrait>(db: &C, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>> {
    let next_id_subquery = Query::select()
        .column(durable_signal::Column::Id)
        .from(durable_signal::Entity)
        .and_where(durable_signal::Column::TaskId.eq(task_id))
        .and_where(durable_signal::Column::SignalName.eq(name))
        .and_where(durable_signal::Column::Consumed.eq(false))
        .order_by(durable_signal::Column::InsertSeq, Order::Asc)
        .limit(1)
        .to_owned();
    let rows = Update::many(durable_signal::Entity)
        .col_expr(durable_signal::Column::Consumed, Expr::value(true))
        .col_expr(durable_signal::Column::ConsumedAtMs, Expr::value(now_ms))
        .filter(durable_signal::Column::Id.in_subquery(next_id_subquery))
        .exec_with_returning(db)
        .await?;
    rows.into_iter().next().map(TryInto::try_into).transpose()
}
