//! In-crate fakes for the backends, so the state logic is tested without
//! SQLite, `git`, a PTY or an agent binary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use vibevalley_git::{DiffTarget, FileDiff, GitError, MergeCheck};
use vibevalley_oar::{
    AgentError, Capabilities, ContentBlock, Event, EventKind, Installation, ModelInfo, PermissionDecision, Runtime, Session, SessionOptions, SessionStatus,
};
use vibevalley_store::{AgentSessionRow, Project, ProjectId, SavedTerminal, StoreError};

use crate::git::{GitProvider, RepoOps};
use crate::persist::Persistence;
use crate::workspace::TerminalHandle;

#[derive(Default)]
pub struct MemStore {
    pub projects: Mutex<Vec<Project>>,
    pub layouts: Mutex<HashMap<ProjectId, Value>>,
    pub terminals: Mutex<HashMap<ProjectId, Vec<SavedTerminal>>>,
    pub sessions: Mutex<Vec<AgentSessionRow>>,
    pub settings: Mutex<HashMap<String, Value>>,
}

impl Persistence for MemStore {
    fn projects(&self) -> vibevalley_store::Result<Vec<Project>> {
        Ok(self.projects.lock().unwrap().clone())
    }
    fn add_project(&self, path: &Path) -> vibevalley_store::Result<Project> {
        let mut projects = self.projects.lock().unwrap();
        if let Some(p) = projects.iter().find(|p| p.path == path) {
            return Ok(p.clone());
        }
        let id = projects.len() as i64 + 1;
        let project = Project {
            id,
            path: path.to_path_buf(),
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            position: id,
            last_opened_ms: 0,
        };
        projects.push(project.clone());
        Ok(project)
    }
    fn remove_project(&self, id: ProjectId) -> vibevalley_store::Result<()> {
        self.projects.lock().unwrap().retain(|p| p.id != id);
        Ok(())
    }
    fn rename_project(&self, id: ProjectId, name: &str) -> vibevalley_store::Result<()> {
        let mut projects = self.projects.lock().unwrap();
        let p = projects.iter_mut().find(|p| p.id == id).ok_or(StoreError::NotFound)?;
        p.name = name.to_string();
        Ok(())
    }
    fn reorder_projects(&self, ids: &[ProjectId]) -> vibevalley_store::Result<()> {
        for p in self.projects.lock().unwrap().iter_mut() {
            p.position = ids.iter().position(|i| *i == p.id).unwrap_or(usize::MAX) as i64;
        }
        Ok(())
    }
    fn touch_project(&self, _id: ProjectId) -> vibevalley_store::Result<()> {
        Ok(())
    }
    fn layout(&self, id: ProjectId) -> vibevalley_store::Result<Option<Value>> {
        Ok(self.layouts.lock().unwrap().get(&id).cloned())
    }
    fn set_layout(&self, id: ProjectId, layout: &Value) -> vibevalley_store::Result<()> {
        self.layouts.lock().unwrap().insert(id, layout.clone());
        Ok(())
    }
    fn terminals(&self, id: ProjectId) -> vibevalley_store::Result<Vec<SavedTerminal>> {
        Ok(self.terminals.lock().unwrap().get(&id).cloned().unwrap_or_default())
    }
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> vibevalley_store::Result<()> {
        self.terminals.lock().unwrap().insert(id, terminals.to_vec());
        Ok(())
    }
    fn agent_sessions(&self, project: Option<ProjectId>) -> vibevalley_store::Result<Vec<AgentSessionRow>> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|r| project.is_none_or(|p| r.project_id == p))
            .cloned()
            .collect())
    }
    fn upsert_agent_session(&self, row: &AgentSessionRow) -> vibevalley_store::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|r| r.id != row.id);
        sessions.push(row.clone());
        Ok(())
    }
    fn delete_agent_session(&self, id: &str) -> vibevalley_store::Result<()> {
        self.sessions.lock().unwrap().retain(|r| r.id != id);
        Ok(())
    }
    fn setting(&self, key: &str) -> vibevalley_store::Result<Option<Value>> {
        Ok(self.settings.lock().unwrap().get(key).cloned())
    }
    fn set_setting(&self, key: &str, value: &Value) -> vibevalley_store::Result<()> {
        self.settings.lock().unwrap().insert(key.to_string(), value.clone());
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct FakeTerm {
    pub cwd: Option<PathBuf>,
    pub scrollback: String,
    pub killed: Arc<Mutex<bool>>,
}

impl FakeTerm {
    pub fn new(cwd: &str, scrollback: &str) -> Self {
        FakeTerm {
            cwd: Some(cwd.into()),
            scrollback: scrollback.into(),
            killed: Arc::default(),
        }
    }
    pub fn was_killed(&self) -> bool {
        *self.killed.lock().unwrap()
    }
}

impl TerminalHandle for FakeTerm {
    fn cwd(&self) -> Option<PathBuf> {
        self.cwd.clone()
    }
    fn scrollback_text(&self, _max_lines: usize) -> String {
        self.scrollback.clone()
    }
    fn is_alive(&self) -> bool {
        !self.was_killed()
    }
    fn kill(&self) {
        *self.killed.lock().unwrap() = true;
    }
}

#[derive(Default)]
pub struct GitState {
    pub no_repo: bool,
    pub calls: Vec<String>,
    pub dirty: Vec<PathBuf>,
    pub merge_check: Option<MergeCheck>,
    pub fail_worktree_add: bool,
}

#[derive(Clone, Default)]
pub struct FakeGit {
    pub state: Arc<Mutex<GitState>>,
}

impl FakeGit {
    pub fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }
}

