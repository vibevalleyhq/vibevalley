use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, Implementation, InitializeRequest, LoadSessionRequest, NewSessionRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SetSessionConfigOptionRequest, SetSessionModeRequest, SystemPrompt,
};
use agent_client_protocol::{Agent, Builder, Client, ConnectionTo, Lines, Responder, UntypedMessage};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use super::antigravity;
use super::antigravity_db;
use super::antigravity_swarm;
use super::projector::{Projector, is_empty_input, stop_reason, str_of};
use super::spec::{
    AcpFlavor, OptionSet, config_option_in, current_model, extract_effort_config, matching_mode, models_of, select_values, session_config_options,
};
use super::turn_state::{AcpTurnMachine, CancelOutcome, PromptErrOutcome, PromptOkOutcome, UsageOutcome};
use crate::oar::core::SessionCore;
use crate::oar::process::{AbortWatchdog, LineChild};
use crate::oar::{
    AgentError, ChildTranscriptStep, EventKind, InteractionDecision, InteractionOption, McpServer, ModelInfo, PermissionDecision, PermissionMode, Result,
    SessionOptions, StopReason, SubagentSnapshot, SubagentStatus, SwarmMemberState, SwarmSnapshot, Usage,
};

pub(super) const OPEN_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const ABORT_GRACE: Duration = Duration::from_secs(10);
pub(super) const CONFIG_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct PendingPermission {
    pub(super) responder: Responder<RequestPermissionResponse>,
    pub(super) options: OptionSet,
}

pub(super) struct PendingInteraction {
    pub(super) responder: Responder<RequestPermissionResponse>,
    pub(super) options: Vec<InteractionOption>,
    pub(super) allow_custom: bool,
}

pub(super) enum Command {
    Steer(Vec<Value>),
    Prompt(Vec<Value>),
    SetConfig {
        model: Option<String>,
        effort: Option<String>,
        permission_mode: Option<PermissionMode>,
        reply: oneshot::Sender<Result<()>>,
    },
    Cancel,
    Shutdown,
}

pub(super) struct Opened {
    pub(super) session_id: String,
    pub(super) model: Option<String>,
    pub(super) title: Option<String>,
    pub(super) image_input: bool,
    /// The agent's `session/new` answer, for `list_models`.
    pub(super) session: Value,
    /// Populated when `list_models` probes per-model `thought_level` options.
    pub(super) probed_models: Option<Vec<ModelInfo>>,
    pub(super) available_modes: Vec<String>,
    pub(super) config_options: Vec<Value>,
}

pub(super) struct Shared {
    pub(super) runtime_id: String,
    pub(super) flavor: AcpFlavor,
    pub(super) child: OnceLock<Arc<LineChild>>,
    pub(super) core: OnceLock<Arc<SessionCore>>,
    pub(super) acp_session: OnceLock<String>,
    pub(super) session_title: Mutex<Option<String>>,
    pub(super) base_dir: OnceLock<PathBuf>,
    pub(super) db_path: OnceLock<PathBuf>,
    pub(super) auth_notice: OnceLock<String>,
    pub(super) projector: Mutex<Projector>,
    pub(super) pending: Mutex<HashMap<String, PendingPermission>>,
    pub(super) pending_interactions: Mutex<HashMap<String, PendingInteraction>>,
    pub(super) next_permission: AtomicU64,
    pub(super) permission_mode: Mutex<PermissionMode>,
    pub(super) available_modes: Mutex<Vec<String>>,
    pub(super) config_options: Mutex<Vec<Value>>,
    pub(super) turn: AcpTurnMachine,
    pub(super) watchdog: Arc<AbortWatchdog>,
    pub(super) image_input: AtomicBool,
    pub(super) background: Mutex<antigravity::BackgroundTracker>,
    pub(super) has_child_activity: AtomicBool,
    pub(super) child_activity: Mutex<antigravity::ChildActivityTracker>,
    pub(super) swarm_reader: Mutex<Option<antigravity_swarm::SwarmReader>>,
    pub(super) turn_start_step_idx: Mutex<Option<i64>>,
    pub(super) children: Mutex<HashMap<String, Vec<String>>>,
    pub(super) updates: Mutex<VecDeque<String>>,
    pub(super) commands: mpsc::UnboundedSender<Command>,
    pub(super) cwd: PathBuf,
}

impl Shared {
    fn agent_path(&self, params: &Value) -> Vec<String> {
        let root = self.acp_session.get().map(String::as_str).unwrap_or_default();
        let meta = params
            .pointer("/_meta/opencode~1child-session")
            .or_else(|| params.pointer("/update/_meta/opencode~1child-session"));
        let mut id = str_of(params, "sessionId").unwrap_or(root);
        let mut paths = self.children.lock();
        if let Some(meta) = meta
            && let Some(child) = meta
                .as_str()
                .or_else(|| ["childSessionId", "sessionId", "id"].into_iter().find_map(|k| str_of(meta, k)))
            && child != root
        {
            let parent = str_of(meta, "parentSessionId").or_else(|| str_of(meta, "parentId")).unwrap_or(id);
            let mut parent_path = paths
                .get(parent)
                .cloned()
                .unwrap_or_else(|| if parent == root { vec![] } else { vec![parent.to_owned()] });
            parent_path.push(child.to_string());
            if !paths.contains_key(child) {
                if let Some(core) = self.core.get() {
                    core.child_session(parent, child, &parent_path);
                }
                paths.insert(child.to_owned(), parent_path);
            }
            id = child;
        }
        paths.get(id).cloned().unwrap_or_else(|| if id != root { vec![id.into()] } else { vec![] })
    }

