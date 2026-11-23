//! Direct user workspace chat sessions (`session.openWorkspace`, `session.send`,
//! `session.respondPermission`, `session.respondInteraction`,
//! `session.setConfig`): a `Session` with `SessionController::User` and
//! `ExecutionPolicy::DirectCwd`, reusing `Sessions::go_live`, `pump()`, and `Trajectories`.

use std::path::{Path, PathBuf};

use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, EventTokens, ExecutionPolicy, Fact, FactSessionPhaseChanged, FactSessionReported, Outcome, Phase, PhaseFailed, PhaseResting, Session,
    SessionAction, SessionChildStep, SessionChildToolCall, SessionChildTranscript, SessionChildTranscriptInput, SessionController, SessionInteractionOption,
    SessionInteractionRequest, SessionOpenWorkspaceInput, SessionPermissionDecision, SessionPermissionMode, SessionPermissionRequest,
    SessionRespondInteractionInput, SessionRespondPermissionInput, SessionSendInput, SessionSetConfigInput, SessionSwarmMember, SessionSwarmMemberState,
    SessionSwarmMessage, SessionSwarmOverview, SessionSwarmRole, SessionSwarmState, SessionSwarmThread, SessionWorkspace, Spent,
};
use vibevalley_runtime::oar::{
    AgentError, ContentBlock, InteractionDecision, InteractionOption, PermissionDecision, PermissionMode, RefusableOption, SessionOptions, StopReason,
    SwarmMemberState, TurnOptions, Usage,
};

use super::db::SessionConfig;
use super::mailbox::{MailboxSource, SessionMailbox};
use super::sessions::Sessions;
use crate::base::{LookIn, missing};
use crate::modules::content::attachment::Attachments;
use crate::modules::work::ledger::{BoardError, Result, Step, now};

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
    pub watchers: Vec<flume::Sender<()>>,
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

fn missing_session(id: &str) -> BoardError {
    BoardError::Api(missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session))
}

fn invalid_input(message: String) -> BoardError {
    BoardError::Api(ApiError::new(BizCode::InvalidInput, message))
}

fn refused_session(message: String) -> BoardError {
    BoardError::Api(ApiError::new(BizCode::SessionRefused, message))
}

impl Sessions {
    fn load_workspace_meta(&self, session_id: &str) -> WorkspaceMeta {
        match self.0.ledger.database(|db| super::db::config(db, session_id)) {
            Ok(Some(cfg)) => WorkspaceMeta::from(cfg),
            Ok(None) => WorkspaceMeta::default(),
            Err(e) => {
                eprintln!("vibevalley: reading session config {session_id}: {e}");
                WorkspaceMeta::default()
            }
        }
    }

    fn save_workspace_meta(&self, session_id: &str, meta: &WorkspaceMeta) {
        let cfg = SessionConfig {
            title: meta.title.clone(),
            model: meta.model.clone(),
            effort: meta.effort.clone(),
            permission_mode: Some(meta.permission_mode),
        };
        if let Err(e) = self.0.ledger.database(|db| super::db::put_config(db, session_id, &cfg)) {
            eprintln!("vibevalley: saving session config {session_id}: {e}");
        }
    }

    pub(super) fn remove_workspace_meta(&self, session_id: &str) {
        self.0.workspaces.lock().remove(session_id);
    }

