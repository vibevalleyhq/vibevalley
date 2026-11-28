//! The issue board (`Board`): workflow rules of `vibevalley-core` at work on
//! issues — creating, moving, telling, queueing and sending, accepting and
//! delivering, closing. Sessions and worktrees live in [`crate::runtime::Runtime`],
//! and state transitions persist through [`IssueState`].
//!
//! One process holds a board at a time (a lock file next to its data); others
//! read it with [`Board::snapshot_async`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::{Move, status_move};
use vibevalley_kit::sync::{KeyLock, KeyLockGuard};
use vibevalley_protocol::{
    ActorRef, ApiError, AppliedIssue, Assignment, Attachment, BacklogTriageSuggestion, BizCode, Deliverable, DeliveryReceipt, HumanPause, HumanPauseSource,
    Issue, IssueCanceled, IssueConstraints, IssueMandate, IssueRelation, IssueStageKind as StageKind, IssueStatus, JsNumber, Landing, Outcome, Phase, Priority,
    PullRequestState, ResumeCondition, Run, RunTriggerKind, Session, SessionClose, SliceBundle, StuckReason,
};
use vibevalley_runtime::oar::Registry;

use super::store::{BoardConfig, BoardError, IssueChange, IssueState, Opened, Result, find_issue};
use super::types::{board_io, read_round};
use crate::context::{AsyncRequestKeys, Context, now};
use crate::repo::Repo;
use crate::runtime::{
    DraftEnd, Hire, MailboxSource, MailboxStatus, Report, RoundEnd, Rounds, RunMode, Runtime, SessionEngine, combine_report_and_failure, trigger_of,
};
use crate::storage::Storage;

/// What the user writes down.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewIssue {
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    /// A path inside the repository it changes; none for an answer only.
    pub repo: Option<PathBuf>,
    /// The runtime or profile id that does it (`claude`, `codex`, `acp:…`, `scripted`).
    pub agent: String,
    /// Optional execution host id (`"local"` or remote/sandbox machine id).
    #[serde(default)]
    pub machine_id: Option<String>,
    pub deliver: Deliverable,
    #[serde(default)]
    pub priority: Priority,
    /// Its parent issue (id or number); the child works on a branch cut
    /// from the parent's and merges into it.
    #[serde(default)]
    pub parent: Option<String>,
    /// Issues (ids or numbers) it waits for.
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub constraints: Option<IssueConstraints>,
    /// The cron that keeps it (`Issue.cron`).
    #[serde(default)]
    pub cron: Option<String>,
    /// Explicit user mandate allowing the helper to open a PR itself.
    #[serde(default)]
    pub auto_submit_pr: bool,
    /// Optional explicit/inferred mandate supplied by internal callers (e.g. tools).
    #[serde(default)]
    pub mandate: Option<IssueMandate>,
    /// Uploaded attachment ids bound to this issue.
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub start_at: Option<JsNumber>,
    #[serde(default)]
    pub due_at: Option<JsNumber>,
    #[serde(default)]
    pub owner: Option<ActorRef>,
    /// Non-blocking links (`duplicate` / `related`), maintained bidirectionally.
    #[serde(default)]
    pub relations: Vec<IssueRelation>,
}

pub(super) fn resolve_blocked_by(all_issues: &[Issue], self_id: Option<&str>, refs: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for raw in refs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let target = find_issue(all_issues, trimmed).ok_or_else(|| BoardError::NoIssue(trimmed.to_string()))?;
        if self_id == Some(target.id.as_str()) {
            return Err(BoardError::Other("an issue cannot be blocked by itself".into()));
        }
        if !out.contains(&target.id) {
            out.push(target.id.clone());
        }
    }
    Ok(out)
}

pub(super) fn resolve_relations(all_issues: &[Issue], self_id: Option<&str>, refs: &[IssueRelation]) -> Result<Vec<IssueRelation>> {
    let mut out = Vec::new();
    for raw in refs {
        let trimmed = raw.issue.trim();
        if trimmed.is_empty() {
            continue;
        }
        let target = find_issue(all_issues, trimmed).ok_or_else(|| BoardError::NoIssue(trimmed.to_string()))?;
        if self_id == Some(target.id.as_str()) {
            return Err(BoardError::Other("an issue cannot relate to itself".into()));
        }
        let candidate = IssueRelation {
            kind: raw.kind,
            issue: target.id.clone(),
        };
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    Ok(out)
}

fn get_or_clone_peer<'a>(id: &str, all_issues: &[Issue], map: &'a mut HashMap<String, Issue>) -> Option<&'a mut Issue> {
    if !map.contains_key(id)
        && let Some(found) = all_issues.iter().find(|i| i.id == id)
    {
        map.insert(id.to_string(), found.clone());
    }
    map.get_mut(id)
}

pub(super) fn sync_bidirectional_relations(source_id: &str, old_rels: &[IssueRelation], new_rels: &[IssueRelation], all_issues: &[Issue]) -> Vec<Issue> {
    let mut modified: HashMap<String, Issue> = HashMap::new();
    for old in old_rels {
        if !new_rels.contains(old)
            && let Some(peer) = get_or_clone_peer(&old.issue, all_issues, &mut modified)
        {
            peer.relations.retain(|r| !(r.kind == old.kind && r.issue == source_id));
        }
    }
    for next in new_rels {
        if !old_rels.contains(next)
            && let Some(peer) = get_or_clone_peer(&next.issue, all_issues, &mut modified)
        {
            let reverse = IssueRelation {
                kind: next.kind,
                issue: source_id.to_string(),
            };
            if !peer.relations.contains(&reverse) {
                peer.relations.push(reverse);
            }
        }
    }
    modified.into_values().collect()
}

pub(super) fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in tags {
        let tag = raw.trim();
        if !tag.is_empty() && !out.iter().any(|existing: &String| existing == tag) {
            out.push(tag.to_string());
        }
    }
    out
}

pub(super) fn normalize_timestamp(value: Option<JsNumber>) -> Option<JsNumber> {
    value.and_then(|v| {
        let raw = v.get();
        (raw.is_finite() && raw > 0.0).then(|| JsNumber::from(raw.round() as i64))
    })
}

pub(super) fn normalize_owner(owner: Option<ActorRef>) -> Option<ActorRef> {
    owner.and_then(|o| match o {
        ActorRef::User { id } => {
            let trimmed = id.trim();
            (!trimmed.is_empty()).then(|| ActorRef::User { id: trimmed.to_string() })
        }
        ActorRef::Agent { id } => {
            let trimmed = id.trim();
            (!trimmed.is_empty()).then(|| ActorRef::Agent { id: trimmed.to_string() })
        }
    })
}

pub(super) fn normalize_owner_with_driver(driver: &dyn crate::runtime::SessionDriver, owner: Option<ActorRef>) -> Option<ActorRef> {
    normalize_owner(owner).and_then(|o| match o {
        ActorRef::User { .. } => Some(o),
        ActorRef::Agent { id } => {
            let resolved = driver.resolve_agent_key(&id);
            let trimmed = resolved.trim();
            (!trimmed.is_empty()).then(|| ActorRef::Agent { id: trimmed.to_string() })
        }
    })
}

/// Default config values (`space_limit == MAX_RUNNING` and `per_repo == 3`) are treated as
/// unbounded so issues can start concurrently without artificial 6-slot blocking; explicit
/// overrides (such as tests configuring `space_limit = 1` or `per_repo = 1`) are still honored.
pub(super) fn effective_limits(config: &BoardConfig) -> (usize, usize) {
    let space = if config.space_limit == vibevalley_protocol::MAX_RUNNING {
        0
    } else {
        config.space_limit
    };
    let per_repo = if config.space_limit == vibevalley_protocol::MAX_RUNNING && config.per_repo == 3 {
        0
    } else {
        config.per_repo
    };
    (space, per_repo)
}

/// What became of a request to send an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "sent", rename_all = "snake_case")]
pub enum Sent {
    /// A session works on it.
    Working { session: String },
    /// It waits in todo: for room, or for the issues it is blocked by.
    Queued { blocked_by: Vec<String> },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoReviewDoc {
    #[serde(default)]
    rounds: i64,
    #[serde(default)]
    last_session_id: Option<String>,
    #[serde(default)]
    last_session_runs: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct TriageStore {
    #[serde(default)]
    pub custom: Vec<BacklogTriageSuggestion>,
    #[serde(default)]
    pub dismissed: HashSet<String>,
}

/// Issue board domain service.
pub struct Board {
    pub(super) ctx: Arc<Context>,
    pub(super) state: Arc<IssueState>,
    pub(super) runtime: Arc<Runtime>,
    pub(super) repos: Option<Arc<Repo>>,
    storage: Option<Arc<Storage>>,
    pub(super) create_keys: AsyncRequestKeys<AppliedIssue>,
    pub(super) status_keys: AsyncRequestKeys<AppliedIssue>,
    /// Held for short workflow state checks and room reservations so slow
    /// dispatch I/O runs outside this coarse lock.
    pub(super) work: AsyncMutex<()>,
    pub(super) triage_path: PathBuf,
    pub(super) triage: AsyncMutex<TriageStore>,
    issue_locks: KeyLock<String>,
    in_flight: Mutex<HashMap<String, Option<String>>>,
    lock: Mutex<Option<tokio::fs::File>>,
}

struct InFlightGuard<'a> {
    board: &'a Board,
    issue_id: String,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.board.in_flight.lock().remove(&self.issue_id);
    }
}