    async fn on_update(&self, params: &Value) {
        let detached_abort = {
            let line = self
                .updates
                .lock()
                .pop_front()
                .unwrap_or_else(|| json!({"jsonrpc":"2.0","method":"session/update","params":params}).to_string());
            if let Some(update) = params.get("update")
                && str_of(update, "sessionUpdate") == Some("session_info_update")
                && str_of(params, "sessionId").is_none_or(|id| self.acp_session.get().is_none_or(|root| root == id))
                && let Some(title) = str_of(update, "title").map(str::trim).filter(|t| !t.is_empty())
            {
                *self.session_title.lock() = Some(title.to_string());
            }
            if self.turn.is_replaying() {
                return;
            }
            let Some(core) = self.core.get() else { return };
            let Some(update) = params.get("update") else { return };
            let path = self.agent_path(params);
            let update_kind = str_of(update, "sessionUpdate").unwrap_or_default();
            let mut child_events = Vec::new();
            if self.flavor == AcpFlavor::Antigravity
                && path.is_empty()
                && matches!(update_kind, "tool_call" | "tool_call_update")
                && let Some(tool_id) = str_of(update, "toolCallId")
            {
                let title = str_of(update, "title").unwrap_or_default();
                let kind = str_of(update, "kind").unwrap_or_default();
                let status = str_of(update, "status").unwrap_or_default();
                self.background.lock().on_tool_update(tool_id, title, kind, update.get("rawInput"), status);
                let parent_id = self.acp_session.get().map(String::as_str).unwrap_or_default();
                let (matched, mapped) = self.child_activity.lock().on_tool_update(parent_id, update);
                if matched {
                    self.has_child_activity.store(true, Ordering::SeqCst);
                    child_events = mapped;
                }
            }
            let frame_type = format!("session/update/{update_kind}");
            let _frame = core.record_raw(&frame_type, path.clone(), &line, params);
            let events = self.projector.lock().update(update);
            for kind in events.into_iter().chain(child_events) {
                core.emit(path.clone(), kind);
            }
            if self.flavor == AcpFlavor::Antigravity
                && path.is_empty()
                && update_kind == "usage_update"
                && let UsageOutcome::FinishDetached { abort_wanted } = self.turn.on_usage_update()
            {
                Some(abort_wanted)
            } else {
                None
            }
        };
        if let Some(abort_wanted) = detached_abort {
            self.background.lock().clear();
            let (reason, error) = if abort_wanted {
                (StopReason::Aborted, None)
            } else {
                self.check_silent_error(StopReason::Completed, None).await
            };
            self.turn_finished(reason, error);
        }
    }

    fn auto_allow(&self, tool_kind: Option<&str>) -> bool {
        let mode = *self.permission_mode.lock();
        match self.flavor {
            AcpFlavor::Antigravity => antigravity::client_auto_allow(mode, tool_kind),
            AcpFlavor::Generic => match mode {
                PermissionMode::Bypass => true,
                PermissionMode::AcceptEdits => matches!(tool_kind, Some("edit" | "delete" | "move")),
                PermissionMode::Ask | PermissionMode::Plan => false,
            },
        }
    }

