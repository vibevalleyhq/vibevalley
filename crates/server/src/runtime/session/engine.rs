//! The board's sessions at work: hiring a helper on an issue, each round it
//! works, the words it is sent, its agent's events turned into live state and
//! persistent checkpoints, stopping it and letting it go.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;
use vibevalley_core::{SliceMask, derive_issues, overlay_sessions};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Deliverable, Doing, Issue, IssueAnswer, IssueReportMemoryScope, LastRun, Millis, Outcome, Phase, PhaseDone, PhaseFailed, PhaseResting,
    PhaseWorking, ProjectCheckStatus, Question, RunTrigger, Session, SessionAction, SessionClose, SessionPermissionRequest, SessionSubagents, Spent,
};
use vibevalley_runtime::agent::durable::BoxFuture;
use vibevalley_runtime::oar::{ContentBlock, EventKind, McpServer, PermissionDecision, PermissionMode, SessionOptions, StopReason};

use super::driver::{Drive, HelperPlace, Persona, SessionDriver};
use super::gen_table::SessionGenerationTable;
use super::journal::Trajectory;
use super::report::{Report, ReportQuestion, ReportStatus};
use crate::context::error::{LookIn, missing};
use crate::context::live::LiveSessionSnapshot;
use crate::context::{Context, now};
use crate::runtime::worktree::{Leave, Leaving, Worktree};
use crate::runtime::{IssueChange, Result, RuntimeConfig, RuntimeError, Step, find_issue};
use crate::service::DbError;
use crate::service::session::SessionExtra;

pub(crate) use crate::context::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};

/// Lifecycle notification for in-domain chat thread seating & dismissal.
#[derive(Debug, Clone)]
pub enum SessionLifecycleEvent {
    Changed(Box<Session>),
    Left {
        at: Millis,
        id: String,
        closed: Option<SessionClose>,
        merged_commits: Option<i64>,
    },
}

/// Out-of-band workspace permission lifecycle events for external push connectors.
#[derive(Debug, Clone)]
pub enum PermissionEvent {
    Requested {
        session_id: String,
        session_name: String,
        channel_id: Option<String>,
        request: SessionPermissionRequest,
        at: Millis,
    },
    Resolved {
        session_id: String,
        request_id: String,
    },
    ClearedSession {
        session_id: String,
    },
}

pub(super) fn ended_phase(outcome: Outcome) -> Phase {
    match outcome {
        Outcome::Completed => Phase::Done(PhaseDone {}),
        Outcome::Failed => Phase::Failed(PhaseFailed {}),
        Outcome::Interrupted => Phase::Resting(PhaseResting {}),
    }
}

/// The helpers' MCP door as the board hands it out: where it is, and which
/// helper each bearer token names.
#[derive(Default)]
struct Door {
    url: Option<String>,
    tokens: HashMap<String, String>,
    opening: HashMap<String, Session>,
}

/// A drafting round that ended: what the drafter said, for the issue
/// module to read the draft from.
pub struct DraftEnd {
    pub spent: Option<Spent>,
    pub session: Session,
    pub issue: Issue,
    pub reason: StopReason,
    pub said: String,
    pub asked: Vec<Question>,
}

/// What the issue module does when rounds end.
pub trait Rounds: Send + Sync {
    /// A drafting round ended; the draft goes onto the issue and the
    /// drafter goes home.
    fn drafted(&self, end: DraftEnd) -> BoxFuture<'_, ()>;
    /// After every round: what waits may go now.
    fn after(&self) -> BoxFuture<'_, ()>;
}

/// A new session on an issue: who, where, and its first prompt.
pub struct Hire<'a> {
    pub issue: &'a Issue,
    pub drive: Drive,
    pub cwd: PathBuf,
    pub branch: Option<String>,
    /// The branch its work forks from.
    pub base: Option<String>,
    pub name: String,
    pub brief: String,
    pub drafting: bool,
    pub prompt: String,
    pub trigger: RunTrigger,
}

pub(super) fn text(s: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(s.to_string())]
}

#[derive(Clone)]
pub struct SessionEngine(pub(super) Arc<Inner>);

pub(super) struct Inner {
    pub ctx: Arc<Context>,
    pub durable: vibevalley_runtime::agent::durable::Store,
    pub write_lock: Arc<AsyncMutex<()>>,
    pub(super) extra_lock: AsyncMutex<()>,
    pub drivers: Arc<dyn SessionDriver>,
    pub worktree: Arc<Worktree>,
    pub config: Arc<RuntimeConfig>,
    pub trajectory: Option<Arc<Trajectory>>,
    events: broadcast::Sender<SessionLifecycleEvent>,
    doing_events: broadcast::Sender<(String, Millis, Doing)>,
    permission_events: broadcast::Sender<PermissionEvent>,
    live: SessionGenerationTable<Arc<dyn vibevalley_runtime::oar::Session>>,
    pub(super) extras: Mutex<HashMap<String, SessionExtra>>,
    door: Mutex<Door>,
    rounds: OnceLock<Box<dyn Rounds>>,
    pub(super) recovering: Mutex<Vec<String>>,
    pub(super) listeners: Mutex<Vec<super::news::Listener>>,
    /// Held while a direct talk finds or hires its session.
    pub talking: AsyncMutex<()>,
    pub(super) workspaces: Mutex<HashMap<String, super::workspace::WorkspaceState>>,
}

impl SessionEngine {
    pub async fn new_async(
        ctx: Arc<Context>,
        write_lock: Arc<AsyncMutex<()>>,
        drivers: Arc<dyn SessionDriver>,
        worktree: Arc<Worktree>,
        config: Arc<RuntimeConfig>,
        trajectory: Option<Arc<Trajectory>>,
    ) -> Result<SessionEngine> {
        let durable = ctx.service.durable().await?;
        let (extras, configs) = tokio::try_join!(ctx.service.session.extras(), ctx.service.session.configs())?;
        let mut workspaces = HashMap::new();
        for (id, cfg) in configs {
            workspaces.insert(
                id,
                super::workspace::WorkspaceState {
                    meta: cfg.into(),
                    ..Default::default()
                },
            );
        }
        let (events, _) = broadcast::channel(256);
        let (doing_events, _) = broadcast::channel(512);
        let (permission_events, _) = broadcast::channel(128);
        Ok(SessionEngine(Arc::new(Inner {
            ctx,
            durable,
            write_lock,
            extra_lock: AsyncMutex::new(()),
            drivers,
            worktree,
            config,
            trajectory,
            events,
            doing_events,
            permission_events,
            live: SessionGenerationTable::new(),
            extras: Mutex::new(extras),
            door: Mutex::new(Door::default()),
            rounds: OnceLock::new(),
            listeners: Mutex::new(Vec::new()),
            recovering: Default::default(),
            talking: AsyncMutex::new(()),
            workspaces: Mutex::new(workspaces),
        })))
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.0.ctx
    }

    pub fn write_lock(&self) -> &Arc<AsyncMutex<()>> {
        &self.0.write_lock
    }

    pub fn driver(&self) -> &Arc<dyn SessionDriver> {
        &self.0.drivers
    }

    pub fn worktree(&self) -> &Arc<Worktree> {
        &self.0.worktree
    }

    pub fn config(&self) -> &Arc<RuntimeConfig> {
        &self.0.config
    }

    pub fn trajectory(&self) -> Option<&Arc<Trajectory>> {
        self.0.trajectory.as_ref()
    }

    /// Subscribes to in-domain session lifecycle events (`Changed`, `Left`).
    pub fn subscribe_events(&self) -> broadcast::Receiver<SessionLifecycleEvent> {
        self.0.events.subscribe()
    }

    /// Subscribes to in-domain working tool/action updates `(session_id, at, doing)`.
    pub fn subscribe_doing(&self) -> broadcast::Receiver<(String, Millis, Doing)> {
        self.0.doing_events.subscribe()
    }

    /// Subscribes to workspace permission request/resolution events.
    pub fn subscribe_permissions(&self) -> broadcast::Receiver<PermissionEvent> {
        self.0.permission_events.subscribe()
    }

    pub(super) fn emit_lifecycle(&self, event: SessionLifecycleEvent) {
        let _ = self.0.events.send(event);
    }

    pub(super) fn emit_permission(&self, event: PermissionEvent) {
        let _ = self.0.permission_events.send(event);
    }

    /// Who hears rounds end; set once.
    pub fn on_rounds(&self, rounds: Box<dyn Rounds>) {
        let _ = self.0.rounds.set(rounds);
    }

    /// The agents this process drives stop; their rounds are recorded as
    /// interrupted when the board opens next.
    pub fn close(&self) {
        for agent in self.0.live.drain_all() {
            agent.signal_dispose();
        }
    }

    pub async fn session_async(&self, id: &str) -> Option<Session> {
        let stored = self.0.ctx.service.session.get(id).await.ok().flatten()?;
        let overlays = self.0.ctx.live.core_session_overlays();
        overlay_sessions(&[stored], &overlays).into_iter().next()
    }

