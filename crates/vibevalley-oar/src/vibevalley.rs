//! The built-in `vibevalley` runtime: VibeValley's own agent (`vibevalley-agent`) on
//! DeepSeek, needing only an API key. VibeValley's equivalent is its
//! `vibevalley` farm machine on pi-durable (`modules/agent/vibevalley.ts`):
//! one conversation per session, resumed by session id, a turn cut short by
//! a crash finished when the session is opened again, no permission
//! prompts.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use vibevalley_agent::generation::{
    Generation,
    workers::{SharedExecution, WorkersOnly, worker_conversation},
};
#[path = "vibevalley_execution.rs"]
mod execution;

use serde_json::Value;
use vibevalley_agent::price::{charge_usd, deepseek_price};
use vibevalley_agent::{Brain, BrainEvent, Conversation, ModelClient, OpenAiClient, TurnOutcome, Workspace, coding_tools, kit};

use crate::core::{CoreSession, Driver, SessionCore, check_cwd, render_text};
use crate::record::{self, Recorder};
use crate::{
    AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, ModelInfo, PermissionDecision, PermissionMode, Result, Runtime, Session,
    SessionOptions, StopReason, Usage,
};

pub const ID: &str = "vibevalley";
const MODELS: [(&str, &str); 2] = [("deepseek-flash", "DeepSeek Flash"), ("deepseek-v4-pro", "DeepSeek V4 Pro")];

const SYSTEM: &str = "You are a careful software engineer working in the user's repository through tools. \
    Read before you change; keep changes small and focused; run the project's tests when they exist; \
    say plainly what you did and what you could not do.";

pub type KeySource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct VibeValleyRuntime {
    key: KeySource,
    /// Directory of standalone worker data.
    dir: PathBuf,
    client: Option<Arc<dyn ModelClient>>,
    execution: Arc<OnceLock<SharedExecution>>,
    init: Mutex<()>,
}

impl VibeValleyRuntime {
    /// Reads `DEEPSEEK_API_KEY` or `<home>/settings.json`; conversations under `<home>/conversations`.
    pub fn from_env() -> VibeValleyRuntime {
        let dir = vibevalley_home::home().join("conversations");
        VibeValleyRuntime::new(
            Arc::new(|| {
                std::env::var("DEEPSEEK_API_KEY")
                    .ok()
                    .map(|k| k.trim().to_string())
                    .filter(|k| !k.is_empty())
                    .or_else(|| vibevalley_home::saved_deepseek_key(&vibevalley_home::home()))
            }),
            dir,
        )
    }

    pub fn new(key: KeySource, dir: PathBuf) -> VibeValleyRuntime {
        VibeValleyRuntime {
            key,
            dir,
            client: None,
            execution: Default::default(),
            init: Default::default(),
        }
    }

    pub fn with_execution(mut self, execution: Arc<OnceLock<SharedExecution>>) -> Self {
        self.execution = execution;
        self
    }

    fn execution(&self) -> Result<SharedExecution> {
        if let Some(shared) = self.execution.get() {
            return Ok(shared.clone());
        }
        let _init = self.init.lock().unwrap();
        if let Some(shared) = self.execution.get() {
            return Ok(shared.clone());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| AgentError::Io(e.to_string()))?;
        let store = vibevalley_durable::Store::open(&self.dir.join("execution.db")).map_err(|e| AgentError::Io(e.to_string()))?;
        let scheduler = vibevalley_durable::Scheduler::new(store.clone(), 32);
        let generation = Generation::new(store, Arc::new(WorkersOnly));
        generation.register(&scheduler);
        scheduler.recover().map_err(|e| AgentError::Io(e.to_string()))?;
        Ok(self.execution.get_or_init(|| SharedExecution { generation, scheduler }).clone())
    }

    /// Talks to `client` instead of DeepSeek (tests).
    pub fn with_client(mut self, client: Arc<dyn ModelClient>) -> VibeValleyRuntime {
        self.client = Some(client);
        self
    }

    fn client(&self) -> Arc<dyn ModelClient> {
        self.client.clone().unwrap_or_else(|| {
            let key = self.key.clone();
            Arc::new(OpenAiClient::deepseek(move || key()))
        })
    }
}