    fn on_permission(&self, request: &Value, responder: Responder<RequestPermissionResponse>) {
        let cancelled = || RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        let Some(core) = self.core.get() else {
            let _ = responder.respond(cancelled());
            return;
        };
        let tool_call = request.get("toolCall").cloned().unwrap_or(Value::Null);
        let options_val = request.get("options").unwrap_or(&Value::Null);
        let path = self.agent_path(request);

        // `interaction_*` questions are routed to the dedicated interaction channel
        // and MUST NEVER be auto-approved, even under `PermissionMode::Bypass`.
        if self.flavor == AcpFlavor::Antigravity && antigravity::is_interaction_request(&tool_call) {
            let (question, options, allow_custom) = antigravity::parse_interaction(&tool_call, options_val);
            let request_id = format!("int-{}", self.next_permission.fetch_add(1, Ordering::SeqCst));
            self.pending_interactions.lock().insert(
                request_id.clone(),
                PendingInteraction {
                    responder,
                    options: options.clone(),
                    allow_custom,
                },
            );
            core.emit(
                path,
                EventKind::InteractionRequested {
                    request_id,
                    question,
                    options,
                    allow_custom,
                },
            );
            return;
        }

        let options = OptionSet::from_json(options_val);
        for kind in self.projector.lock().permission_tool(&tool_call) {
            core.emit(path.clone(), kind);
        }
        if self.auto_allow(str_of(&tool_call, "kind"))
            && let Ok(Some(option)) = options.pick(&PermissionDecision::AllowOnce)
        {
            let _ = responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option),
            )));
            return;
        }
        let request_id = format!("perm-{}", self.next_permission.fetch_add(1, Ordering::SeqCst));
        let mut summary = str_of(&tool_call, "title").unwrap_or("tool").to_string();
        let tool_kind = str_of(&tool_call, "kind");
        let mut input = match tool_call.get("rawInput") {
            Some(input) if !is_empty_input(input) => match self.flavor {
                AcpFlavor::Generic => input.clone(),
                AcpFlavor::Antigravity => antigravity::normalize_tool_input(input, tool_kind),
            },
            _ => match self.flavor {
                AcpFlavor::Generic => tool_call.clone(),
                AcpFlavor::Antigravity => antigravity::normalize_tool_input(&tool_call, tool_kind),
            },
        };
        if self.flavor == AcpFlavor::Antigravity {
            let warnings = antigravity::extract_security_warnings(options_val);
            if !warnings.is_empty() {
                if let Value::Object(map) = &mut input {
                    map.insert("_securityWarnings".to_string(), json!(warnings));
                }
                summary = format!("{summary} [warning: {}]", warnings.join("; "));
            }
        }
        self.pending.lock().insert(request_id.clone(), PendingPermission { responder, options });
        core.emit(
            path,
            EventKind::PermissionRequested {
                request_id,
                tool: tool_kind.unwrap_or("tool").to_string(),
                input,
                summary,
            },
        );
    }

    /// ACP requires every open permission / interaction request to be answered
    /// `cancelled` once the turn is cancelled.
    fn cancel_pending(&self) {
        let pending: Vec<(String, PendingPermission)> = self.pending.lock().drain().collect();
        for (request_id, pending) in pending {
            let _ = pending.responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            if let Some(core) = self.core.get() {
                core.emit_root(EventKind::PermissionResolved {
                    request_id,
                    decision: PermissionDecision::Deny {
                        message: Some("cancelled".into()),
                    },
                });
            }
        }
        let interactions: Vec<(String, PendingInteraction)> = self.pending_interactions.lock().drain().collect();
        for (request_id, pending) in interactions {
            let _ = pending.responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            if let Some(core) = self.core.get() {
                core.emit_root(EventKind::InteractionResolved {
                    request_id,
                    decision: InteractionDecision::Cancel,
                });
            }
        }
    }

    async fn check_silent_error(&self, reason: StopReason, error: Option<String>) -> (StopReason, Option<String>) {
        if self.flavor != AcpFlavor::Antigravity {
            return (reason, error);
        }
        let start_idx = self.turn_start_step_idx.lock().take();
        let (Some(path), Some(after_idx)) = (self.db_path.get(), start_idx) else {
            return (reason, error);
        };
        if let Some(silent) = antigravity_db::detect_silent_error(path, after_idx).await {
            if silent.invalid_thinking_signature
                && let Some(core) = self.core.get()
            {
                core.mark_unresumable();
            }
            return (StopReason::Error, Some(silent.message));
        }
        (reason, error)
    }

    pub(super) fn swarm_snapshot(&self) -> Option<SwarmSnapshot> {
        if self.flavor != AcpFlavor::Antigravity {
            return None;
        }
        let mut guard = self.swarm_reader.lock();
        let reader = guard.as_mut()?;
        // Avoid parsing swarm files on single-agent chats until either a swarm/subagent
        // tool fires or `swarm.json` appears on disk (e.g. `/swarm` or resumed session).
        if !self.has_child_activity.load(Ordering::SeqCst) {
            if !reader.has_swarm_file() {
                return None;
            }
            self.has_child_activity.store(true, Ordering::SeqCst);
        }
        reader.poll_snapshot()
    }

    pub(super) fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<ChildTranscriptStep> {
        if self.flavor != AcpFlavor::Antigravity {
            return Vec::new();
        }
        let Some(base) = self.base_dir.get() else {
            return Vec::new();
        };
        antigravity_swarm::read_child_transcript(base, conversation_id, limit)
    }

    pub(super) async fn read_subagent(&self, thread_id: &str, _turn_id: Option<&str>) -> Result<SubagentSnapshot> {
        if self.flavor != AcpFlavor::Antigravity {
            return Err(AgentError::Unsupported {
                option: "read_subagent".into(),
                reason: "runtime cannot read a saved child thread".into(),
            });
        }
        let parent_thread_id = self.acp_session.get().cloned();
        let last_message = |conv_id: &str| -> (Option<String>, Option<SubagentStatus>) {
            let steps = self.read_child_transcript(conv_id, 5);
            let msg = steps.iter().rev().find_map(|s| s.error.clone().or_else(|| s.content.clone()));
            let derived = steps.last().map(|s| {
                if s.error.is_some() || s.kind == "ERROR_MESSAGE" {
                    SubagentStatus::Errored
                } else if s.status.as_deref().is_some_and(|st| st.eq_ignore_ascii_case("RUNNING")) {
                    SubagentStatus::Running
                } else {
                    SubagentStatus::Completed
                }
            });
            (msg, derived)
        };

        if let Some(swarm) = self.swarm_snapshot()
            && let Some(member) = swarm.members.iter().find(|m| m.name == thread_id || m.conversation_id == thread_id)
        {
            let status = match member.state {
                SwarmMemberState::Working | SwarmMemberState::Waiting => SubagentStatus::Running,
                SwarmMemberState::Stopped => SubagentStatus::Interrupted,
                SwarmMemberState::Killed => SubagentStatus::Shutdown,
            };
            let (message, _) = last_message(&member.conversation_id);
            return Ok(SubagentSnapshot {
                parent_thread_id,
                agent_name: Some(member.name.clone()),
                status: Some(status),
                message,
            });
        }

        if let Some(db_path) = self.db_path.get() {
            let children = antigravity_db::list_invoked_subagents(db_path, antigravity_db::MAX_CHILDREN).await;
            if let Some(child) = children
                .into_iter()
                .find(|c| c.conversation_id.as_deref() == Some(thread_id) || c.role.as_deref() == Some(thread_id))
            {
                let (message, status) = child
                    .conversation_id
                    .as_deref()
                    .map(last_message)
                    .unwrap_or((None, Some(SubagentStatus::Running)));
                return Ok(SubagentSnapshot {
                    parent_thread_id,
                    agent_name: child.role,
                    status: status.or(Some(SubagentStatus::Running)),
                    message,
                });
            }
        }

        Ok(SubagentSnapshot {
            parent_thread_id,
            agent_name: None,
            status: Some(SubagentStatus::NotFound),
            message: None,
        })
    }

    fn turn_finished(&self, reason: StopReason, error: Option<String>) {
        self.cancel_pending();
        self.watchdog.on_turn_finished();
        let Some(core) = self.core.get() else { return };
        if let Some(message) = error {
            core.emit_root(EventKind::Error { message });
        }
        core.emit_root(EventKind::TurnFinished {
            reason,
            usage: Usage::default(),
        });
    }
}

