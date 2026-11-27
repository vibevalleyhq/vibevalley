use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::v1::schema::{RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use super::antigravity;
use super::antigravity_db;
use super::antigravity_swarm;
use super::projector::{Projector, prompt_blocks};
use super::session::{ABORT_GRACE, CONFIG_TIMEOUT, Command, OPEN_TIMEOUT, Opened, Shared, acp_error, run_connection};
use super::spec::{AcpAgentSpec, AcpFlavor, models_of};
use super::turn_state::AcpTurnMachine;
use crate::BoxFuture;
use crate::oar::core::{CoreSession, Driver, SessionCore, rejected, rejection};
use crate::oar::process::{AbortWatchdog, LineChild, Spawn, find_binary, run_capture};
use crate::oar::record::{self, Recorder};
use crate::oar::{
    AccountUsage, AgentError, Capabilities, ChildTranscriptStep, ContentBlock, EventKind, Installation, InteractionDecision, ModelInfo, PermissionDecision,
    PermissionMode, Result, Runtime, Session, SessionOptions, SubagentSnapshot, SwarmSnapshot, runtime_spec,
};

const ACP_COMMAND_CHANNEL_CAPACITY: usize = 256;
const ACP_INCOMING_CHANNEL_CAPACITY: usize = 1024;

struct AcpDriver {
    shared: Arc<Shared>,
}

impl AcpDriver {
    fn blocks(&self, content: &[ContentBlock]) -> Result<Vec<Value>> {
        prompt_blocks(&self.shared.cwd, self.shared.image_input.load(Ordering::SeqCst), content)
    }

    fn send(&self, command: Command) -> Result<()> {
        self.shared.commands.try_send(command).map_err(|err| match err {
            mpsc::error::TrySendError::Full(_) => {
                tracing::warn!(runtime_id = %self.shared.runtime_id, capacity = ACP_COMMAND_CHANNEL_CAPACITY, "acp command channel full; rejecting command");
                AgentError::Io("the ACP command queue is full".into())
            }
            mpsc::error::TrySendError::Closed(_) => AgentError::Io("the ACP connection is closed".into()),
        })
    }
}

impl Driver for AcpDriver {
    fn read_subagent<'a>(&'a self, thread_id: &'a str, turn_id: Option<&'a str>) -> BoxFuture<'a, Result<SubagentSnapshot>> {
        Box::pin(self.shared.read_subagent(thread_id, turn_id))
    }

    fn swarm_snapshot(&self) -> Option<SwarmSnapshot> {
        self.shared.swarm_snapshot()
    }

    fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<ChildTranscriptStep> {
        self.shared.read_child_transcript(conversation_id, limit)
    }

    fn session_title(&self) -> Option<String> {
        self.shared.session_title.lock().clone()
    }

    fn check_content(&self, content: &[ContentBlock]) -> Result<()> {
        self.blocks(content).map(|_| ())
    }

    fn start_turn(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.send(Command::Prompt(self.blocks(&content)?)) })
    }

    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.send(Command::Steer(self.blocks(&content)?)) })
    }

    fn abort(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.shared.turn.request_abort();
            self.send(Command::Cancel)?;
            if let (Some(core), Some(child)) = (self.shared.core.get(), self.shared.child.get()) {
                self.shared.watchdog.arm(ABORT_GRACE, core.clone(), child.clone());
            }
            Ok(())
        })
    }

    /// ACP answers with one of the agent's own options; a denial's message
    /// has no field to travel in and is not delivered.
    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: &'a PermissionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut pending = self.shared.pending.lock();
            let Some(entry) = pending.get(request_id) else {
                return Err(rejected(rejection::UNKNOWN_REQUEST, format!("the agent no longer waits on `{request_id}`")));
            };
            // Refused before the request is taken, so it can be answered again.
            let outcome = match entry.options.pick(decision)? {
                Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option)),
                None => RequestPermissionOutcome::Cancelled,
            };
            let entry = pending.remove(request_id).expect("checked above");
            entry
                .responder
                .respond(RequestPermissionResponse::new(outcome))
                .map_err(|e| AgentError::Io(acp_error("permission answer", &e)))
        })
    }

    fn respond_interaction<'a>(&'a self, request_id: &'a str, decision: &'a InteractionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut pending = self.shared.pending_interactions.lock();
            let Some(entry) = pending.get(request_id) else {
                return Err(rejected(
                    rejection::UNKNOWN_REQUEST,
                    format!("the agent no longer waits on interaction `{request_id}`"),
                ));
            };
            let response = match decision {
                InteractionDecision::Select { option_id } => {
                    if !entry.options.is_empty() && !entry.options.iter().any(|o| o.id == *option_id) {
                        return Err(rejected(rejection::UNSUPPORTED, format!("unknown interaction option `{option_id}`")));
                    }
                    RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.clone())))
                }
                InteractionDecision::Custom { text } => {
                    if !entry.allow_custom {
                        return Err(rejected(rejection::UNSUPPORTED, "this interaction does not accept custom free-text replies"));
                    }
                    let custom_id = entry
                        .options
                        .iter()
                        .find(|o| {
                            matches!(o.id.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform")
                                || o.kind
                                    .as_deref()
                                    .is_some_and(|k| matches!(k.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform"))
                        })
                        .or_else(|| entry.options.first())
                        .map(|o| o.id.clone())
                        .unwrap_or_else(|| "custom".to_string());
                    let mut meta = Map::new();
                    meta.insert("customText".to_string(), json!(text));
                    meta.insert("text".to_string(), json!(text));
                    meta.insert("answer".to_string(), json!(text));
                    RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(custom_id).meta(meta.clone()))).meta(meta)
                }
                InteractionDecision::Cancel => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
            };
            let entry = pending.remove(request_id).expect("checked above");
            entry
                .responder
                .respond(response)
                .map_err(|e| AgentError::Io(acp_error("interaction answer", &e)))
        })
    }

    fn set_config<'a>(&'a self, model: Option<&'a str>, effort: Option<&'a str>, permission_mode: Option<PermissionMode>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let (reply_tx, reply_rx) = oneshot::channel();
            self.send(Command::SetConfig {
                model: model.map(str::to_string),
                effort: effort.map(str::to_string),
                permission_mode,
                reply: reply_tx,
            })?;
            tokio::time::timeout(CONFIG_TIMEOUT, reply_rx)
                .await
                .map_err(|_| AgentError::Protocol("timed out waiting for session config update".into()))?
                .map_err(|_| AgentError::Protocol("timed out waiting for session config update".into()))?
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.shared.commands.try_send(Command::Shutdown);
            if let Some(child) = self.shared.child.get() {
                child.kill().await;
                if let Some(core) = self.shared.core.get() {
                    core.observe_exit(child.status());
                }
            }
            self.shared.watchdog.wake();
        })
    }

    fn signal_dispose(&self) {
        let _ = self.shared.commands.try_send(Command::Shutdown);
        if let Some(child) = self.shared.child.get() {
            child.signal_kill();
            if let Some(core) = self.shared.core.get() {
                core.observe_exit(child.status());
            }
        }
        self.shared.watchdog.wake();
    }
}