impl Runtime for VibeValleyRuntime {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        "VibeValley"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: false,
            model_selection: true,
            subagents: false,
            usage: true,
        }
    }

    fn installation(&self) -> Installation {
        if self.client.is_some() || (self.key)().is_some_and(|k| !k.trim().is_empty()) {
            Installation::Available {
                version: Some(env!("CARGO_PKG_VERSION").into()),
                path: PathBuf::from("(built in)"),
            }
        } else {
            Installation::Unusable {
                reason: "no DeepSeek API key is set".into(),
            }
        }
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Ok(MODELS.iter().map(|(id, name)| ModelInfo::new(*id, *name)).collect())
    }

    /// Plan mode gets read-only tools; every other mode runs without asking
    /// (the runtime has no permission prompts, as in VibeValley).
    fn open(&self, opts: SessionOptions) -> Result<Arc<dyn Session>> {
        check_cwd(&opts.cwd)?;
        let model = opts.model.clone().unwrap_or_else(|| MODELS[0].0.to_string());
        if !MODELS.iter().any(|(id, _)| *id == model) {
            return Err(AgentError::Unsupported {
                option: "model".into(),
                reason: format!("{ID} has no model `{model}`"),
            });
        }
        let shared = self.execution()?;
        if let Some(id) = &opts.resume {
            if !id.starts_with("vv-") || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err(AgentError::Rejected(format!("session_not_found: {id}")));
            }
            match shared.generation.store.read(|tx| tx.conversation(&worker_conversation(id))) {
                Err(vibevalley_durable::Error::Missing(_)) if !self.dir.join(format!("{id}.jsonl")).is_file() => {
                    return Err(AgentError::Rejected(format!("session_not_found: {id}")));
                }
                Err(vibevalley_durable::Error::Missing(_)) | Ok(_) => (),
                Err(e) => return Err(AgentError::Io(e.to_string())),
            }
        }
        let session_id = opts.resume.clone().unwrap_or_else(|| format!("vv-{}", uuid::Uuid::new_v4()));
        let mut system = opts.system_prompt.clone().unwrap_or_else(|| SYSTEM.to_string());
        if let Some(extra) = &opts.append_system_prompt {
            system.push_str("\n\n");
            system.push_str(extra);
        }
        // As VibeValley's helper: skills from the usual folders, its own
        // task graph; memory belongs to the session's owner, not here.
        let dirs = kit::default_skill_dirs(&opts.cwd);
        let skills = kit::scan_skills(&dirs);
        if !skills.is_empty() {
            system.push_str("\n\n## 技能\n");
            system.push_str(&kit::skill_index(&skills, 160));
        }
        let workspace = Workspace {
            env: opts.env.clone(),
            ..Workspace::new(&opts.cwd)
        };
        let mut brain = Brain::new(self.client(), &model, system);
        brain.effort = opts.effort.clone();
        brain.tools = if opts.permission_mode == PermissionMode::Plan {
            coding_tools(&workspace).into_iter().filter(|t| t.spec().name == "read").collect()
        } else {
            coding_tools(&workspace)
        };
        brain.tools.push(Box::new(kit::LoadSkill {
            skills: Box::new(move || kit::scan_skills(&dirs)),
        }));
        brain.tools.extend(kit::todo_tools(Default::default()));
        if opts.permission_mode != PermissionMode::Plan {
            // Helpers get the coding tools and the task graph, not spawn_agent.
            let helper_ws = workspace.clone();
            brain.tools.push(Box::new(kit::SpawnAgent {
                parent: "VibeValley".into(),
                client: self.client(),
                model: model.clone(),
                tools: Arc::new(move || {
                    let mut tools = coding_tools(&helper_ws);
                    tools.extend(kit::todo_tools(Default::default()));
                    tools
                }),
                dir: self.dir.join(format!("{session_id}.helpers")),
            }));
        }
        if !opts.mcp_servers.is_empty() {
            let config: vibevalley_agent::mcp::McpConfig =
                serde_json::from_value(crate::mcp_config(&opts.mcp_servers)).map_err(|e| AgentError::Unsupported {
                    option: "mcp_servers".into(),
                    reason: e.to_string(),
                })?;
            // The tools keep their servers alive; a server that failed to
            // connect is simply absent, as in VibeValley's connectAll.
            brain.tools.extend(vibevalley_agent::mcp::McpHub::connect(&config).tools());
        }
        brain.tools.retain(|t| !opts.disallowed_tools.iter().any(|name| *name == t.spec().name));
        let file = record::open_file(opts.record_to.as_deref())?;
        let recorder = Recorder::start(file, ID, &session_id, &opts.cwd, Some(&model));
        let core = SessionCore::new(ID, &session_id, recorder);
        core.emit_root(EventKind::SessionStarted {
            session_id: session_id.clone(),
            model: Some(model.clone()),
        });
        if !self.dir.join(format!("{session_id}.jsonl")).exists() {
            return execution::WorkerDriver::open(shared, &session_id, brain, core, opts.cwd, self.capabilities());
        }
        let conversation = Conversation::open(self.dir.join(format!("{session_id}.jsonl")), brain).map_err(|e| AgentError::Io(e.to_string()))?;
        let abort = conversation.abort_handle();
        let unfinished = conversation.unfinished_turn();
        let driver = BrainDriver {
            core: core.clone(),
            conversation: Arc::new(Mutex::new(conversation)),
            abort,
            model,
            cwd: opts.cwd.clone(),
        };
        // A turn the last process left unfinished is finished now.
        if let Some(input) = unfinished {
            core.begin_turn(&input)?;
            driver.spawn(None);
        }
        Ok(CoreSession::new(core, driver, self.capabilities()))
    }
}