fn error_code(error: &agent_client_protocol::Error) -> Option<i64> {
    serde_json::to_value(error.code).ok().and_then(|c| c.as_i64())
}

pub(super) fn acp_error(context: &str, error: &agent_client_protocol::Error) -> String {
    let code = error_code(error).unwrap_or(0);
    match &error.data {
        Some(data) if !data.is_null() => format!("{context}: {} ({code}): {data}", error.message),
        _ => format!("{context}: {} ({code})", error.message),
    }
}

fn is_auth_required(flavor: AcpFlavor, error: &agent_client_protocol::Error) -> bool {
    let code = error_code(error);
    match flavor {
        AcpFlavor::Generic => code == Some(-32000),
        AcpFlavor::Antigravity => antigravity::is_auth_error(code, &error.message, error.data.as_ref()),
    }
}

fn unsupported(option: &str, reason: impl Into<String>) -> AgentError {
    AgentError::Unsupported {
        option: option.into(),
        reason: reason.into(),
    }
}

fn typed<T: serde::de::DeserializeOwned>(value: Value) -> std::result::Result<T, agent_client_protocol::Error> {
    serde_json::from_value(value).map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))
}

async fn send_set_config_option(
    cx: &ConnectionTo<Agent>,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> std::result::Result<Value, agent_client_protocol::Error> {
    let msg = UntypedMessage::new(
        "session/set_config_option",
        json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": value,
        }),
    )?;
    cx.send_request(msg).block_task().await
}

