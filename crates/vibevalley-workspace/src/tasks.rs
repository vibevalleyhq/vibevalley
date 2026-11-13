//! Agent tasks: one task = one agent session, optionally isolated in its own
//! git worktree and branch, followed from creation through review to merge.
//!
//! `TaskManager` is `Send + Sync` and owns its threads: `create`/`resume`
//! return at once and do the slow part (worktree, opening the runtime) on a
//! task thread that then pumps the session's events. Methods documented as
//! blocking must be called off the UI thread. Every state change is announced
//! on the `TaskEvent` channel.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use vibevalley_git::{DiffTarget, FileDiff, GitError, MergeCheck};
use vibevalley_oar::{
    AgentError, Capabilities, ContentBlock, Event, EventKind, Installation, PermissionDecision, PermissionMode, Registry, Session, SessionOptions, StopReason,
    Usage,
};
use vibevalley_store::{AgentSessionRow, ProjectId};

use crate::git::{GitProvider, RepoOps};
use crate::persist::Persistence;
use crate::transcript::{Entry, Transcript};
use crate::util::{app_support_dir, new_id, now_ms, slug};

#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    #[error("unknown task")]
    UnknownTask,
    #[error("the agent session is not running")]
    NoSession,
    #[error("the task does not run in its own worktree")]
    NotIsolated,
    #[error("the project is not a git repository")]
    NotARepo,
    #[error("merge would conflict in {} file(s)", .0.len())]
    Conflicts(Vec<PathBuf>),
    #[error("nothing to merge")]
    NothingToMerge,
    #[error(transparent)]
    Agent(#[from] AgentError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Store(#[from] vibevalley_store::StoreError),
}

pub type Result<T> = std::result::Result<T, TaskError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    /// Creating the worktree and opening the runtime.
    Preparing,
    Running,
    WaitingPermission,
    WaitingReply,
    /// Session open, no turn running, nothing to review.
    Idle,
    /// A turn completed; the diff is ready to review (and merge, if isolated).
    Review,
    Merged,
    Ended,
    Failed,
}

impl TaskPhase {
    pub fn is_live(self) -> bool {
        matches!(
            self,
            TaskPhase::Preparing | TaskPhase::Running | TaskPhase::WaitingPermission | TaskPhase::WaitingReply
        )
    }

    pub fn needs_user(self) -> bool {
        matches!(self, TaskPhase::WaitingPermission | TaskPhase::WaitingReply | TaskPhase::Review)
    }
}

/// Phase after `event`, given the phase before it. `reviewable` says whether
/// a diff base exists for the task.
pub fn next_phase(current: TaskPhase, event: &EventKind, pending_permissions: usize, reviewable: bool) -> TaskPhase {
    if current == TaskPhase::Merged {
        return current;
    }
    match event {
        EventKind::TurnStarted { .. } => TaskPhase::Running,
        EventKind::PermissionRequested { .. } => TaskPhase::WaitingPermission,
        EventKind::PermissionResolved { .. } if pending_permissions == 0 => TaskPhase::Running,
        EventKind::Question { .. } => TaskPhase::WaitingReply,
        EventKind::TurnFinished { reason, .. } => match reason {
            StopReason::Completed | StopReason::MaxTurns if reviewable => TaskPhase::Review,
            StopReason::Error => TaskPhase::Failed,
            // A question ends the turn; keep asking until the user replies.
            _ if current == TaskPhase::WaitingReply => current,
            _ => TaskPhase::Idle,
        },
        EventKind::SessionEnded if matches!(current, TaskPhase::Review | TaskPhase::Failed) => current,
        EventKind::SessionEnded => TaskPhase::Ended,
        _ => current,
    }
}

