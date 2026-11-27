//! Issue state coordination (`IssueState`): serializes issue read-modify-write
//! transitions through `ctx.service.issue` and `ctx.service.session`, overlays
//! live session state, and marks dirty slices on `ctx.feed`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use vibevalley_core::{
    BOARD_KEEP_CLOSED_ISSUES, BoardInput, LiveSnapshot, SessionInput, SliceMask, derive_issues, derive_single_issue, overlay_sessions, project_board,
    project_sessions,
};
use vibevalley_protocol::{Issue, PullRequest, Session, SliceBundle};

use crate::context::{Context, now};
use crate::runtime::{RuntimeError, derive_all_issues};
use crate::service::{DatabaseConfig, Service};

pub use crate::runtime::{BoardConfig, BoardError, IssueChange, Opened, Result, Step, Undelivered};

pub type CronOfIssue = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type PullOfIssue = Arc<dyn Fn(&str) -> Option<PullRequest> + Send + Sync>;

/// Lightweight issue/session state coordinator backed by [`Context`] and [`Service`].
///
/// Uses per-issue sharded async locks (completely decoupled from `SessionEngine`'s lock)
/// so unrelated issue edits and session turns never serialize against each other.
pub struct IssueState {
    ctx: Arc<Context>,
    issue_locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    cron_of_issue: Mutex<Option<CronOfIssue>>,
    pull_of_issue: Mutex<Option<PullOfIssue>>,
}

impl IssueState {
    pub fn new(ctx: Arc<Context>) -> Self {
        Self {
            ctx,
            issue_locks: Mutex::new(HashMap::new()),
            cron_of_issue: Mutex::new(None),
            pull_of_issue: Mutex::new(None),
        }
    }

    async fn lock_issue(&self, id: &str) -> OwnedMutexGuard<()> {
        let mutex = {
            let mut locks = self.issue_locks.lock();
            if let Some(existing) = locks.get(id).and_then(Weak::upgrade) {
                existing
            } else {
                locks.retain(|_, w| w.strong_count() > 0);
                let created = Arc::new(AsyncMutex::new(()));
                locks.insert(id.to_owned(), Arc::downgrade(&created));
                created
            }
        };
        mutex.lock_owned().await
    }

    async fn lock_issues_sorted(&self, ids: impl IntoIterator<Item = String>) -> Vec<OwnedMutexGuard<()>> {
        let sorted: BTreeSet<String> = ids.into_iter().collect();
        let mut guards = Vec::with_capacity(sorted.len());
        for id in sorted {
            guards.push(self.lock_issue(&id).await);
        }
        guards
    }

    /// Reads the board as stored without taking its lock, for inspection while
    /// another process holds it.
    pub async fn snapshot_async(path: &Path) -> Result<SliceBundle> {
        let service = Service::open_config(&DatabaseConfig::Sqlite { path: path.to_path_buf() }).await?;
        let stored_sessions = service.session.all().await?;
        let stored_issues = service.issue.all().await?;
        service.close().await;
        let derived_issues = derive_issues(&stored_issues, &stored_sessions);
        let live = LiveSnapshot::default();
        let board = project_board(
            &BoardInput {
                issues: derived_issues.clone(),
                sessions: stored_sessions.clone(),
                ..Default::default()
            },
            &live,
            0,
        );
        let sessions_slice = project_sessions(
            &SessionInput {
                sessions: stored_sessions,
                issues: derived_issues,
                ..Default::default()
            },
            &live,
            0,
        );
        let empty = vibevalley_core::slice_bundle(&vibevalley_core::empty_space_state(), vec![], 0);
        Ok(SliceBundle {
            seq: 0,
            board,
            sessions: sessions_slice,
            collab: empty.collab,
            inbox: empty.inbox,
            ops: empty.ops,
            farm: empty.farm,
        })
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.ctx
    }

    pub fn seq(&self) -> i64 {
        self.ctx.feed.seq()
    }

    pub fn mark_dirty(&self, dirty: SliceMask) -> i64 {
        self.ctx.mark_dirty(dirty)
    }