/// Initialize, authenticate (if configured/non-interactive), open the session,
/// and apply options; everything that can refuse an option happens here before
/// `open` returns a session.
async fn handshake(cx: &ConnectionTo<Agent>, shared: &Shared, opts: &SessionOptions, probe_models: bool) -> Result<Opened> {
    let name = &shared.runtime_id;
    let init = match shared.flavor {
        AcpFlavor::Generic => {
            let reply = cx
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_info(Implementation::new("vibevalley", env!("CARGO_PKG_VERSION")).title("VibeValley")),
                )
                .block_task()
                .await
                .map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?;
            serde_json::to_value(&reply).unwrap_or(Value::Null)
        }
        AcpFlavor::Antigravity => {
            let req = UntypedMessage::new("initialize", antigravity::initialize_params()).map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?;
            cx.send_request(req)
                .block_task()
                .await
                .map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?
        }
    };

    let auth_error = |context: &str, error: &agent_client_protocol::Error| -> AgentError {
        let methods: Vec<&str> = init
            .get("authMethods")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| str_of(m, "name").or_else(|| str_of(m, "id")))
            .collect();
        let hint = match shared.flavor {
            AcpFlavor::Antigravity => "Run `agy acp --login` first.",
            AcpFlavor::Generic => "Log in with the agent's own CLI first.",
        };
        AgentError::NotAvailable(format!(
            "{name} needs a login before it can open a session ({context}): {} (methods: {}). {hint}",
            error.message,
            methods.join(", ")
        ))
    };

    if shared.flavor == AcpFlavor::Antigravity
        && let Some(method_id) = antigravity::pick_auth_method(&init, &opts.env, opts.base_env.as_deref())
    {
        let auth_req =
            UntypedMessage::new("authenticate", json!({ "methodId": method_id })).map_err(|e| AgentError::Protocol(acp_error("authenticate", &e)))?;
        cx.send_request(auth_req).block_task().await.map_err(|e| {
            if is_auth_required(shared.flavor, &e) {
                auth_error("authenticate", &e)
            } else {
                AgentError::NotAvailable(acp_error("authenticate", &e))
            }
        })?;
    }

    let capabilities = init.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let session_capability = |key: &str| capabilities.pointer(&format!("/sessionCapabilities/{key}")).is_some_and(|v| !v.is_null());
    let image_input = capabilities.pointer("/promptCapabilities/image").and_then(Value::as_bool) == Some(true);

    let mut meta = Map::new();
    let system_prompt = match shared.flavor {
        AcpFlavor::Antigravity => {
            if let Some(extra) = opts.append_system_prompt.as_deref().filter(|s| !s.is_empty()) {
                if let Some(agy_meta) = antigravity::build_session_meta(&init, Some(extra)) {
                    meta.extend(agy_meta);
                    None
                } else if session_capability("systemPrompt") {
                    Some(
                        typed::<SystemPrompt>(json!({ "mode": "append", "content": [{ "type": "text", "text": extra }] }))
                            .map_err(|e| AgentError::Protocol(acp_error("system prompt", &e)))?,
                    )
                } else {
                    return Err(unsupported(
                        "append_system_prompt",
                        format!("{name} does not advertise `_meta.antigravity.systemPrompt.append`"),
                    ));
                }
            } else {
                None
            }
        }
        AcpFlavor::Generic => {
            // A replacing prompt overrides the agent's own, with the appended part after it.
            let (mode, text) = match (&opts.system_prompt, &opts.append_system_prompt) {
                (None, None) => ("append", None),
                (None, Some(extra)) => ("append", Some(extra.clone())),
                (Some(own), None) => ("override", Some(own.clone())),
                (Some(own), Some(extra)) => ("override", Some(format!("{own}\n\n{extra}"))),
            };
            let sp = match text {
                None => None,
                Some(_) if matches!(name.as_str(), "grok" | "acp:opencode" | "opencode") && !session_capability("systemPrompt") => None,
                Some(_) if !session_capability("systemPrompt") => {
                    let option = if opts.system_prompt.is_some() {
                        "system_prompt"
                    } else {
                        "append_system_prompt"
                    };
                    return Err(unsupported(option, format!("{name} does not accept a system prompt over ACP")));
                }
                Some(text) => Some(
                    typed::<SystemPrompt>(json!({ "mode": mode, "content": [{ "type": "text", "text": text }] }))
                        .map_err(|e| AgentError::Protocol(acp_error("system prompt", &e)))?,
                ),
            };
            if sp.is_none() {
                if let Some(text) = &opts.system_prompt {
                    meta.insert("systemPrompt".into(), json!(text));
                }
                if let Some(text) = &opts.append_system_prompt {
                    meta.insert("appendSystemPrompt".into(), json!(text));
                }
            }
            sp
        }
    };

    let mcp_servers: Vec<agent_client_protocol::v1::schema::McpServer> = typed(json!(
        opts.mcp_servers
            .iter()
            .map(|server| match server {
                McpServer::Stdio { name, command, args, env, .. } => json!({
                    "name": name, "command": command, "args": args,
                    "env": env.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
                McpServer::Http { name, url, headers } => json!({
                    "type": "http", "name": name, "url": url,
                    "headers": headers.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
            })
            .collect::<Vec<_>>()
    ))
    .map_err(|e| AgentError::Protocol(acp_error("mcp servers", &e)))?;

    let open_error = |context: &str, error: agent_client_protocol::Error| {
        if is_auth_required(shared.flavor, &error) {
            auth_error(context, &error)
        } else if opts.resume.is_some() {
            AgentError::Rejected(format!("session_not_found: {}", acp_error(context, &error)))
        } else {
            AgentError::Protocol(acp_error(context, &error))
        }
    };

    let (session_id, session) = match &opts.resume {
        None => {
            let mut request = NewSessionRequest::new(&opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/new: {e}")))?;
            let msg = UntypedMessage::new("session/new", params).map_err(|e| AgentError::Protocol(acp_error("session/new", &e)))?;
            let reply = cx.send_request(msg).block_task().await.map_err(|e| open_error("session/new", e))?;
            let id = str_of(&reply, "sessionId")
                .map(str::to_string)
                .ok_or_else(|| AgentError::Protocol("session/new returned no sessionId".into()))?;
            (id, reply)
        }
        Some(id) if session_capability("resume") => {
            let mut request = ResumeSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/resume: {e}")))?;
            let msg = UntypedMessage::new("session/resume", params).map_err(|e| AgentError::Protocol(acp_error("session/resume", &e)))?;
            let reply = cx.send_request(msg).block_task().await.map_err(|e| open_error("session/resume", e))?;
            (id.clone(), reply)
        }
        Some(id) if capabilities.get("loadSession").and_then(Value::as_bool) == Some(true) || session_capability("load") => {
            let mut request = LoadSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/load: {e}")))?;
            let msg = UntypedMessage::new("session/load", params).map_err(|e| AgentError::Protocol(acp_error("session/load", &e)))?;
            let _replay = shared.turn.enter_replay();
            let reply = cx.send_request(msg).block_task().await;
            drop(_replay);
            let reply = reply.map_err(|e| open_error("session/load", e))?;
            (id.clone(), reply)
        }
        Some(_) => return Err(unsupported("resume", format!("{name} can neither resume nor load a session"))),
    };

    let mut config_options = session_config_options(&session).unwrap_or_default();

    // `list_models()` on Antigravity probes each advertised model once in the
    // throwaway session so each `ModelInfo` carries its `thought_level` options.
    let probed_models = if probe_models && shared.flavor == AcpFlavor::Antigravity {
        let mut models = models_of(&session);
        let model_config_id = config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string);
        let initial_model = current_model(&session);
        if let Some(config_id) = model_config_id {
            for model in &mut models {
                if initial_model.as_deref() == Some(model.id.as_str()) {
                    let (levels, default_effort) = extract_effort_config(&config_options);
                    model.effort_levels = levels;
                    model.default_effort = default_effort;
                    continue;
                }
                if let Ok(reply) = send_set_config_option(cx, &session_id, &config_id, &model.id).await
                    && let Some(updated) = session_config_options(&reply)
                {
                    let (levels, default_effort) = extract_effort_config(&updated);
                    model.effort_levels = levels;
                    model.default_effort = default_effort;
                    config_options = updated;
                }
            }
        }
        Some(models)
    } else {
        None
    };

    let mut model = current_model(&session);
    if let Some(wanted) = &opts.model {
        let listed = models_of(&session);
        if !listed.is_empty() && !listed.iter().any(|m| &m.id == wanted) {
            return Err(unsupported("model", format!("{name} does not list model `{wanted}` (see list_models)")));
        }
        match config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string) {
            Some(config_id) => {
                let reply = send_set_config_option(cx, &session_id, &config_id, wanted)
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                if let Some(updated) = session_config_options(&reply) {
                    config_options = updated;
                }
            }
            None => {
                let message = UntypedMessage::new("session/set_model", json!({ "sessionId": session_id, "modelId": wanted }))
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                cx.send_request(message)
                    .block_task()
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
            }
        }
        model = Some(wanted.clone());
    }

    if let Some(effort) = &opts.effort {
        let config_id = config_option_in(&config_options, "thought_level")
            .or_else(|| config_option_in(&config_options, "reasoning_effort"))
            .and_then(|o| str_of(o, "id"))
            .unwrap_or(match shared.flavor {
                AcpFlavor::Antigravity => "thought_level",
                AcpFlavor::Generic => "reasoning_effort",
            })
            .to_string();
        let reply = send_set_config_option(cx, &session_id, &config_id, effort)
            .await
            .map_err(|e| unsupported("effort", acp_error("the agent refused the reasoning effort", &e)))?;
        if let Some(updated) = session_config_options(&reply) {
            config_options = updated;
        }
    }

    let modes: Vec<String> = session
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| str_of(m, "id").map(str::to_string))
        .collect();
    let mode_option = config_option_in(&config_options, "mode");
    let option_modes: Vec<String> = mode_option.map(select_values).unwrap_or_default().into_iter().map(|(id, _)| id).collect();
    let available_modes = if !modes.is_empty() { modes.clone() } else { option_modes.clone() };

    match shared.flavor {
        AcpFlavor::Antigravity => {
            if let Some(wire_mode) =
                antigravity::wire_mode_for(opts.permission_mode, &available_modes, false).map_err(|reason| unsupported("permission_mode", reason))?
            {
                apply_wire_mode(cx, &session_id, &modes, mode_option, &wire_mode).await?;
            }
        }
        AcpFlavor::Generic => {
            if opts.permission_mode != PermissionMode::Ask {
                let set = if let Some(mode) = matching_mode(opts.permission_mode, &modes) {
                    Some(
                        cx.send_request(SetSessionModeRequest::new(session_id.clone(), mode.clone()))
                            .block_task()
                            .await
                            .map(|_| ()),
                    )
                } else if let (Some(mode), Some(config_id)) = (matching_mode(opts.permission_mode, &option_modes), mode_option.and_then(|o| str_of(o, "id"))) {
                    Some(
                        cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), config_id.to_string(), mode.as_str()))
                            .block_task()
                            .await
                            .map(|_| ()),
                    )
                } else {
                    None
                };
                match (set, opts.permission_mode) {
                    (Some(Ok(())), _) => {}
                    (Some(Err(error)), _) => {
                        return Err(unsupported("permission_mode", acp_error("the agent refused the mode", &error)));
                    }
                    // Enforced by answering its permission requests ourselves.
                    (None, PermissionMode::AcceptEdits | PermissionMode::Bypass) => {}
                    (None, _) => {
                        let known: Vec<&String> = modes.iter().chain(option_modes.iter()).collect();
                        return Err(unsupported("permission_mode", format!("{name} has no plan mode (its modes: {known:?})")));
                    }
                }
            }
        }
    }

    let title = str_of(&session, "title").map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);

    Ok(Opened {
        session_id,
        model,
        title,
        image_input,
        session,
        probed_models,
        available_modes,
        config_options,
    })
}