    pub(crate) async fn session_with_telemetry_async(&self, id: &str) -> Option<Session> {
        let mut stored = self.0.ctx.service.session.get(id).await.ok().flatten()?;
        if let Ok(Some(tel)) = self.0.ctx.service.session.telemetry_for_session(id).await {
            stored.telemetry = Some(tel);
        }
        let overlays = self.0.ctx.live.core_session_overlays();
        overlay_sessions(&[stored], &overlays).into_iter().next()
    }

    pub async fn get_async(&self, id: &str) -> Option<Session> {
        self.session_async(id).await
    }

    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.0.ctx.service.session.past(id).await.ok().flatten()
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        let stored = self.0.ctx.service.session.all().await?;
        let overlays = self.0.ctx.live.core_session_overlays();
        Ok(overlay_sessions(&stored, &overlays))
    }

    pub(crate) async fn sessions_with_telemetry_async(&self) -> Result<Vec<Session>> {
        let (mut stored, mut telemetry_map) = tokio::try_join!(self.0.ctx.service.session.all(), self.0.ctx.service.session.telemetry_by_session(),)?;
        for s in &mut stored {
            if let Some(tel) = telemetry_map.remove(&s.id) {
                s.telemetry = Some(tel);
            }
        }
        let overlays = self.0.ctx.live.core_session_overlays();
        Ok(overlay_sessions(&stored, &overlays))
    }

    pub async fn list_async(&self) -> Vec<Session> {
        self.sessions_async().await.unwrap_or_default()
    }

    pub(super) async fn raw_issue_async(&self, reference: &str) -> Result<Option<Issue>> {
        let (raw_issues, sessions) = tokio::try_join!(async { Ok::<_, RuntimeError>(self.0.ctx.service.issue.all().await?) }, self.sessions_async())?;
        let Some(target) = find_issue(&raw_issues, reference) else {
            return Ok(None);
        };
        let target_id = target.id.clone();
        let derived = derive_issues(&raw_issues, &sessions);
        if let Some(found) = derived.into_iter().find(|i| i.id == target_id) {
            return Ok(Some(found));
        }
        Ok(derive_issues(std::slice::from_ref(target), &sessions).into_iter().next())
    }

    /// Whether this process drives the session now.
    pub fn is_live(&self, session: &str) -> bool {
        self.0.live.contains(session)
    }

    pub(super) fn live_agent(&self, session: &str) -> Option<Arc<dyn vibevalley_runtime::oar::Session>> {
        self.0.live.get(session)
    }

    /// The record file of a session's agent events.
    pub fn record_path(&self, session: &str) -> PathBuf {
        self.0.config.data_dir.join("records").join(format!("{session}.jsonl"))
    }

    pub fn report_path(&self, session: &str) -> PathBuf {
        self.0.config.data_dir.join("reports").join(format!("{session}.json"))
    }

    /// What the helper hands back at the end of its round (`issue_report`),
    /// read when the round ends.
    pub async fn report_async(&self, session: &str, report: &Report) -> Result<()> {
        let path = self.report_path(session);
        let failed = |e: &dyn std::fmt::Display| RuntimeError::Other(format!("the report for {session}: {e}"));
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| failed(&e))?;
        }
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec(report).map_err(|e| failed(&e))?)
            .await
            .map_err(|e| failed(&e))?;
        tokio::fs::rename(tmp, path).await.map_err(|e| failed(&e))
    }

    /// Where helpers reach the farm's MCP door (`http://<addr>/mcp`); a helper
    /// started before it is known gets no door.
    pub fn set_mcp_url(&self, url: String) {
        self.0.door.lock().url = Some(url);
        let ids = std::mem::take(&mut *self.0.recovering.lock());
        if !ids.is_empty() {
            let me = self.clone();
            let fut = async move {
                for id in ids {
                    if let Err(e) = me.restore_generation_async(&id).await {
                        eprintln!("vibevalley: restoring {id}: {e}");
                        me.0.recovering.lock().push(id);
                    }
                }
            };
            self.0.ctx.spawn("session.recover", fut);
        }
    }

    pub fn mcp_url(&self) -> Option<String> {
        self.0.door.lock().url.clone()
    }

    /// The helper a bearer token names.
    pub fn who(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.0.door.lock().tokens.get(token).cloned()
    }

    /// Snapshot of a session whose runtime handle is currently opening before `go_live_async` persists it.
    pub fn opening_session(&self, id: &str) -> Option<Session> {
        self.0.door.lock().opening.get(id).cloned()
    }

    /// Mints (or reuses) the per-session MCP bearer token so remote sessions can
    /// authenticate over the WS MCP reverse tunnel even without a local HTTP MCP URL.
    pub(super) fn mcp_token_for(&self, session: &str) -> String {
        let mut door = self.0.door.lock();
        match door.tokens.iter().find(|(_, s)| s.as_str() == session) {
            Some((t, _)) => t.clone(),
            None => {
                let t = uuid::Uuid::new_v4().simple().to_string();
                door.tokens.insert(t.clone(), session.to_string());
                t
            }
        }
    }

    /// The helper's door entry, minting its token once.
    pub(super) fn door_for(&self, session: &str) -> Option<McpServer> {
        let url = self.0.door.lock().url.clone()?;
        let token = self.mcp_token_for(session);
        Some(McpServer::Http {
            name: "vibevalley".into(),
            url,
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
        })
    }

    pub(super) fn extra(&self, session: &str) -> SessionExtra {
        self.0.extras.lock().get(session).cloned().unwrap_or_default()
    }

    pub(super) async fn set_extra_async(&self, session: &str, change: impl FnOnce(&mut SessionExtra)) -> Result<()> {
        let _guard = self.0.extra_lock.lock().await;
        let extra = {
            let mut extras = self.0.extras.lock();
            let extra = extras.entry(session.to_string()).or_default();
            change(extra);
            extra.clone()
        };
        self.0.ctx.service.session.put_extra(session, &extra).await?;
        Ok(())
    }

    /// The branch a session's work forked from.
    pub fn base_branch(&self, session: &str) -> Option<String> {
        self.extra(session).base
    }

    pub(crate) async fn record_interrupted_async(&self, runs: Vec<(String, String)>) {
        for (session, run) in runs {
            self.record_async(
                &session,
                Step::RunEnded {
                    run,
                    outcome: Outcome::Interrupted,
                },
            )
            .await;
        }
    }

    /// A new session on an issue, its agent opened and its first prompt sent.
    pub async fn hire_async(&self, h: Hire<'_>) -> Result<String> {
        let number = {
            let _write = self.0.write_lock.lock().await;
            self.0.ctx.service.next_seq("session", 0).await?
        };
        let id = format!("w{number}");
        let policy = match h.issue.repo.clone() {
            Some(repo) => vibevalley_protocol::ExecutionPolicy::ManagedWorktree { repo, branch: h.branch },
            None => vibevalley_protocol::ExecutionPolicy::SandboxDir,
        };
        let mut session = Session::new(
            &id,
            vibevalley_protocol::SessionController::IssueBoard,
            h.name,
            h.drive.runtime_id.clone(),
            policy,
            now(),
        );
        session.profile = (!h.drive.agent.is_empty()).then(|| h.drive.agent.clone());
        session.machine = (!h.drive.is_local).then(|| h.drive.machine_id.clone());
        session.brief = h.brief;
        self.0.extras.lock().entry(id.clone()).or_default().base = h.base;
        session.cwd = (!h.cwd.as_os_str().is_empty()).then(|| h.cwd.to_string_lossy().into_owned());
        session.attach_binding(vibevalley_protocol::ContextRef::Issue {
            id: h.issue.id.clone(),
            refining: h.drafting.then_some(true),
        });
        let started = self.start_async(h.drive, session, h.issue, h.prompt, false, h.trigger).await;
        if started.is_err() {
            self.0.extras.lock().remove(&id);
        }
        started
    }

    /// Opens the agent for `session`, puts it on the board and sends the
    /// first prompt. `resume` reopens the runtime's own session.
    async fn start_async(&self, drive: Drive, mut session: Session, issue: &Issue, prompt: String, resume: bool, trigger: RunTrigger) -> Result<String> {
        let _ = tokio::fs::remove_file(self.report_path(&session.id)).await;
        let is_remote = !drive.is_local;
        let (agent, prompt) = self.open_for_async(drive, &session, issue, prompt, resume).await?;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        let started = IssueChange::Started {
            session: session.id.clone(),
            worker: !session.is_refining(),
        };
        self.go_live_async(agent.clone(), session.clone(), Some((issue.id.as_str(), started))).await?;
        let run = self.begin_run_async(&session.id, &issue.id, trigger).await?;
        let prompt = self.with_recall_async(&session, prompt).await;
        self.record_async(&session.id, Step::Asked { text: prompt.clone() }).await;
        if let Err(e) = Self::prompt_run_async(&agent, is_remote, &run, &prompt).await {
            let _ = self.dismiss_async(&session.id, Leave::Keep).await;
            return Err(e.into());
        }
        Ok(session.id)
    }

    async fn prompt_run_async(
        agent: &Arc<dyn vibevalley_runtime::oar::Session>,
        is_remote: bool,
        run: &str,
        prompt: &str,
    ) -> vibevalley_runtime::oar::Result<()> {
        if !is_remote && agent.runtime_id() != vibevalley_runtime::agent::runtime::ID {
            return agent.prompt(text(prompt)).await;
        }
        let key = format!("work:{run}");
        let outcome = agent.control(vibevalley_runtime::oar::ControlAction::Prompt, prompt, &key, &key).await?;
        if outcome.status != vibevalley_runtime::oar::ControlStatus::Accepted {
            return Err(vibevalley_runtime::oar::AgentError::Rejected(format!("{}: {}", outcome.code, outcome.reason)));
        }
        Ok(())
    }

    pub(crate) fn recover_on_connect(&self, ids: Vec<String>) {
        self.0.recovering.lock().extend(ids);
    }

    async fn restore_generation_async(&self, id: &str) -> Result<()> {
        let session = self
            .session_async(id)
            .await
            .ok_or_else(|| RuntimeError::Other(format!("missing session {id}")))?;
        let issue_id = session.issue_id().ok_or_else(|| RuntimeError::Other(format!("missing issue for {id}")))?;
        let issue = self
            .raw_issue_async(issue_id)
            .await?
            .ok_or_else(|| RuntimeError::Other(format!("missing issue for {id}")))?;
        let extra = self.extra(id);
        let run = extra.run.ok_or_else(|| RuntimeError::Other(format!("missing open run for {id}")))?;
        let vendor = extra.agent_session.ok_or_else(|| RuntimeError::Other(format!("missing driver id for {id}")))?;
        let conv = vibevalley_runtime::agent::harness::worker_conversation(&vendor);
        let req = format!("work:{run}");
        let sub = self
            .0
            .durable
            .read_with_async((conv.as_str(), req.as_str()), |tx, &(conv, req)| {
                Box::pin(tx.submission_by_request_async(conv, req))
            })
            .await?
            .ok_or_else(|| RuntimeError::Other(format!("missing generation for {run}")))?;
        let is_remote = session.machine.is_some();
        let drive = self.0.drivers.drive(session.profile_id(), &issue).await?;
        let (agent, _) = self.open_for_async(drive, &session, &issue, String::new(), true).await?;
        let mut history = agent.events_with_history();
        let mut turn_attached = false;
        while let Ok(e) = history.try_recv() {
            if matches!(e.kind, EventKind::TurnStarted { .. }) {
                turn_attached = true;
            }
        }
        self.go_live_async(agent.clone(), session, None).await?;
        if !turn_attached {
            Self::prompt_run_async(&agent, is_remote, &run, sub.payload["text"].as_str().unwrap_or_default()).await?;
        }
        Ok(())
    }

    async fn open_for_async(
        &self,
        drive: Drive,
        session: &Session,
        issue: &Issue,
        prompt: String,
        resume: bool,
    ) -> Result<(Arc<dyn vibevalley_runtime::oar::Session>, String)> {
        let cwd = PathBuf::from(session.cwd.clone().unwrap_or_default());
        let instructions = if session.is_refining() {
            "You are drafting an issue for VibeValley's board. Do not change or commit files.".to_string()
        } else {
            let place = HelperPlace {
                repo: session.repo_name().unwrap_or("").to_string(),
                branch: session.worktree_branch().map(String::from),
                cwd: session.cwd.clone().unwrap_or_default(),
                id: session.id.clone(),
                pull_request: issue.deliver == Deliverable::PullRequest || !drive.is_local,
                house: self.0.worktree.house_rules_async().await,
            };
            self.0.drivers.rules(&place, issue.deliver)
        };
        let system_prompt = match &drive.persona {
            Some(Persona::Replace(persona)) => Some(persona.clone()),
            _ => None,
        };
        let (instructions, prompt) = match &drive.persona {
            Some(Persona::System(persona)) => (format!("{persona}\n\n{instructions}"), prompt),
            Some(Persona::Prompt(persona)) if !resume => (instructions, format!("{persona}\n\n---\n\n{prompt}")),
            _ => (instructions, prompt),
        };
        let mut mcp_servers: Vec<McpServer> = self.door_for(&session.id).into_iter().collect();
        mcp_servers.extend(drive.mcp_servers.iter().cloned());
        let (append_system_prompt, prompt) = drive.work_instructions(instructions, prompt);
        let mut env = drive.env.clone();
        if !drive.is_local {
            let repo_ref = issue
                .repo
                .as_deref()
                .map(|r| self.0.worktree.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
            let branch = session.worktree_branch().map(String::from);
            let base_ref = self.extra(&session.id).base;
            let meta = crate::machine::RemoteDispatchMeta {
                session_id: Some(session.id.clone()),
                repo_ref,
                branch,
                base_ref,
                mcp_session_token: Some(self.mcp_token_for(&session.id)),
            };
            crate::machine::attach_dispatch_meta(&mut env, &meta);
        }
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            resume: if resume { self.extra(&session.id).agent_session } else { None },
            permission_mode: self.0.config.permission,
            append_system_prompt,
            env,
            record_to: Some(self.record_path(&session.id)),
            effort: drive.effort.clone(),
            mcp_servers,
            disallowed_tools: drive.disallowed_tools.clone(),
            system_prompt,
            ..Default::default()
        };
        self.0.door.lock().opening.insert(session.id.clone(), session.clone());
        let agent = match drive.runtime.open(opts).await {
            Ok(agent) => agent,
            Err(err) => {
                self.0.door.lock().opening.remove(&session.id);
                return Err(err.into());
            }
        };
        Ok((agent, prompt))
    }

    /// `session` on the board, driven by `agent` from now on: its events
    /// pumped into live state and durable checkpoints. The issue it works
    /// changes in the same commit.
    pub(super) async fn go_live_async(
        &self,
        agent: Arc<dyn vibevalley_runtime::oar::Session>,
        session: Session,
        issue: Option<(&str, IssueChange)>,
    ) -> Result<()> {
        let events = agent.events_with_history();
        let extra = {
            let mut extras = self.0.extras.lock();
            let entry = extras.entry(session.id.clone()).or_default();
            entry.agent_session = agent.resume_id();
            entry.clone()
        };
        let (generation, replaced) = self.0.live.install(session.id.clone(), agent.clone());
        if let Some(prev) = replaced
            && !Arc::ptr_eq(&prev, &agent)
        {
            prev.dispose().await;
        }
        let id = session.id.clone();
        self.0.door.lock().opening.remove(&id);
        let previous = session
            .subagents
            .as_ref()
            .filter(|s| s.disconnected_at.is_some() && s.root_thread_id == agent.id())
            .cloned();
        let run_id = extra.run.clone();
        {
            let _write = self.0.write_lock.lock().await;
            let at = now();
            let service = self.0.ctx.service.clone();
            let (maybe_issue, dirty) = if let Some((issue_id, change)) = issue {
                let raw = service.issue.all().await?;
                if let Some(mut item) = find_issue(&raw, issue_id).cloned() {
                    let dirty = change.dirty_mask() | SliceMask::SESSIONS;
                    change.fold(&mut item, at);
                    (Some(item), dirty)
                } else {
                    (None, SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM)
                }
            } else {
                (None, SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM)
            };
            let s = session.clone();
            let e = extra.clone();
            let sid = id.clone();
            let (_, written_dirty) = service
                .write_dirty_with(RuntimeError::Store, |tx| {
                    let service = service.clone();
                    Box::pin(async move {
                        service.session.put_in_tx(tx, &s, false).await?;
                        service.session.put_extra_in_tx(tx, &sid, &e).await?;
                        if let Some(item) = &maybe_issue {
                            service.issue.put_in_tx(tx, item).await?;
                        }
                        Ok(((), dirty))
                    })
                })
                .await?;
            self.0.ctx.mark_dirty(written_dirty);
        }
        let seeded_telemetry = if session.telemetry.is_some() {
            session.telemetry.clone()
        } else {
            self.0.ctx.service.session.telemetry_for_session(&id).await.ok().flatten()
        };
        self.sync_live_snapshot(&session, run_id.as_deref(), seeded_telemetry);
        self.emit_lifecycle(SessionLifecycleEvent::Changed(Box::new(session)));
        if let Some(before) = previous {
            let me = self.clone();
            let session_id = id.clone();
            let reconcile = async move {
                let mut after = before.clone();
                let changed = super::subagent::read_back_async(
                    &mut after,
                    |thread, turn| {
                        let agent = agent.clone();
                        Box::pin(async move { agent.read_subagent(thread, turn).await })
                    },
                    now,
                )
                .await;
                if changed
                    && me.current(&session_id, generation)
                    && let Err(err) = me.reconcile_subagents_async(&session_id, &before, after).await
                {
                    eprintln!("could not reconcile subagents for {session_id}: {err}");
                }
            };
            self.0.ctx.task.spawn(reconcile.in_current_span().with_current_subscriber());
        }
        let me = self.clone();
        let cancel = self.0.ctx.task.child_token();
        let pump = async move {
            me.pump_async(id, generation, events, cancel).await;
        };
        self.0.ctx.task.spawn(pump.in_current_span().with_current_subscriber());
        Ok(())
    }

    pub(super) fn sync_live_snapshot(&self, session: &Session, run_id: Option<&str>, telemetry: Option<vibevalley_protocol::SessionTelemetry>) {
        self.0.ctx.live.set_session(
            session.id.clone(),
            LiveSessionSnapshot {
                run_id: run_id.map(str::to_string),
                phase: Some(session.phase.clone()),
                channel: Some(session.channel_id().map(str::to_string)),
                brief: (!session.brief.is_empty()).then(|| session.brief.clone()),
                spent: session.spent.clone(),
                tool_connections: session.tool_connections.clone(),
                subagents: session.subagents.clone(),
                telemetry,
                last_event_at: Some(now()),
            },
        );
    }

    /// `withRecall`: what the agent remembers, set apart before the input.
    pub(super) async fn with_recall_async(&self, session: &Session, input: String) -> String {
        let Some(profile) = session.profile_id() else { return input };
        let block = self.0.drivers.recall(profile, &session.id, session.repo_name().unwrap_or(""), &input).await;
        if block.is_empty() { input } else { format!("{block}\n\n---\n\n{input}") }
    }

    /// The next round for a session on the board: its agent if this process
    /// still drives it, else reopened (resumed when the runtime can, else
    /// told `again`).
    pub async fn next_round_async(
        &self,
        issue: &Issue,
        session: &Session,
        words: String,
        again: impl FnOnce(&str) -> String,
        trigger: RunTrigger,
    ) -> Result<String> {
        let agent = self.0.live.get(&session.id);
        match agent {
            Some(agent) => {
                let _ = tokio::fs::remove_file(self.report_path(&session.id)).await;
                // Working from now, not from when the pump reads the turn's
                // start: the room is counted by it. Apply `Answered` atomically
                // so an `Asking` issue never flickers through `InReview`.
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                let mut updated_session = session.clone();
                updated_session.phase = phase.clone();
                let sid = session.id.clone();
                {
                    let _write = self.0.write_lock.lock().await;
                    let at = now();
                    let service = self.0.ctx.service.clone();
                    let raw = service.issue.all().await?;
                    let mut item = find_issue(&raw, &issue.id).cloned().ok_or_else(|| RuntimeError::NoIssue(issue.id.clone()))?;
                    let change = IssueChange::Answered;
                    let dirty = change.dirty_mask() | SliceMask::SESSIONS;
                    change.fold(&mut item, at);
                    let s_for_tx = updated_session.clone();
                    let (_, written_dirty) = service
                        .write_dirty_with(RuntimeError::Store, |tx| {
                            let service = service.clone();
                            Box::pin(async move {
                                service.session.put_in_tx(tx, &s_for_tx, false).await?;
                                service.issue.put_in_tx(tx, &item).await?;
                                Ok(((), dirty))
                            })
                        })
                        .await?;
                    self.0.ctx.mark_dirty(written_dirty);
                }
                self.0.ctx.live.update_session(&sid, |snap| {
                    snap.phase = Some(phase);
                    snap.last_event_at = Some(now());
                });
                let run = self.begin_run_async(&session.id, &issue.id, trigger).await?;
                let words = self.with_recall_async(session, words).await;
                self.record_async(&session.id, Step::Asked { text: words.clone() }).await;
                Self::prompt_run_async(&agent, session.machine.is_some(), &run, &words).await?;
                self.apply_issue_change_async(&issue.id, IssueChange::Unqueued).await?;
                Ok(session.id.clone())
            }
            None => {
                let drive = self.0.drivers.drive(session.profile_id().filter(|a| !a.is_empty()), issue).await?;
                let resume = drive.runtime.capabilities().resume && self.extra(&session.id).agent_session.is_some();
                let prompt = if resume { words } else { again(&words) };
                self.start_async(drive, session.clone(), issue, prompt, resume, trigger).await
            }
        }
    }

    async fn apply_issue_change_async(&self, id: &str, change: IssueChange) -> Result<()> {
        let _write = self.0.write_lock.lock().await;
        let service = self.0.ctx.service.clone();
        let raw = service.issue.all().await?;
        let mut issue = find_issue(&raw, id).cloned().ok_or_else(|| RuntimeError::NoIssue(id.into()))?;
        let dirty = change.dirty_mask();
        change.fold(&mut issue, now());
        let (_, written_dirty) = service
            .write_dirty_with(RuntimeError::Store, |tx| {
                let service = service.clone();
                Box::pin(async move {
                    service.issue.put_in_tx(tx, &issue).await?;
                    Ok(((), dirty))
                })
            })
            .await?;
        self.0.ctx.mark_dirty(written_dirty);
        Ok(())
    }

    /// Words into the running turn of a working session this process
    /// drives (queued for after it when the runtime cannot steer); none when
    /// it is not working here.
    pub async fn steer_async(&self, session: &Session, words: &str) -> Option<Result<()>> {
        if !session.phase.is_working() {
            return None;
        }
        let agent = self.0.live.get(&session.id)?;
        self.record_async(&session.id, Step::Asked { text: words.to_string() }).await;
        Some(match agent.steer(text(words)).await {
            Ok(()) => Ok(()),
            Err(_) => agent.queue(text(words)).await.map_err(RuntimeError::from),
        })
    }

    /// Aborts the running turn of `session`.
    pub async fn abort_turn_async(&self, session: &str) -> Result<()> {
        let agent = self.0.live.get(session);
        let agent = agent.ok_or_else(|| RuntimeError::Other("nothing is running".into()))?;
        agent.abort().await?;
        Ok(())
    }

    /// Attaches a context reference to an existing session.
    pub async fn attach_binding_async(&self, input: vibevalley_protocol::SessionBindingInput) -> Result<Session> {
        let mut session = self
            .session_async(&input.id)
            .await
            .ok_or_else(|| RuntimeError::Api(missing(t("server.helperRef", &[("id", input.id.clone().into())]), LookIn::Session)))?;
        if session.attach_binding(input.binding) {
            self.persist_session_update_async(&session).await?;
        }
        Ok(self.session_async(&session.id).await.unwrap_or(session))
    }

    /// Detaches a context reference from an existing session.
    pub async fn detach_binding_async(&self, input: vibevalley_protocol::SessionBindingInput) -> Result<Session> {
        let mut session = self
            .session_async(&input.id)
            .await
            .ok_or_else(|| RuntimeError::Api(missing(t("server.helperRef", &[("id", input.id.clone().into())]), LookIn::Session)))?;
        if session.detach_binding(&input.binding) {
            self.persist_session_update_async(&session).await?;
        }
        Ok(self.session_async(&session.id).await.unwrap_or(session))
    }

    /// Upserts an orchestrator session row and updates live state.
    pub async fn upsert_orchestrator_async(&self, session: &Session) -> std::result::Result<(), ApiError> {
        self.persist_session_update_async(session).await.map_err(super::types::session_error)
    }

    pub(super) async fn persist_session_update_async(&self, session: &Session) -> Result<()> {
        let _write = self.0.write_lock.lock().await;
        let service = self.0.ctx.service.clone();
        let s = session.clone();
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        let (_, written_dirty) = service
            .write_dirty_with(RuntimeError::Store, |tx| {
                let service = service.clone();
                Box::pin(async move {
                    service.session.put_in_tx(tx, &s, false).await?;
                    Ok(((), dirty))
                })
            })
            .await?;
        self.0.ctx.mark_dirty(written_dirty);
        self.0.ctx.live.update_session(&session.id, |snap| {
            snap.phase = Some(session.phase.clone());
            snap.channel = Some(session.channel_id().map(str::to_string));
            snap.brief = (!session.brief.is_empty()).then(|| session.brief.clone());
            snap.last_event_at = Some(now());
        });
        self.emit_lifecycle(SessionLifecycleEvent::Changed(Box::new(session.clone())));
        Ok(())
    }

    /// Counts commits merged into the target branch for an integrated issue session
    /// before its branch is removed by [`Worktree::release`].
    async fn resolve_integrated_merge_async(&self, session: &Session) -> (Option<SessionClose>, Option<i64>) {
        let Some(issue_id) = session.issue_id() else {
            return (Some(SessionClose::Completed), None);
        };
        let Ok(Some(issue)) = self.0.ctx.service.issue.get(issue_id).await else {
            return (Some(SessionClose::Completed), None);
        };
        let Some(check) = issue
            .delivery_evidence
            .as_ref()
            .and_then(|e| e.check.as_ref())
            .filter(|c| c.status != ProjectCheckStatus::Failed && c.target_commit != c.candidate_commit)
        else {
            return (Some(SessionClose::Completed), None);
        };
        let commits = if session.machine.is_none()
            && let Some(repo) = session.repo_name()
            && let Ok(Some(main)) = vibevalley_git::Repo::discover_async(&self.0.worktree.repo_dir(repo)).await
        {
            let to_ref = match session.worktree_branch() {
                Some(branch) if main.branch_exists_async(branch).await.unwrap_or(false) => branch,
                _ => check.candidate_commit.as_str(),
            };
            main.commits_between_async(&check.target_commit, to_ref)
                .await
                .ok()
                .and_then(|n| i64::try_from(n).ok())
                .filter(|n| *n > 0)
        } else {
            None
        };
        match commits {
            Some(n) => (Some(SessionClose::Merged), Some(n)),
            None => (Some(SessionClose::Completed), None),
        }
    }

    /// Lets a session go: its agent stops, its open round ends, its
    /// worktree is left as `leave` says, and it leaves the board.
    pub async fn dismiss_async(&self, session_id: &str, leave: Leave) -> Result<()> {
        if let Some(agent) = self.0.live.remove_any(session_id) {
            let _ = agent.abort().await;
            agent.dispose().await;
        }
        let session = self.session_async(session_id).await;
        if session.as_ref().is_some_and(|s| s.phase.is_working()) {
            self.end_run_async(session_id, Outcome::Interrupted, "", None).await?;
        }
        let (closed, merged_commits) = match (&session, leave) {
            (Some(s), Leave::Integrated) => self.resolve_integrated_merge_async(s).await,
            _ => (None, None),
        };
        if let Some(s) = &session
            && s.machine.is_none()
            && let (Some(repo), Some(worktree), Some(branch)) = (s.repo_name(), s.cwd.as_deref(), s.worktree_branch())
        {
            let leaving = Leaving {
                repo,
                worktree,
                branch,
                base: self.extra(&s.id).base,
                name: &s.name,
                drafting: s.is_refining(),
            };
            self.0.worktree.release(&leaving, leave)?;
        }
        let _ = tokio::fs::remove_file(self.report_path(session_id)).await;
        self.0.door.lock().tokens.retain(|_, s| s != session_id);
        let at = now();
        if let Some(s) = session.clone() {
            {
                let _write = self.0.write_lock.lock().await;
                let service = self.0.ctx.service.clone();
                let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
                let (_, written_dirty) = service
                    .write_dirty_with(RuntimeError::Store, |tx| {
                        let service = service.clone();
                        Box::pin(async move {
                            service.session.put_in_tx(tx, &s, true).await?;
                            service.session.remove_extra_in_tx(tx, &s.id).await?;
                            Ok(((), dirty))
                        })
                    })
                    .await?;
                self.0.ctx.mark_dirty(written_dirty);
            }
            self.0.ctx.live.remove_session(session_id);
            self.emit_lifecycle(SessionLifecycleEvent::Left {
                at,
                id: session_id.to_string(),
                closed,
                merged_commits,
            });
        } else {
            self.0.ctx.service.session.remove_extra(session_id).await?;
        }
        self.0.extras.lock().remove(session_id);
        self.remove_workspace_meta(session_id);
        Ok(())
    }

    fn current(&self, session: &str, generation: u64) -> bool {
        self.0.live.is_current(session, generation)
    }

    /// Turns the agent's events into live state and checkpoints until the session
    /// ends or leaves, without pinning an OS thread while idle between events.
    async fn pump_async(
        &self,
        session_id: String,
        generation: u64,
        mut events: mpsc::UnboundedReceiver<vibevalley_runtime::oar::Event>,
        cancel: CancellationToken,
    ) {
        let span = tracing::debug_span!("session.pump", session_id = %session_id, generation);
        async move {
            let quiet_after = self.0.config.quiet_after;
            let tick = quiet_after.min(Duration::from_secs(5)).max(Duration::from_millis(20));
            let mut last_event = tokio::time::Instant::now();
            let mut state = PumpState::default();
            loop {
                let event = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    res = tokio::time::timeout(tick, events.recv()) => match res {
                        Ok(Some(event)) => event,
                        Ok(None) => break,
                        Err(_) => {
                            if !self.current(&session_id, generation) {
                                return;
                            }
                            if last_event.elapsed() >= quiet_after {
                                self.set_quiet_async(&session_id, Some(now())).await;
                            }
                            continue;
                        }
                    },
                };
                if cancel.is_cancelled() || !self.current(&session_id, generation) {
                    return;
                }
                last_event = tokio::time::Instant::now();
                let ended = self.handle_pump_event_async(&session_id, generation, event, &mut state).await;
                if ended {
                    break;
                }
            }
            if cancel.is_cancelled() {
                return;
            }
            if self.0.live.remove_if_current(&session_id, generation).is_some() {
                self.on_workspace_pump_exited_async(&session_id).await;
            }
        }
        .instrument(span)
        .await
    }

    async fn handle_pump_event_async(&self, session_id: &str, generation: u64, event: vibevalley_runtime::oar::Event, state: &mut PumpState) -> bool {
        if !self.current(session_id, generation) {
            return true;
        }
        self.set_quiet_async(session_id, None).await;
        let root = event.agent_path.is_empty();
        if state.observed_run.is_none() || (root && matches!(event.kind, EventKind::TurnStarted { .. })) {
            state.observed_run = self.extra(session_id).run;
        }
        if let Some(run) = state.observed_run.as_deref()
            && super::subagent::relevant(&event)
            && let Err(error) = self.observe_subagents_async(session_id, generation, run, &event).await
        {
            eprintln!("could not record subagent progress for {session_id}: {error}");
        }
        self.record_async(session_id, Step::Agent(event.clone())).await;
        match event.kind {
            EventKind::SessionStarted { session_id: vendor, model } if root => {
                let _ = self.set_extra_async(session_id, |e| e.agent_session = Some(vendor)).await;
                self.on_workspace_session_started_async(session_id, model).await;
            }
            EventKind::TurnStarted { .. } if root => {
                state.said.clear();
                state.asked.clear();
                state.failure = None;
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                let _ = self.persist_phase_change_async(session_id, phase, None, None).await;
            }
            EventKind::TextDelta { text } if root => state.said.push_str(&text),
            EventKind::ToolCallStarted { name, input, .. } if root => {
                let action = super::journal::tool_action(&name, &input);
                let detail = super::journal::tool_detail(&input, "");
                let label = if detail.is_empty() && action == vibevalley_protocol::ToolAction::Other {
                    name
                } else {
                    detail.chars().take(512).collect()
                };
                self.set_doing_async(session_id, Doing { action: action.into(), label }).await;
            }
            EventKind::Question { text } if root => {
                state.asked.push(Question {
                    question: text,
                    options: vec![],
                });
            }
            EventKind::PermissionRequested {
                request_id,
                tool,
                input,
                summary,
            } => {
                if let Some(session) = self.session_async(session_id).await
                    && session.controller == vibevalley_protocol::SessionController::User
                {
                    self.on_workspace_permission_requested(&session, request_id, tool, input, summary);
                } else if self.0.config.permission == PermissionMode::Bypass
                    && let Some(agent) = self.0.live.get_if_current(session_id, generation)
                {
                    let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce).await;
                }
            }
            EventKind::PermissionResolved { request_id, .. } => {
                self.on_workspace_permission_resolved(session_id, &request_id);
            }
            EventKind::InteractionRequested {
                request_id,
                question,
                options,
                allow_custom,
            } => {
                if self
                    .session_async(session_id)
                    .await
                    .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::User)
                {
                    self.on_workspace_interaction_requested(session_id, request_id, question, options, allow_custom);
                } else if root {
                    state.asked.push(Question {
                        question,
                        options: options.into_iter().map(|o| o.label).collect(),
                    });
                }
            }
            EventKind::InteractionResolved { request_id, .. } => {
                self.on_workspace_interaction_resolved(session_id, &request_id);
            }
            EventKind::Error { message } if root => {
                state.failure = Some(message);
                self.0.ctx.live.update_session(session_id, |snap| {
                    let tel = snap.telemetry.get_or_insert_with(Default::default);
                    tel.run_errors += 1;
                    snap.last_event_at = Some(now());
                });
                self.0.ctx.mark_dirty(SliceMask::SESSIONS);
            }
            EventKind::TurnFinished { reason, usage } if root => {
                state.observed_run = None;
                let spent = reported_spent(&usage);
                if let Some(tokens) = super::journal::event_tokens_of(&usage) {
                    self.0.ctx.live.update_session(session_id, |snap| {
                        let tel = snap.telemetry.get_or_insert_with(Default::default);
                        vibevalley_core::merge_session_telemetry_usage(tel, &tokens);
                        if let Some(s) = &spent {
                            snap.spent = Some(s.clone());
                        }
                        snap.last_event_at = Some(now());
                    });
                    self.0.ctx.mark_dirty(SliceMask::SESSIONS);
                }
                let is_user = self
                    .session_async(session_id)
                    .await
                    .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::User);
                if is_user {
                    self.on_workspace_turn_finished(session_id, &usage);
                }
                self.finish_async(session_id, reason, spent, &state.said, &state.asked, state.failure.as_deref())
                    .await;
                if !is_user && let Some(rounds) = self.0.rounds.get() {
                    rounds.after().await;
                }
            }
            EventKind::SessionEnded => return true,
            _ => {}
        }
        false
    }

    async fn observe_subagents_async(&self, session_id: &str, generation: u64, run: &str, event: &vibevalley_runtime::oar::Event) -> Result<()> {
        if !self.current(session_id, generation) {
            return Ok(());
        }
        let Some(root) = self.extra(session_id).agent_session else { return Ok(()) };
        let _write = self.0.write_lock.lock().await;
        let Some(current_session) = self.session_async(session_id).await else {
            return Ok(());
        };
        let Some(summary) = super::subagent::observe(&current_session, run, &root, event) else {
            return Ok(());
        };
        let session_svc = self.0.ctx.service.session.clone();
        let current = self
            .0
            .durable
            .write_with_async(
                (session_svc, session_id.to_string(), run.to_string(), root, summary.clone()),
                |tx, (session_svc, session_id, run, root, summary)| {
                    let session_svc = session_svc.clone();
                    let session_id = session_id.clone();
                    let run = run.clone();
                    let root = root.clone();
                    let summary = summary.clone();
                    Box::pin(async move {
                        let active = session_svc
                            .active_run_in_tx(tx.transaction(), &session_id, &run, &root)
                            .await
                            .map_err(DbError::into_durable_error)?;
                        if active {
                            session_svc
                                .put_subagents_in_tx(tx.transaction(), &summary)
                                .await
                                .map_err(DbError::into_durable_error)?;
                        }
                        Ok(active)
                    })
                },
            )
            .await?;
        if current {
            self.0.ctx.live.update_session(session_id, |snap| {
                snap.subagents = Some(summary);
            });
            self.0
                .ctx
                .mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        }
        Ok(())
    }

    async fn reconcile_subagents_async(&self, session: &str, before: &SessionSubagents, after: SessionSubagents) -> Result<()> {
        let _write = self.0.write_lock.lock().await;
        let stored = self.0.ctx.service.session.run(&before.run).await?;
        if !stored.is_some_and(|r| r.session == session && r.subagents.as_ref() == Some(before)) {
            return Ok(());
        }
        let matches_live = self.session_async(session).await.is_some_and(|s| s.subagents.as_ref() == Some(before));
        let session_svc = self.0.ctx.service.session.clone();
        self.0
            .durable
            .write_with_async((session_svc, after.clone()), |tx, (session_svc, after)| {
                let session_svc = session_svc.clone();
                let after = after.clone();
                Box::pin(async move {
                    session_svc
                        .put_subagents_in_tx(tx.transaction(), &after)
                        .await
                        .map_err(DbError::into_durable_error)
                })
            })
            .await?;
        if matches_live {
            self.0.ctx.live.update_session(session, |snap| {
                snap.subagents = Some(after);
            });
            self.0
                .ctx
                .mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        }
        Ok(())
    }

    /// Persists a lifecycle phase transition on `session` and updates `LiveState`.
    pub(super) async fn persist_phase_change_async(&self, id: &str, phase: Phase, brief: Option<String>, spent: Option<Spent>) -> Result<()> {
        let at = now();
        let updated = {
            let _write = self.0.write_lock.lock().await;
            let service = self.0.ctx.service.clone();
            let id = id.to_string();
            let phase = phase.clone();
            let brief = brief.clone();
            let spent = spent.clone();
            let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
            let (updated, written_dirty) = service
                .write_dirty_with(RuntimeError::Store, |tx| {
                    let service = service.clone();
                    Box::pin(async move {
                        let Some(mut session) = service.session.get_in_tx(tx, &id).await? else {
                            return Ok((None, SliceMask::NONE));
                        };
                        session.phase = phase;
                        if let Some(b) = brief {
                            session.brief = b;
                        }
                        if let Some(s) = spent {
                            session.spent = Some(s);
                        }
                        service.session.put_in_tx(tx, &session, false).await?;
                        Ok((Some(session), dirty))
                    })
                })
                .await?;
            self.0.ctx.mark_dirty(written_dirty);
            updated
        };
        if let Some(session) = updated {
            self.0.ctx.live.update_session(id, |snap| {
                snap.phase = Some(session.phase.clone());
                if brief.is_some() {
                    snap.brief = Some(session.brief.clone());
                }
                if spent.is_some() {
                    snap.spent = session.spent.clone();
                }
                snap.last_event_at = Some(at);
            });
            self.emit_lifecycle(SessionLifecycleEvent::Changed(Box::new(session)));
        }
        Ok(())
    }

    async fn working_async(&self, session_id: &str) -> Option<PhaseWorking> {
        if let Some(live) = self.0.ctx.live.session(session_id)
            && let Some(phase) = live.phase
        {
            return match phase {
                Phase::Working(p) => Some(p),
                _ => None,
            };
        }
        self.session_async(session_id).await.and_then(|s| match s.phase {
            Phase::Working(p) => Some(p),
            _ => None,
        })
    }

    async fn set_doing_async(&self, session_id: &str, doing: Doing) {
        let Some(p) = self.working_async(session_id).await else { return };
        let at = now();
        let phase = Phase::Working(PhaseWorking {
            doing: doing.clone(),
            quiet_since: None,
            ..p
        });
        self.0.ctx.live.update_session(session_id, |snap| {
            snap.phase = Some(phase);
            snap.last_event_at = Some(at);
        });
        let _ = self.0.doing_events.send((session_id.to_string(), at, doing));
        self.0.ctx.mark_dirty(SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
    }

    async fn set_quiet_async(&self, session_id: &str, quiet: Option<Millis>) {
        let Some(p) = self.working_async(session_id).await else { return };
        if p.quiet_since.is_some() == quiet.is_some() {
            return;
        }
        tracing::debug!(quiet = quiet.is_some(), "session quiet state updated");
        let phase = Phase::Working(PhaseWorking { quiet_since: quiet, ..p });
        self.0.ctx.live.update_session(session_id, |snap| {
            snap.phase = Some(phase);
        });
        self.0.ctx.mark_dirty(SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
    }

    pub async fn review_work_async(&self, vendor: &str, run_id: &str, candidate: &str) -> Result<Option<(Issue, Report)>> {
        let Some(run) = self.0.ctx.service.session.run(run_id).await? else {
            return Ok(None);
        };
        let Some(session) = self.session_async(&run.session).await else {
            return Ok(None);
        };
        let extra = self.extra(&run.session);
        if session.is_refining()
            || run.outcome.is_some()
            || session.runtime != vibevalley_runtime::agent::runtime::ID
            || extra.run.as_deref() != Some(run_id)
            || extra.agent_session.as_deref() != Some(vendor)
        {
            return Ok(None);
        }
        let Some(issue_id) = run.issue.as_deref() else { return Ok(None) };
        let Some(issue) = self.raw_issue_async(issue_id).await? else {
            return Ok(None);
        };
        if issue.criteria.iter().all(|line| line.trim().is_empty()) {
            return Ok(None);
        }
        let report = Report::read_async(&self.report_path(&run.session)).await;
        let round = read_round(&issue, StopReason::Completed, report.as_ref(), candidate, &[]);
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

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn settle_report_async(
        &self,
        session: &Session,
        outcome: Outcome,
        summary: String,
        spent: Option<Spent>,
        answer: Option<IssueAnswer>,
        run_id: Option<String>,
        issue_change: Option<(String, IssueChange)>,
    ) -> Result<()> {
        let at = now();
        let next_runs = session.runs + 1;
        let next_phase = ended_phase(outcome);
        let session_id = session.id.clone();
        let next_last_run = LastRun {
            needs_reconciliation: false,
            outcome,
            summary: summary.clone(),
            at,
            spent: spent.clone(),
            answer: answer.clone(),
        };
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        let outbox_payload = OutboxSessionReported {
            id: session_id.clone(),
            at,
            outcome,
            summary: summary.clone(),
            spent: spent.clone(),
            run: run_id.clone(),
        };

        let updated = {
            let _write = self.0.write_lock.lock().await;
            let ctx = self.0.ctx.clone();
            let issue_change_slot = Mutex::new(issue_change);
            let updated = self
                .0
                .durable
                .write_with_async(
                    (
                        ctx,
                        session_id,
                        summary,
                        spent,
                        run_id,
                        next_runs,
                        next_phase,
                        next_last_run,
                        outbox_payload,
                        &issue_change_slot,
                    ),
                    |tx, state| {
                        let ctx = state.0.clone();
                        let session_id = state.1.clone();
                        let summary = state.2.clone();
                        let spent = state.3.clone();
                        let run_id = state.4.clone();
                        let next_runs = state.5;
                        let next_phase = state.6.clone();
                        let next_last_run = state.7.clone();
                        let outbox_payload = state.8.clone();
                        let issue_change = state.9.lock().take();
                        Box::pin(async move {
                            let db_tx = tx.transaction();
                            if let Some(id) = run_id.as_deref()
                                && let Some(mut r) = ctx.service.session.run_in_tx(db_tx, id).await.map_err(DbError::into_durable_error)?
                            {
                                r.ended_at = Some(at);
                                r.outcome = Some(outcome);
                                r.summary = summary.clone();
                                r.spent = spent.clone();
                                ctx.service.session.put_run_in_tx(db_tx, &r).await.map_err(DbError::into_durable_error)?;
                                ctx.service
                                    .session
                                    .clear_run_in_tx(db_tx, &session_id, id)
                                    .await
                                    .map_err(DbError::into_durable_error)?;
                                super::delivery::settle_run(tx, &r).await?;
                            }
                            let db_tx = tx.transaction();
                            if let Some((issue_id, change)) = issue_change
                                && let Some(mut issue) = ctx.service.issue.get_in_tx(db_tx, &issue_id).await.map_err(DbError::into_durable_error)?
                            {
                                change.fold(&mut issue, at);
                                ctx.service.issue.put_in_tx(db_tx, &issue).await.map_err(DbError::into_durable_error)?;
                            }
                            let Some(mut stored) = ctx.service.session.get_in_tx(db_tx, &session_id).await.map_err(DbError::into_durable_error)? else {
                                return Ok((None, false));
                            };
                            stored.runs = next_runs;
                            stored.phase = next_phase;
                            stored.last_run = Some(next_last_run);
                            if let Some(s) = spent {
                                stored.spent = Some(s);
                            }
                            ctx.service
                                .session
                                .put_in_tx(db_tx, &stored, false)
                                .await
                                .map_err(DbError::into_durable_error)?;
                            let _ = ctx
                                .outbox
                                .enqueue_event_in_tx(db_tx, &crate::context::OutboxEvent::SessionReported(outbox_payload))
                                .await
                                .map_err(|e| vibevalley_runtime::agent::durable::Error::Invalid(e.message))?;
                            Ok((Some(stored), true))
                        })
                    },
                )
                .await?;
            self.0.ctx.mark_dirty(dirty);
            if updated.1 {
                self.0.ctx.outbox.wake();
            }
            updated.0
        };
        if let Some(updated_session) = updated {
            self.0.ctx.live.update_session(&updated_session.id, |snap| {
                snap.phase = Some(updated_session.phase.clone());
                snap.spent = updated_session.spent.clone();
                snap.last_event_at = Some(at);
            });
            self.emit_lifecycle(SessionLifecycleEvent::Changed(Box::new(updated_session)));
        }
        Ok(())
    }

    /// A round's end: a talk's answer, a draft for the issue module, or a
    /// work round's report onto its issue.
    async fn finish_async(&self, session_id: &str, reason: StopReason, spent: Option<Spent>, said: &str, asked: &[Question], failure: Option<&str>) {
        let Some(session) = self.session_async(session_id).await else { return };
        if session.controller == vibevalley_protocol::SessionController::User && !session.is_board_worker() {
            self.finish_workspace_async(&session, reason, spent, said, failure).await;
            return;
        }
        if session.is_direct_talker() && session.issue_id().is_none() {
            self.finish_talk_async(&session, reason, said, spent).await;
            return;
        }
        let Some(issue_id) = session.issue_id() else {
            if session.controller == vibevalley_protocol::SessionController::User {
                self.finish_workspace_async(&session, reason, spent, said, failure).await;
            }
            return;
        };
        let Some(issue) = self.raw_issue_async(issue_id).await.ok().flatten() else {
            if session.controller == vibevalley_protocol::SessionController::User {
                self.finish_workspace_async(&session, reason, spent, said, failure).await;
            }
            return;
        };
        if session.is_refining() {
            if let Some(rounds) = self.0.rounds.get() {
                rounds
                    .drafted(DraftEnd {
                        spent,
                        session,
                        issue,
                        reason,
                        said: said.to_string(),
                        asked: asked.to_vec(),
                    })
                    .await;
            }
            return;
        }
        let extra = self.extra(session_id);
        let output = match self.graded_output_async(&session, &extra).await {
            Ok(output) => output,
            Err(e) => {
                eprintln!("vibevalley: reading the outcome for {session_id}: {e}");
                return;
            }
        };
        let report = Report::read_async(&self.report_path(session_id)).await;
        let failed = matches!(reason, StopReason::Error | StopReason::MaxTurns);
        let mut round = read_round(&issue, reason, report.as_ref(), output.as_deref().unwrap_or(said), asked);
        if failed && let Some(error) = failure {
            round.summary = vibevalley_core::text::clip(error, 400);
        }
        let run_id = extra.run;
        let outcome = round.outcome;
        let change = IssueChange::Reported {
            questions: (round.outcome != Outcome::Interrupted).then_some(round.questions),
            checks: round.checks,
            answer: round.answer.clone(),
        };
        if let Some(id) = run_id.clone() {
            if let Some(extra) = self.0.extras.lock().get_mut(session_id)
                && extra.run.as_ref() == Some(&id)
            {
                extra.run = None;
            }
            self.record_async(session_id, Step::RunEnded { run: id, outcome }).await;
        }
        if let Err(error) = self
            .settle_report_async(&session, outcome, round.summary, spent, round.answer, run_id, Some((issue.id.clone(), change)))
            .await
        {
            eprintln!("vibevalley: settling {session_id}: {error}");
            return;
        }
        if let Some(r) = report.as_ref().filter(|r| !r.remember.is_empty())
            && let Some(agent) = session.profile.clone()
        {
            let repo_name = session.repo_name().unwrap_or_default().to_string();
            let mut enqueued = false;
            for m in &r.remember {
                let repo = match m.scope {
                    IssueReportMemoryScope::Repo => (!repo_name.is_empty()).then(|| repo_name.clone()),
                    IssueReportMemoryScope::All => None,
                };
                let event = crate::context::OutboxEvent::SessionRemember {
                    agent: agent.clone(),
                    text: m.text.clone(),
                    repo,
                };
                if let Err(e) = self.0.ctx.outbox.enqueue_event(&event).await {
                    eprintln!("memory: {session_id}'s report note was not kept: {}", e.message);
                } else {
                    enqueued = true;
                }
            }
            if enqueued {
                self.0.ctx.outbox.wake();
            }
        }
    }
}

#[derive(Default)]
struct PumpState {
    observed_run: Option<String>,
    said: String,
    asked: Vec<Question>,
    failure: Option<String>,
}

fn reported_spent(usage: &vibevalley_runtime::oar::Usage) -> Option<Spent> {
    let tokens = usage.input_tokens?.checked_add(usage.output_tokens?)?;
    Some(Spent {
        tokens: i64::try_from(tokens).ok()?,
        cny: None,
    })
}

/// What a work round handed back, from its report or else from what the
/// agent said.
struct Round {
    outcome: Outcome,
    summary: String,
    questions: Vec<Question>,
    checks: Vec<vibevalley_protocol::CriterionCheck>,
    answer: Option<IssueAnswer>,
}

fn read_round(issue: &Issue, reason: StopReason, report: Option<&Report>, said: &str, asked: &[Question]) -> Round {
    let outcome = match (&reason, report) {
        (StopReason::Aborted, _) => Outcome::Interrupted,
        (StopReason::Error | StopReason::MaxTurns, _) => Outcome::Failed,
        (StopReason::Completed, Some(r)) if r.status == ReportStatus::Failed => Outcome::Failed,
        (StopReason::Completed, _) => Outcome::Completed,
    };
    let declared = report.map(|r| r.summary.trim().to_string()).filter(|s| !s.is_empty());
    let summary = declared.unwrap_or_else(|| {
        let read = vibevalley_core::text::summary_of(said);
        if !read.is_empty() {
            read
        } else if outcome == Outcome::Completed {
            "Done.".into()
        } else {
            "Did not finish.".into()
        }
    });
    let summary = vibevalley_core::text::clip(&summary, 400);
    let mut questions: Vec<Question> = match report {
        Some(r) if !r.questions.is_empty() => r.questions.iter().map(ReportQuestion::to_question).collect(),
        _ => vibevalley_core::text::questions_from_text(said),
    };
    questions.extend(asked.iter().cloned());
    if outcome == Outcome::Completed && questions.is_empty() && report.is_some_and(|r| r.status == ReportStatus::Blocked) {
        questions.push(Question {
            question: summary.clone(),
            options: vec![],
        });
    }
    let questions = vibevalley_core::refine::open_questions(&questions);
    let answer: Option<IssueAnswer> = report.and_then(|r| r.answer.clone()).or_else(|| {
        (issue.deliver == Deliverable::Answer && outcome == Outcome::Completed && !said.trim().is_empty()).then(|| IssueAnswer {
            conclusion: said.trim().to_string(),
            evidence: vec![],
            unsure: vec![],
            next: vec![],
        })
    });
    let checks = report
        .map(|r| r.checks.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| vibevalley_core::text::checks_from_text(said));
    Round {
        outcome,
        summary,
        questions,
        checks,
        answer,
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;
    use tokio::sync::mpsc;
    use tracing::instrument::WithSubscriber as _;
    use vibevalley_protocol::{ExecutionPolicy, Phase, Session, SessionAction, SessionController};
    use vibevalley_runtime::agent::durable::BoxFuture;
    use vibevalley_runtime::oar::{
        Capabilities, ContentBlock, ControlAction, ControlOutcome, ControlStatus, Event, EventKind, Installation, ModelInfo, PermissionDecision, Registry,
        Runtime as OarRuntime, Session as OarSession, SessionOptions, SessionStatus, voyage,
    };

    use super::SessionEngine;
    use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup, now};
    use crate::runtime::session::RuntimeDriver;
    use crate::runtime::worktree::Worktree;
    use crate::runtime::{RuntimeConfig, reopen_sessions_async};
    use crate::service::Service;

    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
        type Writer = BufWriter;

        fn make_writer(&'a self) -> Self::Writer {
            BufWriter(self.0.clone())
        }
    }

    struct StubSession {
        id: String,
        tx: mpsc::UnboundedSender<Event>,
        rx: Mutex<Option<mpsc::UnboundedReceiver<Event>>>,
    }

    impl OarSession for StubSession {
        fn id(&self) -> String {
            self.id.clone()
        }

        fn control<'a>(
            &'a self,
            action: ControlAction,
            _: &'a str,
            input_id: &'a str,
            span_id: &'a str,
        ) -> BoxFuture<'a, vibevalley_runtime::oar::Result<ControlOutcome>> {
            Box::pin(async move {
                Ok(ControlOutcome {
                    action,
                    status: ControlStatus::Accepted,
                    code: String::new(),
                    reason: String::new(),
                    span_id: span_id.into(),
                    input_id: input_id.into(),
                })
            })
        }

        fn records(&self) -> Vec<voyage::Record> {
            vec![]
        }

        fn subscribe_records(&self, _: Option<u64>) -> mpsc::UnboundedReceiver<voyage::Record> {
            let (_tx, rx) = mpsc::unbounded_channel();
            rx
        }

        fn runtime_id(&self) -> &str {
            "stub"
        }

        fn status(&self) -> SessionStatus {
            SessionStatus::Idle
        }

        fn events(&self) -> mpsc::UnboundedReceiver<Event> {
            self.rx.lock().take().unwrap_or_else(|| mpsc::unbounded_channel().1)
        }

        fn prompt(&self, _: Vec<ContentBlock>) -> BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn steer(&self, _: Vec<ContentBlock>) -> BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn queue(&self, _: Vec<ContentBlock>) -> BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn abort(&self) -> BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn respond_permission<'a>(&'a self, _: &'a str, _: PermissionDecision) -> BoxFuture<'a, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn dispose(&self) -> BoxFuture<'_, ()> {
            self.signal_dispose();
            Box::pin(async {})
        }

        fn signal_dispose(&self) {
            let _ = self.tx.send(Event {
                seq: 0,
                at_ms: 0,
                agent_path: vec![],
                kind: EventKind::SessionEnded,
            });
        }
    }

    struct StubRuntime;

    impl OarRuntime for StubRuntime {
        fn id(&self) -> &str {
            "stub"
        }

        fn display_name(&self) -> &str {
            "Stub"
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn installation(&self) -> BoxFuture<'_, Installation> {
            Box::pin(async {
                Installation::Available {
                    version: None,
                    path: std::path::PathBuf::from("/bin/true"),
                }
            })
        }

        fn list_models(&self) -> BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
            Box::pin(async { Ok(vec![]) })
        }

        fn open(&self, _: SessionOptions) -> BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn OarSession>>> {
            Box::pin(async {
                let (tx, rx) = mpsc::unbounded_channel();
                Ok(Arc::new(StubSession {
                    id: "stub-1".into(),
                    tx,
                    rx: Mutex::new(Some(rx)),
                }) as Arc<dyn OarSession>)
            })
        }
    }

    #[tokio::test]
    async fn pump_async_quiet_timer_uses_virtual_clock_and_propagates_session_pump_span() {
        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .with_writer(buf.clone())
            .finish();

        async {
            let dir = tempfile::tempdir().unwrap();
            let service = Service::open(dir.path()).await.unwrap();
            let outbox = Arc::new(Outbox::new(service.clone()));
            let ctx = Arc::new(Context::new(
                service,
                TaskGroup::new(),
                Arc::new(LiveState::new()),
                outbox,
                Arc::new(StateFeed::new()),
                vibevalley_core::system_clock(),
                Arc::new(Http),
                Arc::new(PublicDownload),
            ));
            let _opened = reopen_sessions_async(&ctx).await.unwrap();
            let mut cfg = RuntimeConfig::under(dir.path());
            cfg.quiet_after = Duration::from_secs(300);
            let config = Arc::new(cfg);
            let worktree = Arc::new(Worktree::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
            let mut registry = Registry::new();
            registry.register(Arc::new(StubRuntime));
            let drivers = Arc::new(RuntimeDriver {
                registry: Arc::new(registry),
                model: None,
            });
            let sessions = SessionEngine::new_async(ctx.clone(), Arc::new(tokio::sync::Mutex::new(())), drivers, worktree, config, None)
                .await
                .unwrap();

            tokio::time::pause();

            let (tx, rx) = mpsc::unbounded_channel();
            let agent = Arc::new(StubSession {
                id: "stub-quiet".into(),
                tx: tx.clone(),
                rx: Mutex::new(Some(rx)),
            });
            let mut session = Session::new(
                "w-quiet",
                SessionController::IssueBoard,
                "Quiet test",
                "stub",
                ExecutionPolicy::SandboxDir,
                now(),
            );
            session.phase = Phase::working(now(), SessionAction::Thinking, "");

            let wall_start = std::time::Instant::now();
            sessions.go_live_async(agent, session, None).await.unwrap();
            tokio::task::yield_now().await;

            let live_phase = || ctx.live.session("w-quiet").and_then(|s| s.phase);

            tokio::time::advance(Duration::from_secs(290)).await;
            tokio::task::yield_now().await;
            assert!(
                matches!(live_phase(), Some(Phase::Working(ref w)) if w.quiet_since.is_none()),
                "session must not be quiet before quiet_after elapses"
            );

            tokio::time::advance(Duration::from_secs(15)).await;
            for _ in 0..8 {
                tokio::task::yield_now().await;
                if matches!(live_phase(), Some(Phase::Working(ref w)) if w.quiet_since.is_some()) {
                    break;
                }
            }
            assert!(
                matches!(live_phase(), Some(Phase::Working(ref w)) if w.quiet_since.is_some()),
                "session must become quiet once virtual quiet_after elapses"
            );
            assert!(
                wall_start.elapsed() < Duration::from_secs(2),
                "5 virtual minutes must elapse instantaneously, took {:?}",
                wall_start.elapsed()
            );

            tx.send(Event {
                seq: 1,
                at_ms: now() as u64,
                agent_path: vec![],
                kind: EventKind::TextDelta { text: "progress".into() },
            })
            .unwrap();
            for _ in 0..8 {
                tokio::task::yield_now().await;
                if matches!(live_phase(), Some(Phase::Working(ref w)) if w.quiet_since.is_none()) {
                    break;
                }
            }
            assert!(
                matches!(live_phase(), Some(Phase::Working(ref w)) if w.quiet_since.is_none()),
                "event arrival must clear quiet_since"
            );

            tokio::time::resume();
            let _ = ctx.shutdown(Duration::from_secs(1)).await;
            ctx.service.close().await;

            let logs = String::from_utf8(buf.0.lock().clone()).unwrap();
            assert!(
                logs.contains("session.pump{session_id=w-quiet generation=1}"),
                "expected session.pump span in tracing output:\n{logs}"
            );
        }
        .with_subscriber(subscriber)
        .await;
    }
}