pub struct AcpRuntime {
    spec: AcpAgentSpec,
}

struct Connected {
    shared: Arc<Shared>,
    opened: Opened,
}

impl AcpRuntime {
    pub fn new(spec: AcpAgentSpec) -> Self {
        Self { spec }
    }

    pub fn spec(&self) -> &AcpAgentSpec {
        &self.spec
    }

    fn flavor(&self) -> AcpFlavor {
        AcpFlavor::of(&self.spec.id)
    }

    async fn connect(&self, opts: &SessionOptions, probe_models: bool) -> Result<Connected> {
        let flavor = self.flavor();
        let binary = opts.binary(&self.spec.command)?;
        let spawn_args = match flavor {
            AcpFlavor::Generic => self.spec.args.clone(),
            AcpFlavor::Antigravity => antigravity::spawn_args(&self.spec.args, opts),
        };
        let spawn_env = match flavor {
            AcpFlavor::Generic => opts.env.clone(),
            AcpFlavor::Antigravity => antigravity::spawn_env(opts),
        };
        let (commands_tx, commands_rx) = mpsc::channel(ACP_COMMAND_CHANNEL_CAPACITY);
        let shared = Arc::new(Shared {
            runtime_id: self.spec.id.clone(),
            flavor,
            child: OnceLock::new(),
            core: OnceLock::new(),
            acp_session: OnceLock::new(),
            session_title: Mutex::new(None),
            base_dir: OnceLock::new(),
            db_path: OnceLock::new(),
            auth_notice: OnceLock::new(),
            projector: Mutex::new(Projector::for_flavor(flavor)),
            pending: Mutex::new(HashMap::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            next_permission: AtomicU64::new(1),
            permission_mode: Mutex::new(opts.permission_mode),
            available_modes: Mutex::new(Vec::new()),
            config_options: Mutex::new(Vec::new()),
            turn: AcpTurnMachine::new(),
            watchdog: AbortWatchdog::new(),
            image_input: AtomicBool::new(false),
            background: Mutex::new(antigravity::BackgroundTracker::default()),
            has_child_activity: AtomicBool::new(false),
            child_activity: Mutex::new(antigravity::ChildActivityTracker::default()),
            swarm_reader: Mutex::new(None),
            turn_start_step_idx: Mutex::new(None),
            children: Default::default(),
            updates: Default::default(),
            commands: commands_tx,
            cwd: opts.cwd.clone(),
        });
        let (incoming_tx, incoming_rx) = mpsc::channel::<Option<std::io::Result<String>>>(ACP_INCOMING_CHANNEL_CAPACITY);
        let (ready_tx, mut ready_rx) = mpsc::channel(2);
        let on_line = {
            let incoming = incoming_tx.clone();
            let shared = shared.clone();
            let ready_auth = ready_tx.clone();
            move |line: String| {
                let incoming = incoming.clone();
                let shared = shared.clone();
                let ready_auth = ready_auth.clone();
                async move {
                    if flavor == AcpFlavor::Antigravity
                        && let Some(url) = antigravity::auth_url_line(&line)
                    {
                        let msg = format!("antigravity requires login before opening an ACP session; run `agy acp --login` (auth URL: {url})");
                        let _ = shared.auth_notice.set(msg.clone());
                        let _ = ready_auth.try_send(Err(AgentError::NotAvailable(msg)));
                        if let Some(child) = shared.child.get() {
                            child.kill().await;
                        }
                        return;
                    }
                    // Reserve capacity first so stdout reading applies backpressure when
                    // the connection consumer falls behind and keeps `shared.updates` bounded.
                    let Ok(permit) = incoming.reserve().await else {
                        return;
                    };
                    if let Ok(v) = serde_json::from_str::<Value>(&line)
                        && v["method"] == "session/update"
                    {
                        shared.updates.lock().push_back(line.clone());
                    }
                    permit.send(Some(Ok(line)));
                }
            }
        };
        // Closing the stream is how the connection learns the agent is gone.
        let on_exit = move |_code: Option<i32>, _stderr: String| async move {
            let _ = incoming_tx.send(None).await;
        };
        let child = LineChild::spawn(
            Spawn {
                label: &self.spec.id,
                binary: &binary,
                args: spawn_args.clone(),
                cwd: &opts.cwd,
                env: &spawn_env,
                options: Some(opts),
                env_remove: &[],
            },
            on_line,
            on_exit,
        )?;
        let _ = shared.child.set(child.clone());
        crate::rt::current_or_global_handle().spawn(run_connection(
            shared.clone(),
            child.clone(),
            incoming_rx,
            opts.clone(),
            probe_models,
            commands_rx,
            ready_tx,
        ));
        match tokio::time::timeout(opts.request_timeout.unwrap_or(OPEN_TIMEOUT), ready_rx.recv()).await {
            Ok(Some(Ok(opened))) => {
                if flavor == AcpFlavor::Antigravity
                    && let Some((gemini_dir, app_data_dir)) = antigravity::resolve_db_dirs(&spawn_args, &spawn_env, opts.base_env.as_deref())
                {
                    if let Some(base) = antigravity_db::base_data_dir(&gemini_dir, &app_data_dir) {
                        let reader = antigravity_swarm::SwarmReader::new(base.clone(), opened.session_id.clone());
                        if reader.has_swarm_file() {
                            shared.has_child_activity.store(true, Ordering::SeqCst);
                        }
                        *shared.swarm_reader.lock() = Some(reader);
                        let _ = shared.base_dir.set(base);
                    }
                    if let Some(path) = antigravity_db::conversation_db_path(&opened.session_id, &gemini_dir, &app_data_dir) {
                        let _ = shared.db_path.set(path);
                    }
                }
                Ok(Connected { shared, opened })
            }
            Ok(Some(Err(error))) => {
                child.kill().await;
                Err(error)
            }
            Ok(None) | Err(_) => {
                child.kill().await;
                Err(AgentError::Protocol(format!("{} did not open a session in time", self.spec.id)))
            }
        }
    }
}

impl Runtime for AcpRuntime {
    fn id(&self) -> &str {
        &self.spec.id
    }