async fn apply_wire_mode(cx: &ConnectionTo<Agent>, session_id: &str, modes: &[String], mode_option: Option<&Value>, wire_mode: &str) -> Result<()> {
    if modes.iter().any(|m| m == wire_mode) {
        cx.send_request(SetSessionModeRequest::new(session_id.to_string(), wire_mode.to_string()))
            .block_task()
            .await
            .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
        return Ok(());
    }
    if let Some(config_id) = mode_option.and_then(|o| str_of(o, "id")) {
        send_set_config_option(cx, session_id, config_id, wire_mode)
            .await
            .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
        return Ok(());
    }
    cx.send_request(SetSessionModeRequest::new(session_id.to_string(), wire_mode.to_string()))
        .block_task()
        .await
        .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
    Ok(())
}

async fn dispatch_prompt(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    session_id: &str,
    blocks: Vec<Value>,
) -> std::result::Result<(), agent_client_protocol::Error> {
    let request = UntypedMessage::new("session/prompt", json!({ "sessionId": session_id, "prompt": blocks }))?;
    let start = shared.turn.begin_prompt();
    if shared.flavor == AcpFlavor::Antigravity && start.is_first {
        let start_idx = match shared.db_path.get() {
            Some(p) => antigravity_db::latest_step_index(p).await,
            None => None,
        };
        *shared.turn_start_step_idx.lock() = start_idx;
    }
    let shared_cb = shared.clone();
    // Ordered: the answer is handled after every update that preceded it.
    if let Err(err) = cx.send_request(request).on_receiving_result(move |result| async move {
        match result {
            Ok(reply) => {
                let raw_stop = str_of(&reply, "stopReason").map(str::to_string);
                match shared_cb.flavor {
                    AcpFlavor::Generic => {
                        let _frame = shared_cb
                            .core
                            .get()
                            .map(|core| core.record_raw("session/prompt_result", vec![], &reply.to_string(), &reply));
                        if let PromptOkOutcome::Finish { .. } = shared_cb.turn.on_prompt_ok(false) {
                            let (reason, error) = stop_reason(&reply);
                            shared_cb.turn_finished(reason, error);
                        }
                    }
                    AcpFlavor::Antigravity => {
                        let (mut reason, mut error) = stop_reason(&reply);
                        let check_silent = matches!(raw_stop.as_deref(), Some("end_turn" | "refusal"));
                        // Check silent DB errors before acquiring `FrameGuard` so no guard crosses `.await`.
                        if check_silent {
                            (reason, error) = shared_cb.check_silent_error(reason, error).await;
                        }
                        let _frame = shared_cb
                            .core
                            .get()
                            .map(|core| core.record_raw("session/prompt_result", vec![], &reply.to_string(), &reply));
                        if shared_cb.turn.try_finish_steered_prompt() {
                            return Ok(());
                        }
                        let may_detach = reason == StopReason::Completed && shared_cb.background.lock().has_open();
                        match shared_cb.turn.on_prompt_ok(may_detach) {
                            PromptOkOutcome::StillInFlight | PromptOkOutcome::Detached => return Ok(()),
                            PromptOkOutcome::Finish { .. } => {
                                shared_cb.turn_finished(reason, error);
                            }
                        }
                    }
                }
            }
            Err(error) => {
                if let PromptErrOutcome::Finish { abort_wanted } = shared_cb.turn.on_prompt_err() {
                    let reason = if abort_wanted { StopReason::Aborted } else { StopReason::Error };
                    let message = (reason == StopReason::Error).then(|| acp_error("session/prompt", &error));
                    shared_cb.turn_finished(reason, message);
                }
            }
        }
        Ok(())
    }) {
        shared.turn.rollback_prompt();
        return Err(err);
    }
    Ok(())
}