    /// Registers the owner-backed `Issue.cron` projection and marks slices dirty.
    pub async fn use_cron_of_issue_async(&self, lookup: CronOfIssue) {
        *self.cron_of_issue.lock() = Some(lookup);
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    /// Registers the owner-backed `Issue.pull_request` projection and marks slices dirty.
    pub async fn use_pull_of_issue_async(&self, lookup: PullOfIssue) {
        *self.pull_of_issue.lock() = Some(lookup);
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    /// Marks slices dirty so `cron` and `pull_request` projections refresh without touching SQLite.
    pub async fn refresh_issue_async(&self, _id: &str) {
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    fn enrich_issue(&self, issue: &mut Issue) {
        if let Some(lookup) = self.cron_of_issue.lock().as_ref() {
            issue.cron = lookup(&issue.id);
        }
        if let Some(lookup) = self.pull_of_issue.lock().as_ref() {
            issue.pull_request = lookup(&issue.id);
        }
    }

    pub async fn raw_issues_async(&self) -> Result<Vec<Issue>> {
        let mut issues = self.ctx.service.issue.all().await?;
        for issue in &mut issues {
            self.enrich_issue(issue);
        }
        Ok(issues)
    }

    /// Loads only the active board window (open issues + latest closed window + active session issues)
    /// for slice projections, avoiding full-table reads of archived closed issues.
    pub async fn raw_issues_for_board_async(&self, include_ids: &[String]) -> Result<Vec<Issue>> {
        let mut issues = self.ctx.service.issue.list_board_window(BOARD_KEEP_CLOSED_ISSUES, include_ids).await?;
        for issue in &mut issues {
            self.enrich_issue(issue);
        }
        Ok(issues)
    }

    /// Loads active sessions and the board issue window from a single consistent read transaction
    /// and enriches issues with in-memory `cron` / `pull_request` metadata.
    pub async fn projection_snapshot_async(&self) -> Result<(Vec<Session>, Vec<Issue>)> {
        let (raw_sessions, mut raw_issues) = self
            .ctx
            .service
            .issue
            .board_projection_snapshot(&self.ctx.service.session, BOARD_KEEP_CLOSED_ISSUES)
            .await?;
        for issue in &mut raw_issues {
            self.enrich_issue(issue);
        }
        Ok((raw_sessions, raw_issues))
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        let stored = self.ctx.service.session.all().await?;
        let overlays = self.ctx.live.core_session_overlays();
        Ok(overlay_sessions(&stored, &overlays))
    }

    pub async fn issues_async(&self) -> Result<Vec<Issue>> {
        let (raw_issues, sessions) = tokio::try_join!(self.raw_issues_async(), self.sessions_async())?;
        Ok(derive_all_issues(&raw_issues, &sessions))
    }

    async fn derive_single_issue_async(&self, mut target: Issue) -> Result<Issue> {
        self.enrich_issue(&mut target);
        let mut descendants = self.ctx.service.issue.list_descendants(&target.id).await?;
        for child in &mut descendants {
            self.enrich_issue(child);
        }
        let mut session_ids: HashSet<String> = HashSet::new();
        let mut issue_ids: Vec<String> = Vec::with_capacity(1 + descendants.len());
        issue_ids.push(target.id.clone());
        if let Some(sid) = target.latest_session_id() {
            session_ids.insert(sid.clone());
        }
        for child in &descendants {
            issue_ids.push(child.id.clone());
            if let Some(sid) = child.latest_session_id() {
                session_ids.insert(sid.clone());
            }
        }
        let sid_vec: Vec<String> = session_ids.into_iter().collect();
        let stored_sessions = self.ctx.service.sessions_for_issues(&sid_vec, &issue_ids).await?;
        let overlays = self.ctx.live.core_session_overlays();
        let sessions = overlay_sessions(&stored_sessions, &overlays);
        Ok(derive_single_issue(&target, &descendants, &sessions))
    }

    /// By id, number or `#number`. Uses indexed lookup + local subtree derivation (no full-table scan).
    pub async fn issue_async(&self, reference: &str) -> Result<Option<Issue>> {
        let Some(target) = self.ctx.service.issue.get_by_ref(reference).await? else {
            return Ok(None);
        };
        Ok(Some(self.derive_single_issue_async(target).await?))
    }

    pub async fn session_async(&self, id: &str) -> Result<Option<Session>> {
        let Some(stored) = self.ctx.service.session.get(id).await? else {
            return Ok(None);
        };
        let overlays = self.ctx.live.core_session_overlays();
        Ok(overlay_sessions(&[stored], &overlays).into_iter().next())
    }

    /// A session that left the board, as it was when it did.
    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.ctx.service.session.past(id).await.ok().flatten()
    }

    /// Applies `change` to issue `id` under a per-issue sharded lock (no full-table scan, no
    /// cross-issue or cross-session lock contention) and returns the locally derived issue.
    pub async fn change_async(&self, id: &str, change: IssueChange) -> Result<Issue> {
        let dirty = change.dirty_mask();
        let record_episode = matches!(change, IssueChange::Delivered(..) | IssueChange::MergedIntoParent { .. });
        let resolved_id = self.ctx.service.issue.get_by_ref(id).await?.ok_or_else(|| RuntimeError::NoIssue(id.into()))?.id;

        let (saved_issue, enqueued_episode) = {
            let _issue_guard = self.lock_issue(&resolved_id).await;
            let mut issue = self
                .ctx
                .service
                .issue
                .get(&resolved_id)
                .await?
                .ok_or_else(|| RuntimeError::NoIssue(id.into()))?;
            self.enrich_issue(&mut issue);
            let session = if record_episode && let Some(sid) = issue.latest_session_id() {
                match self.ctx.service.session.get(sid).await.ok().flatten() {
                    Some(s) => Some(s),
                    None => self.past_session_async(sid).await,
                }
            } else {
                None
            };
            let at = now();
            change.fold(&mut issue, at);
            let episode = record_episode.then(|| {
                let agent = issue
                    .assigned_agent()
                    .map(str::to_string)
                    .or_else(|| session.as_ref().and_then(|s| s.profile.clone()))
                    .unwrap_or_else(|| vibevalley_protocol::DEFAULT_ORCHESTRATOR.to_string());
                let title_text = vibevalley_core::text::clip(&issue.title, 120);
                let title = format!("#{} {title_text}", issue.number);
                let summary = session
                    .as_ref()
                    .and_then(|s| s.last_run.as_ref())
                    .map(|r| r.summary.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| issue.answer.as_ref().map(|a| a.conclusion.as_str()).filter(|s| !s.trim().is_empty()))
                    .or_else(|| (!issue.description.trim().is_empty()).then_some(issue.description.as_str()));
                let text = match summary {
                    Some(s) => format!("{title}：{}", vibevalley_core::text::clip(s, 600)),
                    None => title.clone(),
                };
                crate::context::OutboxEvent::IssueEpisode {
                    agent,
                    title: Some(title),
                    text,
                    repo: issue.repo.clone(),
                    session: issue.latest_session_id().cloned(),
                }
            });
            let to_save = issue.clone();
            let issue_svc = self.ctx.service.issue.clone();
            let outbox = self.ctx.outbox.clone();
            let has_episode = episode.is_some();
            let (_, written_dirty) = self
                .ctx
                .service
                .write_dirty_with(RuntimeError::Store, |tx| {
                    Box::pin(async move {
                        issue_svc.put_in_tx(tx, &to_save).await?;
                        if let Some(ev) = episode {
                            outbox.enqueue_event_in_tx(tx, &ev).await.map_err(RuntimeError::Api)?;
                        }
                        Ok(((), dirty))
                    })
                })
                .await?;
            self.ctx.mark_dirty(written_dirty);
            (issue, has_episode)
        };
        if enqueued_episode {
            self.ctx.outbox.wake();
        }
        self.derive_single_issue_async(saved_issue).await
    }

    pub async fn put_issues_async(&self, issues: &[Issue]) -> Result<()> {
        let _guards = self.lock_issues_sorted(issues.iter().map(|i| i.id.clone())).await;
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        self.ctx.service.issue.put_batch(issues).await?;
        self.ctx.mark_dirty(dirty);
        Ok(())
    }

    pub async fn remove_issue_async(&self, id: &str) -> Result<()> {
        let _guard = self.lock_issue(id).await;
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        self.ctx.service.issue.remove(id).await?;
        self.ctx.mark_dirty(dirty);
        Ok(())
    }

    /// The next sequence number for `counter`, strictly above `at_least`.
    /// Serialized atomically by the database `seq_counter` UPSERT (no global process lock).
    pub async fn next_async(&self, counter: &str, at_least: i64) -> Result<i64> {
        Ok(self.ctx.service.next_seq(counter, at_least).await?)
    }

    pub async fn keep_words_async(&self, id: &str, words: &str) -> Result<()> {
        self.ctx.service.issue.keep_words(id, words).await?;
        Ok(())
    }

    pub async fn take_words_async(&self, id: &str) -> Result<Option<String>> {
        let kept = self.ctx.service.issue.take_words(id).await?;
        Ok((!kept.is_empty()).then(|| kept.join("\n\n")))
    }

    /// Associates a lazily materialized Block Doc body note with an issue.
    pub async fn set_body_note_id_async(&self, id: &str, note_id: String) -> Result<Issue> {
        let saved = {
            let _guard = self.lock_issue(id).await;
            let mut issue = self.ctx.service.issue.get(id).await?.ok_or_else(|| RuntimeError::NoIssue(id.to_owned()))?;
            if issue.body_note_id.as_deref() != Some(note_id.as_str()) {
                issue.body_note_id = Some(note_id);
                let issue_svc = self.ctx.service.issue.clone();
                let to_save = issue.clone();
                self.ctx
                    .service
                    .write_dirty_with(RuntimeError::Store, |tx| {
                        Box::pin(async move {
                            issue_svc.put_in_tx(tx, &to_save).await?;
                            Ok(((), SliceMask::BOARD | SliceMask::INBOX))
                        })
                    })
                    .await?;
                self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX);
            }
            issue
        };
        self.derive_single_issue_async(saved).await
    }
}