struct FakeRepo {
    root: PathBuf,
    state: Arc<Mutex<GitState>>,
}

impl FakeRepo {
    fn log(&self, call: String) {
        self.state.lock().unwrap().calls.push(call);
    }
}

impl GitProvider for FakeGit {
    fn discover(&self, path: &Path) -> vibevalley_git::Result<Option<Box<dyn RepoOps>>> {
        if self.state.lock().unwrap().no_repo {
            return Ok(None);
        }
        Ok(Some(Box::new(FakeRepo {
            root: path.to_path_buf(),
            state: self.state.clone(),
        })))
    }
}

impl RepoOps for FakeRepo {
    fn root(&self) -> PathBuf {
        self.root.clone()
    }
    fn head(&self) -> vibevalley_git::Result<Option<String>> {
        Ok(Some("headsha".into()))
    }
    fn dirty_paths(&self) -> vibevalley_git::Result<Vec<PathBuf>> {
        Ok(self.state.lock().unwrap().dirty.clone())
    }
    fn diff(&self, target: &DiffTarget) -> vibevalley_git::Result<Vec<FileDiff>> {
        self.log(format!("diff {target:?}"));
        Ok(vec![FileDiff {
            old_path: Some("a.rs".into()),
            new_path: Some("a.rs".into()),
            change: vibevalley_git::Change::Modified,
            binary: false,
            added: 1,
            removed: 0,
            hunks: Vec::new(),
        }])
    }
    fn stage(&self, paths: &[PathBuf]) -> vibevalley_git::Result<()> {
        self.log(format!("stage {paths:?}"));
        Ok(())
    }
    fn commit(&self, message: &str) -> vibevalley_git::Result<String> {
        self.log(format!("commit {}", message.lines().next().unwrap_or_default()));
        self.state.lock().unwrap().dirty.clear();
        Ok("commitsha".into())
    }
    fn snapshot(&self, label: &str) -> vibevalley_git::Result<String> {
        self.log(format!("snapshot {}", self.root.display()));
        Ok(format!("snap:{}", label.rsplit('-').next().unwrap_or_default()))
    }
    fn worktree_add(&self, path: &Path, branch: &str) -> vibevalley_git::Result<Box<dyn RepoOps>> {
        if self.state.lock().unwrap().fail_worktree_add {
            return Err(GitError::Command {
                command: "worktree add".into(),
                stderr: "boom".into(),
            });
        }
        self.log(format!("worktree_add {branch}"));
        Ok(Box::new(FakeRepo {
            root: path.to_path_buf(),
            state: self.state.clone(),
        }))
    }
    fn worktree_remove(&self, _path: &Path, force: bool) -> vibevalley_git::Result<()> {
        self.log(format!("worktree_remove force={force}"));
        Ok(())
    }
    fn merge_check(&self, branch: &str) -> vibevalley_git::Result<MergeCheck> {
        self.log(format!("merge_check {branch}"));
        Ok(self.state.lock().unwrap().merge_check.clone().unwrap_or(MergeCheck::Clean))
    }
    fn merge(&self, branch: &str, _message: Option<&str>) -> vibevalley_git::Result<String> {
        self.log(format!("merge {branch}"));
        Ok("mergesha".into())
    }
}