async fn apply_live_config(
    cx: &ConnectionTo<Agent>,
    shared: &Shared,
    session_id: &str,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
) -> Result<()> {
    let mut config_options = shared.config_options.lock().clone();
    if let Some(wanted) = model {
        match config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string) {
            Some(config_id) => {
                let reply = send_set_config_option(cx, session_id, &config_id, &wanted)
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                if let Some(updated) = session_config_options(&reply) {
                    config_options = updated;
                }
            }
            None => {
                let msg = UntypedMessage::new("session/set_model", json!({ "sessionId": session_id, "modelId": wanted }))
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                cx.send_request(msg)
                    .block_task()
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
            }
        }
    }
    if let Some(wanted_effort) = effort {
        let config_id = config_option_in(&config_options, "thought_level")
            .or_else(|| config_option_in(&config_options, "reasoning_effort"))
            .and_then(|o| str_of(o, "id"))
            .unwrap_or(match shared.flavor {
                AcpFlavor::Antigravity => "thought_level",
                AcpFlavor::Generic => "reasoning_effort",
            })
            .to_string();
        let reply = send_set_config_option(cx, session_id, &config_id, &wanted_effort)
            .await
            .map_err(|e| unsupported("effort", acp_error("the agent refused the reasoning effort", &e)))?;
        if let Some(updated) = session_config_options(&reply) {
            config_options = updated;
        }
    }
    *shared.config_options.lock() = config_options.clone();

    if let Some(wanted_mode) = permission_mode {
        let prev_mode = *shared.permission_mode.lock();
        let available = shared.available_modes.lock().clone();
        let mode_option = config_option_in(&config_options, "mode");
        match shared.flavor {
            AcpFlavor::Antigravity => {
                if let Some(wire_mode) = antigravity::wire_mode_for(wanted_mode, &available, prev_mode == PermissionMode::Plan)
                    .map_err(|reason| unsupported("permission_mode", reason))?
                {
                    apply_wire_mode(cx, session_id, &available, mode_option, &wire_mode).await?;
                }
            }
            AcpFlavor::Generic => {
                if wanted_mode != PermissionMode::Ask {
                    if let Some(mode) = matching_mode(wanted_mode, &available) {
                        apply_wire_mode(cx, session_id, &available, mode_option, mode).await?;
                    } else if wanted_mode == PermissionMode::Plan {
                        return Err(unsupported(
                            "permission_mode",
                            format!("{} has no plan mode (its modes: {available:?})", shared.runtime_id),
                        ));
                    }
                }
            }
        }
        *shared.permission_mode.lock() = wanted_mode;
    }
    Ok(())
}