struct BrainDriver {
    core: Arc<SessionCore>,
    conversation: Arc<Mutex<Conversation>>,
    abort: Arc<AtomicBool>,
    model: String,
    cwd: PathBuf,
}

impl BrainDriver {
    /// Runs `input` (or resumes the unfinished turn when `None`) on a thread.
    fn spawn(&self, input: Option<String>) {
        let core = self.core.clone();
        let conversation = self.conversation.clone();
        let model = self.model.clone();
        let cwd = self.cwd.clone();
        let spawned = std::thread::Builder::new().name("vibevalley-agent-vibevalley".into()).spawn(move || {
            let mut tools: std::collections::HashMap<String, (String, Value)> = Default::default();
            let mut on = |event: BrainEvent| match event {
                BrainEvent::Text(text) => core.emit_root(EventKind::TextDelta { text }),
                BrainEvent::Reasoning(text) => core.emit_root(EventKind::ThinkingDelta { text }),
                BrainEvent::ToolStarted { id, name, arguments } => {
                    let input: Value = serde_json::from_str(&arguments).unwrap_or(Value::String(arguments));
                    tools.insert(id.clone(), (name.clone(), input.clone()));
                    core.emit_root(EventKind::ToolCallStarted { id, name, input });
                }
                BrainEvent::ToolFinished { id, output } => {
                    let ok = !output.is_error;
                    core.emit_root(EventKind::ToolCallFinished {
                        id: id.clone(),
                        ok,
                        output: output.text,
                    });
                    if ok
                        && let Some((name, input)) = tools.get(&id)
                        && (name == "write" || name == "edit")
                        && let Some(path) = input.get("path").and_then(Value::as_str)
                    {
                        let full = cwd.join(path);
                        let change = if name == "write" { FileChangeKind::Created } else { FileChangeKind::Modified };
                        core.emit_root(EventKind::FileChanged { path: full, change });
                    }
                }
                BrainEvent::Error(message) => core.emit_root(EventKind::Error { message }),
                BrainEvent::TurnFinished { outcome, usage, .. } => {
                    let reason = match outcome {
                        TurnOutcome::Completed => StopReason::Completed,
                        TurnOutcome::Aborted => StopReason::Aborted,
                        TurnOutcome::Failed => StopReason::Error,
                        TurnOutcome::TooLong => StopReason::MaxTurns,
                    };
                    let cost_usd = deepseek_price(&model).map(|p| charge_usd(p, usage));
                    let usage = Usage {
                        input_tokens: Some(usage.input),
                        output_tokens: Some(usage.output),
                        cost_usd,
                    };
                    core.emit_root(EventKind::TurnFinished { reason, usage });
                }
                BrainEvent::TurnStarted { .. } | BrainEvent::Compacted => {}
            };
            let mut conv = conversation.lock().unwrap_or_else(|p| p.into_inner());
            let result = match input {
                Some(input) => conv.send(&input, &mut on),
                None => conv.resume(&mut on).unwrap_or(Ok(TurnOutcome::Completed)),
            };
            if let Err(e) = result {
                on(BrainEvent::Error(e.to_string()));
                on(BrainEvent::TurnFinished {
                    outcome: TurnOutcome::Failed,
                    usage: Default::default(),
                    text: String::new(),
                });
            }
        });
        if let Err(e) = spawned {
            self.core.emit_root(EventKind::Error { message: e.to_string() });
        }
    }
}

impl Driver for BrainDriver {
    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.abort.store(false, Ordering::SeqCst);
        self.spawn(Some(render_text(&content)));
        Ok(())
    }

    fn steer(&self, _content: Vec<ContentBlock>) -> Result<()> {
        Err(AgentError::Unsupported {
            option: "steer".into(),
            reason: "the vibevalley runtime queues instead".into(),
        })
    }

    fn abort(&self) -> Result<()> {
        self.abort.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn respond_permission(&self, request_id: &str, _decision: &PermissionDecision) -> Result<()> {
        Err(AgentError::Rejected(format!("unknown_request: {request_id}")))
    }

    fn dispose(&self) {
        self.abort.store(true, Ordering::SeqCst);
    }
}