/// Bridges session round completions back onto [`Board`].
struct Heard(Weak<Board>);

impl Rounds for Heard {
    fn lookup_issue<'a>(&'a self, issue_id: &'a str) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Option<Issue>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let board = weak.upgrade()?;
            board.issue_async(issue_id).await.ok().flatten()
        })
    }

    fn round_ended(&self, end: RoundEnd) -> vibevalley_runtime::agent::durable::BoxFuture<'_, ()> {
        let weak = self.0.clone();
        Box::pin(async move {
            if let Some(board) = weak.upgrade() {
                board.finish_round_ended_async(end).await;
            }
        })
    }

    fn after(&self) -> vibevalley_runtime::agent::durable::BoxFuture<'_, ()> {
        let weak = self.0.clone();
        Box::pin(async move {
            if let Some(board) = weak.upgrade() {
                board.after_round_async().await;
            }
        })
    }
}

impl Board {
    /// The board as stored, without taking it: for reading while another
    /// process holds it. Working sessions show as they were last stored.
    pub async fn snapshot_async(path: &Path) -> Result<SliceBundle> {
        IssueState::snapshot_async(path).await
    }

    /// Returns issue ids that currently hold a persisted human pause so boot
    /// session recovery skips auto-resuming them.
    pub async fn paused_issue_ids_async(ctx: &Context) -> Result<HashSet<String>> {
        let issues = ctx.service.issue.all().await?;
        Ok(issues.into_iter().filter(|i| i.mandate.is_paused()).map(|i| i.id).collect())
    }

    /// Takes the board lock and wires issue workflow coordination onto an already-opened
    /// [`Runtime`]. Settles published deliveries, cancels lost issues, and dismisses
    /// cut-short drafts from `opened`. Call `refresh_queue_async` afterwards to send what waits.
    pub async fn open_async(ctx: Arc<Context>, runtime: Arc<Runtime>, opened: Opened, repos: Option<Arc<Repo>>) -> Result<Arc<Board>> {
        Self::with_storage(ctx, runtime, opened, repos, None).await
    }

    /// Takes the board lock with optional content-addressed [`Storage`] for resolving
    /// issue attachments and formatting their local CAS paths in agent prompts.
    pub async fn with_storage(
        ctx: Arc<Context>,
        runtime: Arc<Runtime>,
        opened: Opened,
        repos: Option<Arc<Repo>>,
        storage: Option<Arc<Storage>>,
    ) -> Result<Arc<Board>> {
        let config = runtime.config();
        tokio::fs::create_dir_all(config.data_dir.join("reports")).await.map_err(board_io)?;
        tokio::fs::create_dir_all(config.data_dir.join("records")).await.map_err(board_io)?;
        let lock_path = config.data_dir.join("board.lock");
        let file = tokio::fs::File::create(&lock_path).await.map_err(board_io)?.into_std().await;
        // A child process forked while the last holder had it open may hold
        // it a moment longer.
        let deadline = Instant::now() + Duration::from_secs(2);
        while file.try_lock().is_err() {
            if Instant::now() > deadline {
                return Err(BoardError::Busy(lock_path));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let state = Arc::new(IssueState::new(ctx.clone()));
        let triage_path = config.data_dir.join("triage.json");
        let triage_store: TriageStore = match tokio::fs::read_to_string(&triage_path).await {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => TriageStore::default(),
        };
        let board = Arc::new(Board {
            ctx,
            state,
            runtime,
            repos,
            storage,
            create_keys: AsyncRequestKeys::default(),
            status_keys: AsyncRequestKeys::default(),
            work: AsyncMutex::new(()),
            triage_path,
            triage: AsyncMutex::new(triage_store),
            issue_locks: KeyLock::new(),
            in_flight: Mutex::new(HashMap::new()),
            lock: Mutex::new(Some(tokio::fs::File::from_std(file))),
        });
        board.runtime.session_engine().on_rounds(Box::new(Heard(Arc::downgrade(&board))));
        // A draft cut short leaves its issue as it was.
        for draft in opened.drafts {
            board.runtime.session_engine().dismiss_async(&draft).await?;
        }
        Ok(board)
    }

    pub(super) async fn issue_lock(&self, id: &str) -> KeyLockGuard<'_, String> {
        self.issue_locks.lock(id.to_owned()).await
    }

    fn reserve_in_flight(&self, issue: &Issue) -> InFlightGuard<'_> {
        self.in_flight.lock().insert(issue.id.clone(), issue.repo.clone());
        InFlightGuard {
            board: self,
            issue_id: issue.id.clone(),
        }
    }

    /// Standalone convenience constructor opening a [`Runtime`] backed by `registry`.
    pub async fn open_standalone_async(ctx: Arc<Context>, registry: Arc<Registry>, config: BoardConfig) -> Result<Arc<Board>> {
        let paused = Self::paused_issue_ids_async(&ctx).await?;
        let drivers = Arc::new(crate::runtime::RuntimeDriver {
            registry,
            model: config.model.clone(),
        });
        let (runtime, opened) = Runtime::open_with_paused_async(ctx.clone(), drivers, config, &paused).await?;
        Board::open_async(ctx, runtime, opened, None).await
    }

    /// Lets the board go: active sessions stop and the lock is released.
    pub async fn close_async(&self) {
        self.runtime.close_async().await;
        self.lock.lock().take();
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.ctx
    }

    pub fn config(&self) -> &BoardConfig {
        self.runtime.config()
    }

    pub fn state(&self) -> &Arc<IssueState> {
        &self.state
    }

    pub fn runtime(&self) -> &Arc<Runtime> {
        &self.runtime
    }

    pub fn session_engine(&self) -> &SessionEngine {
        self.runtime.session_engine()
    }

    pub fn repos(&self) -> Option<&Arc<Repo>> {
        self.repos.as_ref()
    }

    /// Normalizes an optional advisory repository hint to a registered repo name when matched,
    /// without requiring the path to be a local Git repository.
    pub(super) async fn normalize_repo_hint_async(&self, raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        if let Some(repos) = &self.repos {
            if let Some(name) = repos.infer_name_for_dir_async(Path::new(trimmed)).await {
                return name;
            }
            if repos.resolve_dir_async(trimmed).await.is_some() {
                return trimmed.to_string();
            }
        }
        trimmed.to_string()
    }

    /// Resolves an optional working directory for an issue session.
    /// Returns `None` for directoryless sessions (no repo hint, remote machine, or non-local path).
    pub(super) async fn resolve_issue_cwd_async(&self, issue: &Issue, drive_is_local: bool) -> Option<PathBuf> {
        if !drive_is_local {
            return None;
        }
        let hint = issue.repo.as_deref().map(str::trim).filter(|r| !r.is_empty())?;
        if let Some(repos) = &self.repos
            && let Some(dir) = repos.resolve_dir_async(hint).await
        {
            return Some(dir);
        }
        let path = PathBuf::from(hint);
        if path.is_dir() {
            return Some(path);
        }
        let under_repos = self.config().repos_dir.as_ref()?.join(hint);
        under_repos.is_dir().then_some(under_repos)
    }

    pub fn storage(&self) -> Option<&Arc<Storage>> {
        self.storage.as_ref()
    }

