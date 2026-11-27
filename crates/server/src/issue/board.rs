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
use vibevalley_protocol::{
    ActorRef, ApiError, AppliedIssue, Assignment, Attachment, BacklogTriageSuggestion, BizCode, Deliverable, HumanPause, HumanPauseSource, Issue,
    IssueCanceled, IssueConstraints, IssueMandate, IssueRelation, IssueStageKind as StageKind, IssueStatus, JsNumber, Landing, Priority, ResumeCondition, Run,
    RunTriggerKind, Session, SliceBundle, StuckReason,
};
use vibevalley_runtime::oar::Registry;

use super::store::{BoardConfig, BoardError, CronOfIssue, IssueChange, IssueState, Opened, PullOfIssue, Result, Undelivered};
use crate::channel::Chat;
use crate::context::{AsyncRequestKeys, Context, now};
use crate::repo::Repo;
use crate::runtime::{
    Changes, Delivery, DraftEnd, Hire, Landed, Leave, MailboxSource, MailboxStatus, OnDisk, Rounds, Runtime, SessionEngine, Worktree, find_issue, io,
    issue_branch, trigger_of,
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
pub(super) struct TriageStore {
    #[serde(default)]
    pub custom: Vec<BacklogTriageSuggestion>,
    #[serde(default)]
    pub dismissed: HashSet<String>,
}

/// Issue board domain service.
pub struct Board {
    ctx: Arc<Context>,
    pub(super) state: Arc<IssueState>,
    pub(super) runtime: Arc<Runtime>,
    pub(super) repos: Option<Arc<Repo>>,
    channel: Option<Arc<Chat>>,
    storage: Option<Arc<Storage>>,
    pub(super) create_keys: AsyncRequestKeys<AppliedIssue>,
    pub(super) status_keys: AsyncRequestKeys<AppliedIssue>,
    /// Held for short workflow state checks and room reservations so slow
    /// git/worktree/dispatch I/O runs outside this coarse lock.
    pub(super) work: AsyncMutex<()>,
    pub(super) triage_path: PathBuf,
    pub(super) triage: AsyncMutex<TriageStore>,
    issue_locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    in_flight: Mutex<HashMap<String, Option<String>>>,
    join_lock: AsyncMutex<()>,
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
    fn drafted(&self, end: DraftEnd) -> vibevalley_runtime::agent::durable::BoxFuture<'_, ()> {
        let weak = self.0.clone();
        Box::pin(async move {
            if let Some(board) = weak.upgrade() {
                board.finish_draft_async(end).await;
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

fn pending_delivery(issue: &Issue) -> Option<&vibevalley_protocol::ProjectCheckReceipt> {
    if issue.status.is_closed() || issue.deliver != Deliverable::Change {
        return None;
    }
    issue
        .delivery_evidence
        .as_ref()?
        .check
        .as_ref()
        .filter(|r| r.status != vibevalley_protocol::ProjectCheckStatus::Failed && r.target_commit != r.candidate_commit)
}

impl Board {
    /// The board as stored, without taking it: for reading while another
    /// process holds it. Working sessions show as they were last stored.
    pub async fn snapshot_async(path: &Path) -> Result<SliceBundle> {
        IssueState::snapshot_async(path).await
    }

    /// Takes the board lock and wires issue workflow coordination onto an already-opened
    /// [`Runtime`]. Settles published deliveries, cancels lost issues, and dismisses
    /// cut-short drafts from `opened`. Call `refresh_queue_async` afterwards to send what waits.
    pub async fn open_async(
        ctx: Arc<Context>,
        runtime: Arc<Runtime>,
        opened: Opened,
        repos: Option<Arc<Repo>>,
        channel: Option<Arc<Chat>>,
    ) -> Result<Arc<Board>> {
        Self::with_storage(ctx, runtime, opened, repos, channel, None).await
    }

    /// Takes the board lock with optional content-addressed [`Storage`] for resolving
    /// issue attachments and formatting their local CAS paths in agent prompts.
    pub async fn with_storage(
        ctx: Arc<Context>,
        runtime: Arc<Runtime>,
        opened: Opened,
        repos: Option<Arc<Repo>>,
        channel: Option<Arc<Chat>>,
        storage: Option<Arc<Storage>>,
    ) -> Result<Arc<Board>> {
        let config = runtime.config();
        tokio::fs::create_dir_all(config.data_dir.join("reports")).await.map_err(io)?;
        tokio::fs::create_dir_all(config.data_dir.join("records")).await.map_err(io)?;
        let lock_path = config.data_dir.join("board.lock");
        let file = tokio::fs::File::create(&lock_path).await.map_err(io)?.into_std().await;
        // A child process forked while the last holder had it open may hold
        // it a moment longer.
        let deadline = Instant::now() + Duration::from_secs(2);
        while file.try_lock().is_err() {
            if Instant::now() > deadline {
                return Err(BoardError::Busy(lock_path));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let state = Arc::new(IssueState::new(ctx.clone(), runtime.write_lock().clone()));
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
            channel,
            storage,
            create_keys: AsyncRequestKeys::default(),
            status_keys: AsyncRequestKeys::default(),
            work: AsyncMutex::new(()),
            triage_path,
            triage: AsyncMutex::new(triage_store),
            issue_locks: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            join_lock: AsyncMutex::new(()),
            lock: Mutex::new(Some(tokio::fs::File::from_std(file))),
        });
        board.runtime.session_engine().on_rounds(Box::new(Heard(Arc::downgrade(&board))));
        board.recover_published_deliveries_async().await?;
        for id in opened.lost {
            if let Ok(issue) = board.stored_async(&id).await
                && !issue.status.is_closed()
                && issue.latest_session_id().is_some()
                && pending_delivery(&issue).is_none()
            {
                board.close_issue_async(&issue, IssueCanceled::Lost).await?;
            }
        }
        // A draft cut short leaves its issue as it was.
        for draft in opened.drafts {
            board.runtime.session_engine().dismiss_async(&draft, Leave::Discard).await?;
        }
        Ok(board)
    }

    async fn issue_lock(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut map = self.issue_locks.lock();
            map.retain(|_, v| v.strong_count() > 0);
            if let Some(existing) = map.get(id).and_then(Weak::upgrade) {
                existing
            } else {
                let fresh = Arc::new(AsyncMutex::new(()));
                map.insert(id.to_string(), Arc::downgrade(&fresh));
                fresh
            }
        };
        lock.lock_owned().await
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
        let (runtime, opened) = Runtime::open_with_registry_async(ctx.clone(), registry, config).await?;
        Board::open_async(ctx, runtime, opened, None, None).await
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

    pub fn worktree(&self) -> &Worktree {
        self.runtime.worktree()
    }

    pub fn repos(&self) -> Option<&Arc<Repo>> {
        self.repos.as_ref()
    }

    pub fn channel(&self) -> Option<&Arc<Chat>> {
        self.channel.as_ref()
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
        self.runtime.runs_async(issue).await
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
        let remote_machine = machine_id.as_deref().is_some_and(|m| m != vibevalley_protocol::LOCAL_MACHINE_ID);
        let is_remote_repo_url = |raw: &str| {
            let trimmed = raw.trim();
            trimmed.starts_with("https://") || trimmed.starts_with("http://") || trimmed.starts_with("ssh://") || trimmed.starts_with("git@")
        };
        let (repo, remote_repo_ref) = match &new.repo {
            Some(path) => {
                let raw = path.to_string_lossy();
                if remote_machine && is_remote_repo_url(&raw) {
                    (None, Some(raw.trim().to_string()))
                } else {
                    (Some(self.worktree().ensure_repo_async(self.worktree().repo_dir(&raw)).await?), None)
                }
            }
            None => (None, None),
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
        let repo_root_from_repo = match (&repo, remote_repo_ref) {
            (Some(r), _) => Some(self.worktree().repo_ref_async(r.root()).await),
            (None, Some(url)) => Some(url),
            (None, None) => None,
        };
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
        self.stored_async(&id).await
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
        self.move_reviewed_async(reference, to, words, None)
    }

    pub fn move_reviewed_async<'a>(
        &'a self,
        reference: &'a str,
        to: IssueStatus,
        words: Option<&'a str>,
        seen: Option<&'a vibevalley_protocol::ReviewRevision>,
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
                        self.session_engine().dismiss_async(&s.id, Leave::KeepBranch).await?;
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
                    self.complete_for_issue_async(&issue).await?;
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
                return steered;
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
            let _ = sessions.settle_mailbox_async(mail_entry.id, false, Some(&e.to_string())).await;
            sessions.settle_words_async(&sub.id, false, Some(&e.to_string())).await?;
            return Err(e);
        }
        if let Some(session) = board_session
            && session.phase.is_working()
            && sessions.is_live(&session.id)
            && sessions.bind_to_active_run_async(&session.id, &sub).await?
        {
            let _ = sessions.claim_mailbox_by_key_async(&mail_key).await;
            let result = sessions
                .steer_async(&session, words)
                .await
                .unwrap_or_else(|| Err(BoardError::Other("the active run ended during handoff".into())));
            let _ = sessions
                .settle_mailbox_async(mail_entry.id, result.is_ok(), result.as_ref().err().map(|e| e.to_string()).as_deref())
                .await;
            if let Err(e) = &result {
                sessions.settle_words_async(&sub.id, false, Some(&e.to_string())).await?;
            }
            return result;
        }
        if matches!(issue.status, IssueStatus::Backlog | IssueStatus::Todo) {
            return Ok(());
        }
        let _ = sessions.claim_mailbox_by_key_async(&mail_key).await;
        let res = self.dispatch_replies_for_issue_async(&issue).await;
        let _ = sessions
            .settle_mailbox_async(mail_entry.id, res.is_ok(), res.as_ref().err().map(|e| e.to_string()).as_deref())
            .await;
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

    /// Sends queued issues while there is room, in board order. Children in
    /// review are merged into their parents first.
    pub async fn refresh_queue_async(&self) -> Result<()> {
        {
            let _join = self.join_lock.lock().await;
            self.join_children_async().await?;
        }
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
            if let Err(e) = self.send_unlocked_async(&id, None, RunTriggerKind::Issue).await {
                // One that cannot go any more leaves the queue.
                eprintln!("vibevalley: issue {id} could not be sent: {e}");
                let _work = self.work.lock().await;
                let _ = self.change_async(&id, IssueChange::Unqueued).await;
            }
        }
    }

    pub(super) async fn refresh_queue_locked_async(&self) {
        let issues = match self.issues_async().await {
            Ok(issues) => issues,
            Err(e) => {
                eprintln!("vibevalley: reading queued issues: {e}");
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
                eprintln!("vibevalley: issue {id} could not be sent: {e}");
                let _ = self.change_async(&id, IssueChange::Unqueued).await;
            }
        }
    }

    /// After every round: children in review merge into their parents,
    /// then what waits is sent.
    async fn after_round_async(&self) {
        {
            let _join = self.join_lock.lock().await;
            if let Err(e) = self.join_children_async().await {
                eprintln!("vibevalley: child issues could not be merged: {e}");
            }
        }
        self.refresh_queue_unlocked_async().await;
        self.retry_replies_unlocked_async().await;
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

    async fn send_unlocked_async(&self, id: &str, words: Option<String>, kind: RunTriggerKind) -> Result<Sent> {
        let _issue_guard = self.issue_lock(id).await;
        self.send_for_issue_async(id, words, kind).await
    }

    fn send_for_issue_async<'a>(
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
                    if let Some(w) = &retry_words {
                        let _ = self.keep_words_async(id, w).await;
                    }
                    let _ = self.change_async(id, IssueChange::Unqueued).await;
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
                        "{}\n\nYou are taking this issue up again in its worktree; earlier work is on its branch: \
                         check `git status` and `git log` first.",
                        brief(issue, all_issues, Some(words), storage)
                    )
                };
                self.session_engine().next_round_async(issue, &s, words, again, trigger).await
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
                    if let Some(w) = &retry_words {
                        let _ = self.keep_words_async(id, w).await;
                    }
                    let _ = self.change_async(id, IssueChange::Unqueued).await;
                    Err(e)
                }
            }
        })
    }

    async fn hire_async(&self, issue: &Issue, all: &[Issue], words: Option<String>, kind: RunTriggerKind) -> Result<String> {
        let drive = self.runtime.driver().drive(issue.assigned_agent(), issue).await?;
        let wp = self.worktree();
        let parent_number = match issue.parent.as_deref() {
            Some(p) => all.iter().find(|i| i.id == p).map(|p| p.number),
            None => None,
        };
        let (cwd, branch, base) = if !drive.is_local {
            // PR-first remote dispatch: skip local git worktree creation; the remote machine
            // prepares its own isolated worktree using `repo_ref`, `branch`, and `base_ref`.
            let branch = issue.repo.as_ref().map(|_| issue_branch(issue.number));
            let base = if let Some(repo) = issue.repo.as_deref() {
                if let Some(p) = parent_number {
                    Some(issue_branch(p))
                } else {
                    wp.existing(repo)?
                        .and_then(|main| Worktree::main_branch(&main).ok())
                        .or_else(|| Some("main".to_string()))
                }
            } else {
                None
            };
            (PathBuf::new(), branch, base)
        } else {
            match wp.main_repo_async(issue.repo.as_deref()).await? {
                Some(main) => {
                    let base = wp.base(&main, parent_number)?;
                    let (dir, branch) = wp.worktree_async(&main, issue.number, &base).await?;
                    (dir, Some(branch), Some(base))
                }
                None => (wp.context_async(&issue.id).await?, None, None),
            }
        };
        let name = format!("{} #{}", drive.name, issue.number);
        self.session_engine()
            .hire_async(Hire {
                issue,
                prompt: brief(issue, all, words.as_deref(), self.storage.as_deref()),
                trigger: trigger_of(kind, words),
                drive,
                cwd,
                branch,
                base,
                name,
                brief: issue.title.clone(),
                drafting: false,
            })
            .await
    }

    /// Registers the owner-backed `Issue.cron` lookup (from `cron`).
    pub async fn use_cron_of_issue_async(&self, lookup: CronOfIssue) {
        self.state.use_cron_of_issue_async(lookup).await;
    }

    /// Registers the owner-backed `Issue.pull_request` lookup (from `issue/pull`).
    pub async fn use_pull_of_issue_async(&self, lookup: PullOfIssue) {
        self.state.use_pull_of_issue_async(lookup).await;
    }

    /// Refreshes owner-backed `cron` and `pull_request` projections on `id`.
    pub async fn refresh_issue_async(&self, id: &str) {
        self.state.refresh_issue_async(id).await;
    }

    /// Settles `reference` after its tracked pull request transitions to `merged` or `closed`.
    pub async fn settle_pull_async(&self, reference: &str, state: vibevalley_protocol::PullRequestState) -> Result<Option<Issue>> {
        let Some(initial) = self.issue_async(reference).await? else {
            return Ok(None);
        };
        let issue_guard = self.issue_lock(&initial.id).await;
        self.state.refresh_issue_async(&initial.id).await;
        let Some(updated) = self.issue_async(&initial.id).await? else {
            return Ok(None);
        };
        if state == vibevalley_protocol::PullRequestState::Open || !vibevalley_core::pr::finishes_with_pull_request(&updated) {
            return Ok(Some(updated));
        }
        if let Some(s) = self.on_board_async(&updated).await {
            self.session_engine().dismiss_async(&s.id, Leave::KeepBranch).await?;
        } else if let Some(main) = self.worktree().main_repo_async(updated.repo.as_deref()).await? {
            self.worktree().clear_checkout(&main, updated.number)?;
        }
        let change = match state {
            vibevalley_protocol::PullRequestState::Merged => IssueChange::Delivered(vibevalley_protocol::Landing::PullRequest, None),
            vibevalley_protocol::PullRequestState::Closed => IssueChange::Canceled(vibevalley_protocol::IssueCanceled::Dismissed),
            vibevalley_protocol::PullRequestState::Open => unreachable!(),
        };
        let done = {
            let _work = self.work.lock().await;
            let done = self.change_async(&updated.id, change).await?;
            let _ = self.take_words_async(&updated.id).await;
            done
        };
        drop(issue_guard);
        self.refresh_queue_unlocked_async().await;
        Ok(Some(done))
    }

    /// Finds an open issue whose worktree or `vibevalley/issue-<n>` branch
    /// matches a published branch in `cwd`.
    pub async fn open_issue_for_branch_async(&self, cwd: &str, branch: &str) -> Option<Issue> {
        let cwd_canon = tokio::fs::canonicalize(cwd).await.ok();
        let cwd_owned = cwd.to_string();
        let raw_repo_root = crate::log::spawn_blocking_traced(move || {
            vibevalley_git::Repo::discover(Path::new(&cwd_owned))
                .ok()
                .flatten()
                .map(|r| r.root().to_path_buf())
        })
        .await
        .ok()
        .flatten();
        let repo_root = match raw_repo_root {
            Some(r) => tokio::fs::canonicalize(r).await.ok(),
            None => None,
        };
        let issues = self.issues_async().await.ok()?;
        let sessions = self.sessions_async().await.ok()?;
        for issue in issues {
            if issue.status.is_closed() {
                continue;
            }
            let session = issue.latest_session_id().and_then(|id| sessions.iter().find(|s| s.id == *id));
            if let Some(wt) = session.and_then(|s| s.cwd.as_deref()) {
                let wt_canon = tokio::fs::canonicalize(wt).await.ok();
                if (wt == cwd || (wt_canon.is_some() && wt_canon == cwd_canon))
                    && (session.and_then(|s| s.worktree_branch()) == Some(branch) || issue_branch(issue.number) == branch)
                {
                    return Some(issue);
                }
            }
            if issue_branch(issue.number) != branch {
                continue;
            }
            if let (Some(repo), Some(root)) = (&issue.repo, &repo_root)
                && let Ok(Some(m)) = self.worktree().main_repo_async(Some(repo.as_str())).await
                && tokio::fs::canonicalize(m.root()).await.ok().as_ref() == Some(root)
            {
                return Some(issue);
            }
        }
        None
    }

    /// The issue's work as it stands.
    pub async fn changes_async(&self, reference: &str) -> Result<Changes> {
        self.changes_since_async(reference, None).await
    }

    pub async fn changes_since_async(&self, reference: &str, since_tree: Option<&str>) -> Result<Changes> {
        let issue = self.stored_async(reference).await?;
        let wp = self.worktree();
        let main = wp
            .main_repo_async(issue.repo.as_deref())
            .await?
            .ok_or_else(|| BoardError::Other("the issue has no repository".into()))?;
        if issue.status.is_closed()
            && let Some(evidence) = &issue.delivery_evidence
            && let Some(receipt) = &evidence.check
            && evidence.merged_commit.as_deref() == Some(receipt.candidate_commit.as_str())
        {
            let revision = evidence
                .reviews
                .last()
                .map(|r| r.revision.clone())
                .unwrap_or_else(|| vibevalley_protocol::ReviewRevision {
                    base_commit: receipt.target_commit.clone(),
                    tree: receipt.candidate_tree.clone(),
                });
            return Worktree::published_changes(&main, issue.number, revision, receipt, since_tree);
        }
        let base = self.session_base_async(&issue, &main).await?;
        let worktree = self.on_board_async(&issue).await.and_then(|s| s.cwd);
        let at = OnDisk {
            number: issue.number,
            title: &issue.title,
            worktree: worktree.as_deref(),
        };
        wp.changes_async(
            &main,
            &at,
            base,
            issue.parent.is_some(),
            since_tree.or_else(|| {
                issue
                    .delivery_evidence
                    .as_ref()
                    .and_then(|e| e.reviews.last())
                    .map(|r| r.revision.tree.as_str())
            }),
        )
        .await
    }

    /// The branch the issue's work forked from: its session's, else its
    /// parent's or the main branch.
    async fn session_base_async(&self, issue: &Issue, main: &vibevalley_git::Repo) -> Result<String> {
        match self.on_board_async(issue).await.and_then(|s| self.session_engine().base_branch(&s.id)) {
            Some(base) => Ok(base),
            None => {
                let parent = match issue.parent.as_deref() {
                    Some(p) => self.issue_async(p).await?.map(|p| p.number),
                    None => None,
                };
                self.worktree().base(main, parent)
            }
        }
    }

    async fn recover_published_deliveries_async(&self) -> Result<()> {
        let issues: Vec<(Issue, vibevalley_protocol::ProjectCheckReceipt)> = self
            .issues_async()
            .await?
            .into_iter()
            .filter_map(|i| pending_delivery(&i).cloned().map(|r| (i, r)))
            .collect();
        for (issue, receipt) in issues {
            match self.recover_delivery_async(&issue, &receipt).await {
                Err(BoardError::Git(_) | BoardError::NotARepo(_) | BoardError::Other(_)) => {
                    self.hold_delivery_async(&issue.id, &receipt.candidate_commit).await?
                }
                result => result?,
            }
        }
        Ok(())
    }

    async fn hold_delivery_async(&self, issue: &str, commit: &str) -> Result<()> {
        let why = vibevalley_i18n::t("server.issue.verifyDelivery", &[("commit", commit.into())]);
        self.change_async(issue, IssueChange::Stuck { why, conflict: None }).await.map(|_| ())
    }

    async fn recover_delivery_async(&self, issue: &Issue, last: &vibevalley_protocol::ProjectCheckReceipt) -> Result<()> {
        let Some(repo) = issue.repo.as_deref() else { return Ok(()) };
        let Some(main) = self.worktree().existing(repo)? else {
            return self.hold_delivery_async(&issue.id, &last.candidate_commit).await;
        };
        let session = self.on_board_async(issue).await;
        let worktree = session.as_ref().and_then(|s| s.cwd.as_deref());
        let tree = self
            .worktree()
            .checkout_async(&main, issue.number, worktree, false)
            .await?
            .as_ref()
            .map(vibevalley_git::Repo::worktree_tree)
            .transpose()?;
        if self.worktree().was_published(&main, &issue_branch(issue.number), tree.as_deref(), last)? {
            self.finish_delivery_async(issue, Some(&main), vibevalley_protocol::Landing::Merged, Some(last.candidate_commit.clone()))
                .await?;
        } else if tree.is_none() {
            self.hold_delivery_async(&issue.id, &last.candidate_commit).await?;
        }
        Ok(())
    }

    /// Accepted: deliver as the issue says (caller holds `issue_lock` for `issue.id` and refreshes queue afterwards).
    fn complete_for_issue_async<'a>(&'a self, issue: &'a Issue) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(r) = &issue.refining {
                self.session_engine().dismiss_async(&r.session, Leave::Discard).await?;
            }
            let session = self.on_board_async(issue).await;
            if let Some(s) = &session
                && s.phase.is_working()
            {
                let _ = self.session_engine().abort_turn_async(&s.id).await;
            }
            let all_issues = self.issues_async().await?;
            let has_merged_child = all_issues
                .iter()
                .any(|t| t.parent.as_ref() == Some(&issue.id) && t.delivered == Some(Landing::MergedIntoParent));
            // Manual completion from backlog/todo (never sent to a worker and no merged child branch):
            // close cleanly with Landing::None without requiring a git branch or PR.
            if !issue.was_sent() && !has_merged_child {
                return self.finish_delivery_async(issue, None, Landing::None, None).await;
            }
            let wp = self.worktree();
            if issue.deliver == Deliverable::PullRequest && issue.pull_request.is_none() {
                return Err(BoardError::Other(vibevalley_i18n::t("server.issue.deliveryNeedsPr", &[])));
            }
            let main = wp.main_repo_async(issue.repo.as_deref()).await?;
            let pr_merged = issue.deliver == Deliverable::Change
                && issue
                    .pull_request
                    .as_ref()
                    .is_some_and(|pr| pr.state == vibevalley_protocol::PullRequestState::Merged);
            let mut merged = None;
            let landing = match &main {
                _ if issue.deliver == Deliverable::Answer => Landing::None,
                _ if issue.deliver == Deliverable::PullRequest => Landing::Submitted,
                _ if pr_merged => Landing::PullRequest,
                None => Landing::None,
                Some(main) => {
                    let has_children = all_issues.iter().any(|t| t.parent.as_ref() == Some(&issue.id));
                    let worktree = session.as_ref().and_then(|s| s.cwd.clone());
                    let at = OnDisk {
                        number: issue.number,
                        title: &issue.title,
                        worktree: worktree.as_deref(),
                    };
                    let delivery = Delivery {
                        work: at,
                        kind: issue.deliver,
                        has_children,
                        evidence: issue.delivery_evidence.as_ref(),
                    };
                    let base = self.session_base_async(issue, main).await?;
                    match wp
                        .land_async(
                            main,
                            delivery,
                            move || Ok(base),
                            |receipt| Box::pin(async move { self.change_async(&issue.id, IssueChange::ProjectChecked(receipt)).await.map(|_| ()) }),
                        )
                        .await?
                    {
                        Landed::Merged(commit) => {
                            merged = Some(commit);
                            vibevalley_protocol::Landing::Merged
                        }
                        Landed::Landed(landing) => landing,
                        Landed::Conflict(conflict) => {
                            let (base, files) = (conflict.base.clone(), conflict.files.clone());
                            self.change_async(&issue.id, IssueChange::Conflicted(conflict)).await?;
                            return Err(BoardError::NotDelivered(Undelivered::Conflict { base, files }));
                        }
                        Landed::CheckFailed(output) => {
                            let sent_back = if session.is_some() {
                                let _work = self.work.lock().await;
                                if self.room_for_round_async(issue).await.is_ok() {
                                    self.change_async(&issue.id, IssueChange::Queued).await?;
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            };
                            if sent_back {
                                let words = format!("The project check failed. Fix it and commit:\n\n{output}");
                                self.send_for_issue_async(&issue.id, Some(words), RunTriggerKind::Comment).await?;
                            }
                            return Err(BoardError::NotDelivered(Undelivered::CheckFailed { output, sent_back }));
                        }
                    }
                }
            };
            self.finish_delivery_async(issue, main.as_ref(), landing, merged).await
        })
    }

    async fn finish_delivery_async(
        &self,
        issue: &Issue,
        main: Option<&vibevalley_git::Repo>,
        landing: vibevalley_protocol::Landing,
        merged: Option<String>,
    ) -> Result<()> {
        if let Some(s) = self.on_board_async(issue).await {
            let leave = if matches!(issue.deliver, Deliverable::Branch | Deliverable::PullRequest)
                || landing == vibevalley_protocol::Landing::PullRequest
                || vibevalley_core::pr::goes_by_pull_request(issue, false)
            {
                Leave::KeepBranch
            } else if issue.deliver == Deliverable::Change {
                Leave::Integrated
            } else {
                Leave::Discard
            };
            self.session_engine().dismiss_async(&s.id, leave).await?;
        } else if let Some(main) = main {
            self.worktree().clear_checkout(main, issue.number)?;
        }
        let _work = self.work.lock().await;
        self.change_async(&issue.id, IssueChange::Delivered(landing, merged)).await?;
        let _ = self.take_words_async(&issue.id).await;
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
                self.session_engine().dismiss_async(&r.session, Leave::Discard).await?;
            }
            if let Some(s) = self.on_board_async(issue).await {
                self.session_engine().dismiss_async(&s.id, Leave::KeepBranch).await?;
            }
            let _work = self.work.lock().await;
            let _ = self.take_words_async(&issue.id).await;
            self.change_async(&issue.id, IssueChange::Canceled(why)).await?;
            Ok(())
        })
    }

    /// Not done any more: its session goes home (leftovers committed on its
    /// branch, which stays when it has commits), its open children with it.
    pub(super) fn close_issue_async<'a>(&'a self, issue: &'a Issue, why: IssueCanceled) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let _issue_guard = self.issue_lock(&issue.id).await;
            self.close_issue_for_locked_parent_async(issue, why).await
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
pub(super) fn brief(issue: &Issue, all: &[Issue], words: Option<&str>, storage: Option<&Storage>) -> String {
    let frozen: Vec<String> = vibevalley_core::acceptance_ancestors(issue, all)
        .iter()
        .flat_map(|t| t.constraints.as_ref().map(|c| c.frozen.clone()).unwrap_or_default())
        .collect();
    let brief = vibevalley_core::prompts::issue_brief(&issue.title, &issue.description, &issue.criteria, issue.deliver);
    let attachments = attachments_brief(issue, storage);
    let constraints = vibevalley_core::work_constraints(issue.constraints.as_ref(), &frozen);
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