async fn serve(
    cx: ConnectionTo<Agent>,
    shared: Arc<Shared>,
    opts: SessionOptions,
    probe_models: bool,
    mut commands: mpsc::UnboundedReceiver<Command>,
    ready: mpsc::Sender<Result<Opened>>,
) -> std::result::Result<(), agent_client_protocol::Error> {
    let opened = match handshake(&cx, &shared, &opts, probe_models).await {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.try_send(Err(error));
            return Ok(());
        }
    };
    let session_id = opened.session_id.clone();
    let _ = shared.acp_session.set(session_id.clone());
    if let Some(title) = opened.title.clone() {
        let mut slot = shared.session_title.lock();
        if slot.is_none() {
            *slot = Some(title);
        }
    }
    *shared.available_modes.lock() = opened.available_modes.clone();
    *shared.config_options.lock() = opened.config_options.clone();
    shared.image_input.store(opened.image_input, Ordering::SeqCst);
    if ready.send(Ok(opened)).await.is_err() {
        return Ok(());
    }
    while let Some(command) = commands.recv().await {
        match command {
            Command::Prompt(blocks) => {
                dispatch_prompt(&cx, &shared, &session_id, blocks).await?;
            }
            Command::Steer(blocks) => match shared.flavor {
                AcpFlavor::Generic => {
                    cx.send_notification(UntypedMessage::new("session/steer", json!({"sessionId": session_id, "prompt": blocks}))?)?;
                }
                AcpFlavor::Antigravity => {
                    dispatch_prompt(&cx, &shared, &session_id, blocks).await?;
                }
            },
            Command::SetConfig {
                model,
                effort,
                permission_mode,
                reply,
            } => {
                let outcome = apply_live_config(&cx, &shared, &session_id, model, effort, permission_mode).await;
                let _ = reply.send(outcome);
            }
            Command::Cancel => {
                shared.cancel_pending();
                shared.background.lock().clear();
                let cancel_outcome = shared.turn.on_cancel();
                cx.send_notification(CancelNotification::new(session_id.clone()))?;
                if cancel_outcome == CancelOutcome::FinishAborted {
                    shared.turn_finished(StopReason::Aborted, None);
                }
            }
            Command::Shutdown => break,
        }
    }
    Ok(())
}

pub(super) async fn run_connection(
    shared: Arc<Shared>,
    child: Arc<LineChild>,
    incoming: mpsc::UnboundedReceiver<Option<std::io::Result<String>>>,
    opts: SessionOptions,
    probe_models: bool,
    commands: mpsc::UnboundedReceiver<Command>,
    ready: mpsc::Sender<Result<Opened>>,
) {
    let incoming = Box::pin(futures_util::stream::unfold(incoming, |mut rx| async move {
        rx.recv().await.flatten().map(|line| (line, rx))
    }));
    let outgoing = Box::pin(futures_util::sink::unfold(child, |child, line: String| async move {
        child.write_line(&line).await.map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok::<_, std::io::Error>(child)
    }));
    let updates = shared.clone();
    let permissions = shared.clone();
    let serving = shared.clone();
    let ready_failed = ready.clone();
    let result = Builder::new(Client)
        .name("vibevalley")
        .on_receive_notification(
            async move |notification: UntypedMessage, _cx| {
                if notification.method() == "session/update" {
                    updates.on_update(notification.params()).await;
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                permissions.on_permission(&serde_json::to_value(&request).unwrap_or(Value::Null), responder);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(Lines::new(outgoing, incoming), |cx: ConnectionTo<Agent>| {
            serve(cx, serving, opts, probe_models, commands, ready)
        })
        .await;
    let child_error = shared.child.get().map(|c| c.stderr_text()).unwrap_or_default();
    let mut message = match &result {
        Ok(()) => format!("{} closed the connection", shared.runtime_id),
        Err(error) => acp_error(&format!("{} connection failed", shared.runtime_id), error),
    };
    if !child_error.trim().is_empty() {
        message.push_str(": ");
        message.push_str(child_error.trim());
    }
    if let Some(auth_msg) = shared.auth_notice.get() {
        let _ = ready_failed.try_send(Err(AgentError::NotAvailable(auth_msg.clone())));
    } else {
        // Still waiting in `open`: the handshake never finished.
        let _ = ready_failed.try_send(Err(AgentError::Protocol(message.clone())));
    }
    if let Some(child) = shared.child.get() {
        child.kill().await;
    }
    if let Some(core) = shared.core.get() {
        core.observe_exit(shared.child.get().and_then(|c| c.status()));
        shared.watchdog.finish_on_exit(core, message);
    } else {
        shared.watchdog.wake();
    }
}