    pub(super) async fn resolve_attachments_async(&self, ids: &[String]) -> Result<Vec<Attachment>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(storage) = &self.storage {
            return storage.of_async(ids).await.map_err(BoardError::Api);
        }
        let map = self.ctx.service.storage.find_attachments_map(ids).await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if out.iter().any(|a: &Attachment| &a.id == id) {
                continue;
            }
            let att = map.get(id).cloned().ok_or_else(|| {
                BoardError::Api(ApiError::new(
                    BizCode::NotFound,
                    vibevalley_i18n::t("server.attachment.noAttachment", &[("id", id.clone().into())]),
                ))
            })?;
            out.push(att);
        }
        Ok(out)
    }

    pub fn seq(&self) -> i64 {
        self.state.seq()
    }

    pub async fn issues_async(&self) -> Result<Vec<Issue>> {
        self.state.issues_async().await
    }

    pub async fn raw_issues_async(&self) -> Result<Vec<Issue>> {
        self.state.raw_issues_async().await
    }

    pub async fn raw_issues_for_board_async(&self, include_ids: &[String]) -> Result<Vec<Issue>> {
        self.state.raw_issues_for_board_async(include_ids).await
    }

    pub async fn projection_snapshot_async(&self) -> Result<(Vec<Session>, Vec<Issue>)> {
        self.state.projection_snapshot_async().await
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        self.state.sessions_async().await
    }

    /// By id, number or `#number`.
    pub async fn issue_async(&self, reference: &str) -> Result<Option<Issue>> {
        self.state.issue_async(reference).await
    }

    pub async fn session_async(&self, id: &str) -> Option<Session> {
        self.state.session_async(id).await.ok().flatten()
    }

    /// A session that left the board, as it was when it did.
    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.state.past_session_async(id).await
    }

    /// The issue's runs, oldest first.
    pub async fn runs_async(&self, issue: &str) -> Result<Vec<Run>> {
        Ok(self.ctx.service.session.runs(issue).await?)
    }

    /// Evaluates whether an active built-in worker run has criteria ready for grading.
    pub async fn review_work_async(&self, vendor: &str, run_id: &str, candidate: &str) -> Result<Option<(Issue, Report)>> {
        let Some(snap) = self.runtime.active_run_snapshot_async(vendor, run_id).await? else {
            return Ok(None);
        };
        let Some(issue_id) = snap.run.issue.as_deref() else { return Ok(None) };
        let Some(issue) = self.issue_async(issue_id).await? else {
            return Ok(None);
        };
        if issue.criteria.iter().all(|line| line.trim().is_empty()) {
            return Ok(None);
        }
        let round = read_round(&issue, vibevalley_runtime::oar::StopReason::Completed, snap.report.as_ref(), candidate, &[]);
        if round.outcome != Outcome::Completed || !round.questions.is_empty() {
            return Ok(None);
        }
        Ok(Some((
            issue,
            Report {
                summary: round.summary,
                checks: round.checks,
                answer: round.answer,
                ..Report::default()
            },
        )))
    }

    /// Settles an issue-bound session round reported by [`SessionEngine`].
    async fn finish_round_ended_async(&self, end: RoundEnd) {
        let Some(issue) = self.issue_async(&end.issue_id).await.ok().flatten() else {
            return;
        };
        if end.refining {
            self.finish_draft_async(DraftEnd {
                spent: end.spent,
                session: end.session,
                issue,
                reason: end.reason,
                said: end.said,
                asked: end.asked,
            })
            .await;
            return;
        }
        let failed = matches!(
            end.reason,
            vibevalley_runtime::oar::StopReason::Error | vibevalley_runtime::oar::StopReason::MaxTurns
        );
        let mut round = read_round(
            &issue,
            end.reason.clone(),
            end.report.as_ref(),
            end.graded_output.as_deref().unwrap_or(&end.said),
            &end.asked,
        );
        if failed {
            let error_fact = end.failure.as_deref().map(str::trim).filter(|e| !e.is_empty()).or_else(|| {
                end.report.as_ref().map(|_| match end.reason {
                    vibevalley_runtime::oar::StopReason::MaxTurns => "达到最大轮次",
                    _ => "会话连接异常断开",
                })
            });
            if let Some(error) = error_fact {
                round.summary = combine_report_and_failure(end.report.as_ref(), error);
            }
        } else if let Some(error) = end.failure.as_deref().map(str::trim).filter(|e| !e.is_empty())
            && round.outcome == Outcome::Interrupted
        {
            round.summary = combine_report_and_failure(end.report.as_ref(), error);
        }
        let outcome = round.outcome;
        let sessions = self.session_engine();
        let mode = sessions.helper_mode_async(&end.session, Some(&issue)).await;
        let tx_hook = if matches!(mode, RunMode::ReadOnlyReview | RunMode::ReadOnlyCollaborator) {
            None
        } else {
            Some(self.state.issue_change_hook(
                issue.id.clone(),
                IssueChange::Reported {
                    questions: (round.outcome != Outcome::Interrupted).then_some(round.questions),
                    checks: round.checks,
                    answer: round.answer.clone(),
                    delivery_receipt: round.delivery_receipt,
                },
            ))
        };
        sessions.finish_run_record_async(&end.session.id, end.run_id.as_deref(), outcome).await;
        if let Err(error) = sessions
            .settle_report_async(&end.session, outcome, round.summary, end.spent, round.answer, end.run_id, tx_hook)
            .await
        {
            eprintln!("vibevalley: settling {}: {error}", end.session.id);
            return;
        }
        if let Some(r) = end.report.as_ref() {
            sessions.enqueue_remember_notes_async(&end.session, r).await;
        }
    }

    pub(super) async fn stored_async(&self, reference: &str) -> Result<Issue> {
        self.issue_async(reference).await?.ok_or_else(|| BoardError::NoIssue(reference.to_string()))
    }

    pub(super) fn change_async<'a>(
        &'a self,
        id: &'a str,
        change: IssueChange,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Issue>> + Send + 'a>> {
        Box::pin(async move { self.state.change_async(id, change).await })
    }

    pub async fn create_async(&self, new: NewIssue) -> Result<Issue> {
        let machine_id = new.machine_id.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(String::from);
        let repo_root_from_repo = match &new.repo {
            Some(path) => {
                let raw = path.to_string_lossy();
                let norm = self.normalize_repo_hint_async(&raw).await;
                (!norm.is_empty()).then_some(norm)
            }
            None => None,
        };
        if !new.agent.trim().is_empty() {
            self.runtime.driver().check(new.agent.trim())?;
        }
        let (title, description) =
            vibevalley_core::brief::issue_words(&new.title, &new.description).ok_or_else(|| BoardError::Other("the issue has no title".into()))?;
        if new
            .constraints
            .as_ref()
            .is_some_and(|c| c.acceptance && c.check.as_deref().unwrap_or("").is_empty())
        {
            return Err(BoardError::Other("an acceptance issue needs a check command".into()));
        }
        let attachments = self.resolve_attachments_async(&new.attachments).await?;

        let id = {
            let _work = self.work.lock().await;
            let all_issues = self.issues_async().await?;
            let parent = match &new.parent {
                Some(p) => Some(find_issue(&all_issues, p).cloned().ok_or_else(|| BoardError::NoIssue(p.clone()))?),
                None => None,
            };
            let blocked_by = resolve_blocked_by(&all_issues, None, &new.blocked_by)?;
            let relations = resolve_relations(&all_issues, None, &new.relations)?;
            if let Some(p) = &parent
                && p.status.is_closed()
            {
                return Err(BoardError::Other(format!("issue #{} is closed", p.number)));
            }
            let repo_root = repo_root_from_repo.or_else(|| parent.as_ref().and_then(|p| p.repo.clone()));
            let stored_max = all_issues.iter().map(|t| t.number).max().unwrap_or(0);
            let number = self.state.next_async("issue", stored_max).await?;
            let id = format!("i{number}");
            let mut graph: Vec<(String, Option<String>, Vec<String>)> =
                all_issues.iter().map(|t| (t.id.clone(), t.parent.clone(), t.blocked_by.clone())).collect();
            graph.push((id.clone(), parent.as_ref().map(|p| p.id.clone()), blocked_by.clone()));
            let problems = vibevalley_core::dependency_problems(&graph);
            if !problems.is_empty() {
                return Err(BoardError::Other(format!("the dependencies do not form a DAG: {problems:?}")));
            }
            let at = now();
            let mut issue = Issue::new(&id, number, title, at);
            issue.description = description;
            issue.criteria = vibevalley_core::refine::kept(&new.criteria);
            issue.deliver = new.deliver;
            issue.repo = repo_root;
            issue.machine_id = machine_id;
            issue.priority = parent.as_ref().map(|p| p.priority).unwrap_or(new.priority);
            let parent_agent = parent.as_ref().and_then(|p| p.assigned_agent()).map(String::from);
            issue.parent = parent.map(|p| p.id);
            issue.blocked_by = blocked_by;
            issue.relations = relations.clone();
            issue.constraints = new.constraints;
            issue.cron = new.cron;
            issue.attachments = attachments;
            issue.tags = clean_tags(&new.tags);
            issue.start_at = normalize_timestamp(new.start_at);
            issue.due_at = normalize_timestamp(new.due_at);
            issue.owner = normalize_owner_with_driver(self.runtime.driver().as_ref(), new.owner).or_else(|| Some(ActorRef::self_user()));
            if let Some(mut m) = new.mandate {
                if new.auto_submit_pr {
                    m.auto_submit_pr = true;
                }
                issue.mandate = m;
            } else if new.auto_submit_pr {
                issue.mandate = vibevalley_protocol::IssueMandate::explicit("", true);
            }
            let agent = new.agent.trim().to_string();
            let agent = if agent.is_empty() { parent_agent.unwrap_or_default() } else { agent };
            if !agent.is_empty() {
                issue.assignments = vec![Assignment {
                    id: format!("{id}-a1"),
                    issue: id.clone(),
                    agent,
                    assigned_at: at,
                    ended_at: None,
                    executions: vec![],
                }];
            }
            let mut to_put = vec![issue];
            to_put.extend(sync_bidirectional_relations(&id, &[], &relations, &all_issues));
            self.state.put_issues_async(&to_put).await?;
            id
        };
        let created = self.stored_async(&id).await?;
        let links = vibevalley_core::note::links::extract_markdown_links(&created.description);
        if let Err(err) = self
            .ctx
            .service
            .note
            .replace_links_for_source(vibevalley_protocol::LinkEntityKind::Issue, &created.id, &links, now())
            .await
        {
            tracing::warn!(issue_id = %created.id, error = %err, "issue.create failed to sync markdown note links");
        }
        Ok(created)
    }

    pub(super) fn verify_approval(issue: &Issue, to: IssueStatus, seen: Option<&vibevalley_protocol::ReviewRevision>) -> Result<()> {
        if let Some(seen) = seen
            && (to != IssueStatus::Done || issue.delivery_evidence.as_ref().and_then(|e| e.reviews.last()).map(|r| &r.revision) != Some(seen))
        {
            return Err(BoardError::Other(vibevalley_i18n::t("server.issue.reviewChanged", &[])));
        }
        Ok(())
    }

    /// The user moves an issue on the board. `words` carry what to do this
    /// time for a round or a reopen.
    pub fn move_to_async<'a>(
        &'a self,
        reference: &'a str,
        to: IssueStatus,
        words: Option<&'a str>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Move>> + Send + 'a>> {
        self.move_with_receipt_async(reference, to, words, None, None)
    }

    pub fn move_reviewed_async<'a>(
        &'a self,
        reference: &'a str,
        to: IssueStatus,
        words: Option<&'a str>,
        seen: Option<&'a vibevalley_protocol::ReviewRevision>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Move>> + Send + 'a>> {
        self.move_with_receipt_async(reference, to, words, seen, None)
    }

    pub fn move_with_receipt_async<'a>(
        &'a self,
        reference: &'a str,
        to: IssueStatus,
        words: Option<&'a str>,
        seen: Option<&'a vibevalley_protocol::ReviewRevision>,
        delivery_receipt: Option<DeliveryReceipt>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Move>> + Send + 'a>> {
        Box::pin(async move {
            let initial = self.stored_async(reference).await?;
            let issue_guard = self.issue_lock(&initial.id).await;
            let words = words.map(str::trim).filter(|w| !w.is_empty()).map(String::from);
            let (issue, mv) = {
                let _work = self.work.lock().await;
                let issue = self.stored_async(&initial.id).await?;
                Self::verify_approval(&issue, to, seen)?;
                let mv = status_move(&issue, to).map_err(BoardError::Refused)?;
                match mv {
                    Move::Start => {
                        if let Some(agent) = issue.assigned_agent() {
                            self.runtime.driver().check(agent)?;
                        }
                        if issue.mandate.is_paused() {
                            self.change_async(&issue.id, IssueChange::Resumed).await?;
                        }
                        if let Some(w) = &words {
                            self.keep_words_async(&issue.id, w).await?;
                        }
                        self.change_async(&issue.id, IssueChange::Queued).await?;
                    }
                    Move::Unqueue => {
                        if issue.queued_at.is_some() {
                            self.change_async(&issue.id, IssueChange::Unqueued).await?;
                        }
                        if issue.status != IssueStatus::Backlog {
                            let mut unqueued = self.stored_async(&issue.id).await?;
                            unqueued.status = IssueStatus::Backlog;
                            unqueued.queued_at = None;
                            unqueued.reviewed_at = None;
                            self.state.put_issues_async(&[unqueued]).await?;
                        }
                    }
                    Move::Round | Move::Reopen => {
                        let required = mv == Move::Reopen || issue.stage.state == StageKind::Reviewing;
                        if words.is_none() && required {
                            return Err(BoardError::WordsRequired);
                        }
                        self.room_for_round_async(&issue).await?;
                        self.change_async(&issue.id, IssueChange::Reopened).await?;
                    }
                    Move::Revive => {
                        let mut revived = issue.clone();
                        revived.status = IssueStatus::Backlog;
                        revived.closed_at = None;
                        revived.canceled = None;
                        revived.delivered = None;
                        revived.queued_at = None;
                        revived.reviewed_at = None;
                        self.state.put_issues_async(&[revived]).await?;
                    }
                    Move::Track | Move::Complete | Move::Cancel | Move::Drop => {}
                }
                (issue, mv)
            };

            match mv {
                Move::Start => {
                    self.send_for_issue_async(&issue.id, None, RunTriggerKind::Issue).await?;
                }
                Move::Round | Move::Reopen => {
                    let round_words = words.unwrap_or_else(|| default_words(&issue));
                    self.send_for_issue_async(&issue.id, Some(round_words), RunTriggerKind::Comment).await?;
                }
                Move::Track => {
                    if let Some(s) = self.on_board_async(&issue).await {
                        self.session_engine().dismiss_async(&s.id).await?;
                    }
                    let _work = self.work.lock().await;
                    let mut tracked = self.stored_async(&issue.id).await?;
                    tracked.status = to;
                    tracked.queued_at = None;
                    tracked.closed_at = None;
                    tracked.delivered = None;
                    tracked.canceled = None;
                    tracked.reviewed_at = (to == IssueStatus::InReview).then(now);
                    self.state.put_issues_async(&[tracked]).await?;
                }
                Move::Complete => {
                    self.complete_for_issue_async(&issue, delivery_receipt).await?;
                    drop(issue_guard);
                    self.refresh_queue_unlocked_async().await;
                }
                Move::Cancel | Move::Drop => {
                    self.close_issue_for_locked_parent_async(&issue, IssueCanceled::Dismissed).await?;
                    drop(issue_guard);
                    self.refresh_queue_unlocked_async().await;
                }
                Move::Unqueue | Move::Revive => {}
            }
            Ok(mv)
        })
    }

    /// A round for a session still on the board needs room now (the
    /// delivery is refused); a new session may wait in todo.
    pub(super) async fn room_for_round_async(&self, issue: &Issue) -> Result<()> {
        let Some(session) = self.on_board_async(issue).await else { return Ok(()) };
        let (space, repo) = self.room_async(issue, &session.id).await;
        if space == 0 || repo == 0 {
            let sessions = self.sessions_async().await?;
            let busy = sessions.iter().filter(|s| s.phase.is_working()).count();
            let per_repo = self.config().per_repo;
            return Err(BoardError::NoRoom(format!(
                "{busy} sessions work in the space (limit {}), {} in this repository",
                self.config().space_limit,
                per_repo.saturating_sub(repo.min(per_repo))
            )));
        }
        Ok(())
    }

    /// Words to the issue's session: an answer to its question, or a note.
    /// Steers the running turn when the runtime can; otherwise the next
    /// round starts with them. Words for an issue not sent yet wait for it.
    pub fn tell_async<'a>(&'a self, reference: &'a str, words: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let words = words.trim();
            if words.is_empty() {
                return Err(BoardError::WordsRequired);
            }
            let initial = self.stored_async(reference).await?;
            let _issue_guard = self.issue_lock(&initial.id).await;
            let (issue, board_session) = {
                let _work = self.work.lock().await;
                let mut issue = self.stored_async(&initial.id).await?;
                if issue.status.is_closed() {
                    return Err(BoardError::Api(ApiError::new(
                        BizCode::IssueRefused,
                        vibevalley_i18n::t("server.issue.closedReopen", &[]),
                    )));
                }
                if issue.mandate.is_paused() {
                    issue = self.change_async(&issue.id, IssueChange::Resumed).await?;
                }
                let session = self.on_board_async(&issue).await;
                (issue, session)
            };
            if let Some(session) = board_session
                && let Some(steered) = self.session_engine().steer_async(&session, words).await
            {
                return steered.map_err(BoardError::from);
            }
            match issue.status {
                IssueStatus::Backlog | IssueStatus::Todo => {
                    let _work = self.work.lock().await;
                    self.keep_words_async(&issue.id, words).await
                }
                _ => {
                    {
                        let _work = self.work.lock().await;
                        self.room_for_round_async(&issue).await?;
                    }
                    if matches!(
                        self.send_for_issue_async(&issue.id, Some(words.to_string()), RunTriggerKind::Comment).await?,
                        Sent::Queued { .. }
                    ) {
                        let _work = self.work.lock().await;
                        self.change_async(&issue.id, IssueChange::Answered).await?;
                    }
                    Ok(())
                }
            }
        })
    }

    pub async fn tell_message_async(&self, reference: &str, words: &str, key: &str) -> Result<()> {
        self.tell_message_from_async(reference, words, key, false).await
    }

    /// Delivers a thread message to an issue; only `from_user == true` clears
    /// an active human pause (`ExplicitUserResume`).
    pub async fn tell_message_from_async(&self, reference: &str, words: &str, key: &str, from_user: bool) -> Result<()> {
        if key.trim().is_empty() || words.trim().is_empty() {
            return Err(BoardError::WordsRequired);
        }
        let initial = self.stored_async(reference).await?;
        let _issue_guard = self.issue_lock(&initial.id).await;
        let mut issue = self.stored_async(&initial.id).await?;
        if issue.mandate.is_paused() && !from_user {
            return Err(BoardError::Api(ApiError::new(
                BizCode::IssueRefused,
                "工单已由人工暂停，仅用户明确回复或恢复后才能继续".to_string(),
            )));
        }
        let sessions = self.session_engine();
        let sub = sessions.submit_words_async(&issue.id, key, words).await?;
        match sub.status {
            vibevalley_runtime::agent::durable::SubmissionStatus::Done | vibevalley_runtime::agent::durable::SubmissionStatus::Placed => return Ok(()),
            vibevalley_runtime::agent::durable::SubmissionStatus::Unanswered => return Err(BoardError::Other(sub.result.to_string())),
            vibevalley_runtime::agent::durable::SubmissionStatus::Queued => (),
        }
        if issue.mandate.is_paused() && from_user {
            let _work = self.work.lock().await;
            issue = self.change_async(&issue.id, IssueChange::Resumed).await?;
        }
        let board_session = self.on_board_async(&issue).await;
        let mail_owner = board_session.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| format!("issue:{}", issue.id));
        let mail_key = format!("issue:{}:{key}", issue.id);
        let mail_entry = sessions
            .enqueue_mailbox_async(&mail_owner, &mail_key, MailboxSource::IssueComment, Some(key), words)
            .await?;
        if mail_entry.status == MailboxStatus::Withdrawn {
            return Ok(());
        }
        if issue.status.is_closed() {
            let e = BoardError::Api(ApiError::new(BizCode::IssueRefused, vibevalley_i18n::t("server.issue.closedReopen", &[])));
            if let Err(err) = sessions.settle_mailbox_async(mail_entry.id, false, Some(&e.to_string())).await {
                tracing::warn!(issue_id = %issue.id, mailbox_id = mail_entry.id, error = %err, "issue.tell failed to settle closed-issue mailbox");
            }
            sessions.settle_words_async(&sub.id, false, Some(&e.to_string())).await?;
            return Err(e);
        }
        if let Some(session) = board_session
            && session.phase.is_working()
            && sessions.is_live(&session.id)
            && sessions.bind_to_active_run_async(&session.id, &sub).await?
        {
            if let Err(err) = sessions.claim_mailbox_by_key_async(&mail_key).await {
                tracing::warn!(issue_id = %issue.id, mail_key = %mail_key, error = %err, "issue.tell failed to claim active-run mailbox");
            }
            let result = sessions
                .steer_async(&session, words)
                .await
                .unwrap_or_else(|| Err(crate::runtime::RuntimeError::Other("the active run ended during handoff".into())));
            if let Err(err) = sessions
                .settle_mailbox_async(mail_entry.id, result.is_ok(), result.as_ref().err().map(|e| e.to_string()).as_deref())
                .await
            {
                tracing::warn!(issue_id = %issue.id, mailbox_id = mail_entry.id, error = %err, "issue.tell failed to settle steered mailbox");
            }
            if let Err(e) = &result {
                sessions.settle_words_async(&sub.id, false, Some(&e.to_string())).await?;
            }
            return result.map_err(BoardError::from);
        }
        if matches!(issue.status, IssueStatus::Backlog | IssueStatus::Todo) {
            return Ok(());
        }
        if let Err(err) = sessions.claim_mailbox_by_key_async(&mail_key).await {
            tracing::warn!(issue_id = %issue.id, mail_key = %mail_key, error = %err, "issue.tell failed to claim dispatch mailbox");
        }
        let res = self.dispatch_replies_for_issue_async(&issue).await;
        if let Err(err) = sessions
            .settle_mailbox_async(mail_entry.id, res.is_ok(), res.as_ref().err().map(|e| e.to_string()).as_deref())
            .await
        {
            tracing::warn!(issue_id = %issue.id, mailbox_id = mail_entry.id, error = %err, "issue.tell failed to settle reply mailbox");
        }
        res
    }

    async fn dispatch_replies_for_issue_async(&self, issue: &Issue) -> Result<()> {
        if issue.mandate.is_paused() {
            return Ok(());
        }
        {
            let _work = self.work.lock().await;
            if self.room_for_round_async(issue).await.is_err() {
                return Ok(());
            }
        }
        if matches!(self.send_for_issue_async(&issue.id, None, RunTriggerKind::Comment).await?, Sent::Queued { .. }) {
            let _work = self.work.lock().await;
            self.change_async(&issue.id, IssueChange::Answered).await?;
        }
        Ok(())
    }

    /// Records an explicit human pause on an issue without touching its runtime session.
    pub async fn mark_human_pause_async(&self, issue_id: &str, source: HumanPauseSource, session_id: Option<String>) -> Result<Issue> {
        let pause = HumanPause {
            source,
            clear_condition: ResumeCondition::ExplicitUserResume,
            paused_at: now(),
            session_id,
            note: None,
        };
        let _issue_guard = self.issue_lock(issue_id).await;
        let _work = self.work.lock().await;
        self.change_async(issue_id, IssueChange::Paused(pause)).await
    }

    /// Stops the running turn of the issue's session (its drafter's while
    /// it is drafted) and records a persistent human pause.
    pub async fn stop_async(&self, reference: &str) -> Result<()> {
        self.stop_with_pause_async(reference, HumanPauseSource::UserStop).await
    }

    /// Stops/pauses an issue on behalf of a human (`source`), persisting the pause
    /// across restarts until explicitly resumed by a user action.
    pub async fn stop_with_pause_async(&self, reference: &str, source: HumanPauseSource) -> Result<()> {
        let issue = self.stored_async(reference).await?;
        if issue.status.is_closed() {
            return Err(BoardError::Other("closed issue cannot be paused".into()));
        }
        let refining = issue.refining.as_ref().map(|r| r.session.clone());
        let session = refining.or_else(|| issue.latest_session_id().cloned());
        let pause = HumanPause {
            source,
            clear_condition: ResumeCondition::ExplicitUserResume,
            paused_at: now(),
            session_id: session.clone(),
            note: None,
        };
        {
            let _work = self.work.lock().await;
            self.change_async(&issue.id, IssueChange::Paused(pause)).await?;
        }
        if let Some(sid) = session
            && self.session_engine().is_live(&sid)
            && self.session_engine().session_async(&sid).await.is_some_and(|s| s.phase.is_working())
        {
            self.session_engine().abort_turn_async(&sid).await?;
        }
        Ok(())
    }

    /// Sends queued issues while there is room, in board order.
    pub async fn refresh_queue_async(&self) -> Result<()> {
        self.refresh_queue_unlocked_async().await;
        self.retry_replies_unlocked_async().await;
        Ok(())
    }

    pub(super) async fn refresh_queue_unlocked_async(&self) {
        let queued = {
            let _work = self.work.lock().await;
            match self.issues_async().await {
                Ok(issues) => issues
                    .into_iter()
                    .filter(|t| t.status == IssueStatus::Todo && t.queued_at.is_some() && !t.mandate.is_paused())
                    .map(|t| t.id)
                    .collect::<Vec<_>>(),
                Err(e) => {
                    eprintln!("vibevalley: reading queued issues: {e}");
                    return;
                }
            }
        };
        for id in queued {
            if let Err(e) = self.send_queued_unlocked_async(&id).await {
                // One that cannot go any more leaves the queue.
                tracing::warn!(issue_id = %id, error = %e, "issue.board queued issue could not be sent; unqueuing");
                let _work = self.work.lock().await;
                if let Err(err) = self.change_async(&id, IssueChange::Unqueued).await {
                    tracing::warn!(issue_id = %id, error = %err, "issue.board failed to persist Unqueued state");
                }
            }
        }
    }

    pub(super) async fn refresh_queue_locked_async(&self) {
        let issues = match self.issues_async().await {
            Ok(issues) => issues,
            Err(e) => {
                tracing::warn!(error = %e, "issue.board failed to read queued issues");
                return;
            }
        };
        let queued: Vec<String> = issues
            .iter()
            .filter(|t| t.status == IssueStatus::Todo && t.queued_at.is_some() && !t.mandate.is_paused())
            .map(|t| t.id.clone())
            .collect();
        for id in queued {
            if let Err(e) = self.send_async(&id, None, RunTriggerKind::Issue).await {
                // One that cannot go any more leaves the queue.
                tracing::warn!(issue_id = %id, error = %e, "issue.board queued issue could not be sent; unqueuing");
                if let Err(err) = self.change_async(&id, IssueChange::Unqueued).await {
                    tracing::warn!(issue_id = %id, error = %err, "issue.board failed to persist Unqueued state");
                }
            }
        }
    }

    /// After every round: send what waits, retry replies, and dispatch auto-reviews.
    async fn after_round_async(&self) {
        self.refresh_queue_unlocked_async().await;
        self.retry_replies_unlocked_async().await;
        self.dispatch_auto_reviews_async().await;
    }

    async fn retry_replies_unlocked_async(&self) {
        let issues = match self.issues_async().await {
            Ok(issues) => issues,
            Err(e) => {
                eprintln!("vibevalley: reading reply issues: {e}");
                return;
            }
        };
        for issue in issues
            .into_iter()
            .filter(|i| matches!(i.status, IssueStatus::InReview | IssueStatus::InProgress) && !i.mandate.is_paused())
        {
            let _issue_guard = self.issue_lock(&issue.id).await;
            let Some(fresh) = self.issue_async(&issue.id).await.ok().flatten() else {
                continue;
            };
            if fresh.mandate.is_paused() {
                continue;
            }
            if self.on_board_async(&fresh).await.is_some_and(|s| s.phase.is_working()) {
                continue;
            }
            if self.session_engine().queued_words_async(&fresh.id).await.is_ok_and(|q| !q.is_empty())
                && let Err(e) = self.dispatch_replies_for_issue_async(&fresh).await
            {
                eprintln!("vibevalley: queued replies for {}: {e}", fresh.id);
            }
        }
    }

    /// The issue's newest session, while it is on the board.
    pub(super) async fn on_board_async(&self, issue: &Issue) -> Option<Session> {
        let id = issue.latest_session_id()?;
        self.session_async(id).await
    }

    /// Room left for one more session on `issue`: in the space, and in its repository.
    /// Direct workspace chat sessions do not count toward issue board concurrency limits.
    pub(super) async fn room_async(&self, issue: &Issue, except: &str) -> (usize, usize) {
        let sessions = self.sessions_async().await.unwrap_or_default();
        let board_sessions: Vec<Session> = sessions.into_iter().filter(|h| h.is_board_worker()).collect();
        let (space_limit, per_repo) = effective_limits(self.config());
        let repo_str = issue.repo.as_deref().unwrap_or("");
        let room = vibevalley_core::rules::room_left(&board_sessions, repo_str, space_limit, per_repo, except);
        let mut farm = room.farm;
        let mut repo_room = room.repo.unwrap_or(usize::MAX);
        let in_flight = self.in_flight.lock();
        for (inflight_id, inflight_repo) in in_flight.iter() {
            if inflight_id == &issue.id {
                continue;
            }
            let materialized = board_sessions
                .iter()
                .any(|s| s.issue_id() == Some(inflight_id.as_str()) && s.phase.is_working());
            if materialized {
                continue;
            }
            if space_limit > 0 {
                farm = farm.saturating_sub(1);
            }
            if per_repo > 0 && inflight_repo.as_deref().unwrap_or("") == repo_str {
                repo_room = repo_room.saturating_sub(1);
            }
        }
        (farm, repo_room)
    }

    pub(super) fn keep_words_async<'a>(&'a self, id: &'a str, words: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move { self.state.keep_words_async(id, words).await })
    }

    pub(super) fn take_words_async<'a>(&'a self, id: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>>> + Send + 'a>> {
        Box::pin(async move { self.state.take_words_async(id).await })
    }

    async fn send_queued_unlocked_async(&self, id: &str) -> Result<Option<Sent>> {
        let _issue_guard = self.issue_lock(id).await;
        // Re-check under the per-issue lock: another caller (e.g. `move_to_async`) may have
        // already dispatched or unqueued this issue between the queue snapshot and lock acquisition.
        let still_queued = {
            let _work = self.work.lock().await;
            let issue = self.stored_async(id).await?;
            issue.status == IssueStatus::Todo && issue.queued_at.is_some() && !issue.mandate.is_paused()
        };
        if !still_queued {
            return Ok(None);
        }
        self.send_for_issue_async(id, None, RunTriggerKind::Issue).await.map(Some)
    }

    pub(super) fn send_for_issue_async<'a>(
        &'a self,
        id: &'a str,
        words: Option<String>,
        kind: RunTriggerKind,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Sent>> + Send + 'a>> {
        Box::pin(async move {
            let (issue, all_issues, session, _slot_guard, words, retry_words) = {
                let _work = self.work.lock().await;
                let issue = self.stored_async(id).await?;
                if issue.mandate.is_paused() {
                    return Err(BoardError::Api(ApiError::new(
                        BizCode::IssueRefused,
                        "工单已由人工暂停，等待用户明确恢复".to_string(),
                    )));
                }
                let all_issues = self.issues_async().await?;
                let blocked = vibevalley_core::blocked_issues(&issue, &all_issues);
                let session = self.on_board_async(&issue).await;
                let (space, repo) = self.room_async(&issue, session.as_ref().map(|s| s.id.as_str()).unwrap_or("")).await;
                if !blocked.is_empty() || space == 0 || repo == 0 {
                    if let Some(w) = &words {
                        self.keep_words_async(id, w).await?;
                    }
                    return Ok(Sent::Queued { blocked_by: blocked });
                }
                let slot_guard = self.reserve_in_flight(&issue);
                let kept = self.take_words_async(id).await?;
                let original = words.clone();
                let deliveries = self.session_engine().queued_words_async(id).await?;
                let words = words
                    .into_iter()
                    .chain(deliveries.iter().filter_map(|s| s.payload["text"].as_str().map(str::to_owned)))
                    .collect::<Vec<_>>();
                let words = (!words.is_empty()).then(|| words.join("\n\n"));
                let retry_words = match (&kept, original) {
                    (Some(k), Some(o)) => Some(format!("{k}\n\n{o}")),
                    (Some(k), None) => Some(k.clone()),
                    (None, o) => o,
                };
                let words = match (kept, words) {
                    (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
                    (a, b) => a.or(b),
                };
                (issue, all_issues, session, slot_guard, words, retry_words)
            };
            let result = self.dispatch_session_async(&issue, &all_issues, session, words, kind).await;
            drop(_slot_guard);
            match result {
                Ok(session) => Ok(Sent::Working { session }),
                Err(e) => {
                    let _work = self.work.lock().await;
                    if let Some(w) = &retry_words
                        && let Err(err) = self.keep_words_async(id, w).await
                    {
                        tracing::warn!(issue_id = id, error = %err, "issue.board failed to preserve retry words after dispatch error");
                    }
                    if let Err(err) = self.change_async(id, IssueChange::Unqueued).await {
                        tracing::warn!(issue_id = id, error = %err, "issue.board failed to unqueue issue after dispatch error");
                    }
                    Err(e)
                }
            }
        })
    }

    async fn dispatch_session_async(
        &self,
        issue: &Issue,
        all_issues: &[Issue],
        session: Option<Session>,
        words: Option<String>,
        kind: RunTriggerKind,
    ) -> Result<String> {
        match session {
            Some(s) => {
                let words = words.unwrap_or_else(|| default_words(issue));
                let trigger = trigger_of(kind, Some(words.clone()));
                let storage = self.storage.as_deref();
                let again = |words: &str| {
                    format!(
                        "{}\n\nYou are taking this issue up again; earlier work may exist in the workspace or your branch: \
                         check `git status` and `git log` first if working in a repo.",
                        brief(issue, all_issues, Some(words), storage)
                    )
                };
                let live_hook = self.state.issue_change_hook(issue.id.clone(), IssueChange::Answered);
                let reopen_hook = (!s.is_readonly_issue_helper()).then(|| {
                    self.state.issue_change_hook(
                        issue.id.clone(),
                        IssueChange::Started {
                            session: s.id.clone(),
                            worker: !s.is_refining(),
                        },
                    )
                });
                let sid = self
                    .session_engine()
                    .next_round_async(issue, &s, words, again, trigger, Some(live_hook), reopen_hook)
                    .await?;
                let _ = self.change_async(&issue.id, IssueChange::Unqueued).await;
                Ok(sid)
            }
            None => self.hire_async(issue, all_issues, words, kind).await,
        }
    }

    /// Starts (or continues) the issue's session when its blockers are done
    /// and there is room; else it waits in todo and `refresh_queue_async` sends
    /// it later. Holds `work`.
    pub(super) fn send_async<'a>(
        &'a self,
        id: &'a str,
        words: Option<String>,
        kind: RunTriggerKind,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Sent>> + Send + 'a>> {
        Box::pin(async move {
            let issue = self.stored_async(id).await?;
            if issue.mandate.is_paused() {
                return Err(BoardError::Api(ApiError::new(
                    BizCode::IssueRefused,
                    "工单已由人工暂停，等待用户明确恢复".to_string(),
                )));
            }
            let all_issues = self.issues_async().await?;
            let blocked = vibevalley_core::blocked_issues(&issue, &all_issues);
            let session = self.on_board_async(&issue).await;
            let (space, repo) = self.room_async(&issue, session.as_ref().map(|s| s.id.as_str()).unwrap_or("")).await;
            if !blocked.is_empty() || space == 0 || repo == 0 {
                if let Some(w) = &words {
                    self.keep_words_async(id, w).await?;
                }
                return Ok(Sent::Queued { blocked_by: blocked });
            }
            let kept = self.take_words_async(id).await?;
            let original = words.clone();
            let deliveries = self.session_engine().queued_words_async(id).await?;
            let words = words
                .into_iter()
                .chain(deliveries.iter().filter_map(|s| s.payload["text"].as_str().map(str::to_owned)))
                .collect::<Vec<_>>();
            let words = (!words.is_empty()).then(|| words.join("\n\n"));
            let retry_words = match (&kept, original) {
                (Some(k), Some(o)) => Some(format!("{k}\n\n{o}")),
                (Some(k), None) => Some(k.clone()),
                (None, o) => o,
            };
            let words = match (kept, words) {
                (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
                (a, b) => a.or(b),
            };
            let result = self.dispatch_session_async(&issue, &all_issues, session, words, kind).await;
            match result {
                Ok(session) => Ok(Sent::Working { session }),
                Err(e) => {
                    // Not sent: it leaves the queue, the words stay for the next try.
                    if let Some(w) = &retry_words
                        && let Err(err) = self.keep_words_async(id, w).await
                    {
                        tracing::warn!(issue_id = id, error = %err, "issue.board failed to preserve retry words after send_async error");
                    }
                    if let Err(err) = self.change_async(id, IssueChange::Unqueued).await {
                        tracing::warn!(issue_id = id, error = %err, "issue.board failed to unqueue issue after send_async error");
                    }
                    Err(e)
                }
            }
        })
    }

    async fn hire_async(&self, issue: &Issue, all: &[Issue], words: Option<String>, kind: RunTriggerKind) -> Result<String> {
        let drive = self.runtime.driver().drive(issue.assigned_agent(), issue).await?;
        let cwd = self.resolve_issue_cwd_async(issue, drive.is_local).await;
        let name = format!("{} #{}", drive.name, issue.number);
        let state = self.state.clone();
        let issue_id = issue.id.clone();
        self.session_engine()
            .hire_async(Hire {
                issue,
                prompt: brief(issue, all, words.as_deref(), self.storage.as_deref()),
                trigger: trigger_of(kind, words),
                drive,
                cwd,
                name,
                brief: issue.title.clone(),
                drafting: false,
                on_start: Some(Box::new(move |sid| {
                    state.issue_change_hook(
                        issue_id,
                        IssueChange::Started {
                            session: sid.to_string(),
                            worker: true,
                        },
                    )
                })),
            })
            .await
            .map_err(Into::into)
    }

    async fn load_auto_review_async(&self, issue_id: &str) -> AutoReviewDoc {
        self.session_engine()
            .durable_store()
            .read_with_async(issue_id.to_string(), |tx, id| {
                Box::pin(async move { tx.document_async("issue", id, "auto_review").await })
            })
            .await
            .ok()
            .flatten()
            .and_then(|d| serde_json::from_value::<AutoReviewDoc>(d.state).ok())
            .unwrap_or_default()
    }

    async fn save_auto_review_async(&self, issue_id: &str, doc: &AutoReviewDoc) {
        match serde_json::to_value(doc) {
            Ok(val) => {
                if let Err(err) = self
                    .session_engine()
                    .durable_store()
                    .write_with_async((issue_id.to_string(), val), |tx, (id, val)| {
                        Box::pin(async move { tx.put_document_async("issue", id, "auto_review", val).await })
                    })
                    .await
                {
                    tracing::warn!(issue_id, error = %err, "issue.board failed to persist auto_review state");
                }
            }
            Err(err) => {
                tracing::warn!(issue_id, error = %err, "issue.board failed to serialize auto_review state");
            }
        }
    }

    async fn readonly_issue_place_async(&self, issue: &Issue, drive_is_local: bool) -> Option<PathBuf> {
        if let Some(worker) = self.on_board_async(issue).await
            && let Some(cwd) = worker.cwd.as_deref().filter(|c| !c.is_empty())
        {
            return Some(PathBuf::from(cwd));
        }
        self.resolve_issue_cwd_async(issue, drive_is_local).await
    }

    /// Dispatches a readonly auto-reviewer for `InReview` issues when an eligible
    /// enabled reviewer profile applies and `mandate.max_bot_review_rounds` has remaining budget.
    pub(super) async fn dispatch_auto_reviews_async(&self) {
        let Some(reviewer) = self.runtime.driver().reviewer_profile() else {
            return;
        };
        let (issues, sessions) = match tokio::try_join!(self.issues_async(), self.sessions_async()) {
            Ok(pair) => pair,
            Err(err) => {
                tracing::warn!(error = %err, "issue.board auto-review dispatch failed to load issues/sessions");
                return;
            }
        };
        for issue in issues {
            if issue.status != IssueStatus::InReview
                || issue.stage.state != StageKind::Reviewing
                || issue.parent.is_some()
                || issue.reviewed_at.is_some()
                || !issue.was_sent()
                || issue.mandate.is_paused()
                || issue.mandate.max_bot_review_rounds <= 0
                || issue.deliver == Deliverable::Answer
                || (issue.repo.is_none() && issue.criteria.is_empty())
                || issue.assigned_agent() == Some(reviewer.id.as_str())
            {
                continue;
            }
            let issue_guard = self.issue_lock(&issue.id).await;
            let Some(fresh) = self.issue_async(&issue.id).await.ok().flatten() else {
                continue;
            };
            if fresh.status != IssueStatus::InReview
                || fresh.stage.state != StageKind::Reviewing
                || fresh.reviewed_at.is_some()
                || fresh.mandate.is_paused()
                || fresh.mandate.max_bot_review_rounds <= 0
            {
                continue;
            }
            let Some(worker) = self.on_board_async(&fresh).await else {
                continue;
            };
            if worker.phase.is_working() || worker.last_run.as_ref().is_none_or(|r| r.outcome != Outcome::Completed) {
                continue;
            }
            let review_running = sessions.iter().any(|s| {
                s.issue_id() == Some(fresh.id.as_str()) && s.is_readonly_issue_helper() && s.profile_id() == Some(reviewer.id.as_str()) && s.phase.is_working()
            });
            if review_running {
                continue;
            }
            let previous_doc = self.load_auto_review_async(&fresh.id).await;
            if previous_doc.rounds >= fresh.mandate.max_bot_review_rounds {
                continue;
            }
            if previous_doc.last_session_id.as_deref() == Some(worker.id.as_str()) && previous_doc.last_session_runs == worker.runs {
                continue;
            }
            let Ok(drive) = self.runtime.driver().drive(Some(&reviewer.id), &fresh).await else {
                continue;
            };
            let cwd = self.readonly_issue_place_async(&fresh, drive.is_local).await;
            let next_round = previous_doc.rounds + 1;
            let next_doc = AutoReviewDoc {
                rounds: next_round,
                last_session_id: Some(worker.id.clone()),
                last_session_runs: worker.runs,
            };
            self.save_auto_review_async(&fresh.id, &next_doc).await;
            drop(issue_guard);

            let summary = worker
                .last_run
                .as_ref()
                .map(|r| r.summary.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("(no summary provided)");
            let criteria = if fresh.criteria.is_empty() {
                "- (none specified)".to_string()
            } else {
                fresh.criteria.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n")
            };
            let prompt = format!(
                "Automated review round {next_round}/{} for issue #{} ({}): {}\n\n\
                 Acceptance criteria:\n{criteria}\n\n\
                 Primary worker ({}) latest summary:\n{summary}\n\n\
                 Inspect the acceptance criteria and git diff (`issue_diff_get`), never modify or commit any files, \
                 and record your verdict via `issue_review(id=\"{}\", pass=true|false, findings=..., text=...)`.",
                fresh.mandate.max_bot_review_rounds, fresh.number, fresh.id, fresh.title, worker.name, fresh.id
            );
            let name = format!("{} #{}", reviewer.name, fresh.number);
            let hire = Hire {
                issue: &fresh,
                prompt,
                trigger: trigger_of(RunTriggerKind::Issue, None),
                drive,
                cwd,
                name,
                brief: format!("Review #{}: {}", fresh.number, fresh.title),
                drafting: false,
                on_start: None,
            };
            if let Err(e) = self.session_engine().hire_readonly_async(hire, RunMode::ReadOnlyReview).await {
                self.save_auto_review_async(&fresh.id, &previous_doc).await;
                eprintln!("vibevalley: auto-reviewer dispatch for #{}: {e}", fresh.number);
            }
        }
    }

    /// Dispatches or re-engages a readonly `@<agent>` collaborator session for `issue_id`
    /// without acquiring write ownership or disturbing the issue's primary worker.
    pub(crate) async fn dispatch_collaborator_async(&self, issue_id: &str, agent_id: &str, message_body: &str, _message_id: &str) -> Result<String> {
        let fresh = self.stored_async(issue_id).await?;
        if fresh.status.is_closed() {
            return Err(BoardError::Api(ApiError::new(
                BizCode::IssueRefused,
                vibevalley_i18n::t("server.issue.closed", &[]),
            )));
        }
        let drive = self.runtime.driver().drive(Some(agent_id), &fresh).await?;
        let prompt = format!(
            "You were @mentioned in the discussion thread of issue #{} ({}): \"{}\"\n\n\
             Comment:\n{}\n\n\
             Inspect the issue, diff (`issue_diff_get`), and workspace read-only without modifying any files or changing issue status, \
             and provide a helpful review/answer in your report.",
            fresh.number,
            fresh.id,
            fresh.title,
            message_body.trim()
        );
        let sessions = self.sessions_async().await?;
        for s in sessions {
            if s.issue_id() == Some(fresh.id.as_str())
                && s.is_readonly_issue_helper()
                && s.profile_id() == Some(agent_id)
                && !matches!(s.phase, Phase::Closed(_))
                && self.session_engine().helper_mode_async(&s, Some(&fresh)).await == RunMode::ReadOnlyCollaborator
            {
                if let Some(steered) = self.session_engine().steer_async(&s, &prompt).await {
                    return steered.map(|()| s.id).map_err(Into::into);
                }
                return self
                    .session_engine()
                    .next_readonly_round_async(
                        &fresh,
                        &s,
                        prompt.clone(),
                        |_| prompt.clone(),
                        trigger_of(RunTriggerKind::Comment, Some(message_body.to_string())),
                    )
                    .await
                    .map_err(Into::into);
            }
        }
        let cwd = self.readonly_issue_place_async(&fresh, drive.is_local).await;
        let name = format!("{} #{}", drive.name, fresh.number);
        self.session_engine()
            .hire_readonly_async(
                Hire {
                    issue: &fresh,
                    prompt,
                    trigger: trigger_of(RunTriggerKind::Comment, Some(message_body.to_string())),
                    drive,
                    cwd,
                    name,
                    brief: format!("Collaborate #{}: {}", fresh.number, fresh.title),
                    drafting: false,
                    on_start: None,
                },
                RunMode::ReadOnlyCollaborator,
            )
            .await
            .map_err(Into::into)
    }

    /// Marks slices dirty so derived issue projections refresh.
    pub async fn refresh_issue_async(&self, id: &str) {
        self.state.refresh_issue_async(id).await;
    }

    /// Settles `reference` after its tracked pull request transitions to `merged` or `closed`.
    pub async fn settle_pull_async(&self, reference: &str, state: PullRequestState) -> Result<Option<Issue>> {
        let Some(initial) = self.issue_async(reference).await? else {
            return Ok(None);
        };
        let issue_guard = self.issue_lock(&initial.id).await;
        self.state.refresh_issue_async(&initial.id).await;
        let Some(updated) = self.issue_async(&initial.id).await? else {
            return Ok(None);
        };
        if state == PullRequestState::Open || !vibevalley_core::pr::finishes_with_pull_request(&updated) {
            return Ok(Some(updated));
        }
        if let Some(s) = self.on_board_async(&updated).await {
            let close = (state == PullRequestState::Merged).then_some(SessionClose::Completed);
            self.session_engine().dismiss_with_close_async(&s.id, close).await?;
        }
        let change = match state {
            PullRequestState::Merged => {
                let receipt = updated.delivery_receipt.clone().or_else(|| {
                    updated.pull_request.as_ref().map(|pr| DeliveryReceipt::PullRequest {
                        url: pr.url.clone(),
                        number: Some(pr.number),
                        branch: None,
                        summary: None,
                    })
                });
                IssueChange::Delivered(Landing::PullRequest, receipt)
            }
            PullRequestState::Closed => IssueChange::Canceled(IssueCanceled::Dismissed),
            PullRequestState::Open => unreachable!(),
        };
        let done = {
            let _work = self.work.lock().await;
            let done = self.change_async(&updated.id, change).await?;
            if let Err(err) = self.take_words_async(&updated.id).await {
                tracing::warn!(issue_id = %updated.id, error = %err, "issue.board failed to clear queued words on settle_pull");
            }
            done
        };
        drop(issue_guard);
        self.refresh_queue_unlocked_async().await;
        Ok(Some(done))
    }

    /// Finds an open issue whose active session `cwd`, `delivery_receipt` branch, or
    /// conventional `vibevalley/issue-<n>` branch matches a published branch in `cwd`.
    pub async fn open_issue_for_branch_async(&self, cwd: &str, branch: &str) -> Option<Issue> {
        let cwd_canon = tokio::fs::canonicalize(cwd).await.ok();
        let inferred_repo = match &self.repos {
            Some(repos) => repos.infer_name_for_dir_async(Path::new(cwd)).await,
            None => None,
        };
        let issues = self.issues_async().await.ok()?;
        let sessions = self.sessions_async().await.ok()?;
        for issue in issues {
            if issue.status.is_closed() {
                continue;
            }
            let session = issue.latest_session_id().and_then(|id| sessions.iter().find(|s| s.id == *id));
            let receipt_branch = match issue.delivery_receipt.as_ref() {
                Some(DeliveryReceipt::PullRequest { branch: Some(b), .. }) | Some(DeliveryReceipt::Commit { branch: Some(b), .. }) => Some(b.as_str()),
                _ => None,
            };
            let conventional_branch = format!("vibevalley/issue-{}", issue.number);
            let branch_matches = receipt_branch == Some(branch) || conventional_branch == branch;
            if let Some(wt) = session.and_then(|s| s.cwd.as_deref()) {
                let wt_canon = tokio::fs::canonicalize(wt).await.ok();
                if (wt == cwd || (wt_canon.is_some() && wt_canon == cwd_canon)) && branch_matches {
                    return Some(issue);
                }
            }
            if !branch_matches {
                continue;
            }
            if let (Some(repo), Some(inferred)) = (&issue.repo, &inferred_repo)
                && repo == inferred
            {
                return Some(issue);
            }
            if let Some(repo) = &issue.repo
                && let Some(repos) = &self.repos
                && let Some(dir) = repos.resolve_dir_async(repo).await
                && tokio::fs::canonicalize(&dir).await.ok() == cwd_canon
            {
                return Some(issue);
            }
        }
        None
    }

    /// Accepted: closes the issue with its polymorphic [`DeliveryReceipt`] (caller holds
    /// `issue_lock` for `issue.id` and refreshes queue afterwards).
    fn complete_for_issue_async<'a>(
        &'a self,
        issue: &'a Issue,
        incoming_receipt: Option<DeliveryReceipt>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(r) = &issue.refining {
                self.session_engine().dismiss_async(&r.session).await?;
            }
            let session = self.on_board_async(issue).await;
            if let Some(s) = &session
                && s.phase.is_working()
                && let Err(err) = self.session_engine().abort_turn_async(&s.id).await
            {
                tracing::warn!(issue_id = %issue.id, session_id = %s.id, error = %err, "issue.board failed to abort active turn before completing issue");
            }
            let receipt = incoming_receipt.or_else(|| issue.delivery_receipt.clone());
            if !issue.was_sent() && receipt.is_none() {
                return self.finish_delivery_async(issue, Landing::None, None).await;
            }
            let has_pr_receipt = matches!(receipt, Some(DeliveryReceipt::PullRequest { .. }));
            if issue.was_sent() && issue.deliver == Deliverable::PullRequest && issue.pull_request.is_none() && !has_pr_receipt {
                return Err(BoardError::Other(vibevalley_i18n::t("server.issue.deliveryNeedsPr", &[])));
            }
            let pr_merged = issue.pull_request.as_ref().is_some_and(|pr| pr.state == PullRequestState::Merged);
            let landing = match receipt.as_ref() {
                Some(DeliveryReceipt::PullRequest { .. }) => {
                    if pr_merged {
                        Landing::PullRequest
                    } else {
                        Landing::Submitted
                    }
                }
                Some(DeliveryReceipt::Commit { .. }) => Landing::Merged,
                Some(DeliveryReceipt::Note { .. } | DeliveryReceipt::Answer { .. }) => Landing::None,
                None => {
                    if pr_merged {
                        Landing::PullRequest
                    } else if issue.deliver == Deliverable::PullRequest {
                        Landing::Submitted
                    } else if issue.deliver == Deliverable::Branch {
                        Landing::Kept
                    } else {
                        Landing::None
                    }
                }
            };
            self.finish_delivery_async(issue, landing, receipt).await
        })
    }

    async fn finish_delivery_async(&self, issue: &Issue, landing: Landing, receipt: Option<DeliveryReceipt>) -> Result<()> {
        if let Some(s) = self.on_board_async(issue).await {
            self.session_engine().dismiss_with_close_async(&s.id, Some(SessionClose::Completed)).await?;
        }
        let _work = self.work.lock().await;
        self.change_async(&issue.id, IssueChange::Delivered(landing, receipt)).await?;
        if let Err(err) = self.take_words_async(&issue.id).await {
            tracing::warn!(issue_id = %issue.id, error = %err, "issue.board failed to clear queued words on delivery");
        }
        Ok(())
    }

    fn close_issue_for_locked_parent_async<'a>(
        &'a self,
        issue: &'a Issue,
        why: IssueCanceled,
    ) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let children: Vec<Issue> = self
                .issues_async()
                .await?
                .into_iter()
                .filter(|t| t.parent.as_ref() == Some(&issue.id) && !t.status.is_closed())
                .collect();
            for child in children {
                let _child_guard = self.issue_lock(&child.id).await;
                self.close_issue_for_locked_parent_async(&child, why).await?;
            }
            if let Some(r) = &issue.refining {
                self.session_engine().dismiss_async(&r.session).await?;
            }
            if let Some(s) = self.on_board_async(issue).await {
                self.session_engine().dismiss_async(&s.id).await?;
            }
            let _work = self.work.lock().await;
            if let Err(err) = self.take_words_async(&issue.id).await {
                tracing::warn!(issue_id = %issue.id, error = %err, "issue.board failed to clear queued words on close");
            }
            self.change_async(&issue.id, IssueChange::Canceled(why)).await?;
            Ok(())
        })
    }
}

