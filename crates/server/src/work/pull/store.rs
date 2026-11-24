//! Dual-backend SeaORM storage and synchronous in-memory index for tracked pull requests.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Update};
use vibevalley_protocol::{ApiError, PublishPlatform, PullRequest, PullRequestState};

use crate::db::ServerDb;
use crate::db::column::{db_word as word, read_db_word as read_word};
use crate::db::entities::work_pull::{pull, pull_event};
use crate::db::error::internal_db;

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

fn record_of(r: pull::Model) -> Result<PullRecord, DbErr> {
    Ok(PullRecord {
        id: r.id,
        platform: read_word(r.platform)?,
        repo: r.repo,
        number: r.number,
        url: r.url,
        branch: r.branch,
        base: r.base,
        state: read_word(r.state)?,
        issue_id: r.issue_id,
        check_fingerprint: r.check_fingerprint,
        check_revision: r.check_revision,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

fn prefers_for_issue(candidate: &PullRecord, current: &PullRecord) -> bool {
    let cand_open = candidate.state == PullRequestState::Open;
    let curr_open = current.state == PullRequestState::Open;
    if cand_open != curr_open {
        return cand_open;
    }
    if candidate.updated_at != current.updated_at {
        return candidate.updated_at > current.updated_at;
    }
    candidate.number >= current.number
}

#[derive(Default)]
pub struct PullIndex {
    by_id: HashMap<String, PullRecord>,
    by_repo_number: HashMap<(String, i64), PullRecord>,
    by_issue: HashMap<String, PullRecord>,
}

impl PullIndex {
    pub fn load(&mut self, rows: Vec<PullRecord>) {
        self.by_id.clear();
        self.by_repo_number.clear();
        self.by_issue.clear();
        for row in rows {
            self.put(row);
        }
    }

    pub fn put(&mut self, next: PullRecord) -> PullRecord {
        let previous = self.by_id.get(&next.id).cloned();
        if let Some(prev) = &previous {
            self.by_repo_number.remove(&(prev.repo.clone(), prev.number));
        }
        self.by_id.insert(next.id.clone(), next.clone());
        self.by_repo_number.insert((next.repo.clone(), next.number), next.clone());
        if let Some(prev_issue) = previous.as_ref().and_then(|p| p.issue_id.as_deref())
            && next.issue_id.as_deref() != Some(prev_issue)
        {
            self.recompute_issue(prev_issue);
        }
        if let Some(issue_id) = next.issue_id.as_deref() {
            self.recompute_issue(issue_id);
        }
        next
    }

    fn recompute_issue(&mut self, issue_id: &str) {
        let mut best: Option<&PullRecord> = None;
        for item in self.by_id.values() {
            if item.issue_id.as_deref() != Some(issue_id) {
                continue;
            }
            if best.is_none_or(|curr| prefers_for_issue(item, curr)) {
                best = Some(item);
            }
        }
        if let Some(best) = best.cloned() {
            self.by_issue.insert(issue_id.into(), best);
        } else {
            self.by_issue.remove(issue_id);
        }
    }

    pub fn of_issue(&self, issue_id: &str) -> Option<PullRequest> {
        let found = self.by_issue.get(issue_id)?;
        Some(PullRequest {
            url: found.url.clone(),
            number: found.number,
            state: found.state,
        })
    }

    pub fn find(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.by_repo_number.get(&(repo.into(), number)).cloned()
    }

    pub fn all(&self) -> Vec<PullRecord> {
        let mut items: Vec<PullRecord> = self.by_id.values().cloned().collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        items
    }

    pub fn open(&self) -> Vec<PullRecord> {
        let mut items: Vec<PullRecord> = self.by_id.values().filter(|item| item.state == PullRequestState::Open).cloned().collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        items
    }
}

pub struct PullStore {
    db: Arc<ServerDb>,
    index: Arc<Mutex<PullIndex>>,
}

impl PullStore {
    pub async fn open_async(db: Arc<ServerDb>) -> Result<PullStore, ApiError> {
        let rows: Vec<PullRecord> = pull::Entity::find()
            .order_by_asc(pull::Column::CreatedAt)
            .order_by_asc(pull::Column::Id)
            .all(db.read_conn())
            .await
            .map_err(internal_db)?
            .into_iter()
            .map(record_of)
            .collect::<Result<Vec<_>, DbErr>>()
            .map_err(internal_db)?;
        let mut index = PullIndex::default();
        index.load(rows);
        Ok(PullStore {
            db,
            index: Arc::new(Mutex::new(index)),
        })
    }

    pub fn index(&self) -> Arc<Mutex<PullIndex>> {
        self.index.clone()
    }

    pub fn of_issue(&self, issue_id: &str) -> Option<PullRequest> {
        self.index.lock().of_issue(issue_id)
    }

    pub fn find(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.index.lock().find(repo, number)
    }

    pub fn all(&self) -> Vec<PullRecord> {
        self.index.lock().all()
    }

    pub fn open_pulls(&self) -> Vec<PullRecord> {
        self.index.lock().open()
    }

    pub async fn upsert_async(&self, input: UpsertPullInput) -> Result<PullRecord, ApiError> {
        let model = pull::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            platform: Set(word(&input.platform).map_err(internal_db)?),
            repo: Set(input.repo),
            number: Set(input.number),
            url: Set(input.url),
            branch: Set(input.branch),
            base: Set(input.base),
            state: Set(word(&input.state).map_err(internal_db)?),
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
        let saved = pull::Entity::insert(model)
            .on_conflict(on_conflict)
            .exec_with_returning(self.db.write_conn())
            .await
            .map_err(internal_db)?;
        let record = record_of(saved).map_err(internal_db)?;
        Ok(self.index.lock().put(record))
    }

    pub async fn set_state_async(&self, id: &str, state: PullRequestState, at: i64) -> Result<PullRecord, ApiError> {
        let state_word = word(&state).map_err(internal_db)?;
        let rows = Update::many(pull::Entity)
            .col_expr(pull::Column::State, Expr::value(state_word))
            .col_expr(pull::Column::UpdatedAt, Expr::value(at))
            .filter(pull::Column::Id.eq(id))
            .exec_with_returning(self.db.write_conn())
            .await
            .map_err(internal_db)?;
        let saved = rows
            .into_iter()
            .next()
            .ok_or_else(|| internal_db(DbErr::RecordNotFound(format!("pull {id} not found"))))?;
        let record = record_of(saved).map_err(internal_db)?;
        Ok(self.index.lock().put(record))
    }

    pub async fn observe_checks_async(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> Result<PullRecord, ApiError> {
        let rows = Update::many(pull::Entity)
            .col_expr(pull::Column::CheckFingerprint, Expr::value(fingerprint))
            .col_expr(pull::Column::CheckRevision, Expr::value(revision))
            .col_expr(pull::Column::UpdatedAt, Expr::value(at))
            .filter(pull::Column::Id.eq(id))
            .exec_with_returning(self.db.write_conn())
            .await
            .map_err(internal_db)?;
        let saved = rows
            .into_iter()
            .next()
            .ok_or_else(|| internal_db(DbErr::RecordNotFound(format!("pull {id} not found"))))?;
        let record = record_of(saved).map_err(internal_db)?;
        Ok(self.index.lock().put(record))
    }

    pub async fn known_events_async(&self, pull_id: &str) -> Result<Vec<KnownPullEvent>, ApiError> {
        let rows = pull_event::Entity::find()
            .filter(pull_event::Column::PullId.eq(pull_id))
            .all(self.db.read_conn())
            .await
            .map_err(internal_db)?;
        Ok(rows
            .into_iter()
            .map(|r| KnownPullEvent {
                key: r.key,
                bot_round_key: r.bot_round_key,
                bot_round: r.bot_round,
            })
            .collect())
    }

    pub async fn keep_event_async(&self, pull_id: &str, key: &str, bot_round_key: Option<&str>, bot_round: Option<i64>) -> Result<(), ApiError> {
        let model = pull_event::ActiveModel {
            pull_id: Set(pull_id.to_owned()),
            key: Set(key.to_owned()),
            bot_round_key: Set(bot_round_key.map(str::to_owned)),
            bot_round: Set(bot_round),
        };
        pull_event::Entity::insert(model)
            .on_conflict_do_nothing()
            .exec(self.db.write_conn())
            .await
            .map_err(internal_db)?;
        Ok(())
    }
}