#[derive(Debug, Clone)]
pub struct TaskSpec {
    pub project_id: ProjectId,
    pub project_root: PathBuf,
    pub title: String,
    /// First prompt. Empty = open the session and wait.
    pub prompt: String,
    pub runtime_id: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// Run in a fresh worktree on a new branch instead of the project folder.
    pub isolate: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskInfo {
    pub id: String,
    pub project_id: ProjectId,
    pub project_root: PathBuf,
    pub title: String,
    pub runtime_id: String,
    pub session_id: Option<String>,
    pub phase: TaskPhase,
    pub error: Option<String>,
    /// Where the agent works: the worktree, or the project folder.
    pub cwd: PathBuf,
    pub worktree: Option<PathBuf>,
    pub branch: Option<String>,
    /// Revision the review diff is taken against.
    pub base: Option<String>,
    pub record_path: Option<PathBuf>,
    pub usage: Usage,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingPermission {
    pub task_id: String,
    pub project_id: ProjectId,
    pub task_title: String,
    pub request_id: String,
    pub tool: String,
    pub summary: String,
    pub input: serde_json::Value,
    pub at_ms: u64,
}

#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant, reason = "events are few; boxing would change the public API")]
pub enum TaskEvent {
    /// Created or changed.
    Task(TaskInfo),
    /// The transcript now has `len` entries (the last may have grown).
    Transcript {
        task_id: String,
        len: usize,
    },
    /// The cross-project permission queue changed.
    Permissions,
    Removed {
        task_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeInfo {
    pub id: String,
    pub display_name: String,
    pub capabilities: Capabilities,
    /// `None` until probed.
    pub installation: Option<Installation>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskCounts {
    pub running: usize,
    pub waiting: usize,
    pub review: usize,
    pub failed: usize,
}

#[derive(Debug, Clone)]
pub struct ReviewDiff {
    pub repo_root: PathBuf,
    pub from: String,
    pub to: String,
    pub files: Vec<FileDiff>,
}

#[derive(Debug, Clone)]
pub struct TaskDirs {
    pub worktrees: PathBuf,
    pub records: PathBuf,
}

impl Default for TaskDirs {
    fn default() -> Self {
        let base = app_support_dir();
        TaskDirs {
            worktrees: base.join("worktrees"),
            records: base.join("records"),
        }
    }
}

/// What the store's free-form `status` column holds for a task.
#[derive(Debug, Serialize, Deserialize)]
struct StoredStatus {
    phase: TaskPhase,
    root: PathBuf,
    cwd: PathBuf,
    base: Option<String>,
    error: Option<String>,
}

struct TaskEntry {
    info: TaskInfo,
    session: Option<Arc<dyn Session>>,
    capabilities: Capabilities,
    transcript: Transcript,
    pending: Vec<PendingPermission>,
}

struct Shared {
    registry: Registry,
    store: Arc<dyn Persistence>,
    git: Arc<dyn GitProvider>,
    dirs: TaskDirs,
    events: flume::Sender<TaskEvent>,
    tasks: Mutex<Vec<TaskEntry>>,
}

#[derive(Clone)]
pub struct TaskManager {
    shared: Arc<Shared>,
}

impl TaskManager {
    pub fn new(registry: Registry, store: Arc<dyn Persistence>, git: Arc<dyn GitProvider>, dirs: TaskDirs) -> (TaskManager, flume::Receiver<TaskEvent>) {
        let (events, rx) = flume::unbounded();
        let shared = Shared {
            registry,
            store,
            git,
            dirs,
            events,
            tasks: Mutex::new(Vec::new()),
        };
        (TaskManager { shared: Arc::new(shared) }, rx)
    }

    pub fn runtimes(&self) -> Vec<RuntimeInfo> {
        self.shared
            .registry
            .list()
            .iter()
            .map(|r| RuntimeInfo {
                id: r.id().to_string(),
                display_name: r.display_name().to_string(),
                capabilities: r.capabilities(),
                installation: None,
            })
            .collect()
    }

    /// Blocking: probes the machine for each runtime.
    pub fn probe_runtimes(&self) -> Vec<RuntimeInfo> {
        self.shared
            .registry
            .list()
            .iter()
            .map(|r| RuntimeInfo {
                id: r.id().to_string(),
                display_name: r.display_name().to_string(),
                capabilities: r.capabilities(),
                installation: Some(r.installation()),
            })
            .collect()
    }

    /// Newest first.
    pub fn tasks(&self, project: Option<ProjectId>) -> Vec<TaskInfo> {
        let mut out: Vec<TaskInfo> = self
            .shared
            .lock()
            .iter()
            .filter(|t| project.is_none_or(|p| t.info.project_id == p))
            .map(|t| t.info.clone())
            .collect();
        out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then_with(|| b.id.cmp(&a.id)));
        out
    }

    pub fn task(&self, id: &str) -> Option<TaskInfo> {
        self.shared.lock().iter().find(|t| t.info.id == id).map(|t| t.info.clone())
    }

    pub fn counts(&self, project: Option<ProjectId>) -> TaskCounts {
        let mut counts = TaskCounts::default();
        for t in self.shared.lock().iter().filter(|t| project.is_none_or(|p| t.info.project_id == p)) {
            match t.info.phase {
                TaskPhase::Preparing | TaskPhase::Running => counts.running += 1,
                TaskPhase::WaitingPermission | TaskPhase::WaitingReply => counts.waiting += 1,
                TaskPhase::Review => counts.review += 1,
                TaskPhase::Failed => counts.failed += 1,
                TaskPhase::Idle | TaskPhase::Merged | TaskPhase::Ended => {}
            }
        }
        counts
    }

    /// Transcript entries from index `from`, plus the total length.
    pub fn transcript(&self, id: &str, from: usize) -> (Vec<Entry>, usize) {
        match self.shared.lock().iter().find(|t| t.info.id == id) {
            Some(t) => (t.transcript.since(from).to_vec(), t.transcript.len()),
            None => (Vec::new(), 0),
        }
    }

    /// Unanswered permission requests of every project, oldest first.
    pub fn pending_permissions(&self) -> Vec<PendingPermission> {
        let mut out: Vec<PendingPermission> = self.shared.lock().iter().flat_map(|t| t.pending.iter().cloned()).collect();
        out.sort_by_key(|p| p.at_ms);
        out
    }

    /// Registers the task and starts preparing it in the background.
    pub fn create(&self, spec: TaskSpec) -> String {
        let id = new_id();
        let now = now_ms();
        let info = TaskInfo {
            id: id.clone(),
            project_id: spec.project_id,
            project_root: spec.project_root.clone(),
            title: if spec.title.trim().is_empty() {
                first_line(&spec.prompt)
            } else {
                spec.title.trim().to_string()
            },
            runtime_id: spec.runtime_id.clone(),
            session_id: None,
            phase: TaskPhase::Preparing,
            error: None,
            cwd: spec.project_root.clone(),
            worktree: None,
            branch: None,
            base: None,
            record_path: Some(self.shared.dirs.records.join(format!("{id}.jsonl"))),
            usage: Usage::default(),
            created_ms: now,
            updated_ms: now,
        };
        self.shared.lock().push(TaskEntry {
            info: info.clone(),
            session: None,
            capabilities: Capabilities::default(),
            transcript: Transcript::default(),
            pending: Vec::new(),
        });
        self.shared.persist(&info);
        self.shared.emit(TaskEvent::Task(info));

        let shared = self.shared.clone();
        let task_id = id.clone();
        spawn_named("vibevalley-task", move || {
            let prompt = spec.prompt.clone();
            match shared.prepare(&task_id, &spec, None) {
                Ok(session) => shared.run(&task_id, session, prompt),
                Err(e) => shared.fail(&task_id, e.to_string()),
            }
        });
        id
    }

    /// Reopens an ended task's session (by the runtime's session id) in the
    /// background.
    pub fn resume(&self, id: &str) -> Result<()> {
        let spec = {
            let mut tasks = self.shared.lock();
            let entry = tasks.iter_mut().find(|t| t.info.id == id).ok_or(TaskError::UnknownTask)?;
            if entry.session.is_some() {
                return Ok(());
            }
            let Some(session_id) = entry.info.session_id.clone() else {
                return Err(TaskError::NoSession);
            };
            entry.info.phase = TaskPhase::Preparing;
            entry.info.error = None;
            let spec = TaskSpec {
                project_id: entry.info.project_id,
                project_root: entry.info.project_root.clone(),
                title: entry.info.title.clone(),
                prompt: String::new(),
                runtime_id: entry.info.runtime_id.clone(),
                model: None,
                permission_mode: PermissionMode::default(),
                isolate: false,
            };
            self.shared.emit(TaskEvent::Task(entry.info.clone()));
            (spec, session_id)
        };
        let shared = self.shared.clone();
        let task_id = id.to_string();
        spawn_named("vibevalley-task", move || match shared.prepare(&task_id, &spec.0, Some(spec.1)) {
            Ok(session) => shared.run(&task_id, session, String::new()),
            Err(e) => shared.fail(&task_id, e.to_string()),
        });
        Ok(())
    }

    /// Sends a message. While a turn runs it is queued (or steered in) when
    /// the runtime supports that; otherwise the runtime's rejection is returned.
    pub fn prompt(&self, id: &str, text: &str) -> Result<()> {
        let (session, phase, caps) = self.session(id)?;
        let content = vec![ContentBlock::Text(text.to_string())];
        match phase {
            TaskPhase::Running | TaskPhase::WaitingPermission if caps.queue => session.queue(content)?,
            TaskPhase::Running | TaskPhase::WaitingPermission if caps.steer => session.steer(content)?,
            _ => session.prompt(content)?,
        }
        Ok(())
    }

    pub fn abort(&self, id: &str) -> Result<()> {
        Ok(self.session(id)?.0.abort()?)
    }

    pub fn respond_permission(&self, id: &str, request_id: &str, decision: PermissionDecision) -> Result<()> {
        let (session, ..) = self.session(id)?;
        session.respond_permission(request_id, decision)?;
        // Drop it from the queue now rather than when the runtime confirms,
        // so one key press answers exactly one request.
        if let Some(entry) = self.shared.lock().iter_mut().find(|t| t.info.id == id) {
            entry.pending.retain(|p| p.request_id != request_id);
        }
        self.shared.emit(TaskEvent::Permissions);
        Ok(())
    }

    /// Blocking. Everything the agent changed since the task started,
    /// committed or not.
    pub fn review_diff(&self, id: &str) -> Result<ReviewDiff> {
        let info = self.task(id).ok_or(TaskError::UnknownTask)?;
        let from = info.base.clone().ok_or(TaskError::NotARepo)?;
        let repo = self.shared.git.discover(&info.cwd)?.ok_or(TaskError::NotARepo)?;
        let to = repo.snapshot(&format!("task-{id}-review"))?;
        let files = repo.diff(&DiffTarget::Range {
            from: from.clone(),
            to: to.clone(),
        })?;
        Ok(ReviewDiff {
            repo_root: repo.root(),
            from,
            to,
            files,
        })
    }

    /// Blocking. Commits whatever the agent left uncommitted in the worktree,
    /// then trial-merges the task branch into the project's HEAD.
    pub fn merge_check(&self, id: &str) -> Result<MergeCheck> {
        let (info, main) = self.isolated(id)?;
        self.shared.commit_pending(&info)?;
        Ok(main.merge_check(info.branch.as_deref().expect("isolated task has a branch"))?)
    }

    /// Blocking. Merges the task branch into the project's HEAD, only when
    /// `merge_check` is clean. With `cleanup`, also ends the session and
    /// removes the worktree. Returns the merge commit id.
    pub fn merge(&self, id: &str, cleanup: bool) -> Result<String> {
        let (info, main) = self.isolated(id)?;
        let branch = info.branch.as_deref().expect("isolated task has a branch");
        self.shared.commit_pending(&info)?;
        match main.merge_check(branch)? {
            MergeCheck::Clean => {}
            MergeCheck::UpToDate => return Err(TaskError::NothingToMerge),
            MergeCheck::Conflicts(paths) => return Err(TaskError::Conflicts(paths)),
        }
        let commit = main.merge(branch, Some(&format!("Merge agent task: {}", info.title)))?;
        let session = self.shared.update(id, |entry| {
            entry.info.phase = TaskPhase::Merged;
            if cleanup { entry.session.take() } else { None }
        });
        if cleanup {
            if let Some(Some(session)) = session {
                session.dispose();
            }
            if let Some(path) = &info.worktree {
                main.worktree_remove(path, true)?;
            }
        }
        Ok(commit)
    }

    /// Blocking. Ends the session and forgets the task; with
    /// `remove_worktree` its worktree is deleted too (the branch is kept).
    pub fn discard(&self, id: &str, remove_worktree: bool) -> Result<()> {
        let entry = {
            let mut tasks = self.shared.lock();
            let index = tasks.iter().position(|t| t.info.id == id).ok_or(TaskError::UnknownTask)?;
            tasks.remove(index)
        };
        if let Some(session) = &entry.session {
            session.dispose();
        }
        let had_pending = !entry.pending.is_empty();
        self.shared.store.delete_agent_session(id)?;
        self.shared.emit(TaskEvent::Removed { task_id: id.to_string() });
        if had_pending {
            self.shared.emit(TaskEvent::Permissions);
        }
        if remove_worktree
            && let Some(path) = &entry.info.worktree
            && let Some(main) = self.shared.git.discover(&entry.info.project_root)?
        {
            main.worktree_remove(path, true)?;
        }
        Ok(())
    }

    /// Blocking. Loads the stored tasks of a project (from earlier runs) with
    /// their recorded transcripts. Tasks already known are left alone.
    pub fn load_history(&self, project: ProjectId, project_root: &Path) -> Result<usize> {
        let rows = self.shared.store.agent_sessions(Some(project))?;
        let mut added = Vec::new();
        for row in rows {
            if self.shared.lock().iter().any(|t| t.info.id == row.id) {
                continue;
            }
            let stored: Option<StoredStatus> = serde_json::from_str(&row.status).ok();
            let transcript = row
                .record_path
                .as_deref()
                .filter(|p| p.exists())
                .and_then(|p| vibevalley_oar::read_record(p).ok())
                .map(|events| Transcript::from_events(&events))
                .unwrap_or_default();
            let phase = match stored.as_ref().map(|s| s.phase) {
                // The process that ran it is gone.
                Some(p) if p.is_live() || p == TaskPhase::Idle => TaskPhase::Ended,
                Some(p) => p,
                None => TaskPhase::Ended,
            };
            let info = TaskInfo {
                id: row.id,
                project_id: row.project_id,
                project_root: stored.as_ref().map(|s| s.root.clone()).unwrap_or_else(|| project_root.to_path_buf()),
                title: row.title,
                runtime_id: row.runtime_id,
                session_id: row.session_id,
                phase,
                error: stored.as_ref().and_then(|s| s.error.clone()),
                cwd: stored
                    .as_ref()
                    .map(|s| s.cwd.clone())
                    .or(row.worktree_path.clone())
                    .unwrap_or_else(|| project_root.to_path_buf()),
                worktree: row.worktree_path,
                branch: row.branch,
                base: stored.and_then(|s| s.base),
                record_path: row.record_path,
                usage: Usage::default(),
                created_ms: row.created_ms,
                updated_ms: row.updated_ms,
            };
            added.push(info.clone());
            self.shared.lock().push(TaskEntry {
                info,
                session: None,
                capabilities: Capabilities::default(),
                transcript,
                pending: Vec::new(),
            });
        }
        let n = added.len();
        added.into_iter().for_each(|info| self.shared.emit(TaskEvent::Task(info)));
        Ok(n)
    }

    /// Stops every agent process (app quit). Sessions stay resumable.
    pub fn dispose_all(&self) {
        let sessions: Vec<Arc<dyn Session>> = self.shared.lock().iter_mut().filter_map(|t| t.session.take()).collect();
        sessions.iter().for_each(|s| s.dispose());
    }

    fn session(&self, id: &str) -> Result<(Arc<dyn Session>, TaskPhase, Capabilities)> {
        let tasks = self.shared.lock();
        let entry = tasks.iter().find(|t| t.info.id == id).ok_or(TaskError::UnknownTask)?;
        let session = entry.session.clone().ok_or(TaskError::NoSession)?;
        Ok((session, entry.info.phase, entry.capabilities.clone()))
    }

    fn isolated(&self, id: &str) -> Result<(TaskInfo, Box<dyn RepoOps>)> {
        let info = self.task(id).ok_or(TaskError::UnknownTask)?;
        if info.worktree.is_none() || info.branch.is_none() {
            return Err(TaskError::NotIsolated);
        }
        let main = self.shared.git.discover(&info.project_root)?.ok_or(TaskError::NotARepo)?;
        Ok((info, main))
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Vec<TaskEntry>> {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, event: TaskEvent) {
        let _ = self.events.send(event);
    }

    fn persist(&self, info: &TaskInfo) {
        let status = StoredStatus {
            phase: info.phase,
            root: info.project_root.clone(),
            cwd: info.cwd.clone(),
            base: info.base.clone(),
            error: info.error.clone(),
        };
        let row = AgentSessionRow {
            id: info.id.clone(),
            project_id: info.project_id,
            runtime_id: info.runtime_id.clone(),
            session_id: info.session_id.clone(),
            title: info.title.clone(),
            status: serde_json::to_string(&status).expect("status serializes"),
            worktree_path: info.worktree.clone(),
            branch: info.branch.clone(),
            record_path: info.record_path.clone(),
            created_ms: info.created_ms,
            updated_ms: info.updated_ms,
        };
        // Losing a row only costs history; the live task is unaffected.
        let _ = self.store.upsert_agent_session(&row);
    }

    /// Mutates a task, then persists and announces it. `None` when the task
    /// is gone (discarded meanwhile).
    fn update<R>(&self, id: &str, f: impl FnOnce(&mut TaskEntry) -> R) -> Option<R> {
        let (result, info) = {
            let mut tasks = self.lock();
            let entry = tasks.iter_mut().find(|t| t.info.id == id)?;
            let result = f(entry);
            entry.info.updated_ms = now_ms();
            (result, entry.info.clone())
        };
        self.persist(&info);
        self.emit(TaskEvent::Task(info));
        Some(result)
    }

    fn fail(&self, id: &str, message: String) {
        self.update(id, |entry| {
            entry.info.phase = TaskPhase::Failed;
            entry.info.error = Some(message);
        });
    }

    /// Blocking: worktree (when isolating), diff base, and the runtime session.
    fn prepare(&self, id: &str, spec: &TaskSpec, resume: Option<String>) -> Result<Arc<dyn Session>> {
        let runtime = self.registry.require(&spec.runtime_id)?;
        let existing = self
            .lock()
            .iter()
            .find(|t| t.info.id == id)
            .map(|t| t.info.clone())
            .ok_or(TaskError::UnknownTask)?;
        let mut cwd = existing.cwd.clone();
        let (mut worktree, mut branch, mut base) = (existing.worktree.clone(), existing.branch.clone(), existing.base.clone());

        if resume.is_none() {
            let repo = self.git.discover(&spec.project_root)?;
            if spec.isolate {
                let repo = repo.ok_or(TaskError::NotARepo)?;
                let short = &id[id.len().saturating_sub(6)..];
                let name = format!("{}-{short}", slug(&existing.title, 32));
                let project_dir = spec.project_root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let path = self.dirs.worktrees.join(format!("{}-{}", slug(&project_dir, 32), spec.project_id)).join(&name);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| GitError::Io(e.to_string()))?;
                }
                let branch_name = format!("vibevalley/{name}");
                base = repo.head()?;
                let wt = repo.worktree_add(&path, &branch_name)?;
                // A project may be a subfolder of its repository.
                cwd = match spec.project_root.strip_prefix(repo.root()) {
                    Ok(sub) if !sub.as_os_str().is_empty() => wt.root().join(sub),
                    _ => wt.root(),
                };
                worktree = Some(path);
                branch = Some(branch_name);
            } else if let Some(repo) = repo {
                base = Some(repo.snapshot(&format!("task-{id}-start"))?);
            }
        }

        if let Some(dir) = existing.record_path.as_deref().and_then(Path::parent) {
            let _ = std::fs::create_dir_all(dir);
        }
        let capabilities = runtime.capabilities();
        self.update(id, |entry| {
            entry.info.cwd = cwd.clone();
            entry.info.worktree = worktree;
            entry.info.branch = branch;
            entry.info.base = base;
            entry.capabilities = capabilities;
        });
        let session = runtime.open(SessionOptions {
            cwd,
            model: spec.model.clone(),
            resume,
            permission_mode: spec.permission_mode,
            append_system_prompt: None,
            env: Vec::new(),
            record_to: existing.record_path,
            ..Default::default()
        })?;
        Ok(session)
    }

    /// Attaches the session, sends the first prompt and pumps events until
    /// the session ends. Runs on the task thread.
    fn run(&self, id: &str, session: Arc<dyn Session>, prompt: String) {
        // Subscribe before prompting so no event of the first turn is missed.
        let events = session.events();
        let attached = self.update(id, |entry| {
            entry.session = Some(session.clone());
            entry.info.session_id.get_or_insert(session.id());
            entry.info.phase = TaskPhase::Idle;
        });
        if attached.is_none() {
            session.dispose();
            return;
        }
        if !prompt.trim().is_empty()
            && let Err(e) = session.prompt(vec![ContentBlock::Text(prompt)])
        {
            self.fail(id, e.to_string());
        }
        for event in events.iter() {
            let ended = matches!(event.kind, EventKind::SessionEnded);
            if !self.apply(id, &event) || ended {
                return;
            }
        }
        // Channel closed without a SessionEnded event.
        self.update(id, |entry| {
            entry.session = None;
            if entry.info.phase.is_live() || entry.info.phase == TaskPhase::Idle {
                entry.info.phase = TaskPhase::Ended;
            }
        });
    }

    /// Folds one event into the task. Returns false when the task is gone.
    fn apply(&self, id: &str, event: &Event) -> bool {
        let mut permissions_changed = false;
        let (info_changed, info, len) = {
            let mut tasks = self.lock();
            let Some(entry) = tasks.iter_mut().find(|t| t.info.id == id) else {
                return false;
            };
            let before = entry.info.clone();
            match &event.kind {
                EventKind::SessionStarted { session_id, .. } => entry.info.session_id = Some(session_id.clone()),
                EventKind::PermissionRequested {
                    request_id,
                    tool,
                    input,
                    summary,
                } => {
                    entry.pending.push(PendingPermission {
                        task_id: id.to_string(),
                        project_id: entry.info.project_id,
                        task_title: entry.info.title.clone(),
                        request_id: request_id.clone(),
                        tool: tool.clone(),
                        summary: summary.clone(),
                        input: input.clone(),
                        at_ms: event.at_ms,
                    });
                    permissions_changed = true;
                }
                EventKind::PermissionResolved { request_id, .. } => {
                    let n = entry.pending.len();
                    entry.pending.retain(|p| &p.request_id != request_id);
                    permissions_changed = entry.pending.len() != n;
                }
                EventKind::TurnFinished { usage, .. } => {
                    permissions_changed = !entry.pending.is_empty();
                    entry.pending.clear();
                    add_usage(&mut entry.info.usage, usage);
                }
                EventKind::Error { message } => entry.info.error = Some(message.clone()),
                EventKind::TurnStarted { .. } => entry.info.error = None,
                EventKind::SessionEnded => {
                    permissions_changed = !entry.pending.is_empty();
                    entry.pending.clear();
                    entry.session = None;
                }
                _ => {}
            }
            entry.info.phase = next_phase(entry.info.phase, &event.kind, entry.pending.len(), entry.info.base.is_some());
            entry.transcript.apply(event);
            let changed = entry.info != before;
            if changed {
                entry.info.updated_ms = now_ms();
            }
            (changed, entry.info.clone(), entry.transcript.len())
        };
        if info_changed {
            self.persist(&info);
            self.emit(TaskEvent::Task(info));
        }
        self.emit(TaskEvent::Transcript { task_id: id.to_string(), len });
        if permissions_changed {
            self.emit(TaskEvent::Permissions);
        }
        true
    }

    fn commit_pending(&self, info: &TaskInfo) -> Result<()> {
        let path = info.worktree.as_deref().ok_or(TaskError::NotIsolated)?;
        let wt = self.git.discover(path)?.ok_or(TaskError::NotARepo)?;
        let dirty = wt.dirty_paths()?;
        if !dirty.is_empty() {
            wt.stage(&dirty)?;
            wt.commit(&format!("{}\n\nAgent task {} ({})", info.title, info.id, info.runtime_id))?;
        }
        Ok(())
    }
}

fn add_usage(total: &mut Usage, turn: &Usage) {
    fn add<T: std::ops::Add<Output = T> + Copy>(a: &mut Option<T>, b: Option<T>) {
        if let Some(b) = b {
            *a = Some(a.map_or(b, |a| a + b));
        }
    }
    add(&mut total.input_tokens, turn.input_tokens);
    add(&mut total.output_tokens, turn.output_tokens);
    add(&mut total.cost_usd, turn.cost_usd);
}

fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("Untitled task").trim();
    let mut out: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        out.push('…');
    }
    out
}

fn spawn_named(name: &str, f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new().name(name.to_string()).spawn(f).expect("spawn task thread");
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::testing::{FakeGit, FakeRuntime, MemStore};
    use crate::transcript::Item;

    struct Rig {
        mgr: TaskManager,
        rx: flume::Receiver<TaskEvent>,
        runtime: Arc<FakeRuntime>,
        git: FakeGit,
        store: Arc<MemStore>,
        dir: PathBuf,
    }

    fn rig_with(runtime: FakeRuntime) -> Rig {
        let dir = std::env::temp_dir().join(format!("vibevalley-task-test-{}", new_id()));
        let runtime = Arc::new(runtime);
        let mut registry = Registry::new();
        registry.register(runtime.clone());
        let git = FakeGit::default();
        let store = Arc::new(MemStore::default());
        let dirs = TaskDirs {
            worktrees: dir.join("worktrees"),
            records: dir.join("records"),
        };
        let (mgr, rx) = TaskManager::new(registry, store.clone(), Arc::new(git.clone()), dirs);
        Rig {
            mgr,
            rx,
            runtime,
            git,
            store,
            dir,
        }
    }

    fn rig() -> Rig {
        rig_with(FakeRuntime::default())
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Rig {
        fn spec(&self, isolate: bool) -> TaskSpec {
            TaskSpec {
                project_id: 7,
                project_root: "/code/alpha".into(),
                title: String::new(),
                prompt: "Fix the login bug\nplease".into(),
                runtime_id: "fake".into(),
                model: Some("big".into()),
                permission_mode: PermissionMode::AcceptEdits,
                isolate,
            }
        }

        /// Pumps manager events until `done` holds for the task.
        fn wait(&self, id: &str, done: impl Fn(&TaskInfo) -> bool) -> TaskInfo {
            loop {
                if let Some(info) = self.mgr.task(id)
                    && done(&info)
                {
                    return info;
                }
                self.rx.recv_timeout(Duration::from_secs(5)).expect("task reached the expected state");
            }
        }

        fn wait_transcript(&self, id: &str, len: usize) {
            while self.mgr.transcript(id, 0).1 < len {
                self.rx.recv_timeout(Duration::from_secs(5)).expect("transcript grew");
            }
        }

        fn start(&self, isolate: bool) -> String {
            let id = self.mgr.create(self.spec(isolate));
            self.wait(&id, |t| t.phase == TaskPhase::Idle);
            // The first prompt is sent right after the session is attached.
            while self.runtime.session(0).log.lock().unwrap().prompts.is_empty() {
                std::thread::sleep(Duration::from_millis(2));
            }
            id
        }

        fn finish_turn(&self, id: &str) {
            let s = self.runtime.session(0);
            s.emit(EventKind::TurnStarted {
                prompt: "Fix the login bug\nplease".into(),
            });
            s.emit(EventKind::TextDelta { text: "Done".into() });
            s.emit(EventKind::TurnFinished {
                reason: StopReason::Completed,
                usage: Usage {
                    input_tokens: Some(10),
                    output_tokens: Some(5),
                    cost_usd: Some(0.5),
                },
            });
            self.wait(id, |t| t.phase == TaskPhase::Review);
        }
    }

    #[test]
    fn phase_transitions() {
        use TaskPhase::*;
        let done = |reason| EventKind::TurnFinished {
            reason,
            usage: Usage::default(),
        };
        let turn = EventKind::TurnStarted { prompt: String::new() };
        let resolved = EventKind::PermissionResolved {
            request_id: "r".into(),
            decision: PermissionDecision::AllowOnce,
        };
        let asked = EventKind::PermissionRequested {
            request_id: "r".into(),
            tool: "t".into(),
            input: serde_json::Value::Null,
            summary: String::new(),
        };
        assert_eq!(next_phase(Idle, &turn, 0, true), Running);
        assert_eq!(next_phase(Running, &asked, 1, true), WaitingPermission);
        assert_eq!(
            next_phase(WaitingPermission, &resolved, 1, true),
            WaitingPermission,
            "another request is still open"
        );
        assert_eq!(next_phase(WaitingPermission, &resolved, 0, true), Running);
        assert_eq!(next_phase(Running, &done(StopReason::Completed), 0, true), Review);
        assert_eq!(
            next_phase(Running, &done(StopReason::Completed), 0, false),
            Idle,
            "nothing to review without a repo"
        );
        assert_eq!(next_phase(Running, &done(StopReason::Aborted), 0, true), Idle);
        assert_eq!(next_phase(Running, &done(StopReason::Error), 0, true), Failed);
        assert_eq!(next_phase(Running, &EventKind::Question { text: String::new() }, 0, true), WaitingReply);
        assert_eq!(next_phase(WaitingReply, &done(StopReason::Aborted), 0, true), WaitingReply);
        assert_eq!(next_phase(WaitingReply, &turn, 0, true), Running);
        assert_eq!(next_phase(Review, &EventKind::SessionEnded, 0, true), Review);
        assert_eq!(next_phase(Running, &EventKind::SessionEnded, 0, true), Ended);
        assert_eq!(next_phase(Merged, &turn, 0, true), Merged);
    }

    #[test]
    fn isolated_task_gets_a_worktree_branch_and_session_there() {
        let r = rig();
        let id = r.start(true);
        let info = r.mgr.task(&id).unwrap();
        assert_eq!(info.title, "Fix the login bug");
        let branch = info.branch.clone().unwrap();
        assert!(branch.starts_with("vibevalley/fix-the-login-bug-"), "{branch}");
        let worktree = info.worktree.clone().unwrap();
        assert!(worktree.starts_with(r.dir.join("worktrees/alpha-7")), "{worktree:?}");
        assert_eq!(info.cwd, worktree);
        assert_eq!(info.base.as_deref(), Some("headsha"));
        assert_eq!(info.session_id.as_deref(), Some("sess-1"));

        let opts = r.runtime.options(0);
        assert_eq!(opts.cwd, worktree);
        assert_eq!(opts.model.as_deref(), Some("big"));
        assert_eq!(opts.permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(opts.record_to, Some(r.dir.join(format!("records/{id}.jsonl"))));
        assert_eq!(r.runtime.session(0).log.lock().unwrap().prompts, vec!["Fix the login bug\nplease".to_string()]);
        assert_eq!(r.git.calls(), vec![format!("worktree_add {branch}")]);

        let row = r.store.sessions.lock().unwrap().iter().find(|s| s.id == id).cloned().unwrap();
        assert_eq!(row.branch.as_deref(), Some(branch.as_str()));
        assert_eq!(row.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn in_place_task_snapshots_the_tree_as_review_base() {
        let r = rig();
        let id = r.start(false);
        let info = r.mgr.task(&id).unwrap();
        assert_eq!(info.cwd, PathBuf::from("/code/alpha"));
        assert!(info.worktree.is_none() && info.branch.is_none());
        assert_eq!(info.base.as_deref(), Some("snap:start"));
        assert!(matches!(r.mgr.merge_check(&id), Err(TaskError::NotIsolated)));
    }

    #[test]
    fn without_a_repo_isolation_fails_and_in_place_has_no_review() {
        let r = rig();
        r.git.state.lock().unwrap().no_repo = true;
        let id = r.mgr.create(r.spec(true));
        let info = r.wait(&id, |t| t.phase == TaskPhase::Failed);
        assert!(info.error.unwrap().contains("not a git repository"));
        assert!(r.runtime.opened.lock().unwrap().is_empty(), "the runtime is never opened");

        let id = r.start(false);
        let s = r.runtime.session(0);
        s.emit(EventKind::TurnStarted { prompt: "x".into() });
        s.emit(EventKind::TurnFinished {
            reason: StopReason::Completed,
            usage: Usage::default(),
        });
        r.wait(&id, |t| t.phase == TaskPhase::Idle && t.updated_ms > 0 && r.mgr.transcript(&t.id, 0).1 == 2);
        assert!(matches!(r.mgr.review_diff(&id), Err(TaskError::NotARepo)));
    }

    #[test]
    fn failures_while_preparing_are_reported_on_the_task() {
        let r = rig();
        r.git.state.lock().unwrap().fail_worktree_add = true;
        let id = r.mgr.create(r.spec(true));
        assert!(r.wait(&id, |t| t.phase == TaskPhase::Failed).error.unwrap().contains("boom"));

        let r = rig_with(FakeRuntime {
            fail_open: true,
            ..Default::default()
        });
        let id = r.mgr.create(r.spec(false));
        assert!(r.wait(&id, |t| t.phase == TaskPhase::Failed).error.unwrap().contains("not logged in"));

        let r = rig_with(FakeRuntime {
            reject_prompt: true,
            ..Default::default()
        });
        let id = r.mgr.create(r.spec(false));
        assert!(r.wait(&id, |t| t.phase == TaskPhase::Failed).error.unwrap().contains("busy"));

        let r = rig();
        let id = r.mgr.create(TaskSpec {
            runtime_id: "nope".into(),
            ..r.spec(false)
        });
        assert!(r.wait(&id, |t| t.phase == TaskPhase::Failed).error.unwrap().contains("nope"));
    }

    #[test]
    fn events_drive_status_transcript_and_usage() {
        let r = rig();
        let id = r.start(true);
        let s = r.runtime.session(0);
        s.emit(EventKind::SessionStarted {
            session_id: "real-id".into(),
            model: None,
        });
        s.emit(EventKind::TurnStarted { prompt: "go".into() });
        r.wait(&id, |t| t.phase == TaskPhase::Running);
        assert_eq!(
            r.mgr.counts(Some(7)),
            TaskCounts {
                running: 1,
                ..Default::default()
            }
        );
        s.emit(EventKind::TextDelta { text: "Wor".into() });
        s.emit(EventKind::TextDelta { text: "king".into() });
        s.emit(EventKind::TurnFinished {
            reason: StopReason::Completed,
            usage: Usage {
                input_tokens: Some(10),
                output_tokens: Some(5),
                cost_usd: None,
            },
        });
        let info = r.wait(&id, |t| t.phase == TaskPhase::Review);
        assert_eq!(info.session_id.as_deref(), Some("real-id"), "the runtime's own id replaces the provisional one");
        assert_eq!(info.usage.input_tokens, Some(10));
        let (entries, len) = r.mgr.transcript(&id, 0);
        assert_eq!(len, 3);
        assert_eq!(entries[1].item, Item::Assistant("Working".into()));
        assert_eq!(r.mgr.transcript(&id, 2).0.len(), 1);
        assert_eq!(r.mgr.counts(None).review, 1);
        assert_eq!(r.mgr.counts(Some(8)), TaskCounts::default());

        s.emit(EventKind::TurnStarted { prompt: "more".into() });
        s.emit(EventKind::TurnFinished {
            reason: StopReason::Error,
            usage: Usage {
                input_tokens: Some(1),
                output_tokens: None,
                cost_usd: Some(0.25),
            },
        });
        let info = r.wait(&id, |t| t.phase == TaskPhase::Failed);
        assert_eq!(
            (info.usage.input_tokens, info.usage.output_tokens, info.usage.cost_usd),
            (Some(11), Some(5), Some(0.25))
        );
    }

    #[test]
    fn permission_queue_spans_tasks_and_one_answer_removes_one_request() {
        let r = rig();
        let a = r.start(false);
        let b = r.mgr.create(TaskSpec {
            project_id: 8,
            ..r.spec(false)
        });
        r.wait(&b, |t| t.phase == TaskPhase::Idle);
        let (sa, sb) = (r.runtime.session(0), r.runtime.session(1));
        let ask = |id: &str| EventKind::PermissionRequested {
            request_id: id.into(),
            tool: "Bash".into(),
            input: serde_json::json!({"command": "rm -rf target"}),
            summary: "rm -rf target".into(),
        };
        sa.emit(EventKind::TurnStarted { prompt: "x".into() });
        sa.emit(ask("r1"));
        r.wait(&a, |t| t.phase == TaskPhase::WaitingPermission);
        sb.emit(ask("r2"));
        r.wait(&b, |t| t.phase == TaskPhase::WaitingPermission);
        sa.emit(ask("r3"));
        r.wait_transcript(&a, 3);

        let queue = r.mgr.pending_permissions();
        assert_eq!(queue.iter().map(|p| p.request_id.as_str()).collect::<Vec<_>>().len(), 3);
        assert_eq!(queue.iter().filter(|p| p.project_id == 8).count(), 1);
        assert_eq!(r.mgr.counts(None).waiting, 2);

        r.mgr.respond_permission(&a, "r1", PermissionDecision::AllowOnce).unwrap();
        assert_eq!(r.mgr.pending_permissions().len(), 2, "removed before the runtime confirms");
        assert_eq!(sa.log.lock().unwrap().decisions, vec![("r1".to_string(), PermissionDecision::AllowOnce)]);
        sa.emit(EventKind::PermissionResolved {
            request_id: "r1".into(),
            decision: PermissionDecision::AllowOnce,
        });
        r.wait_transcript(&a, 4);
        assert_eq!(r.mgr.task(&a).unwrap().phase, TaskPhase::WaitingPermission, "r3 is still open");

        r.mgr.respond_permission(&a, "r3", PermissionDecision::Deny { message: None }).unwrap();
        sa.emit(EventKind::PermissionResolved {
            request_id: "r3".into(),
            decision: PermissionDecision::Deny { message: None },
        });
        r.wait(&a, |t| t.phase == TaskPhase::Running);
        assert_eq!(r.mgr.pending_permissions().len(), 1);

        // A request the agent abandons disappears when the turn ends.
        sb.emit(EventKind::TurnFinished {
            reason: StopReason::Aborted,
            usage: Usage::default(),
        });
        r.wait(&b, |t| t.phase == TaskPhase::Idle);
        assert!(r.mgr.pending_permissions().is_empty());
    }

    #[test]
    fn prompts_follow_runtime_capabilities_while_a_turn_runs() {
        for (caps, field) in [
            (
                Capabilities {
                    queue: true,
                    steer: true,
                    ..Default::default()
                },
                "queued",
            ),
            (
                Capabilities {
                    steer: true,
                    ..Default::default()
                },
                "steered",
            ),
            (Capabilities::default(), "prompts"),
        ] {
            let r = rig_with(FakeRuntime {
                capabilities: caps,
                ..Default::default()
            });
            let id = r.start(false);
            let s = r.runtime.session(0);
            s.emit(EventKind::TurnStarted { prompt: "x".into() });
            r.wait(&id, |t| t.phase == TaskPhase::Running);
            r.mgr.prompt(&id, "also this").unwrap();
            let log = s.log.lock().unwrap();
            let got = match field {
                "queued" => &log.queued,
                "steered" => &log.steered,
                _ => &log.prompts,
            };
            assert_eq!(got.last().map(String::as_str), Some("also this"), "{field}");
        }
        let r = rig();
        assert!(matches!(r.mgr.prompt("missing", "x"), Err(TaskError::UnknownTask)));
    }

    #[test]
    fn review_diff_covers_base_to_a_fresh_snapshot_of_the_worktree() {
        let r = rig();
        let id = r.start(true);
        r.finish_turn(&id);
        let info = r.mgr.task(&id).unwrap();
        let review = r.mgr.review_diff(&id).unwrap();
        assert_eq!(review.from, "headsha");
        assert_eq!(review.to, "snap:review");
        assert_eq!(review.repo_root, info.worktree.clone().unwrap());
        assert_eq!(review.files.len(), 1);
        let calls = r.git.calls();
        assert!(calls.contains(&format!("snapshot {}", info.worktree.unwrap().display())), "{calls:?}");
    }

    #[test]
    fn merge_commits_leftovers_checks_then_merges_and_cleans_up() {
        let r = rig();
        let id = r.start(true);
        r.finish_turn(&id);
        r.git.state.lock().unwrap().dirty = vec!["src/login.rs".into()];
        let branch = r.mgr.task(&id).unwrap().branch.unwrap();

        assert_eq!(r.mgr.merge_check(&id).unwrap(), MergeCheck::Clean);
        assert_eq!(r.mgr.merge(&id, true).unwrap(), "mergesha");
        let calls = r.git.calls();
        let tail: Vec<&str> = calls.iter().skip(1).map(String::as_str).collect();
        assert_eq!(
            tail,
            vec![
                r#"stage ["src/login.rs"]"#,
                "commit Fix the login bug",
                &format!("merge_check {branch}"),
                &format!("merge_check {branch}"),
                &format!("merge {branch}"),
                "worktree_remove force=true",
            ]
        );
        assert_eq!(r.mgr.task(&id).unwrap().phase, TaskPhase::Merged);
        assert!(r.runtime.session(0).log.lock().unwrap().disposed);
        // Late events cannot move a merged task.
        r.runtime.session(0).emit(EventKind::SessionEnded);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(r.mgr.task(&id).unwrap().phase, TaskPhase::Merged);
    }

    #[test]
    fn merge_refuses_conflicts_and_no_ops() {
        let r = rig();
        let id = r.start(true);
        r.finish_turn(&id);
        r.git.state.lock().unwrap().merge_check = Some(MergeCheck::Conflicts(vec!["a.rs".into()]));
        assert!(matches!(r.mgr.merge(&id, true), Err(TaskError::Conflicts(p)) if p == vec![PathBuf::from("a.rs")]));
        r.git.state.lock().unwrap().merge_check = Some(MergeCheck::UpToDate);
        assert!(matches!(r.mgr.merge(&id, true), Err(TaskError::NothingToMerge)));
        assert!(!r.git.calls().iter().any(|c| c.starts_with("merge vibevalley/")));
        assert_eq!(r.mgr.task(&id).unwrap().phase, TaskPhase::Review);
    }

    #[test]
    fn a_dropped_event_stream_ends_the_task() {
        let r = rig();
        let id = r.start(false);
        r.runtime.session(0).emit(EventKind::TurnStarted { prompt: "x".into() });
        r.wait(&id, |t| t.phase == TaskPhase::Running);
        r.runtime.session(0).hang_up();
        r.wait(&id, |t| t.phase == TaskPhase::Ended);
        assert!(matches!(r.mgr.prompt(&id, "hello?"), Err(TaskError::NoSession)));
    }

    #[test]
    fn discard_disposes_removes_the_worktree_and_forgets_the_row() {
        let r = rig();
        let id = r.start(true);
        r.mgr.discard(&id, true).unwrap();
        assert!(r.mgr.task(&id).is_none());
        assert!(r.runtime.session(0).log.lock().unwrap().disposed);
        assert!(r.store.sessions.lock().unwrap().is_empty());
        assert_eq!(r.git.calls().last().map(String::as_str), Some("worktree_remove force=true"));
        assert!(matches!(r.mgr.discard(&id, true), Err(TaskError::UnknownTask)));
    }

    #[test]
    fn history_reloads_from_the_store_and_resumes_by_session_id() {
        let r = rig();
        let id = r.start(true);
        r.runtime.session(0).emit(EventKind::TurnStarted { prompt: "x".into() });
        let before = r.wait(&id, |t| t.phase == TaskPhase::Running);

        // A later run of the app: same store, fresh manager.
        let mut registry = Registry::new();
        registry.register(r.runtime.clone());
        let dirs = TaskDirs {
            worktrees: r.dir.join("worktrees"),
            records: r.dir.join("records"),
        };
        let (mgr2, rx2) = TaskManager::new(registry, r.store.clone(), Arc::new(r.git.clone()), dirs);
        assert_eq!(mgr2.load_history(7, Path::new("/code/alpha")).unwrap(), 1);
        assert_eq!(mgr2.load_history(7, Path::new("/code/alpha")).unwrap(), 0, "idempotent");
        let loaded = mgr2.task(&id).unwrap();
        assert_eq!(loaded.phase, TaskPhase::Ended, "a task that was live when the app quit is shown as ended");
        assert_eq!(
            (loaded.cwd.clone(), loaded.branch.clone(), loaded.base.clone()),
            (before.cwd, before.branch, before.base)
        );

        mgr2.resume(&id).unwrap();
        loop {
            if mgr2.task(&id).unwrap().phase == TaskPhase::Idle {
                break;
            }
            rx2.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let opts = r.runtime.options(1);
        assert_eq!(opts.resume.as_deref(), Some("sess-1"));
        assert_eq!(opts.cwd, loaded.cwd);
        assert_eq!(r.git.calls().iter().filter(|c| c.starts_with("worktree_add")).count(), 1, "no second worktree");
    }

    #[test]
    fn dispose_all_stops_every_session() {
        let r = rig();
        r.start(false);
        r.mgr.dispose_all();
        assert!(r.runtime.session(0).log.lock().unwrap().disposed);
    }
}