pub(super) fn default_words(issue: &Issue) -> String {
    match issue.stage.stuck {
        Some(StuckReason::Conflict) => {
            let base = issue.conflict.as_ref().map(|c| c.base.as_str()).unwrap_or("the base branch");
            format!(
                "Your branch conflicts with {base}. Merge {base} into your branch, resolve the conflicts, run the \
                 tests and commit."
            )
        }
        Some(StuckReason::Failed) => "The last round failed. Find out why, fix it and try again.".into(),
        Some(StuckReason::Interrupted) => "You were interrupted. Check `git status` and `git log`, then carry on.".into(),
        _ => "Carry on.".into(),
    }
}

pub(super) fn attachments_brief(issue: &Issue, storage: Option<&Storage>) -> String {
    if issue.attachments.is_empty() {
        return String::new();
    }
    let mut lines = vec!["Attachments:".to_string()];
    for a in &issue.attachments {
        let path = storage.map(|s| format!(" — {}", s.path_of(&a.id).display())).unwrap_or_default();
        lines.push(format!("- {} ({}, {} bytes){path}", a.name, a.r#type, a.size));
    }
    lines.join("\n")
}

/// What the agent is told to do.
pub(super) fn brief(issue: &Issue, _all: &[Issue], words: Option<&str>, storage: Option<&Storage>) -> String {
    let brief = vibevalley_core::prompts::issue_brief(&issue.title, &issue.description, &issue.criteria, issue.deliver);
    let attachments = attachments_brief(issue, storage);
    let constraints = vibevalley_core::work_constraints(issue.constraints.as_ref(), &[]);
    let brief = [brief, attachments, constraints]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    match words.map(str::trim).filter(|w| !w.is_empty()) {
        Some(words) => format!("{words}{}", vibevalley_i18n::t("server.issue.brief.original", &[("brief", brief.into())])),
        None => brief,
    }
}
