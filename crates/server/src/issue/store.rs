//! Issue state coordination (`IssueState`): serializes issue read-modify-write
//! transitions through `ctx.service.issue` and `ctx.service.session`, overlays
//! live session state, and marks dirty slices on `ctx.feed`.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::Arc;

use vibevalley_core::{
    BOARD_KEEP_CLOSED_ISSUES, BoardInput, LiveSnapshot, SessionInput, SliceMask, derive_issues, derive_single_issue, overlay_sessions, project_board,
    project_sessions,
};
use vibevalley_kit::sync::{KeyLock, KeyLockGuard};
use vibevalley_protocol::{Issue, Millis, Session, SliceBundle};
use vibevalley_runtime::agent::durable::BoxFuture;

pub use super::types::{BoardConfig, BoardError, IssueChange, Result};
pub(crate) use super::types::{best_pull_for_issue, best_pulls_by_issue, derive_all_issues, find_issue};
use crate::context::{Context, now};
use crate::runtime::AtomicTxHook;
pub use crate::runtime::{Opened, Step};
use crate::service::{DatabaseConfig, DbError, Service, Tx};

/// Atomic transaction hook folding an [`IssueChange`] inside a [`crate::runtime::SessionEngine`] transaction.
struct FoldIssueChangeHook {
    service: Arc<Service>,
    issue_id: String,
    change: IssueChange,
}

impl AtomicTxHook for FoldIssueChangeHook {
    fn apply<'a>(self: Box<Self>, tx: &'a Tx, at: Millis) -> BoxFuture<'a, std::result::Result<SliceMask, DbError>> {
        Box::pin(async move {
            let dirty = self.change.dirty_mask();
            if let Some(mut item) = self.service.issue.get_in_tx(tx, &self.issue_id).await? {
                self.change.fold(&mut item, at);
                self.service.issue.put_in_tx(tx, &item).await?;
            }
            Ok(dirty)
        })
    }
}

/// Lightweight issue/session state coordinator backed by [`Context`] and [`Service`].
///
/// Uses per-issue sharded async locks (completely decoupled from `SessionEngine`'s lock)
/// so unrelated issue edits and session turns never serialize against each other.
pub struct IssueState {
    ctx: Arc<Context>,
    issue_locks: KeyLock<String>,
}

impl IssueState {
    pub fn new(ctx: Arc<Context>) -> Self {
        Self {
            ctx,
            issue_locks: KeyLock::new(),
        }
    }

    pub(crate) fn issue_change_hook(&self, issue_id: String, change: IssueChange) -> Box<dyn AtomicTxHook> {
        Box::new(FoldIssueChangeHook {
            service: self.ctx.service.clone(),
            issue_id,
            change,
        })
    }

    async fn lock_issue(&self, id: &str) -> KeyLockGuard<'_, String> {
        self.issue_locks.lock(id.to_owned()).await
    }

    async fn lock_issues_sorted(&self, ids: impl IntoIterator<Item = String>) -> Vec<KeyLockGuard<'_, String>> {
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

    /// Marks board/inbox/farm slices dirty so derived projections refresh.
    pub async fn refresh_issue_async(&self, _id: &str) {
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    pub async fn raw_issues_async(&self) -> Result<Vec<Issue>> {
        Ok(self.ctx.service.issue.all().await?)
    }

    /// Loads only the active board window (open issues + latest closed window + active session issues)
    /// for slice projections, avoiding full-table reads of archived closed issues.
    pub async fn raw_issues_for_board_async(&self, include_ids: &[String]) -> Result<Vec<Issue>> {
        Ok(self.ctx.service.issue.list_board_window(BOARD_KEEP_CLOSED_ISSUES, include_ids).await?)
    }

    /// Loads active sessions and the board issue window from a single consistent read transaction.
    pub async fn projection_snapshot_async(&self) -> Result<(Vec<Session>, Vec<Issue>)> {
        Ok(self
            .ctx
            .service
            .issue
            .board_projection_snapshot(&self.ctx.service.session, BOARD_KEEP_CLOSED_ISSUES)
            .await?)
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        let stored = self.ctx.service.session.all().await?;
        let overlays = self.ctx.live.core_session_overlays();
        Ok(overlay_sessions(&stored, &overlays))
    }

    pub async fn issues_async(&self) -> Result<Vec<Issue>> {
        let (raw_issues, sessions, pulls) = tokio::try_join!(self.raw_issues_async(), self.sessions_async(), async {
            self.ctx.service.issue.list_pulls().await.map_err(BoardError::from)
        })?;
        let pulls_by_issue = best_pulls_by_issue(&pulls);
        let mut derived = derive_all_issues(&raw_issues, &sessions);
        for issue in &mut derived {
            if let Some(pr) = pulls_by_issue.get(&issue.id) {
                issue.pull_request = Some(pr.clone());
            }
        }
        Ok(derived)
    }

    async fn derive_single_issue_async(&self, target: Issue) -> Result<Issue> {
        let descendants = self.ctx.service.issue.list_descendants(&target.id).await?;
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
        let (stored_sessions, pulls) = tokio::try_join!(self.ctx.service.sessions_for_issues(&sid_vec, &issue_ids), self.ctx.service.issue.list_pulls(),)?;
        let overlays = self.ctx.live.core_session_overlays();
        let sessions = overlay_sessions(&stored_sessions, &overlays);
        let mut derived = derive_single_issue(&target, &descendants, &sessions);
        derived.pull_request = best_pull_for_issue(&pulls, &derived.id);
        Ok(derived)
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
        let record_episode = matches!(change, IssueChange::Delivered(..));
        let resolved_id = self.ctx.service.issue.get_by_ref(id).await?.ok_or_else(|| BoardError::NoIssue(id.into()))?.id;

        let (saved_issue, enqueued_episode) = {
            let _issue_guard = self.lock_issue(&resolved_id).await;
            let mut issue = self.ctx.service.issue.get(&resolved_id).await?.ok_or_else(|| BoardError::NoIssue(id.into()))?;
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
                .write_dirty_with(BoardError::Store, |tx| {
                    Box::pin(async move {
                        issue_svc.put_in_tx(tx, &to_save).await?;
                        if let Some(ev) = episode {
                            outbox.enqueue_event_in_tx(tx, &ev).await.map_err(BoardError::Api)?;
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
            let mut issue = self.ctx.service.issue.get(id).await?.ok_or_else(|| BoardError::NoIssue(id.to_owned()))?;
            if issue.body_note_id.as_deref() != Some(note_id.as_str()) {
                issue.body_note_id = Some(note_id);
                let issue_svc = self.ctx.service.issue.clone();
                let to_save = issue.clone();
                self.ctx
                    .service
                    .write_dirty_with(BoardError::Store, |tx| {
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
