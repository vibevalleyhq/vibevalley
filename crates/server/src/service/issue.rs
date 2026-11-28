//! Dual-backend persistence for board issues (`issue`), tracked pull requests (`pull`),
//! and pull request webhook/check deduplication events (`pull_event`).
//!
//! Derived issue status and stage are rebuilt from issues and sessions, never persisted.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Update};
use vibevalley_protocol::{CodeReview, DeliveryEvidence, DeliveryReceipt, Issue, JsNumber, ProjectCheckReceipt, PublishPlatform, PullRequestState};

use super::{MAX_SQL_BIND_PARAMS, batch_chunk_rows, with_write_tx};
use crate::db::column::{db_json, db_word, read_db_json, read_db_word};
use crate::db::entity::{issue, pull, pull_event};
use crate::db::{Database, DbError, DbResult, Tx};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRecord {
    pub id: String,
    pub platform: PublishPlatform,
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub branch: String,
    pub base: String,
    pub state: PullRequestState,
    pub issue_id: Option<String>,
    pub check_fingerprint: String,
    pub check_revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownPullEvent {
    pub key: String,
    pub bot_round_key: Option<String>,
    pub bot_round: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct UpsertPullInput {
    pub platform: PublishPlatform,
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub branch: String,
    pub base: String,
    pub state: PullRequestState,
    pub issue_id: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDeliveryEvidence {
    #[serde(default)]
    reviews: Vec<CodeReview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    check: Option<ProjectCheckReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    merged_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<DeliveryReceipt>,
}

fn read_issue(r: issue::Model) -> DbResult<Issue> {
    let mut item = Issue::new(r.id, r.number, r.title, r.created_at);
    item.description = r.description;
    item.repo = r.repo;
    item.machine_id = r.machine_id;
    item.parent = r.parent;
    item.rank = r.rank;
    item.queued_at = r.queued_at;
    item.closed_at = r.closed_at;
    item.reviewed_at = r.reviewed_at;
    item.priority = read_db_word(r.priority)?;
    item.status = read_db_word(r.status)?;
    item.deliver = read_db_word(r.deliver)?;
    item.canceled = r.canceled.map(read_db_word).transpose()?;
    item.delivered = r.delivered.map(read_db_word).transpose()?;
    item.mandate = read_db_json(r.mandate)?;
    item.blocked_by = read_db_json(r.blocked_by)?;
    item.criteria = read_db_json(r.criteria)?;
    item.checks = read_db_json(r.checks)?;
    item.findings = read_db_json(r.findings)?;
    item.questions = read_db_json(r.questions)?;
    item.assignments = read_db_json(r.assignments)?;
    item.attachments = read_db_json(r.attachments)?;
    item.tags = read_db_json(r.tags_json)?;
    item.start_at = r.start_at.map(JsNumber::from);
    item.due_at = r.due_at.map(JsNumber::from);
    item.owner = r.owner.map(read_db_json).transpose()?;
    item.relations = read_db_json(r.relations)?;
    item.body_note_id = r.body_note_id;
    item.constraints = r.constraints.map(read_db_json).transpose()?;
    item.conflict = r.conflict.map(read_db_json).transpose()?;
    item.last_run = r.last_run.map(read_db_json).transpose()?;
    item.answer = r.answer.map(read_db_json).transpose()?;
    if let Some(stored) = r.delivery_evidence.map(read_db_json::<StoredDeliveryEvidence>).transpose()? {
        item.delivery_receipt = stored.receipt;
        if !stored.reviews.is_empty() || stored.check.is_some() || stored.merged_commit.is_some() {
            item.delivery_evidence = Some(DeliveryEvidence {
                reviews: stored.reviews,
                check: stored.check,
                merged_commit: stored.merged_commit,
            });
        }
    }
    Ok(item)
}

fn read_pull(r: pull::Model) -> DbResult<PullRecord> {
    Ok(PullRecord {
        id: r.id,
        platform: read_db_word(r.platform)?,
        repo: r.repo,
        number: r.number,
        url: r.url,
        branch: r.branch,
        base: r.base,
        state: read_db_word(r.state)?,
        issue_id: r.issue_id,
        check_fingerprint: r.check_fingerprint,
        check_revision: r.check_revision,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

async fn all_issues_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<Issue>> {
    issue::Entity::find()
        .order_by_asc(issue::Column::Number)
        .all(db)
        .await?
        .into_iter()
        .map(read_issue)
        .collect()
}

async fn get_issue_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<Issue>> {
    issue::Entity::find_by_id(id).one(db).await?.map(read_issue).transpose()
}

const ISSUE_BATCH_ROWS: usize = batch_chunk_rows(37);

fn stored_delivery_evidence(t: &Issue) -> Option<StoredDeliveryEvidence> {
    if t.delivery_evidence.is_none() && t.delivery_receipt.is_none() {
        return None;
    }
    let ev = t.delivery_evidence.clone().unwrap_or_default();
    Some(StoredDeliveryEvidence {
        reviews: ev.reviews,
        check: ev.check,
        merged_commit: ev.merged_commit,
        receipt: t.delivery_receipt.clone(),
    })
}

fn issue_active_model(t: &Issue) -> DbResult<issue::ActiveModel> {
    let delivery_evidence = stored_delivery_evidence(t).as_ref().map(db_json).transpose()?;
    Ok(issue::ActiveModel {
        id: Set(t.id.clone()),
        number: Set(t.number),
        title: Set(t.title.clone()),
        description: Set(t.description.clone()),
        repo: Set(t.repo.clone()),
        machine_id: Set(t.machine_id.clone()),
        priority: Set(db_word(&t.priority)?),
        status: Set(db_word(&t.status)?),
        rank: Set(t.rank),
        deliver: Set(db_word(&t.deliver)?),
        parent: Set(t.parent.clone()),
        created_at: Set(t.created_at),
        queued_at: Set(t.queued_at),
        closed_at: Set(t.closed_at),
        reviewed_at: Set(t.reviewed_at),
        canceled: Set(t.canceled.as_ref().map(db_word).transpose()?),
        delivered: Set(t.delivered.as_ref().map(db_word).transpose()?),
        mandate: Set(db_json(&t.mandate)?),
        constraints: Set(t.constraints.as_ref().map(db_json).transpose()?),
        conflict: Set(t.conflict.as_ref().map(db_json).transpose()?),
        last_run: Set(t.last_run.as_ref().map(db_json).transpose()?),
        answer: Set(t.answer.as_ref().map(db_json).transpose()?),
        delivery_evidence: Set(delivery_evidence),
        queued_words: Set("[]".into()),
        blocked_by: Set(db_json(&t.blocked_by)?),
        criteria: Set(db_json(&t.criteria)?),
        checks: Set(db_json(&t.checks)?),
        findings: Set(db_json(&t.findings)?),
        questions: Set(db_json(&t.questions)?),
        assignments: Set(db_json(&t.assignments)?),
        attachments: Set(db_json(&t.attachments)?),
        tags_json: Set(db_json(&t.tags)?),
        start_at: Set(t.start_at.map(|v| v.get().round() as i64)),
        due_at: Set(t.due_at.map(|v| v.get().round() as i64)),
        owner: Set(t.owner.as_ref().map(db_json).transpose()?),
        relations: Set(db_json(&t.relations)?),
        body_note_id: Set(t.body_note_id.clone()),
    })
}

fn issue_on_conflict() -> OnConflict {
    OnConflict::column(issue::Column::Id)
        .update_columns([
            issue::Column::Number,
            issue::Column::Title,
            issue::Column::Description,
            issue::Column::Repo,
            issue::Column::MachineId,
            issue::Column::Priority,
            issue::Column::Status,
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
            issue::Column::Attachments,
            issue::Column::TagsJson,
            issue::Column::StartAt,
            issue::Column::DueAt,
            issue::Column::Owner,
            issue::Column::Relations,
            issue::Column::BodyNoteId,
        ])
        .to_owned()
}

async fn put_issue_impl<C: ConnectionTrait>(db: &C, t: &Issue) -> DbResult<()> {
    let model = issue_active_model(t)?;
    issue::Entity::insert(model).on_conflict(issue_on_conflict()).exec(db).await?;
    Ok(())
}

async fn put_issues_batch_impl<C: ConnectionTrait>(db: &C, issues: &[Issue]) -> DbResult<()> {
    if issues.is_empty() {
        return Ok(());
    }
    // Deduplicate by `id` (last-write-wins) so PostgreSQL never sees duplicate conflict keys in one statement.
    let mut index_by_id: HashMap<&str, usize> = HashMap::with_capacity(issues.len());
    let mut deduped: Vec<&Issue> = Vec::with_capacity(issues.len());
    for item in issues {
        if let Some(&idx) = index_by_id.get(item.id.as_str()) {
            deduped[idx] = item;
        } else {
            index_by_id.insert(item.id.as_str(), deduped.len());
            deduped.push(item);
        }
    }

    let on_conflict = issue_on_conflict();
    for chunk in deduped.chunks(ISSUE_BATCH_ROWS) {
        let models: Vec<issue::ActiveModel> = chunk.iter().map(|item| issue_active_model(item)).collect::<DbResult<_>>()?;
        issue::Entity::insert_many(models)
            .on_conflict(on_conflict.clone())
            .exec_without_returning(db)
            .await?;
    }
    Ok(())
}

async fn upsert_pull_impl<C: ConnectionTrait>(db: &C, input: UpsertPullInput) -> DbResult<PullRecord> {
    let model = pull::ActiveModel {
        id: Set(uuid::Uuid::now_v7().to_string()),
        platform: Set(db_word(&input.platform)?),
        repo: Set(input.repo),
        number: Set(input.number),
        url: Set(input.url),
        branch: Set(input.branch),
        base: Set(input.base),
        state: Set(db_word(&input.state)?),
        issue_id: Set(input.issue_id),
        check_fingerprint: Set(String::new()),
        check_revision: Set(0),
        created_at: Set(input.at),
        updated_at: Set(input.at),
    };
    let on_conflict = OnConflict::columns([pull::Column::Repo, pull::Column::Number])
        .update_columns([
            pull::Column::Platform,
            pull::Column::Url,
            pull::Column::Branch,
            pull::Column::Base,
            pull::Column::State,
            pull::Column::UpdatedAt,
        ])
        .value(
            pull::Column::IssueId,
            Expr::expr(Func::coalesce([
                Expr::col((Alias::new("excluded"), pull::Column::IssueId)),
                Expr::col((pull::Entity, pull::Column::IssueId)),
            ])),
        )
        .to_owned();
    let saved = pull::Entity::insert(model).on_conflict(on_conflict).exec_with_returning(db).await?;
    read_pull(saved)
}

async fn set_pull_state_impl<C: ConnectionTrait>(db: &C, id: &str, state: PullRequestState, at: i64) -> DbResult<PullRecord> {
    let state_word = db_word(&state)?;
    let rows = Update::many(pull::Entity)
        .col_expr(pull::Column::State, Expr::value(state_word))
        .col_expr(pull::Column::UpdatedAt, Expr::value(at))
        .filter(pull::Column::Id.eq(id))
        .exec_with_returning(db)
        .await?;
    let saved = rows.into_iter().next().ok_or_else(|| DbError::not_found(format!("pull {id} not found")))?;
    read_pull(saved)
}

async fn observe_pull_checks_impl<C: ConnectionTrait>(db: &C, id: &str, fingerprint: &str, revision: i64, at: i64) -> DbResult<PullRecord> {
    let rows = Update::many(pull::Entity)
        .col_expr(pull::Column::CheckFingerprint, Expr::value(fingerprint))
        .col_expr(pull::Column::CheckRevision, Expr::value(revision))
        .col_expr(pull::Column::UpdatedAt, Expr::value(at))
        .filter(pull::Column::Id.eq(id))
        .exec_with_returning(db)
        .await?;
    let saved = rows.into_iter().next().ok_or_else(|| DbError::not_found(format!("pull {id} not found")))?;
    read_pull(saved)
}

async fn keep_pull_event_impl<C: ConnectionTrait>(db: &C, pull_id: &str, key: &str, bot_round_key: Option<&str>, bot_round: Option<i64>) -> DbResult<()> {
    let model = pull_event::ActiveModel {
        pull_id: Set(pull_id.to_owned()),
        key: Set(key.to_owned()),
        bot_round_key: Set(bot_round_key.map(str::to_owned)),
        bot_round: Set(bot_round),
    };
    pull_event::Entity::insert(model).on_conflict_do_nothing().exec(db).await?;
    Ok(())
}

#[derive(Clone)]
pub(crate) struct IssueService {
    db: Arc<Database>,
}

impl IssueService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn all(&self) -> DbResult<Vec<Issue>> {
        all_issues_impl(self.db.read_conn()).await
    }

    pub(crate) async fn get(&self, id: &str) -> DbResult<Option<Issue>> {
        get_issue_impl(self.db.read_conn(), id).await
    }

    /// Resolves a single issue by `id`, `number`, or `#number` using primary/unique index lookups.
    pub(crate) async fn get_by_ref(&self, reference: &str) -> DbResult<Option<Issue>> {
        let trimmed = reference.trim();
        let stripped = trimmed.trim_start_matches('#');
        if stripped.is_empty() {
            return Ok(None);
        }
        let looks_numeric = trimmed.starts_with('#') || stripped.bytes().all(|b| b.is_ascii_digit());
        if looks_numeric && let Ok(number) = stripped.parse::<i64>() {
            if let Some(row) = issue::Entity::find().filter(issue::Column::Number.eq(number)).one(self.db.read_conn()).await? {
                return read_issue(row).map(Some);
            }
            return get_issue_impl(self.db.read_conn(), stripped).await;
        }
        if let Some(found) = get_issue_impl(self.db.read_conn(), stripped).await? {
            return Ok(Some(found));
        }
        if let Ok(number) = stripped.parse::<i64>() {
            return issue::Entity::find()
                .filter(issue::Column::Number.eq(number))
                .one(self.db.read_conn())
                .await?
                .map(read_issue)
                .transpose();
        }
        Ok(None)
    }

    /// Loads all descendant sub-issues of `root_id` via indexed `issue_parent` traversal.
    pub(crate) async fn list_descendants(&self, root_id: &str) -> DbResult<Vec<Issue>> {
        let mut out = Vec::new();
        let mut visited: HashSet<String> = HashSet::from([root_id.to_owned()]);
        let mut frontier: Vec<String> = vec![root_id.to_owned()];
        while !frontier.is_empty() {
            let mut next = Vec::new();
            for chunk in frontier.chunks(MAX_SQL_BIND_PARAMS) {
                let rows = issue::Entity::find()
                    .filter(issue::Column::Parent.is_in(chunk.iter().cloned()))
                    .order_by_asc(issue::Column::Number)
                    .all(self.db.read_conn())
                    .await?;
                for row in rows {
                    let item = read_issue(row)?;
                    if visited.insert(item.id.clone()) {
                        next.push(item.id.clone());
                        out.push(item);
                    }
                }
            }
            frontier = next;
        }
        Ok(out)
    }

    /// Loads the active board window: all open issues (`closed_at IS NULL`), the latest
    /// `keep_closed` closed top-level issues and their descendants, plus any explicit `include_ids`
    /// (e.g. issues currently bound to active sessions). Avoids deserializing archived history.
    pub(crate) async fn list_board_window(&self, keep_closed: usize, include_ids: &[String]) -> DbResult<Vec<Issue>> {
        self.db
            .query_metrics()
            .observe("issue.list_board_window", "SELECT issue (board window)", async {
                list_board_window_impl(self.db.read_conn(), keep_closed, include_ids).await
            })
            .await
    }

    async fn list_board_window_in_tx(&self, tx: &Tx, keep_closed: usize, include_ids: &[String]) -> DbResult<Vec<Issue>> {
        self.db
            .query_metrics()
            .observe("issue.list_board_window", "SELECT issue (board window)", async {
                list_board_window_impl(tx, keep_closed, include_ids).await
            })
            .await
    }

    /// Reads active sessions and the board issue window inside one consistent read transaction
    /// so slice projections never observe a torn `(session, issue)` pair across a concurrent commit.
    pub(crate) async fn board_projection_snapshot(
        &self,
        sessions: &super::SessionService,
        keep_closed: usize,
    ) -> DbResult<(Vec<vibevalley_protocol::Session>, Vec<Issue>)> {
        let tx = crate::db::begin_read_tx(self.db.read_conn()).await?;
        let result = async {
            let raw_sessions = sessions.all_in_tx(&tx).await?;
            let active_issue_ids: Vec<String> = raw_sessions
                .iter()
                .filter_map(|s| s.issue_id().map(str::to_owned))
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let raw_issues = self.list_board_window_in_tx(&tx, keep_closed, &active_issue_ids).await?;
            Ok::<_, DbError>((raw_sessions, raw_issues))
        }
        .await;
        let _ = crate::db::rollback_tx(tx).await;
        result
    }

    pub(crate) async fn get_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<Issue>> {
        get_issue_impl(tx, id).await
    }

    pub(crate) async fn find_by_body_note_id(&self, note_id: &str) -> DbResult<Option<Issue>> {
        issue::Entity::find()
            .filter(issue::Column::BodyNoteId.eq(note_id))
            .one(self.db.read_conn())
            .await?
            .map(read_issue)
            .transpose()
    }

    pub(crate) async fn list_without_body_note(&self) -> DbResult<Vec<Issue>> {
        issue::Entity::find()
            .filter(issue::Column::BodyNoteId.is_null())
            .filter(issue::Column::Description.ne(""))
            .all(self.db.read_conn())
            .await?
            .into_iter()
            .map(read_issue)
            .collect()
    }

    pub(crate) async fn put(&self, issue: &Issue) -> DbResult<()> {
        put_issue_impl(self.db.write_conn(), issue).await
    }

    pub(crate) async fn put_in_tx(&self, tx: &Tx, issue: &Issue) -> DbResult<()> {
        put_issue_impl(tx, issue).await
    }

    pub(crate) async fn put_batch(&self, issues: &[Issue]) -> DbResult<()> {
        if issues.is_empty() {
            return Ok(());
        }
        with_write_tx(&self.db, async |tx| put_issues_batch_impl(tx, issues).await).await
    }

    pub(crate) async fn remove(&self, id: &str) -> DbResult<()> {
        super::delete_by_id::<issue::Entity, _>(self.db.write_conn(), id).await
    }

    pub(crate) async fn keep_words(&self, issue_id: &str, words: &str) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            let Some(raw) = issue::Entity::find_by_id(issue_id.to_owned())
                .select_only()
                .column(issue::Column::QueuedWords)
                .into_tuple::<String>()
                .one(tx)
                .await?
            else {
                return Ok(());
            };
            let mut kept: Vec<String> = read_db_json(raw)?;
            kept.push(words.to_owned());
            Update::many(issue::Entity)
                .col_expr(issue::Column::QueuedWords, Expr::value(db_json(&kept)?))
                .filter(issue::Column::Id.eq(issue_id))
                .exec(tx)
                .await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn take_words(&self, issue_id: &str) -> DbResult<Vec<String>> {
        with_write_tx(&self.db, async |tx| {
            let Some(raw) = issue::Entity::find_by_id(issue_id.to_owned())
                .select_only()
                .column(issue::Column::QueuedWords)
                .into_tuple::<String>()
                .one(tx)
                .await?
            else {
                return Ok(Vec::new());
            };
            let kept: Vec<String> = read_db_json(raw)?;
            if !kept.is_empty() {
                Update::many(issue::Entity)
                    .col_expr(issue::Column::QueuedWords, Expr::value("[]"))
                    .filter(issue::Column::Id.eq(issue_id))
                    .exec(tx)
                    .await?;
            }
            Ok(kept)
        })
        .await
    }

    pub(crate) async fn list_pulls(&self) -> DbResult<Vec<PullRecord>> {
        pull::Entity::find()
            .order_by_asc(pull::Column::CreatedAt)
            .order_by_asc(pull::Column::Id)
            .all(self.db.read_conn())
            .await?
            .into_iter()
            .map(read_pull)
            .collect()
    }

    pub(crate) async fn upsert_pull(&self, input: UpsertPullInput) -> DbResult<PullRecord> {
        upsert_pull_impl(self.db.write_conn(), input).await
    }

    pub(crate) async fn set_pull_state(&self, id: &str, state: PullRequestState, at: i64) -> DbResult<PullRecord> {
        set_pull_state_impl(self.db.write_conn(), id, state, at).await
    }

    pub(crate) async fn observe_pull_checks(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> DbResult<PullRecord> {
        observe_pull_checks_impl(self.db.write_conn(), id, fingerprint, revision, at).await
    }

    pub(crate) async fn known_pull_events(&self, pull_id: &str) -> DbResult<Vec<KnownPullEvent>> {
        let rows = pull_event::Entity::find()
            .filter(pull_event::Column::PullId.eq(pull_id))
            .all(self.db.read_conn())
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| KnownPullEvent {
                key: r.key,
                bot_round_key: r.bot_round_key,
                bot_round: r.bot_round,
            })
            .collect())
    }

    pub(crate) async fn keep_pull_event(&self, pull_id: &str, key: &str, bot_round_key: Option<&str>, bot_round: Option<i64>) -> DbResult<()> {
        keep_pull_event_impl(self.db.write_conn(), pull_id, key, bot_round_key, bot_round).await
    }

    /// Deletes up to `limit` `pull_event` rows belonging to closed/merged pulls with `updated_at < before_ms`.
    pub(crate) async fn prune_closed_pull_events_batch(&self, before_ms: i64, limit: u64) -> DbResult<u64> {
        if limit == 0 {
            return Ok(0);
        }
        with_write_tx(&self.db, async |tx| {
            let pull_ids: Vec<String> = pull::Entity::find()
                .select_only()
                .column(pull::Column::Id)
                .filter(pull::Column::State.is_in(["merged", "closed"]))
                .filter(pull::Column::UpdatedAt.lt(before_ms))
                .into_tuple()
                .all(tx)
                .await?;
            if pull_ids.is_empty() {
                return Ok(0);
            }
            let mut remaining = usize::try_from(limit).unwrap_or(usize::MAX);
            let mut pairs: Vec<(String, String)> = Vec::new();
            for chunk in pull_ids.chunks(super::MAX_SQL_BIND_PARAMS) {
                if remaining == 0 {
                    break;
                }
                let batch: Vec<(String, String)> = pull_event::Entity::find()
                    .select_only()
                    .columns([pull_event::Column::PullId, pull_event::Column::Key])
                    .filter(pull_event::Column::PullId.is_in(chunk.iter().cloned()))
                    .order_by_asc(pull_event::Column::PullId)
                    .order_by_asc(pull_event::Column::Key)
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
            let mut by_pull: HashMap<String, Vec<String>> = HashMap::new();
            for (pull_id, key) in pairs {
                by_pull.entry(pull_id).or_default().push(key);
            }
            let mut deleted = 0u64;
            for (pull_id, keys) in by_pull {
                for key_chunk in keys.chunks(super::MAX_SQL_BIND_PARAMS - 1) {
                    let res = pull_event::Entity::delete_many()
                        .filter(pull_event::Column::PullId.eq(&pull_id))
                        .filter(pull_event::Column::Key.is_in(key_chunk.iter().cloned()))
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

async fn list_board_window_impl(conn: &impl ConnectionTrait, keep_closed: usize, include_ids: &[String]) -> DbResult<Vec<Issue>> {
    let mut by_id: HashMap<String, Issue> = HashMap::new();

    // 1. All non-closed issues.
    let open_rows = issue::Entity::find()
        .filter(issue::Column::ClosedAt.is_null())
        .order_by_asc(issue::Column::Number)
        .all(conn)
        .await?;
    for row in open_rows {
        let item = read_issue(row)?;
        by_id.insert(item.id.clone(), item);
    }

    // 2. Latest `keep_closed` closed top-level issues.
    if keep_closed > 0 {
        let recent_closed = issue::Entity::find()
            .filter(issue::Column::Parent.is_null())
            .filter(issue::Column::ClosedAt.is_not_null())
            .order_by_desc(issue::Column::ClosedAt)
            .order_by_desc(issue::Column::Number)
            .limit(keep_closed as u64)
            .all(conn)
            .await?;
        for row in recent_closed {
            let item = read_issue(row)?;
            by_id.insert(item.id.clone(), item);
        }
    }

    // 3. Closed descendants of retained issues.
    let mut frontier: Vec<String> = by_id.keys().cloned().collect();
    let mut expanded: HashSet<String> = frontier.iter().cloned().collect();
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for chunk in frontier.chunks(MAX_SQL_BIND_PARAMS) {
            let rows = issue::Entity::find()
                .filter(issue::Column::Parent.is_in(chunk.iter().cloned()))
                .filter(issue::Column::ClosedAt.is_not_null())
                .all(conn)
                .await?;
            for row in rows {
                let item = read_issue(row)?;
                if expanded.insert(item.id.clone()) {
                    next.push(item.id.clone());
                }
                by_id.entry(item.id.clone()).or_insert(item);
            }
        }
        frontier = next;
    }

    // 4. Any explicitly requested IDs (e.g. issues bound to active sessions).
    let missing_ids: Vec<String> = include_ids.iter().filter(|id| !by_id.contains_key(id.as_str())).cloned().collect();
    for chunk in missing_ids.chunks(MAX_SQL_BIND_PARAMS) {
        let rows = issue::Entity::find().filter(issue::Column::Id.is_in(chunk.iter().cloned())).all(conn).await?;
        for row in rows {
            let item = read_issue(row)?;
            by_id.insert(item.id.clone(), item);
        }
    }

    let mut out: Vec<Issue> = by_id.into_values().collect();
    out.sort_by_key(|i| i.number);
    Ok(out)
}
