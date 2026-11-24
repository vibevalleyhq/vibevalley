//! Derived status and stage are rebuilt from issues and sessions, never persisted.
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, SqliteTransactionMode, TransactionOptions, TransactionTrait, Update,
};
use vibevalley_protocol::Issue;
use vibevalley_runtime::agent::durable::BoxFuture;

use crate::db::column::{db_json as json, db_word as word, read_db_json as read_json, read_db_word as read_word};
use crate::db::entities::work_issue::issue;
use crate::work::ledger::IssuePersistence;

pub struct SqliteIssueStore;

impl IssuePersistence for SqliteIssueStore {
    fn all<'a>(&'a self, db: &'a DatabaseConnection) -> BoxFuture<'a, Result<Vec<Issue>, DbErr>> {
        Box::pin(all(db))
    }

    fn get<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, Result<Option<Issue>, DbErr>> {
        Box::pin(get(db, id))
    }

    fn put<'a>(&'a self, tx: &'a DatabaseTransaction, issue: &'a Issue) -> BoxFuture<'a, Result<(), DbErr>> {
        Box::pin(put(tx, issue))
    }

    fn remove<'a>(&'a self, tx: &'a DatabaseTransaction, id: &'a str) -> BoxFuture<'a, Result<(), DbErr>> {
        Box::pin(remove(tx, id))
    }
}

fn read(r: issue::Model) -> Result<Issue, DbErr> {
    let mut item = Issue::new(r.id, r.number, r.title, r.created_at);
    item.description = r.description;
    item.repo = r.repo;
    item.machine_id = r.machine_id;
    item.parent = r.parent;
    item.rank = r.rank;
    item.queued_at = r.queued_at;
    item.closed_at = r.closed_at;
    item.reviewed_at = r.reviewed_at;
    item.priority = read_word(r.priority)?;
    item.deliver = read_word(r.deliver)?;
    item.canceled = r.canceled.map(read_word).transpose()?;
    item.delivered = r.delivered.map(read_word).transpose()?;
    item.mandate = read_json(r.mandate)?;
    item.blocked_by = read_json(r.blocked_by)?;
    item.criteria = read_json(r.criteria)?;
    item.checks = read_json(r.checks)?;
    item.findings = read_json(r.findings)?;
    item.questions = read_json(r.questions)?;
    item.assignments = read_json(r.assignments)?;
    item.constraints = r.constraints.map(read_json).transpose()?;
    item.conflict = r.conflict.map(read_json).transpose()?;
    item.last_run = r.last_run.map(read_json).transpose()?;
    item.answer = r.answer.map(read_json).transpose()?;
    item.delivery_evidence = r.delivery_evidence.map(read_json).transpose()?;
    Ok(item)
}

pub async fn all<C: ConnectionTrait>(db: &C) -> Result<Vec<Issue>, DbErr> {
    issue::Entity::find()
        .order_by_asc(issue::Column::Number)
        .all(db)
        .await?
        .into_iter()
        .map(read)
        .collect()
}

pub async fn get<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Issue>, DbErr> {
    issue::Entity::find_by_id(id).one(db).await?.map(read).transpose()
}

