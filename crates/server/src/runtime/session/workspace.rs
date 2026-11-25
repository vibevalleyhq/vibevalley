//! Direct user workspace chat sessions (`session.openWorkspace`, `session.send`,
//! `session.respondPermission`, `session.respondInteraction`,
//! `session.setConfig`): a `Session` with `SessionController::User` and
//! `ExecutionPolicy::DirectCwd`, reusing `SessionEngine::go_live_async`,
//! `pump_async`, and `Trajectory`.

use std::path::{Path, PathBuf};

use tokio::sync::mpsc;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, EventTokens, ExecutionPolicy, Outcome, Phase, PhaseFailed, PhaseResting, Session, SessionAction, SessionChildStep, SessionChildToolCall,
    SessionChildTranscript, SessionChildTranscriptInput, SessionController, SessionInteractionOption, SessionInteractionRequest, SessionOpenWorkspaceInput,
    SessionPermissionDecision, SessionPermissionMode, SessionPermissionRequest, SessionRespondInteractionInput, SessionRespondPermissionInput,
    SessionSendInput, SessionSetConfigInput, SessionSwarmMember, SessionSwarmMemberState, SessionSwarmMessage, SessionSwarmOverview, SessionSwarmRole,
    SessionSwarmState, SessionSwarmThread, SessionWorkspace, Spent,
};
use vibevalley_runtime::oar::{
    AgentError, ContentBlock, InteractionDecision, InteractionOption, PermissionDecision, PermissionMode, RefusableOption, SessionOptions, StopReason,
    SwarmMemberState, TurnOptions, Usage,
};

use super::engine::SessionEngine;
use super::mailbox::MailboxSource;
use crate::context::error::{LookIn, missing};
use crate::context::now;
use crate::runtime::worktree::Leave;
use crate::runtime::{Result, RuntimeError, Step};
use crate::service::session::SessionConfig;
use crate::storage::Storage;

pub(super) fn to_oar_permission(mode: SessionPermissionMode) -> PermissionMode {
    match mode {
        SessionPermissionMode::Ask => PermissionMode::Ask,
        SessionPermissionMode::AcceptEdits => PermissionMode::AcceptEdits,
        SessionPermissionMode::Bypass => PermissionMode::Bypass,
        SessionPermissionMode::ReadOnly => PermissionMode::Plan,
    }
}

pub(super) fn map_interaction_options(options: Vec<InteractionOption>) -> Vec<SessionInteractionOption> {
    options
        .into_iter()
        .map(|o| SessionInteractionOption {
            id: o.id,
            label: o.label,
            description: o.description,
            warning: o.warning,
        })
        .collect()
}

pub(super) fn clip_json_input(input: &serde_json::Value) -> Option<String> {
    let raw = match input {
        serde_json::Value::Null => return None,
        serde_json::Value::String(s) if s.trim().is_empty() => return None,
        serde_json::Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    Some(vibevalley_core::rules::cut(&raw, 4000))
}

#[derive(Debug, Clone)]
pub(super) struct WorkspaceMeta {
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: SessionPermissionMode,
}

impl Default for WorkspaceMeta {
    fn default() -> Self {
        Self {
            title: None,
            model: None,
            effort: None,
            permission_mode: SessionPermissionMode::AcceptEdits,
        }
    }
}

impl From<SessionConfig> for WorkspaceMeta {
    fn from(cfg: SessionConfig) -> Self {
        Self {
            title: cfg.title,
            model: cfg.model,
            effort: cfg.effort,
            permission_mode: cfg.permission_mode.unwrap_or(SessionPermissionMode::AcceptEdits),
        }
    }
}

#[derive(Default)]
pub(super) struct WorkspaceState {
    pub meta: WorkspaceMeta,
    pub pending_permissions: Vec<SessionPermissionRequest>,
    pub pending_interactions: Vec<SessionInteractionRequest>,
    pub tokens: Option<EventTokens>,
    pub watchers: Vec<mpsc::Sender<()>>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSnapshot {
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: SessionPermissionMode,
    pub pending_permissions: Vec<SessionPermissionRequest>,
    pub pending_interactions: Vec<SessionInteractionRequest>,
    pub tokens: Option<EventTokens>,
}

fn missing_session(id: &str) -> RuntimeError {
    RuntimeError::Api(missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session))
}

fn invalid_input(message: String) -> RuntimeError {
    RuntimeError::Api(ApiError::new(BizCode::InvalidInput, message))
}

fn apply_workspace_input_updates(session: &mut Session, mut snap: WorkspaceSnapshot, input: &SessionOpenWorkspaceInput) -> WorkspaceMeta {
    let model_opt = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let effort_opt = input.effort.as_deref().map(str::trim).filter(|e| !e.is_empty());
    let model_changed = model_opt.is_some_and(|m| snap.model.as_deref() != Some(m));
    if let Some(m) = model_opt {
        snap.model = Some(m.to_string());
    }
    if let Some(e) = effort_opt {
        snap.effort = Some(e.to_string());
    } else if model_changed {
        snap.effort = None;
    }
    if let Some(p) = input.permission_mode {
        snap.permission_mode = p;
    }
    if let Some(title) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        snap.title = Some(title.to_string());
        session.name = title.to_string();
        if session.brief.is_empty() {
            session.brief = title.to_string();
        }
    }
    WorkspaceMeta {
        title: snap.title,
        model: snap.model,
        effort: snap.effort,
        permission_mode: snap.permission_mode,
    }
}

