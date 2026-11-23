//! SQLite storage and synchronous in-memory index for tracked pull requests.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use vibevalley_protocol::{ApiError, PublishPlatform, PullRequest, PullRequestState};

use crate::base::{ServerDb, internal};
use crate::modules::infra::column::{read_word, word};

use crate::db::generated::work_pull as queries;

pub const SCHEMA: &str = crate::db::schema::WORK_PULL;

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

fn record_of(r: queries::ListPullsRow) -> sqlx::Result<PullRecord> {
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
    pub fn open(db: Arc<ServerDb>) -> Result<PullStore, ApiError> {
        let rows: Vec<PullRecord> = db
            .run(async |conn| queries::list_pulls(conn).await)
            .map_err(internal)?
            .into_iter()
            .map(record_of)
            .collect::<sqlx::Result<_>>()
            .map_err(internal)?;
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
        let params = queries::UpsertPullParams {
            id: uuid::Uuid::now_v7().to_string(),
            platform: word(&input.platform).map_err(internal)?,
            repo: input.repo,
            number: input.number,
            url: input.url,
            branch: input.branch,
            base: input.base,
            state: word(&input.state).map_err(internal)?,
            issue_id: input.issue_id,
            created_at: input.at,
            updated_at: input.at,
        };
        let mut conn = self.db.acquire_write().await.map_err(internal)?;
        let saved = queries::upsert_pull(&mut *conn, params).await.and_then(record_of).map_err(internal)?;
        drop(conn);
        Ok(self.index.lock().put(saved))
    }

    pub fn upsert(&self, input: UpsertPullInput) -> Result<PullRecord, ApiError> {
        let params = queries::UpsertPullParams {
            id: uuid::Uuid::now_v7().to_string(),
            platform: word(&input.platform).map_err(internal)?,
            repo: input.repo,
            number: input.number,
            url: input.url,
            branch: input.branch,
            base: input.base,
            state: word(&input.state).map_err(internal)?,
            issue_id: input.issue_id,
            created_at: input.at,
            updated_at: input.at,
        };
        let saved = self
            .db
            .run(async |conn| queries::upsert_pull(conn, params).await)
            .and_then(record_of)
            .map_err(internal)?;
        Ok(self.index.lock().put(saved))
    }

    pub async fn set_state_async(&self, id: &str, state: PullRequestState, at: i64) -> Result<PullRecord, ApiError> {
        let params = queries::SetPullStateParams {
            id: id.into(),
            state: word(&state).map_err(internal)?,
            updated_at: at,
        };
        let mut conn = self.db.acquire_write().await.map_err(internal)?;
        let saved = queries::set_pull_state(&mut *conn, params).await.and_then(record_of).map_err(internal)?;
        drop(conn);
        Ok(self.index.lock().put(saved))
    }

    pub fn set_state(&self, id: &str, state: PullRequestState, at: i64) -> Result<PullRecord, ApiError> {
        let params = queries::SetPullStateParams {
            id: id.into(),
            state: word(&state).map_err(internal)?,
            updated_at: at,
        };
        let saved = self
            .db
            .run(async |conn| queries::set_pull_state(conn, params).await)
            .and_then(record_of)
            .map_err(internal)?;
        Ok(self.index.lock().put(saved))
    }

    pub async fn observe_checks_async(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> Result<PullRecord, ApiError> {
        let params = queries::ObservePullChecksParams {
            id: id.into(),
            check_fingerprint: fingerprint.into(),
            check_revision: revision,
            updated_at: at,
        };
        let mut conn = self.db.acquire_write().await.map_err(internal)?;
        let saved = queries::observe_pull_checks(&mut *conn, params).await.and_then(record_of).map_err(internal)?;
        drop(conn);
        Ok(self.index.lock().put(saved))
    }

    pub fn observe_checks(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> Result<PullRecord, ApiError> {
        let params = queries::ObservePullChecksParams {
            id: id.into(),
            check_fingerprint: fingerprint.into(),
            check_revision: revision,
            updated_at: at,
        };
        let saved = self
            .db
            .run(async |conn| queries::observe_pull_checks(conn, params).await)
            .and_then(record_of)
            .map_err(internal)?;
        Ok(self.index.lock().put(saved))
    }

    pub async fn known_events_async(&self, pull_id: &str) -> Result<Vec<KnownPullEvent>, ApiError> {
        let mut conn = self.db.acquire_read_async().await.map_err(internal)?;
        let rows = queries::known_pull_events(&mut *conn, queries::KnownPullEventsParams { pull_id: pull_id.into() })
            .await
            .map_err(internal)?;
        Ok(rows
            .into_iter()
            .map(|r| KnownPullEvent {
                key: r.key,
                bot_round_key: r.bot_round_key,
                bot_round: r.bot_round,
            })
            .collect())
    }

    pub fn known_events(&self, pull_id: &str) -> Result<Vec<KnownPullEvent>, ApiError> {
        let rows = self
            .db
            .run(async |conn| queries::known_pull_events(conn, queries::KnownPullEventsParams { pull_id: pull_id.into() }).await)
            .map_err(internal)?;
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
        let mut conn = self.db.acquire_write().await.map_err(internal)?;
        queries::keep_pull_event(
            &mut *conn,
            queries::KeepPullEventParams {
                pull_id: pull_id.into(),
                key: key.into(),
                bot_round_key: bot_round_key.map(str::to_owned),
                bot_round,
            },
        )
        .await
        .map_err(internal)
    }

    pub fn keep_event(&self, pull_id: &str, key: &str, bot_round_key: Option<&str>, bot_round: Option<i64>) -> Result<(), ApiError> {
        self.db
            .run(async |conn| {
                queries::keep_pull_event(
                    conn,
                    queries::KeepPullEventParams {
                        pull_id: pull_id.into(),
                        key: key.into(),
                        bot_round_key: bot_round_key.map(str::to_owned),
                        bot_round,
                    },
                )
                .await
            })
            .map_err(internal)
    }
}