    /// Aborts and disposes a user session when its tab closes, ending
    /// any running turn as interrupted without touching the project directory.
    pub fn close_workspace(&self, session_id: &str) {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return;
        }
        let existing = self.session(session_id);
        if existing.as_ref().is_some_and(|s| s.controller != SessionController::User) {
            return;
        }
        if let Some(session) = existing.as_ref().filter(|s| s.phase.is_working()) {
            if let Err(e) = self.end_run(session_id, Outcome::Interrupted, "", None) {
                eprintln!("vibevalley: ending workspace run {session_id}: {e}");
            }
            self.finish_workspace(session, StopReason::Aborted, None, "", None);
        }
        if let Err(e) = self.dismiss(session_id, crate::modules::work::workplace::Leave::Keep) {
            eprintln!("vibevalley: closing workspace session {session_id}: {e}");
            self.remove_workspace_meta(session_id);
        }
    }

    fn ensure_workspace_entry<'a>(&self, map: &'a mut std::collections::HashMap<String, WorkspaceState>, session_id: &str) -> &'a mut WorkspaceState {
        map.entry(session_id.to_string()).or_insert_with(|| WorkspaceState {
            meta: self.load_workspace_meta(session_id),
            ..WorkspaceState::default()
        })
    }

    pub(super) fn notify_workspace(&self, session_id: &str) {
        let mut map = self.0.workspaces.lock();
        let Some(ws) = map.get_mut(session_id) else { return };
        ws.watchers.retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
    }

    /// Subscribes to out-of-band workspace state changes (pending permissions,
    /// pending interactions, live config, and latest token telemetry).
    pub fn watch_workspace(&self, session_id: &str) -> flume::Receiver<()> {
        let (tx, rx) = flume::bounded(1);
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
    pub fn read_child_transcript(&self, input: SessionChildTranscriptInput) -> Result<SessionChildTranscript> {
        let session = self.session(&input.id).ok_or_else(|| missing_session(&input.id))?;
        let conversation_id = input.conversation_id.trim();
        if conversation_id.is_empty()
            || conversation_id.contains("..")
            || conversation_id.contains('/')
            || conversation_id.contains('\\')
            || conversation_id.contains('\0')
        {
            return Err(invalid_input("invalid conversationId".into()));
        }
        let limit = input.limit.unwrap_or(30).clamp(1, 30) as usize;
        let steps = match self.live_agent(&session.id) {
            Some(agent) => agent
                .read_child_transcript(conversation_id, limit)
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
            conversation_id: conversation_id.to_string(),
            steps,
        })
    }

    /// Reads the live runtime session title (persisting changes to workspace meta),
    /// falling back to the persisted workspace title.
    pub fn session_title(&self, session_id: &str) -> Option<String> {
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
            self.save_workspace_meta(session_id, &meta);
        }
        resolved
    }

    fn workspace_reply(&self, session: Session) -> SessionWorkspace {
        let title = self.session_title(&session.id);
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
    pub fn open_workspace(&self, input: SessionOpenWorkspaceInput) -> Result<SessionWorkspace> {
        let cwd = input.cwd.trim().to_string();
        if let Some(existing_id) = input.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let mut session = self.session(existing_id).ok_or_else(|| missing_session(existing_id))?;
            if session.controller != SessionController::User {
                return Err(refused_session(t("server.session.workspace.notWorkspace", &[])));
            }
            if session.machine.is_none() && (cwd.is_empty() || !Path::new(&cwd).is_dir()) {
                return Err(invalid_input(t("server.session.workspace.badCwd", &[("cwd", cwd.into())])));
            }
            let mut meta = self.workspace_snapshot(&session.id);
            let model_opt = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
            let effort_opt = input.effort.as_deref().map(str::trim).filter(|e| !e.is_empty());
            let model_changed = model_opt.is_some_and(|m| meta.model.as_deref() != Some(m));
            if let Some(m) = model_opt {
                meta.model = Some(m.to_string());
            }
            if let Some(e) = effort_opt {
                meta.effort = Some(e.to_string());
            } else if model_changed {
                meta.effort = None;
            }
            if let Some(p) = input.permission_mode {
                meta.permission_mode = p;
            }
            if let Some(title) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                meta.title = Some(title.to_string());
                session.name = title.to_string();
                if session.brief.is_empty() {
                    session.brief = title.to_string();
                }
            }
            if let Some(agent) = self.live_agent(&session.id) {
                if input.model.is_some() || input.effort.is_some() || input.permission_mode.is_some() {
                    match agent.set_config(input.model.as_deref(), input.effort.as_deref(), input.permission_mode.map(to_oar_permission)) {
                        Ok(()) | Err(AgentError::Unsupported { .. }) => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                let next_meta = WorkspaceMeta {
                    title: meta.title,
                    model: meta.model,
                    effort: meta.effort,
                    permission_mode: meta.permission_mode,
                };
                self.set_workspace_meta(&session.id, next_meta);
                self.notify_workspace(&session.id);
                return Ok(self.workspace_reply(self.session(&session.id).unwrap_or(session)));
            }
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
                permission_mode: meta.permission_mode,
            };
            let next_meta = WorkspaceMeta {
                title: meta.title,
                model: meta.model,
                effort: meta.effort,
                permission_mode: meta.permission_mode,
            };
            let session = self.launch_workspace_agent(session, next_meta, true)?;
            return Ok(self.workspace_reply(session));
        }

        let runtime_id = input.runtime.trim();
        if runtime_id.is_empty() {
            return Err(invalid_input(t("server.session.workspace.runtimeRequired", &[])));
        }
        let drive = self.0.drivers.drive_runtime(runtime_id, input.model.as_deref(), input.effort.as_deref())?;
        if drive.is_local && (cwd.is_empty() || !Path::new(&cwd).is_dir()) {
            return Err(invalid_input(t("server.session.workspace.badCwd", &[("cwd", cwd.into())])));
        }
        let number = self.0.ledger.next("session", 0)?;
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

        let mut env = drive.env.clone();
        if !drive.is_local {
            let repo_ref = repo_name
                .as_deref()
                .map(|r| self.0.workplaces.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
            let dispatch = crate::modules::infra::machine::RemoteDispatchMeta {
                session_id: Some(id.clone()),
                repo_ref,
                branch: None,
                base_ref: None,
                mcp_session_token: Some(self.mcp_token_for(&id)),
            };
            crate::modules::infra::machine::attach_dispatch_meta(&mut env, &dispatch);
        }

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
        let agent = drive.runtime.open(opts)?;
        self.go_live(agent, session.clone(), None)?;
        self.set_workspace_meta(&id, meta);
        self.notify_workspace(&id);
        Ok(self.workspace_reply(self.session(&id).unwrap_or(session)))
    }

    fn set_workspace_meta(&self, session_id: &str, meta: WorkspaceMeta) {
        self.save_workspace_meta(session_id, &meta);
        let mut map = self.0.workspaces.lock();
        let ws = self.ensure_workspace_entry(&mut map, session_id);
        ws.meta = meta;
    }

    fn launch_workspace_agent(&self, mut session: Session, mut meta: WorkspaceMeta, try_resume: bool) -> Result<Session> {
        let cwd = session.cwd.clone().unwrap_or_default();
        let runtime_target = match session.machine.as_deref() {
            Some(machine) if !machine.is_empty() => format!("{machine}/{}", session.runtime),
            _ => session.runtime.clone(),
        };
        let drive = self.0.drivers.drive_runtime(&runtime_target, meta.model.as_deref(), meta.effort.as_deref())?;
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
            let repo_ref = session
                .repo_name()
                .map(|r| self.0.workplaces.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
            let dispatch = crate::modules::infra::machine::RemoteDispatchMeta {
                session_id: Some(session.id.clone()),
                repo_ref,
                branch: None,
                base_ref: None,
                mcp_session_token: Some(self.mcp_token_for(&session.id)),
            };
            crate::modules::infra::machine::attach_dispatch_meta(&mut env, &dispatch);
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
        let agent = drive.runtime.open(opts)?;
        session.phase = Phase::Resting(PhaseResting {});
        self.go_live(agent, session.clone(), None)?;
        self.set_workspace_meta(&session.id, meta);
        self.notify_workspace(&session.id);
        Ok(self.session(&session.id).unwrap_or(session))
    }

    /// Sends a user message to a user workspace session: starts a turn when idle,
    /// or steers/queues when a turn is already running.
    pub fn send_workspace(&self, input: SessionSendInput, attachments: Option<&Attachments>) -> Result<Session> {
        self.send_workspace_with_trace(input, attachments, None)
    }

    pub fn send_workspace_with_trace(&self, input: SessionSendInput, attachments: Option<&Attachments>, trace_id: Option<u64>) -> Result<Session> {
        let has_text = !input.text.trim().is_empty();
        let has_attachments = input.attachments.as_ref().is_some_and(|a| !a.is_empty());
        let has_context = input.context_files.as_ref().is_some_and(|f| !f.is_empty());
        if !has_text && !has_attachments && !has_context {
            return Err(invalid_input(t("server.session.workspace.emptyMessage", &[])));
        }
        let session = self.session(&input.id).ok_or_else(|| missing_session(&input.id))?;
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
            if let Some(store) = attachments {
                let file = store.file(&att_id).map_err(BoardError::Api)?;
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
            .ledger
            .database(|db| SessionMailbox::enqueue(db, &session.id, &mail_key, MailboxSource::WorkspaceUser, None, &logged_text, now()))?;

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
                match self.launch_workspace_agent(session.clone(), meta, true) {
                    Ok(_) => self
                        .live_agent(&session.id)
                        .ok_or_else(|| refused_session(t("server.session.workspace.notLive", &[])))?,
                    Err(e) => {
                        let _ = self
                            .0
                            .ledger
                            .database(|db| SessionMailbox::settle(db, entry.id, false, Some(&e.to_string()), now()));
                        return Err(e);
                    }
                }
            }
        };

        if !self.0.ledger.database(|db| SessionMailbox::claim_by_key(db, &mail_key, now()))? {
            return Ok(self.session(&session.id).unwrap_or(session));
        }
        let settle_id = entry.id;

        let turn_opts = TurnOptions { trace_id };
        if session.phase.is_working() {
            self.record(&session.id, Step::Asked { text: logged_text });
            let sent = match agent.steer(blocks.clone()) {
                Ok(()) => Ok(()),
                Err(_) => agent.queue_with(blocks, turn_opts),
            };
            if let Err(e) = sent {
                let _ = self
                    .0
                    .ledger
                    .database(|db| SessionMailbox::settle(db, settle_id, false, Some(&e.to_string()), now()));
                return Err(e.into());
            }
            let _ = self.0.ledger.database(|db| SessionMailbox::settle(db, settle_id, true, None, now()));
            return Ok(self.session(&session.id).unwrap_or(session));
        }

        let phase = Phase::working(now(), SessionAction::Thinking, "");
        let brief = session.brief.is_empty().then(|| vibevalley_core::text::clip(&logged_text, 120));
        self.0.ledger.apply(vec![Fact::SessionPhaseChanged(FactSessionPhaseChanged {
            at: now(),
            id: session.id.clone(),
            phase,
            channel: session.channel_id().map(str::to_string),
            spent: None,
            brief,
        })])?;
        self.record(&session.id, Step::Asked { text: logged_text });
        if let Err(e) = agent.prompt_with(blocks, turn_opts) {
            let _ = self
                .0
                .ledger
                .database(|db| SessionMailbox::settle(db, settle_id, false, Some(&e.to_string()), now()));
            let _ = self.0.ledger.apply(vec![self.phase_changed(session.id.clone(), Phase::Failed(PhaseFailed {}))]);
            self.notify_workspace(&session.id);
            return Err(e.into());
        }
        let _ = self.0.ledger.database(|db| SessionMailbox::settle(db, settle_id, true, None, now()));
        self.notify_workspace(&session.id);
        Ok(self.session(&session.id).unwrap_or(session))
    }

    /// Answers a pending tool permission request on a live session.
    pub fn respond_permission(&self, input: SessionRespondPermissionInput) -> Result<()> {
        let session = self.session(&input.id).ok_or_else(|| missing_session(&input.id))?;
        let agent = self
            .live_agent(&session.id)
            .ok_or_else(|| refused_session(t("server.session.workspace.notLive", &[])))?;
        let decision = match input.decision {
            SessionPermissionDecision::AllowOnce => PermissionDecision::AllowOnce,
            SessionPermissionDecision::AllowAlways => PermissionDecision::AllowAlways,
            SessionPermissionDecision::Deny => PermissionDecision::Deny { message: input.message },
        };
        agent.respond_permission(&input.request_id, decision)?;
        self.on_workspace_permission_resolved(&session.id, &input.request_id);
        Ok(())
    }

    /// Answers a pending interactive question (`interaction_*`) on a live session.
    pub fn respond_interaction(&self, input: SessionRespondInteractionInput) -> Result<()> {
        let session = self.session(&input.id).ok_or_else(|| missing_session(&input.id))?;
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
        agent.respond_interaction(&input.request_id, decision)?;
        self.on_workspace_interaction_resolved(&session.id, &input.request_id);
        Ok(())
    }

    /// Updates a user session's `model`, `effort`, and/or `permission_mode`.
    pub fn set_workspace_config(&self, input: SessionSetConfigInput) -> Result<SessionWorkspace> {
        let mut session = self.session(&input.id).ok_or_else(|| missing_session(&input.id))?;
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
            match agent.set_config(model_opt, effort_opt, input.permission_mode.map(to_oar_permission)) {
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
                let _ = self.0.ledger.apply(vec![Fact::session_changed(now(), session.clone())]);
            }
        }
        self.set_workspace_meta(&session.id, next);
        self.notify_workspace(&session.id);
        Ok(self.workspace_reply(self.session(&session.id).unwrap_or(session)))
    }

    pub(super) fn on_workspace_session_started(&self, session_id: &str, model: Option<String>) {
        let Some(model) = model.filter(|m| !m.trim().is_empty()) else { return };
        if !self.session(session_id).is_some_and(|s| s.controller == SessionController::User) {
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
            self.save_workspace_meta(session_id, &meta);
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
                let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce);
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
        if !self.session(session_id).is_some_and(|s| s.controller == SessionController::User) {
            return;
        }
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

    pub(super) fn finish_workspace(&self, session: &Session, reason: StopReason, spent: Option<Spent>, said: &str, failure: Option<&str>) {
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
        let _ = self.0.ledger.apply(vec![Fact::SessionReported(FactSessionReported {
            at: now(),
            id: session.id.clone(),
            run: None,
            outcome,
            phase: None,
            summary,
            runs: session.runs + 1,
            spent,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);
        self.notify_workspace(&session.id);
    }

    pub(super) fn on_workspace_pump_exited(&self, session_id: &str) {
        let Some(session) = self.session(session_id).filter(|s| s.controller == SessionController::User) else {
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
            let _ = self.0.ledger.apply(vec![self.phase_changed(session_id, Phase::Resting(PhaseResting {}))]);
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

    use parking_lot::Mutex;
    use vibevalley_core::Applied;
    use vibevalley_protocol::{
        ContextRef, ExecutionPolicy, Fact, Outcome, Session, SessionController, SessionOpenWorkspaceInput, SessionSendInput, SliceBundle, SpaceState,
    };
    use vibevalley_runtime::oar::{
        Capabilities, ControlAction, ControlOutcome, ControlStatus, Event, Installation, ModelInfo, Registry, Runtime, Session as OarSession, SessionOptions,
        SessionStatus, voyage,
    };

    use super::*;
    use crate::modules::work::ledger::{BoardConfig, Facts, Ledger, LocalFacts};
    use crate::modules::work::session::RuntimeDrivers;
    use crate::modules::work::workplace::Workplace;

    #[derive(Default)]
    struct RecordingFacts {
        inner: LocalFacts,
        applied: Mutex<Vec<Fact>>,
    }

    impl Facts for RecordingFacts {
        fn apply(&self, facts: Vec<Fact>) -> Applied {
            self.applied.lock().extend(facts.iter().cloned());
            self.inner.apply(facts)
        }

        fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
            self.inner.read(f);
        }

        fn bundle(&self) -> SliceBundle {
            self.inner.bundle()
        }
    }

    struct StubSession {
        id: String,
        tx: flume::Sender<Event>,
        rx: flume::Receiver<Event>,
        aborts: Arc<AtomicUsize>,
        disposes: Arc<AtomicUsize>,
    }

    impl OarSession for StubSession {
        fn id(&self) -> String {
            self.id.clone()
        }

        fn control(&self, action: ControlAction, _: &str, input_id: &str, span_id: &str) -> vibevalley_runtime::oar::Result<ControlOutcome> {
            Ok(ControlOutcome {
                action,
                status: ControlStatus::Accepted,
                code: String::new(),
                reason: String::new(),
                span_id: span_id.into(),
                input_id: input_id.into(),
            })
        }

        fn records(&self) -> Vec<voyage::Record> {
            vec![]
        }

        fn subscribe_records(&self, _: Option<u64>) -> flume::Receiver<voyage::Record> {
            let (_tx, rx) = flume::bounded(1);
            rx
        }

        fn runtime_id(&self) -> &str {
            "stub"
        }

        fn status(&self) -> SessionStatus {
            SessionStatus::Idle
        }

        fn events(&self) -> flume::Receiver<Event> {
            self.rx.clone()
        }

        fn prompt(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn steer(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn queue(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn abort(&self) -> vibevalley_runtime::oar::Result<()> {
            self.aborts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn respond_permission(&self, _: &str, _: PermissionDecision) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn dispose(&self) {
            self.disposes.fetch_add(1, Ordering::SeqCst);
            let _ = self.tx.try_send(Event {
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

    impl Runtime for StubRuntime {
        fn id(&self) -> &str {
            "stub"
        }

        fn display_name(&self) -> &str {
            "Stub"
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn installation(&self) -> Installation {
            Installation::Available {
                version: None,
                path: PathBuf::from("/bin/true"),
            }
        }

        fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
            Ok(vec![])
        }

        fn open(&self, _: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn OarSession>> {
            let (tx, rx) = flume::unbounded();
            Ok(Arc::new(StubSession {
                id: "stub-1".into(),
                tx,
                rx,
                aborts: self.aborts.clone(),
                disposes: self.disposes.clone(),
            }))
        }
    }

    struct NoopIssueStore;
    impl crate::modules::work::ledger::IssueStore for NoopIssueStore {
        fn all(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>) -> sqlx::Result<Vec<vibevalley_protocol::Issue>> {
            Ok(vec![])
        }
        fn put(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>, _issue: &vibevalley_protocol::Issue) -> sqlx::Result<()> {
            Ok(())
        }
        fn remove(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>, _id: &str) -> sqlx::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn sqlite_session_config_persists_without_workspace_json_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::base::ServerDb::open(dir.path()).unwrap();
        let facts = Arc::new(RecordingFacts::default());
        let (ledger, _) = Ledger::open(db.clone(), facts, Arc::new(NoopIssueStore), Arc::new(super::super::db::SqliteSessionStore)).unwrap();
        let durable = db.durable().unwrap();
        let config = Arc::new(BoardConfig::under(dir.path()));
        let workplaces = Arc::new(Workplace::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
        let mut registry = Registry::new();
        registry.register(Arc::new(StubRuntime {
            aborts: Arc::new(AtomicUsize::new(0)),
            disposes: Arc::new(AtomicUsize::new(0)),
        }));
        let drivers = Arc::new(RuntimeDrivers {
            registry: Arc::new(registry),
            model: None,
        });
        let sessions = Sessions::new(durable, Arc::new(ledger), drivers, workplaces, config.clone(), None).unwrap();

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
        sessions.0.ledger.apply(vec![Fact::session_changed(now(), session)]).unwrap();
        assert_eq!(sessions.load_workspace_meta("u1").permission_mode, SessionPermissionMode::AcceptEdits);

        let meta = WorkspaceMeta {
            title: Some("Refactor".into()),
            model: Some("claude-sonnet".into()),
            effort: Some("high".into()),
            permission_mode: SessionPermissionMode::ReadOnly,
        };
        sessions.save_workspace_meta("u1", &meta);
        let loaded = sessions.load_workspace_meta("u1");
        assert_eq!(loaded.title.as_deref(), Some("Refactor"));
        assert_eq!(loaded.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(loaded.effort.as_deref(), Some("high"));
        assert_eq!(loaded.permission_mode, SessionPermissionMode::ReadOnly);
        assert!(!config.data_dir.join("workspace/u1.json").exists());
    }

    #[test]
    fn close_workspace_aborts_disposes_ends_turn_preserves_dir_and_emits_session_left() {
        let dir = tempfile::tempdir().unwrap();
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();
        let sentinel = project_dir.join("keep.txt");
        std::fs::write(&sentinel, "precious").unwrap();

        let db = crate::base::ServerDb::open(dir.path()).unwrap();
        let facts = Arc::new(RecordingFacts::default());
        let (ledger, _) = Ledger::open(
            db.clone(),
            facts.clone(),
            Arc::new(NoopIssueStore),
            Arc::new(super::super::db::SqliteSessionStore),
        )
        .unwrap();
        let durable = db.durable().unwrap();
        let config = Arc::new(BoardConfig::under(dir.path()));
        let workplaces = Arc::new(Workplace::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));

        let aborts = Arc::new(AtomicUsize::new(0));
        let disposes = Arc::new(AtomicUsize::new(0));
        let mut registry = Registry::new();
        registry.register(Arc::new(StubRuntime {
            aborts: aborts.clone(),
            disposes: disposes.clone(),
        }));
        let drivers = Arc::new(RuntimeDrivers {
            registry: Arc::new(registry),
            model: None,
        });
        let sessions = Sessions::new(durable, Arc::new(ledger), drivers, workplaces, config.clone(), None).unwrap();

        let opened = sessions
            .open_workspace(SessionOpenWorkspaceInput {
                runtime: "stub".into(),
                cwd: project_dir.to_string_lossy().into_owned(),
                repo: None,
                model: None,
                effort: None,
                permission_mode: None,
                title: Some("Chat tab".into()),
                session_id: None,
            })
            .unwrap();
        let sid = opened.id.clone();
        assert!(sessions.is_live(&sid));
        assert!(!config.data_dir.join("workspace").exists());
        assert_eq!(sessions.session(&sid).unwrap().controller, SessionController::User);
        assert!(sessions.session(&sid).unwrap().is_free_user());

        sessions
            .send_workspace(
                SessionSendInput {
                    id: sid.clone(),
                    text: "investigate".into(),
                    attachments: None,
                    context_files: None,
                },
                None,
            )
            .unwrap();
        assert!(sessions.session(&sid).unwrap().phase.is_working());
        assert_eq!(sessions.mailbox_entries(&sid).unwrap().len(), 1);

        let mut issue_session = Session::new("w-issue", SessionController::IssueBoard, "worker", "stub", ExecutionPolicy::SandboxDir, now());
        issue_session.attach_binding(ContextRef::Issue {
            id: "i1".into(),
            refining: None,
        });
        sessions.0.ledger.apply(vec![Fact::session_changed(now(), issue_session)]).unwrap();

        sessions.close_workspace("w-issue");
        assert!(sessions.session("w-issue").is_some(), "non-user session must not be closed");

        sessions.close_workspace(&sid);
        assert_eq!(aborts.load(Ordering::SeqCst), 1);
        assert_eq!(disposes.load(Ordering::SeqCst), 1);
        assert!(!sessions.is_live(&sid));
        assert!(sessions.session(&sid).is_none());
        assert!(!sessions.0.workspaces.lock().contains_key(&sid));
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "precious");

        let applied = facts.applied.lock();
        assert!(
            applied
                .iter()
                .any(|f| matches!(f, Fact::SessionReported(r) if r.id == sid && r.outcome == Outcome::Interrupted)),
            "closing a working workspace session must interrupt its active turn"
        );
        assert!(
            applied.iter().any(|f| matches!(f, Fact::SessionLeft(l) if l.id == sid)),
            "closing a workspace session must emit Fact::session_left"
        );
    }
}