async fn apply_live_workspace_config_async(agent: &dyn vibevalley_runtime::oar::Session, input: &SessionOpenWorkspaceInput) -> Result<()> {
    if input.model.is_none() && input.effort.is_none() && input.permission_mode.is_none() {
        return Ok(());
    }
    match agent
        .set_config(input.model.as_deref(), input.effort.as_deref(), input.permission_mode.map(to_oar_permission))
        .await
    {
        Ok(()) | Err(AgentError::Unsupported { .. }) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn prepare_relaunch_session(session: &mut Session, cwd: String, input: SessionOpenWorkspaceInput, permission_mode: SessionPermissionMode) {
    let runtime_id = if !input.runtime.trim().is_empty() {
        input.runtime.trim().to_string()
    } else {
        session.runtime.clone()
    };
    if let Ok(parsed) = vibevalley_protocol::RuntimeRef::parse(&runtime_id) {
        session.runtime = parsed.runtime_id.strip_prefix("acp:").unwrap_or(&parsed.runtime_id).to_string();
        session.machine = (!parsed.is_local()).then_some(parsed.machine_id);
    } else {
        session.runtime = runtime_id.strip_prefix("acp:").unwrap_or(&runtime_id).to_string();
    }
    if !cwd.is_empty() {
        session.cwd = Some(cwd);
    }
    let next_repo = input.repo.filter(|r| !r.trim().is_empty()).or_else(|| session.repo_name().map(String::from));
    session.policy = ExecutionPolicy::DirectCwd {
        repo: next_repo,
        permission_mode,
    };
}

fn refused_session(message: String) -> RuntimeError {
    RuntimeError::Api(ApiError::new(BizCode::SessionRefused, message))
}

impl SessionEngine {
    #[cfg(test)]
    async fn load_workspace_meta_async(&self, session_id: &str) -> WorkspaceMeta {
        match self.0.ctx.service.session.config(session_id).await {
            Ok(Some(cfg)) => WorkspaceMeta::from(cfg),
            Ok(None) => WorkspaceMeta::default(),
            Err(e) => {
                eprintln!("vibevalley: reading session config {session_id}: {e}");
                WorkspaceMeta::default()
            }
        }
    }

    async fn save_workspace_meta_async(&self, session_id: &str, meta: &WorkspaceMeta) {
        let cfg = SessionConfig {
            title: meta.title.clone(),
            model: meta.model.clone(),
            effort: meta.effort.clone(),
            permission_mode: Some(meta.permission_mode),
        };
        if let Err(e) = self.0.ctx.service.session.put_config(session_id, &cfg).await {
            eprintln!("vibevalley: saving session config {session_id}: {e}");
        }
    }

    pub(super) fn remove_workspace_meta(&self, session_id: &str) {
        self.0.workspaces.lock().remove(session_id);
    }

    /// Aborts and disposes a user session when its tab closes, ending
    /// any running turn as interrupted without touching the project directory.
    pub async fn close_workspace_async(&self, session_id: &str) {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return;
        }
        let existing = self.session_async(session_id).await;
        if existing.as_ref().is_some_and(|s| s.controller != SessionController::User) {
            return;
        }
        if let Some(session) = existing.as_ref().filter(|s| s.phase.is_working()) {
            if let Err(e) = self.end_run_async(session_id, Outcome::Interrupted, "", None).await {
                eprintln!("vibevalley: ending workspace run {session_id}: {e}");
            }
            self.finish_workspace_async(session, StopReason::Aborted, None, "", None).await;
        }
        if let Err(e) = self.dismiss_async(session_id, Leave::Keep).await {
            eprintln!("vibevalley: closing workspace session {session_id}: {e}");
            self.remove_workspace_meta(session_id);
        }
    }

    fn ensure_workspace_entry<'a>(&self, map: &'a mut std::collections::HashMap<String, WorkspaceState>, session_id: &str) -> &'a mut WorkspaceState {
        map.entry(session_id.to_string()).or_default()
    }

    pub(super) fn notify_workspace(&self, session_id: &str) {
        let mut map = self.0.workspaces.lock();
        let Some(ws) = map.get_mut(session_id) else { return };
        ws.watchers
            .retain(|tx| !matches!(tx.try_send(()), Err(tokio::sync::mpsc::error::TrySendError::Closed(_))));
    }

    /// Subscribes to out-of-band workspace state changes (pending permissions,
    /// pending interactions, live config, and latest token telemetry).
    pub fn watch_workspace(&self, session_id: &str) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel(1);
        let mut map = self.0.workspaces.lock();
        let ws = self.ensure_workspace_entry(&mut map, session_id);
        ws.watchers.push(tx);
        rx
    }

    /// Reads the current workspace-specific state for `session_id`.
    pub fn workspace_snapshot(&self, session_id: &str) -> WorkspaceSnapshot {
        let mut map = self.0.workspaces.lock();
        let ws = self.ensure_workspace_entry(&mut map, session_id);
        WorkspaceSnapshot {
            title: ws.meta.title.clone(),
            model: ws.meta.model.clone(),
            effort: ws.meta.effort.clone(),
            permission_mode: ws.meta.permission_mode,
            pending_permissions: ws.pending_permissions.clone(),
            pending_interactions: ws.pending_interactions.clone(),
            tokens: ws.tokens.clone(),
        }
    }

    /// Reads the live session's mtime-cached native swarm sidecar snapshot, if any.
    pub fn swarm_snapshot(&self, session_id: &str) -> Option<SessionSwarmState> {
        let agent = self.live_agent(session_id)?;
        let snap = agent.swarm_snapshot()?;
        let active_count = i64::from(snap.working_count) + i64::from(snap.waiting_count) + i64::from(snap.stopped_count);
        let members = snap
            .members
            .into_iter()
            .map(|m| SessionSwarmMember {
                name: m.name,
                conversation_id: m.conversation_id,
                role: if m.role == "coordinator" {
                    SessionSwarmRole::Coordinator
                } else {
                    SessionSwarmRole::Worker
                },
                state: match m.state {
                    SwarmMemberState::Working => SessionSwarmMemberState::Working,
                    SwarmMemberState::Waiting => SessionSwarmMemberState::Waiting,
                    SwarmMemberState::Stopped => SessionSwarmMemberState::Stopped,
                    SwarmMemberState::Killed => SessionSwarmMemberState::Killed,
                },
                wake_mode: m.wake_mode,
                wait_since: m.wait_since.and_then(|v| i64::try_from(v).ok()),
                model: m.model,
                workspace_mode: m.workspace_mode,
                task: m.task,
            })
            .collect();
        let overview = snap.plan.map(|p| SessionSwarmOverview {
            goal_title: p.goal_title,
            goal_line: p.goal_line,
            threads: p
                .threads
                .into_iter()
                .map(|t| SessionSwarmThread {
                    id: t.id,
                    title: t.title,
                    goal: t.goal,
                    members: t.tasks,
                })
                .collect(),
            tasks: p.tasks,
        });
        let messages = snap
            .messages
            .into_iter()
            .map(|m| SessionSwarmMessage {
                seq: i64::try_from(m.seq).unwrap_or(i64::MAX),
                agent: m.agent,
                text: m.text,
                time: m.time,
                kind: m.kind,
            })
            .collect();
        Some(SessionSwarmState {
            swarm_id: snap.swarm_id,
            title: snap.title,
            working_count: i64::from(snap.working_count),
            active_count,
            members,
            overview,
            messages,
            total_messages: i64::try_from(snap.total_messages).unwrap_or(i64::MAX),
        })
    }

    /// Reads bounded recent transcript steps for a child agent or swarm member.
    pub async fn read_child_transcript_async(&self, input: SessionChildTranscriptInput) -> Result<SessionChildTranscript> {
        let session = self.session_async(&input.id).await.ok_or_else(|| missing_session(&input.id))?;
        let conversation_id = input.conversation_id.trim().to_string();
        if conversation_id.is_empty()
            || conversation_id.contains("..")
            || conversation_id.contains('/')
            || conversation_id.contains('\\')
            || conversation_id.contains('\0')
        {
            return Err(invalid_input("invalid conversationId".into()));
        }
        let limit = input.limit.unwrap_or(30).clamp(1, 30) as usize;
        let agent = self.live_agent(&session.id);
        let steps = match agent {
            Some(agent) => agent
                .read_child_transcript(&conversation_id, limit)
                .into_iter()
                .map(|s| SessionChildStep {
                    step_index: i64::try_from(s.step_index).unwrap_or(0),
                    source: s.source,
                    kind: s.kind,
                    status: s.status,
                    created_at: s.created_at,
                    model: s.model,
                    thinking: s.thinking,
                    content: s.content,
                    error: s.error,
                    tool_calls: s
                        .tool_calls
                        .into_iter()
                        .map(|tc| SessionChildToolCall {
                            name: tc.name,
                            args: tc.summary,
                        })
                        .collect(),
                    input_tokens: s.input_tokens.and_then(|n| i64::try_from(n).ok()),
                    cache_read_tokens: s.cache_read_tokens.and_then(|n| i64::try_from(n).ok()),
                    output_tokens: s.output_tokens.and_then(|n| i64::try_from(n).ok()),
                })
                .collect(),
            None => Vec::new(),
        };
        Ok(SessionChildTranscript {
            conversation_id: input.conversation_id.trim().to_string(),
            steps,
        })
    }

    /// Reads the live runtime session title (persisting changes to workspace meta),
    /// falling back to the persisted workspace title.
    pub async fn session_title_async(&self, session_id: &str) -> Option<String> {
        let live = self
            .live_agent(session_id)
            .and_then(|agent| agent.session_title())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let mut updated = None;
        let resolved = {
            let mut map = self.0.workspaces.lock();
            let ws = self.ensure_workspace_entry(&mut map, session_id);
            if let Some(title) = live {
                if ws.meta.title.as_deref() != Some(title.as_str()) {
                    ws.meta.title = Some(title.clone());
                    updated = Some(ws.meta.clone());
                }
                Some(title)
            } else {
                ws.meta.title.clone()
            }
        };
        if let Some(meta) = updated {
            self.save_workspace_meta_async(session_id, &meta).await;
        }
        resolved
    }

    async fn workspace_reply_async(&self, session: Session) -> SessionWorkspace {
        let title = self.session_title_async(&session.id).await;
        let snap = self.workspace_snapshot(&session.id);
        SessionWorkspace {
            id: session.id.clone(),
            session,
            title,
            model: snap.model,
            effort: snap.effort,
            permission_mode: snap.permission_mode,
        }
    }

    /// Opens a new user workspace session or reconnects an existing one.
    pub async fn open_workspace_async(&self, input: SessionOpenWorkspaceInput) -> Result<SessionWorkspace> {
        let cwd = input.cwd.trim().to_string();
        if let Some(existing_id) = input.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from) {
            return self.reconnect_workspace_async(&existing_id, cwd, input).await;
        }
        self.create_workspace_async(cwd, input).await
    }

    async fn reconnect_workspace_async(&self, existing_id: &str, cwd: String, input: SessionOpenWorkspaceInput) -> Result<SessionWorkspace> {
        let mut session = self.session_async(existing_id).await.ok_or_else(|| missing_session(existing_id))?;
        if session.controller != SessionController::User {
            return Err(refused_session(t("server.session.workspace.notWorkspace", &[])));
        }
        if session.machine.is_none() && (cwd.is_empty() || !Path::new(&cwd).is_dir()) {
            return Err(invalid_input(t("server.session.workspace.badCwd", &[("cwd", cwd.into())])));
        }
        let snap = self.workspace_snapshot(&session.id);
        let next_meta = apply_workspace_input_updates(&mut session, snap, &input);
        if let Some(agent) = self.live_agent(&session.id) {
            apply_live_workspace_config_async(agent.as_ref(), &input).await?;
            self.set_workspace_meta_async(&session.id, next_meta).await;
            self.notify_workspace(&session.id);
            return Ok(self.workspace_reply_async(self.session_async(&session.id).await.unwrap_or(session)).await);
        }
        prepare_relaunch_session(&mut session, cwd, input, next_meta.permission_mode);
        let session = self.launch_workspace_agent_async(session, next_meta, true).await?;
        Ok(self.workspace_reply_async(session).await)
    }

    async fn create_workspace_async(&self, cwd: String, input: SessionOpenWorkspaceInput) -> Result<SessionWorkspace> {
        let runtime_id = input.runtime.trim();
        if runtime_id.is_empty() {
            return Err(invalid_input(t("server.session.workspace.runtimeRequired", &[])));
        }
        let drive = self
            .0
            .drivers
            .drive_runtime(runtime_id, input.model.as_deref(), input.effort.as_deref())
            .await?;
        if drive.is_local && (cwd.is_empty() || !Path::new(&cwd).is_dir()) {
            return Err(invalid_input(t("server.session.workspace.badCwd", &[("cwd", cwd.into())])));
        }
        let number = {
            let _write = self.0.write_lock.lock().await;
            self.0.ctx.service.next_seq("session", 0).await?
        };
        let id = format!("w{number}");
        let permission_mode = input.permission_mode.unwrap_or(SessionPermissionMode::AcceptEdits);
        let effective_effort = drive
            .effort
            .clone()
            .filter(|_| !drive.runtime.refused_options().contains(&RefusableOption::Effort));
        let title = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
        let repo_name = input.repo.filter(|r| !r.trim().is_empty());

        let mut session = Session::new(
            &id,
            SessionController::User,
            title.clone().unwrap_or_else(|| drive.name.clone()),
            drive.runtime_id.clone(),
            ExecutionPolicy::DirectCwd {
                repo: repo_name.clone(),
                permission_mode,
            },
            now(),
        );
        session.machine = (!drive.is_local).then(|| drive.machine_id.clone());
        session.brief = title.clone().unwrap_or_default();
        session.cwd = (!cwd.is_empty()).then(|| cwd.clone());
        session.phase = Phase::Resting(PhaseResting {});

        let meta = WorkspaceMeta {
            title,
            model: drive.model.clone(),
            effort: effective_effort.clone(),
            permission_mode,
        };
        let env = self.build_workspace_env(&id, &drive, repo_name.as_deref());
        let opts = SessionOptions {
            cwd: PathBuf::from(&cwd),
            model: drive.model.clone(),
            resume: None,
            permission_mode: to_oar_permission(permission_mode),
            env,
            record_to: Some(self.record_path(&id)),
            effort: effective_effort,
            ..Default::default()
        };
        let agent = drive.runtime.open(opts).await?;
        self.go_live_async(agent, session.clone(), None).await?;
        self.set_workspace_meta_async(&id, meta).await;
        self.notify_workspace(&id);
        Ok(self.workspace_reply_async(self.session_async(&id).await.unwrap_or(session)).await)
    }

    fn build_workspace_env(&self, id: &str, drive: &super::driver::Drive, repo_name: Option<&str>) -> Vec<(String, String)> {
        let mut env = drive.env.clone();
        if drive.is_local {
            return env;
        }
        let repo_ref = repo_name.map(|r| self.0.worktree.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
        let dispatch = crate::machine::RemoteDispatchMeta {
            session_id: Some(id.to_string()),
            repo_ref,
            branch: None,
            base_ref: None,
            mcp_session_token: Some(self.mcp_token_for(id)),
        };
        crate::machine::attach_dispatch_meta(&mut env, &dispatch);
        env
    }

    async fn set_workspace_meta_async(&self, session_id: &str, meta: WorkspaceMeta) {
        self.save_workspace_meta_async(session_id, &meta).await;
        let mut map = self.0.workspaces.lock();
        let ws = self.ensure_workspace_entry(&mut map, session_id);
        ws.meta = meta;
    }

    async fn launch_workspace_agent_async(&self, mut session: Session, mut meta: WorkspaceMeta, try_resume: bool) -> Result<Session> {
        let cwd = session.cwd.clone().unwrap_or_default();
        let runtime_target = match session.machine.as_deref() {
            Some(machine) if !machine.is_empty() => format!("{machine}/{}", session.runtime),
            _ => session.runtime.clone(),
        };
        let drive = self
            .0
            .drivers
            .drive_runtime(&runtime_target, meta.model.as_deref(), meta.effort.as_deref())
            .await?;
        if drive.is_local && (cwd.is_empty() || !Path::new(&cwd).is_dir()) {
            return Err(invalid_input(t("server.session.workspace.badCwd", &[("cwd", cwd.into())])));
        }
        meta.model = drive.model.clone();
        meta.effort = drive
            .effort
            .clone()
            .filter(|_| !drive.runtime.refused_options().contains(&RefusableOption::Effort));
        let resume = if try_resume && drive.runtime.capabilities().resume {
            self.extra(&session.id).agent_session
        } else {
            None
        };
        let mut env = drive.env.clone();
        if !drive.is_local {
            let repo_ref = session.repo_name().map(|r| self.0.worktree.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
            let dispatch = crate::machine::RemoteDispatchMeta {
                session_id: Some(session.id.clone()),
                repo_ref,
                branch: None,
                base_ref: None,
                mcp_session_token: Some(self.mcp_token_for(&session.id)),
            };
            crate::machine::attach_dispatch_meta(&mut env, &dispatch);
        }
        let opts = SessionOptions {
            cwd: PathBuf::from(&cwd),
            model: meta.model.clone(),
            resume,
            permission_mode: to_oar_permission(meta.permission_mode),
            env,
            record_to: Some(self.record_path(&session.id)),
            effort: meta.effort.clone(),
            ..Default::default()
        };
        let agent = drive.runtime.open(opts).await?;
        session.phase = Phase::Resting(PhaseResting {});
        self.go_live_async(agent, session.clone(), None).await?;
        self.set_workspace_meta_async(&session.id, meta).await;
        self.notify_workspace(&session.id);
        Ok(self.session_async(&session.id).await.unwrap_or(session))
    }

    /// Sends a user message to a user workspace session: starts a turn when idle,
    /// or steers/queues when a turn is already running.
    pub async fn send_workspace_async(&self, input: SessionSendInput, storage: Option<&Storage>) -> Result<Session> {
        self.send_workspace_with_trace_async(input, storage, None).await
    }

    pub async fn send_workspace_with_trace_async(&self, input: SessionSendInput, storage: Option<&Storage>, trace_id: Option<u64>) -> Result<Session> {
        let has_text = !input.text.trim().is_empty();
        let has_attachments = input.attachments.as_ref().is_some_and(|a| !a.is_empty());
        let has_context = input.context_files.as_ref().is_some_and(|f| !f.is_empty());
        if !has_text && !has_attachments && !has_context {
            return Err(invalid_input(t("server.session.workspace.emptyMessage", &[])));
        }
        let session = self.session_async(&input.id).await.ok_or_else(|| missing_session(&input.id))?;
        if session.controller != SessionController::User {
            return Err(refused_session(t("server.session.workspace.notWorkspace", &[])));
        }

        let cwd = session.cwd.as_deref().map(PathBuf::from).unwrap_or_default();
        let mut blocks = Vec::new();
        if has_text {
            blocks.push(ContentBlock::Text(input.text.clone()));
        }
        for file in input.context_files.unwrap_or_default() {
            let p = PathBuf::from(&file.path);
            let path = if p.is_absolute() || cwd.as_os_str().is_empty() { p } else { cwd.join(p) };
            let lines = match (file.start_line, file.end_line) {
                (Some(s), Some(e)) if s > 0 && e >= s => Some((s as u32, e as u32)),
                (Some(s), None) if s > 0 => Some((s as u32, s as u32)),
                _ => None,
            };
            blocks.push(ContentBlock::File { path, lines });
        }
        for att_id in input.attachments.unwrap_or_default() {
            if let Some(store) = storage {
                let file = store.file_async(&att_id).await.map_err(RuntimeError::Api)?;
                let path = PathBuf::from(file.path);
                if file.r#type.starts_with("image/") {
                    blocks.push(ContentBlock::Image { path });
                } else {
                    blocks.push(ContentBlock::File { path, lines: None });
                }
            } else {
                blocks.push(ContentBlock::File {
                    path: PathBuf::from(att_id),
                    lines: None,
                });
            }
        }

        let logged_text = if has_text {
            input.text.clone()
        } else {
            format!("[{} attachment(s)]", blocks.len())
        };
        let mail_key = format!("ws:{}:{}", session.id, uuid::Uuid::new_v4());
        let entry = self
            .0
            .ctx
            .service
            .session
            .enqueue_mailbox(&session.id, &mail_key, MailboxSource::WorkspaceUser, None, &logged_text, now())
            .await?;

        let agent = match self.live_agent(&session.id) {
            Some(agent) => agent,
            None => {
                let snap = self.workspace_snapshot(&session.id);
                let meta = WorkspaceMeta {
                    title: snap.title,
                    model: snap.model,
                    effort: snap.effort,
                    permission_mode: snap.permission_mode,
                };
                match self.launch_workspace_agent_async(session.clone(), meta, true).await {
                    Ok(_) => self
                        .live_agent(&session.id)
                        .ok_or_else(|| refused_session(t("server.session.workspace.notLive", &[])))?,
                    Err(e) => {
                        let _ = self.0.ctx.service.session.settle_mailbox(entry.id, false, Some(&e.to_string()), now()).await;
                        return Err(e);
                    }
                }
            }
        };

        if !self.0.ctx.service.session.claim_mailbox_by_key(&entry.idempotency_key, now()).await? {
            return Ok(self.session_async(&session.id).await.unwrap_or(session));
        }
        let settle_id = entry.id;

        let turn_opts = TurnOptions { trace_id };
        if session.phase.is_working() {
            self.record_async(&session.id, Step::Asked { text: logged_text }).await;
            let sent = match agent.steer(blocks.clone()).await {
                Ok(()) => Ok(()),
                Err(_) => agent.queue_with(blocks, turn_opts).await,
            };
            if let Err(e) = sent {
                let _ = self.0.ctx.service.session.settle_mailbox(settle_id, false, Some(&e.to_string()), now()).await;
                return Err(e.into());
            }
            let _ = self.0.ctx.service.session.settle_mailbox(settle_id, true, None, now()).await;
            return Ok(self.session_async(&session.id).await.unwrap_or(session));
        }

        let phase = Phase::working(now(), SessionAction::Thinking, "");
        let brief = session.brief.is_empty().then(|| vibevalley_core::text::clip(&logged_text, 120));
        self.persist_phase_change_async(&session.id, phase, brief, None).await?;
        self.record_async(&session.id, Step::Asked { text: logged_text }).await;
        if let Err(e) = agent.prompt_with(blocks, turn_opts).await {
            let _ = self.0.ctx.service.session.settle_mailbox(settle_id, false, Some(&e.to_string()), now()).await;
            let _ = self.persist_phase_change_async(&session.id, Phase::Failed(PhaseFailed {}), None, None).await;
            self.notify_workspace(&session.id);
            return Err(e.into());
        }
        let _ = self.0.ctx.service.session.settle_mailbox(settle_id, true, None, now()).await;
        self.notify_workspace(&session.id);
        Ok(self.session_async(&session.id).await.unwrap_or(session))
    }

    /// Answers a pending tool permission request on a live session.
    pub async fn respond_permission_async(&self, input: SessionRespondPermissionInput) -> Result<()> {
        let session = self.session_async(&input.id).await.ok_or_else(|| missing_session(&input.id))?;
        let agent = self
            .live_agent(&session.id)
            .ok_or_else(|| refused_session(t("server.session.workspace.notLive", &[])))?;
        let decision = match input.decision {
            SessionPermissionDecision::AllowOnce => PermissionDecision::AllowOnce,
            SessionPermissionDecision::AllowAlways => PermissionDecision::AllowAlways,
            SessionPermissionDecision::Deny => PermissionDecision::Deny { message: input.message },
        };
        agent.respond_permission(&input.request_id, decision).await?;
        self.on_workspace_permission_resolved(&session.id, &input.request_id);
        Ok(())
    }

    /// Answers a pending interactive question (`interaction_*`) on a live session.
    pub async fn respond_interaction_async(&self, input: SessionRespondInteractionInput) -> Result<()> {
        let session = self.session_async(&input.id).await.ok_or_else(|| missing_session(&input.id))?;
        let agent = self
            .live_agent(&session.id)
            .ok_or_else(|| refused_session(t("server.session.workspace.notLive", &[])))?;
        let decision = if input.cancelled == Some(true) {
            InteractionDecision::Cancel
        } else if let Some(text) = input.text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            InteractionDecision::Custom { text: text.to_string() }
        } else if let Some(option_id) = input.option_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            InteractionDecision::Select {
                option_id: option_id.to_string(),
            }
        } else {
            return Err(invalid_input(t("server.session.workspace.interactionDecisionRequired", &[])));
        };
        agent.respond_interaction(&input.request_id, decision).await?;
        self.on_workspace_interaction_resolved(&session.id, &input.request_id);
        Ok(())
    }

    /// Updates a user session's `model`, `effort`, and/or `permission_mode`.
    pub async fn set_workspace_config_async(&self, input: SessionSetConfigInput) -> Result<SessionWorkspace> {
        let mut session = self.session_async(&input.id).await.ok_or_else(|| missing_session(&input.id))?;
        if session.controller != SessionController::User {
            return Err(refused_session(t("server.session.workspace.notWorkspace", &[])));
        }
        let snap = self.workspace_snapshot(&session.id);
        let mut next = WorkspaceMeta {
            title: snap.title,
            model: snap.model,
            effort: snap.effort,
            permission_mode: snap.permission_mode,
        };
        let model_opt = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let effort_opt = input.effort.as_deref().map(str::trim).filter(|e| !e.is_empty());
        let model_changed = model_opt.is_some_and(|m| next.model.as_deref() != Some(m));
        if let Some(m) = model_opt {
            next.model = Some(m.to_string());
        }
        if let Some(e) = effort_opt {
            next.effort = Some(e.to_string());
        } else if model_changed {
            next.effort = None;
        }
        if let Some(p) = input.permission_mode {
            next.permission_mode = p;
        }
        if let Some(agent) = self.live_agent(&session.id) {
            match agent.set_config(model_opt, effort_opt, input.permission_mode.map(to_oar_permission)).await {
                Ok(()) | Err(AgentError::Unsupported { .. }) => {}
                Err(e) => return Err(e.into()),
            }
        }
        if let ExecutionPolicy::DirectCwd { repo, .. } = &session.policy {
            let next_policy = ExecutionPolicy::DirectCwd {
                repo: repo.clone(),
                permission_mode: next.permission_mode,
            };
            if session.policy != next_policy {
                session.policy = next_policy;
                let _ = self.persist_session_update_async(&session).await;
            }
        }
        self.set_workspace_meta_async(&session.id, next).await;
        self.notify_workspace(&session.id);
        Ok(self.workspace_reply_async(self.session_async(&session.id).await.unwrap_or(session)).await)
    }

    pub(super) async fn on_workspace_session_started_async(&self, session_id: &str, model: Option<String>) {
        let Some(model) = model.filter(|m| !m.trim().is_empty()) else { return };
        if !self.session_async(session_id).await.is_some_and(|s| s.controller == SessionController::User) {
            return;
        }
        let mut updated = None;
        {
            let mut map = self.0.workspaces.lock();
            let ws = self.ensure_workspace_entry(&mut map, session_id);
            if ws.meta.model.is_none() {
                ws.meta.model = Some(model);
                updated = Some(ws.meta.clone());
            }
        }
        if let Some(meta) = updated {
            self.save_workspace_meta_async(session_id, &meta).await;
            self.notify_workspace(session_id);
        }
    }

    /// Handles `EventKind::PermissionRequested` for a workspace session: auto-approves
    /// only when the workspace session's `permission_mode == Bypass`; otherwise records
    /// a pending permission card and wakes `session.watch` subscribers.
    pub(super) fn on_workspace_permission_requested(&self, session_id: &str, request_id: String, tool: String, input: serde_json::Value, summary: String) {
        let mode = self.workspace_snapshot(session_id).permission_mode;
        if mode == SessionPermissionMode::Bypass {
            if let Some(agent) = self.live_agent(session_id) {
                self.0.ctx.spawn("session.workspace.auto_allow", async move {
                    let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce).await;
                });
            }
            return;
        }
        let req = SessionPermissionRequest {
            request_id: request_id.clone(),
            tool,
            summary,
            input: clip_json_input(&input),
        };
        {
            let mut map = self.0.workspaces.lock();
            let ws = self.ensure_workspace_entry(&mut map, session_id);
            ws.pending_permissions.retain(|p| p.request_id != request_id);
            ws.pending_permissions.push(req);
        }
        self.notify_workspace(session_id);
    }

    pub(super) fn on_workspace_permission_resolved(&self, session_id: &str, request_id: &str) {
        let changed = {
            let mut map = self.0.workspaces.lock();
            if let Some(ws) = map.get_mut(session_id) {
                let before = ws.pending_permissions.len();
                ws.pending_permissions.retain(|p| p.request_id != request_id);
                ws.pending_permissions.len() != before
            } else {
                false
            }
        };
        if changed {
            self.notify_workspace(session_id);
        }
    }

    /// Handles `EventKind::InteractionRequested` for a workspace session.
    /// Interactive questions are NEVER auto-approved, even in `Bypass` mode.
    pub(super) fn on_workspace_interaction_requested(
        &self,
        session_id: &str,
        request_id: String,
        question: String,
        options: Vec<InteractionOption>,
        allow_custom: bool,
    ) {
        let req = SessionInteractionRequest {
            request_id: request_id.clone(),
            question,
            options: map_interaction_options(options),
            allow_custom,
        };
        {
            let mut map = self.0.workspaces.lock();
            let ws = self.ensure_workspace_entry(&mut map, session_id);
            ws.pending_interactions.retain(|i| i.request_id != request_id);
            ws.pending_interactions.push(req);
        }
        self.notify_workspace(session_id);
    }

    pub(super) fn on_workspace_interaction_resolved(&self, session_id: &str, request_id: &str) {
        let changed = {
            let mut map = self.0.workspaces.lock();
            if let Some(ws) = map.get_mut(session_id) {
                let before = ws.pending_interactions.len();
                ws.pending_interactions.retain(|i| i.request_id != request_id);
                ws.pending_interactions.len() != before
            } else {
                false
            }
        };
        if changed {
            self.notify_workspace(session_id);
        }
    }

    pub(super) fn on_workspace_turn_finished(&self, session_id: &str, usage: &Usage) {
        let tokens = super::journal::event_tokens_of(usage);
        {
            let mut map = self.0.workspaces.lock();
            let ws = self.ensure_workspace_entry(&mut map, session_id);
            ws.pending_permissions.clear();
            ws.pending_interactions.clear();
            if let Some(tokens) = tokens {
                ws.tokens = Some(tokens);
            }
        }
        self.notify_workspace(session_id);
    }

    pub(super) async fn finish_workspace_async(&self, session: &Session, reason: StopReason, spent: Option<Spent>, said: &str, failure: Option<&str>) {
        let outcome = match reason {
            StopReason::Aborted => Outcome::Interrupted,
            StopReason::Error | StopReason::MaxTurns => Outcome::Failed,
            StopReason::Completed => Outcome::Completed,
        };
        let summary = if outcome == Outcome::Failed {
            failure
                .map(|e| vibevalley_core::text::clip(e, 400))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Did not finish.".into())
        } else {
            let read = vibevalley_core::text::summary_of(said);
            if !read.is_empty() {
                vibevalley_core::text::clip(&read, 400)
            } else if outcome == Outcome::Completed {
                "Done.".into()
            } else {
                "Did not finish.".into()
            }
        };
        let _ = self.settle_report_async(session, outcome, summary, spent, None, None, None).await;
        self.notify_workspace(&session.id);
    }

    pub(super) async fn on_workspace_pump_exited_async(&self, session_id: &str) {
        let Some(session) = self.session_async(session_id).await.filter(|s| s.controller == SessionController::User) else {
            return;
        };
        let had_pending = {
            let mut map = self.0.workspaces.lock();
            if let Some(ws) = map.get_mut(session_id) {
                let any = !ws.pending_permissions.is_empty() || !ws.pending_interactions.is_empty();
                ws.pending_permissions.clear();
                ws.pending_interactions.clear();
                any
            } else {
                false
            }
        };
        if session.phase.is_working() {
            let _ = self.persist_phase_change_async(session_id, Phase::Resting(PhaseResting {}), None, None).await;
            self.notify_workspace(session_id);
        } else if had_pending {
            self.notify_workspace(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use vibevalley_protocol::{ContextRef, ExecutionPolicy, Outcome, Session, SessionController, SessionOpenWorkspaceInput, SessionSendInput};
    use vibevalley_runtime::oar::{
        Capabilities, ControlAction, ControlOutcome, ControlStatus, Event, Installation, ModelInfo, Registry, Runtime as OarRuntime, Session as OarSession,
        SessionOptions, SessionStatus, voyage,
    };

    use super::*;
    use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::runtime::session::{RuntimeDriver, SessionLifecycleEvent};
    use crate::runtime::worktree::Worktree;
    use crate::runtime::{RuntimeConfig, reopen_sessions_async};
    use crate::service::Service;

    struct StubSession {
        id: String,
        tx: mpsc::UnboundedSender<Event>,
        rx: parking_lot::Mutex<Option<mpsc::UnboundedReceiver<Event>>>,
        aborts: Arc<AtomicUsize>,
        disposes: Arc<AtomicUsize>,
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
        ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<ControlOutcome>> {
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

        fn prompt(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn steer(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn queue(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn abort(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
            self.aborts.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }

        fn respond_permission<'a>(&'a self, _: &'a str, _: PermissionDecision) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn dispose(&self) -> vibevalley_runtime::BoxFuture<'_, ()> {
            self.signal_dispose();
            Box::pin(async {})
        }

        fn signal_dispose(&self) {
            self.disposes.fetch_add(1, Ordering::SeqCst);
            let _ = self.tx.send(Event {
                seq: 0,
                at_ms: 0,
                agent_path: vec![],
                kind: vibevalley_runtime::oar::EventKind::SessionEnded,
            });
        }
    }

    struct StubRuntime {
        aborts: Arc<AtomicUsize>,
        disposes: Arc<AtomicUsize>,
    }

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

        fn installation(&self) -> vibevalley_runtime::BoxFuture<'_, Installation> {
            Box::pin(async {
                Installation::Available {
                    version: None,
                    path: PathBuf::from("/bin/true"),
                }
            })
        }

        fn list_models(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
            Box::pin(async { Ok(vec![]) })
        }

        fn open(&self, _: SessionOptions) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn OarSession>>> {
            let aborts = self.aborts.clone();
            let disposes = self.disposes.clone();
            Box::pin(async move {
                let (tx, rx) = mpsc::unbounded_channel();
                Ok(Arc::new(StubSession {
                    id: "stub-1".into(),
                    tx,
                    rx: parking_lot::Mutex::new(Some(rx)),
                    aborts,
                    disposes,
                }) as Arc<dyn OarSession>)
            })
        }
    }

    async fn test_context(dir: &Path) -> Arc<Context> {
        let service = Service::open(dir).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ))
    }

    #[tokio::test]
    async fn sqlite_session_config_persists_without_workspace_json_files() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_context(dir.path()).await;
        let _opened = reopen_sessions_async(&ctx).await.unwrap();
        let config = Arc::new(RuntimeConfig::under(dir.path()));
        let worktree = Arc::new(Worktree::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
        let mut registry = Registry::new();
        registry.register(Arc::new(StubRuntime {
            aborts: Arc::new(AtomicUsize::new(0)),
            disposes: Arc::new(AtomicUsize::new(0)),
        }));
        let drivers = Arc::new(RuntimeDriver {
            registry: Arc::new(registry),
            model: None,
        });
        let sessions = SessionEngine::new_async(ctx.clone(), Arc::new(tokio::sync::Mutex::new(())), drivers, worktree, config.clone(), None)
            .await
            .unwrap();

        let session = Session::new(
            "u1",
            SessionController::User,
            "Refactor",
            "stub",
            ExecutionPolicy::DirectCwd {
                repo: None,
                permission_mode: SessionPermissionMode::AcceptEdits,
            },
            now(),
        );
        sessions.persist_session_update_async(&session).await.unwrap();
        assert_eq!(
            sessions.load_workspace_meta_async("u1").await.permission_mode,
            SessionPermissionMode::AcceptEdits
        );

        let meta = WorkspaceMeta {
            title: Some("Refactor".into()),
            model: Some("claude-sonnet".into()),
            effort: Some("high".into()),
            permission_mode: SessionPermissionMode::ReadOnly,
        };
        sessions.save_workspace_meta_async("u1", &meta).await;
        let loaded = sessions.load_workspace_meta_async("u1").await;
        assert_eq!(loaded.title.as_deref(), Some("Refactor"));
        assert_eq!(loaded.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(loaded.effort.as_deref(), Some("high"));
        assert_eq!(loaded.permission_mode, SessionPermissionMode::ReadOnly);
        assert!(!config.data_dir.join("workspace/u1.json").exists());
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        ctx.service.close().await;
    }

    #[tokio::test]
    async fn close_workspace_aborts_disposes_ends_turn_preserves_dir_and_emits_session_left() {
        let dir = tempfile::tempdir().unwrap();
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();
        let sentinel = project_dir.join("keep.txt");
        std::fs::write(&sentinel, "precious").unwrap();

        let ctx = test_context(dir.path()).await;
        let _opened = reopen_sessions_async(&ctx).await.unwrap();
        let config = Arc::new(RuntimeConfig::under(dir.path()));
        let worktree = Arc::new(Worktree::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));

        let aborts = Arc::new(AtomicUsize::new(0));
        let disposes = Arc::new(AtomicUsize::new(0));
        let mut registry = Registry::new();
        registry.register(Arc::new(StubRuntime {
            aborts: aborts.clone(),
            disposes: disposes.clone(),
        }));
        let drivers = Arc::new(RuntimeDriver {
            registry: Arc::new(registry),
            model: None,
        });
        let sessions = SessionEngine::new_async(ctx.clone(), Arc::new(tokio::sync::Mutex::new(())), drivers, worktree, config.clone(), None)
            .await
            .unwrap();
        let mut events_rx = sessions.subscribe_events();

        let opened = sessions
            .open_workspace_async(SessionOpenWorkspaceInput {
                runtime: "stub".into(),
                cwd: project_dir.to_string_lossy().into_owned(),
                repo: None,
                model: None,
                effort: None,
                permission_mode: None,
                title: Some("Chat tab".into()),
                session_id: None,
            })
            .await
            .unwrap();
        let sid = opened.id.clone();
        assert!(sessions.is_live(&sid));
        assert!(!config.data_dir.join("workspace").exists());
        assert_eq!(sessions.session_async(&sid).await.unwrap().controller, SessionController::User);
        assert!(sessions.session_async(&sid).await.unwrap().is_free_user());

        sessions
            .send_workspace_async(
                SessionSendInput {
                    id: sid.clone(),
                    text: "investigate".into(),
                    attachments: None,
                    context_files: None,
                },
                None,
            )
            .await
            .unwrap();
        assert!(sessions.session_async(&sid).await.unwrap().phase.is_working());
        assert_eq!(sessions.mailbox_entries_async(&sid).await.unwrap().len(), 1);

        let mut issue_session = Session::new("w-issue", SessionController::IssueBoard, "worker", "stub", ExecutionPolicy::SandboxDir, now());
        issue_session.attach_binding(ContextRef::Issue {
            id: "i1".into(),
            refining: None,
        });
        sessions.persist_session_update_async(&issue_session).await.unwrap();

        sessions.close_workspace_async("w-issue").await;
        assert!(sessions.session_async("w-issue").await.is_some(), "non-user session must not be closed");

        sessions.close_workspace_async(&sid).await;
        assert_eq!(aborts.load(Ordering::SeqCst), 1);
        assert_eq!(disposes.load(Ordering::SeqCst), 1);
        assert!(!sessions.is_live(&sid));
        assert!(sessions.session_async(&sid).await.is_none());
        assert!(!sessions.0.workspaces.lock().contains_key(&sid));
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "precious");

        let past = sessions.past_session_async(&sid).await.expect("closed session archived in DB");
        assert_eq!(past.last_run.as_ref().map(|r| r.outcome), Some(Outcome::Interrupted));
        assert!(ctx.feed.seq() > 0);
        let mut saw_left = false;
        while let Ok(ev) = events_rx.try_recv() {
            if matches!(ev, SessionLifecycleEvent::Left { ref id, .. } if id == &sid) {
                saw_left = true;
            }
        }
        assert!(saw_left, "closing a workspace session must emit SessionLifecycleEvent::Left");
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        ctx.service.close().await;
    }

    #[test]
    fn workspace_input_updates_clear_effort_when_model_changes_without_new_effort() {
        let mut session = Session::new(
            "w1",
            SessionController::User,
            "Old",
            "claude",
            ExecutionPolicy::DirectCwd {
                repo: None,
                permission_mode: SessionPermissionMode::AcceptEdits,
            },
            0,
        );
        let snap = WorkspaceSnapshot {
            title: None,
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            permission_mode: SessionPermissionMode::AcceptEdits,
            pending_permissions: vec![],
            pending_interactions: vec![],
            tokens: None,
        };
        let input = SessionOpenWorkspaceInput {
            runtime: "claude".into(),
            cwd: "/tmp".into(),
            repo: None,
            model: Some("opus".into()),
            effort: None,
            permission_mode: Some(SessionPermissionMode::ReadOnly),
            title: Some("  New title  ".into()),
            session_id: Some("w1".into()),
        };
        let next = apply_workspace_input_updates(&mut session, snap, &input);
        assert_eq!(next.model.as_deref(), Some("opus"));
        assert_eq!(next.effort, None);
        assert_eq!(next.permission_mode, SessionPermissionMode::ReadOnly);
        assert_eq!(next.title.as_deref(), Some("New title"));
        assert_eq!(session.name, "New title");
        assert_eq!(session.brief, "New title");
    }
}