    fn display_name(&self) -> &str {
        &self.spec.display_name
    }

    /// What the adapter can do with an agent that offers it; the agent's own
    /// capabilities are only known after `initialize`, so `resume` and
    /// `model` can still be refused at open.
    fn capabilities(&self) -> Capabilities {
        if let Some(spec) = runtime_spec(self.id()) {
            return spec.capabilities;
        }
        Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        }
    }

    fn installation(&self) -> BoxFuture<'_, Installation> {
        Box::pin(async move {
            let Some(path) = find_binary(&self.spec.command) else {
                return Installation::NotInstalled;
            };
            let version = run_capture(&path, &["--version"], Duration::from_secs(15))
                .await
                .and_then(|out| out.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string));
            match self.flavor() {
                AcpFlavor::Generic => Installation::Available { version, path },
                AcpFlavor::Antigravity => antigravity::check_installation(path, version),
            }
        })
    }

    fn account_usage(&self) -> BoxFuture<'_, Result<AccountUsage>> {
        Box::pin(async move {
            match self.flavor() {
                AcpFlavor::Antigravity => {
                    let Some(path) = find_binary(&self.spec.command) else {
                        return Ok(AccountUsage::Unsupported {
                            reason: "not_installed".into(),
                        });
                    };
                    antigravity::read_account_usage(&path).await
                }
                AcpFlavor::Generic => Ok(AccountUsage::Unsupported {
                    reason: "not_supported".into(),
                }),
            }
        })
    }

    /// Opens a throwaway session in the temp directory to read the agent's
    /// model list (ACP has no other way to ask).
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>> {
        Box::pin(async move {
            let opts = SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            };
            let connected = self.connect(&opts, true).await?;
            let _ = connected.shared.commands.try_send(Command::Shutdown);
            if let Some(child) = connected.shared.child.get() {
                child.kill().await;
            }
            Ok(connected.opened.probed_models.unwrap_or_else(|| models_of(&connected.opened.session)))
        })
    }

    fn open(&self, mut opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>> {
        Box::pin(async move {
            opts.prepare(self.id())?;
            let file = record::open_file(opts.record_to.as_deref())?;
            let Connected { shared, opened } = self.connect(&opts, false).await?;
            let recorder = Recorder::start(file, &self.spec.id, &opened.session_id, &opts.cwd, opened.model.as_deref());
            let core = SessionCore::new(&self.spec.id, &opened.session_id, recorder);
            if opts.resume.is_some() && self.flavor() == AcpFlavor::Generic {
                core.resume_meter(&Value::Null, "acp_resume_baseline_unknown");
            }
            core.emit_root(EventKind::SessionStarted {
                session_id: opened.session_id.clone(),
                model: opened.model.clone(),
            });
            let _ = shared.core.set(core.clone());
            // The connection may have died between the handshake and here.
            if shared.commands.is_closed() {
                core.finish(Some(format!("{} closed the connection", self.spec.id)));
            }
            Ok(CoreSession::new(core, AcpDriver { shared }, self.capabilities()) as Arc<dyn Session>)
        })
    }
}