pub async fn put<C: ConnectionTrait>(db: &C, t: &Issue) -> Result<(), DbErr> {
    let model = issue::ActiveModel {
        id: Set(t.id.clone()),
        number: Set(t.number),
        title: Set(t.title.clone()),
        description: Set(t.description.clone()),
        repo: Set(t.repo.clone()),
        machine_id: Set(t.machine_id.clone()),
        priority: Set(word(&t.priority)?),
        rank: Set(t.rank),
        deliver: Set(word(&t.deliver)?),
        parent: Set(t.parent.clone()),
        created_at: Set(t.created_at),
        queued_at: Set(t.queued_at),
        closed_at: Set(t.closed_at),
        reviewed_at: Set(t.reviewed_at),
        canceled: Set(t.canceled.as_ref().map(word).transpose()?),
        delivered: Set(t.delivered.as_ref().map(word).transpose()?),
        mandate: Set(json(&t.mandate)?),
        constraints: Set(t.constraints.as_ref().map(json).transpose()?),
        conflict: Set(t.conflict.as_ref().map(json).transpose()?),
        last_run: Set(t.last_run.as_ref().map(json).transpose()?),
        answer: Set(t.answer.as_ref().map(json).transpose()?),
        delivery_evidence: Set(t.delivery_evidence.as_ref().map(json).transpose()?),
        queued_words: Set("[]".into()),
        blocked_by: Set(json(&t.blocked_by)?),
        criteria: Set(json(&t.criteria)?),
        checks: Set(json(&t.checks)?),
        findings: Set(json(&t.findings)?),
        questions: Set(json(&t.questions)?),
        assignments: Set(json(&t.assignments)?),
    };
    let on_conflict = OnConflict::column(issue::Column::Id)
        .update_columns([
            issue::Column::Number,
            issue::Column::Title,
            issue::Column::Description,
            issue::Column::Repo,
            issue::Column::MachineId,
            issue::Column::Priority,
            issue::Column::Rank,
            issue::Column::Deliver,
            issue::Column::Parent,
            issue::Column::CreatedAt,
            issue::Column::QueuedAt,
            issue::Column::ClosedAt,
            issue::Column::ReviewedAt,
            issue::Column::Canceled,
            issue::Column::Delivered,
            issue::Column::Mandate,
            issue::Column::Constraints,
            issue::Column::Conflict,
            issue::Column::LastRun,
            issue::Column::Answer,
            issue::Column::DeliveryEvidence,
            issue::Column::BlockedBy,
            issue::Column::Criteria,
            issue::Column::Checks,
            issue::Column::Findings,
            issue::Column::Questions,
            issue::Column::Assignments,
        ])
        .to_owned();
    issue::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

pub async fn remove<C: ConnectionTrait>(db: &C, id: &str) -> Result<(), DbErr> {
    issue::Entity::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}

fn immediate_opts(db: &DatabaseConnection) -> TransactionOptions {
    TransactionOptions {
        sqlite_transaction_mode: (db.get_database_backend() == DatabaseBackend::Sqlite).then_some(SqliteTransactionMode::Immediate),
        ..Default::default()
    }
}

pub async fn keep_words(db: &DatabaseConnection, issue_id: &str, words: &str) -> Result<(), DbErr> {
    let txn = db.begin_with_options(immediate_opts(db)).await?;
    let Some(raw) = issue::Entity::find_by_id(issue_id.to_owned())
        .select_only()
        .column(issue::Column::QueuedWords)
        .into_tuple::<String>()
        .one(&txn)
        .await?
    else {
        txn.commit().await?;
        return Ok(());
    };
    let mut kept: Vec<String> = read_json(raw)?;
    kept.push(words.to_string());
    Update::many(issue::Entity)
        .col_expr(issue::Column::QueuedWords, Expr::value(json(&kept)?))
        .filter(issue::Column::Id.eq(issue_id))
        .exec(&txn)
        .await?;
    txn.commit().await
}

pub async fn take_words(db: &DatabaseConnection, issue_id: &str) -> Result<Vec<String>, DbErr> {
    let txn = db.begin_with_options(immediate_opts(db)).await?;
    let Some(raw) = issue::Entity::find_by_id(issue_id.to_owned())
        .select_only()
        .column(issue::Column::QueuedWords)
        .into_tuple::<String>()
        .one(&txn)
        .await?
    else {
        txn.commit().await?;
        return Ok(Vec::new());
    };
    let kept: Vec<String> = read_json(raw)?;
    if !kept.is_empty() {
        Update::many(issue::Entity)
            .col_expr(issue::Column::QueuedWords, Expr::value("[]"))
            .filter(issue::Column::Id.eq(issue_id))
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(kept)
}