#[derive(Default)]
pub struct SessionLog {
    pub prompts: Vec<String>,
    pub queued: Vec<String>,
    pub steered: Vec<String>,
    pub decisions: Vec<(String, PermissionDecision)>,
    pub aborted: bool,
    pub disposed: bool,
}

/// A session the test drives by hand through `emit`.
pub struct FakeSession {
    subscribers: Mutex<Vec<flume::Sender<Event>>>,
    seq: Mutex<u64>,
    pub log: Mutex<SessionLog>,
    pub reject_prompt: bool,
}

fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(|b| match b {
            ContentBlock::Text(t) => t.clone(),
            other => format!("{other:?}"),
        })
        .collect()
}

impl FakeSession {
    pub fn emit(&self, kind: EventKind) {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let event = Event {
            seq: *seq,
            agent_path: Vec::new(),
            at_ms: *seq,
            kind,
        };
        self.subscribers.lock().unwrap().retain(|s| s.send(event.clone()).is_ok());
    }

    /// Drops every subscriber, as a crashed runtime would.
    pub fn hang_up(&self) {
        self.subscribers.lock().unwrap().clear();
    }
}

impl Session for FakeSession {
    fn id(&self) -> String {
        "sess-1".into()
    }
    fn runtime_id(&self) -> &str {
        "fake"
    }
    fn status(&self) -> SessionStatus {
        SessionStatus::Idle
    }
    fn events(&self) -> flume::Receiver<Event> {
        let (tx, rx) = flume::unbounded();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }
    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        if self.reject_prompt {
            return Err(AgentError::Rejected("busy".into()));
        }
        self.log.lock().unwrap().prompts.push(text_of(&content));
        Ok(())
    }
    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        self.log.lock().unwrap().steered.push(text_of(&content));
        Ok(())
    }
    fn queue(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        self.log.lock().unwrap().queued.push(text_of(&content));
        Ok(())
    }
    fn abort(&self) -> vibevalley_oar::Result<()> {
        self.log.lock().unwrap().aborted = true;
        Ok(())
    }
    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> vibevalley_oar::Result<()> {
        self.log.lock().unwrap().decisions.push((request_id.to_string(), decision));
        Ok(())
    }
    fn dispose(&self) {
        self.log.lock().unwrap().disposed = true;
    }
}

#[derive(Default)]
pub struct FakeRuntime {
    pub capabilities: Capabilities,
    pub opened: Mutex<Vec<(SessionOptions, Arc<FakeSession>)>>,
    pub fail_open: bool,
    pub reject_prompt: bool,
}

impl FakeRuntime {
    pub fn session(&self, index: usize) -> Arc<FakeSession> {
        self.opened.lock().unwrap()[index].1.clone()
    }
    pub fn options(&self, index: usize) -> SessionOptions {
        self.opened.lock().unwrap()[index].0.clone()
    }
}

impl Runtime for FakeRuntime {
    fn id(&self) -> &str {
        "fake"
    }
    fn display_name(&self) -> &str {
        "Fake"
    }
    fn capabilities(&self) -> Capabilities {
        self.capabilities.clone()
    }
    fn installation(&self) -> Installation {
        Installation::Available {
            version: Some("1.0".into()),
            path: "/bin/fake".into(),
        }
    }
    fn list_models(&self) -> vibevalley_oar::Result<Vec<ModelInfo>> {
        Ok(Vec::new())
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_oar::Result<Arc<dyn Session>> {
        if self.fail_open {
            return Err(AgentError::NotAvailable("not logged in".into()));
        }
        let session = Arc::new(FakeSession {
            subscribers: Mutex::default(),
            seq: Mutex::new(0),
            log: Mutex::default(),
            reject_prompt: self.reject_prompt,
        });
        self.opened.lock().unwrap().push((opts, session.clone()));
        Ok(session)
    }
}
