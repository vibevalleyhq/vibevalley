//! The built-in `vibevalley` runtime: VibeValley's own agent (`vibevalley_runtime::agent`) on
//! DeepSeek, driven by the durable execution harness and extension system.

mod driver;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tokio::sync::Mutex as AsyncMutex;

use crate::BoxFuture;
use crate::oar::core::check_cwd;
use crate::oar::record::{self, Recorder};
use crate::oar::{
    AccountUsage, AgentError, Capabilities, EventKind, Installation, ModelInfo, PermissionMode, Registry, Result, Runtime, Session, SessionOptions, mcp_config,
};

use crate::agent::ai::OpenAiClient;
use crate::agent::ai::models::{DEFAULT_MODEL, catalog, find_model};
use crate::agent::ai::types::ModelClient;
use crate::agent::core::events::Brain;
use crate::agent::extensions::budget::BudgetExtension;
use crate::agent::extensions::governance::GovernanceExtension;
use crate::agent::extensions::grader::GraderExtension;
use crate::agent::extensions::subagent::{SpawnAgent, SubagentExtension};
use crate::agent::extensions::todo::{TodoExtension, todo_tools};
use crate::agent::harness::{Harness, SharedExecution, WorkersOnly, worker_conversation};
use crate::agent::resources::mcp::{McpConfig, McpHub};
use crate::agent::resources::skills::{LoadSkill, default_skill_dirs, scan_skills, skill_index};
use crate::agent::tools::{TypedToolAdapter, Workspace, coding_tools, read_only_tools};

pub const ID: &str = "vibevalley";

const SYSTEM: &str = "You are a careful software engineer working in the user's repository through tools. \
    Read before you change; keep changes small and focused; run the project's tests when they exist; \
    say plainly what you did and what you could not do.";

/// Registry with every external OAR runtime plus the built-in `vibevalley` runtime.
pub fn default_registry() -> Registry {
    let mut registry = crate::oar::default_runtimes();
    registry.register(Arc::new(VibeValleyRuntime::from_env()));
    registry
}

pub type KeySource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct VibeValleyRuntime {
    key: KeySource,
    /// Directory of standalone worker data.
    dir: PathBuf,
    client: Option<Arc<dyn ModelClient>>,
    execution: Arc<OnceLock<SharedExecution>>,
    init: AsyncMutex<()>,
}

impl VibeValleyRuntime {
    /// Reads `DEEPSEEK_API_KEY` or `<home>/settings.json`; conversations under `<home>/conversations`.
    pub fn from_env() -> VibeValleyRuntime {
        let dir = vibevalley_protocol::home::home().join("conversations");
        VibeValleyRuntime::new(
            Arc::new(|| {
                std::env::var("DEEPSEEK_API_KEY")
                    .ok()
                    .map(|k| k.trim().to_string())
                    .filter(|k| !k.is_empty())
                    .or_else(|| vibevalley_protocol::home::saved_deepseek_key(&vibevalley_protocol::home::home()))
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

    async fn execution(&self) -> Result<SharedExecution> {
        if let Some(shared) = self.execution.get() {
            return Ok(shared.clone());
        }
        let _init = self.init.lock().await;
        if let Some(shared) = self.execution.get() {
            return Ok(shared.clone());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| AgentError::Io(e.to_string()))?;
        let store = crate::agent::durable::Store::open(&self.dir.join("execution.db"))
            .await
            .map_err(|e| AgentError::Io(e.to_string()))?;
        let harness = Harness::from_store(store, Arc::new(WorkersOnly));
        harness.register_extension(Arc::new(GovernanceExtension::default()));
        harness.register_extension(Arc::new(BudgetExtension));
        harness.register_extension(Arc::new(GraderExtension::default()));
        harness.register_extension(Arc::new(TodoExtension::default().without_global_tools()));
        harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
        harness.recover().await.map_err(|e| AgentError::Io(e.to_string()))?;
        Ok(self.execution.get_or_init(|| SharedExecution::new(harness)).clone())
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
        crate::oar::runtime_spec(ID).expect("vibevalley runtime spec").capabilities
    }

    fn installation(&self) -> BoxFuture<'_, Installation> {
        let status = if self.client.is_some() || (self.key)().is_some_and(|k| !k.trim().is_empty()) {
            Installation::Available {
                version: Some(env!("CARGO_PKG_VERSION").into()),
                path: PathBuf::from("(built in)"),
            }
        } else {
            Installation::Unusable {
                reason: "no DeepSeek API key is set".into(),
            }
        };
        Box::pin(std::future::ready(status))
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>> {
        let models = catalog()
            .iter()
            .map(|spec| {
                let mut info = ModelInfo::new(spec.id, spec.display_name);
                info.effort_levels = spec.effort_levels.iter().map(|s| (*s).to_string()).collect();
                info.is_default = spec.is_default;
                info
            })
            .collect();
        Box::pin(std::future::ready(Ok(models)))
    }

    fn account_usage(&self) -> BoxFuture<'_, Result<AccountUsage>> {
        Box::pin(async move {
            if self.client.is_some() {
                return Ok(AccountUsage::Unsupported {
                    reason: "capability_unavailable".into(),
                });
            }
            let Some(key) = (self.key)().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) else {
                return Ok(AccountUsage::ReauthRequired {
                    reason: "credentials_missing".into(),
                });
            };
            let client = OpenAiClient::deepseek(move || Some(key.clone()));
            match client.fetch_balance().await {
                Ok(balance) => {
                    let summary = balance
                        .balance_infos
                        .iter()
                        .map(|b| format!("{:.2} {}", b.total_balance, b.currency))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let plan = if summary.is_empty() {
                        "DeepSeek API".into()
                    } else {
                        format!("DeepSeek API ({summary})")
                    };
                    Ok(AccountUsage::Available {
                        plan: Some(plan),
                        email: None,
                        rate_limited: !balance.is_available,
                        windows: Vec::new(),
                    })
                }
                Err(err) => Ok(AccountUsage::Unsupported { reason: err.to_string() }),
            }
        })
    }

    fn open(&self, opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>> {
        Box::pin(async move {
            check_cwd(&opts.cwd)?;
            let requested_model = opts.model.as_deref().filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL);
            let Some(model_spec) = find_model(requested_model) else {
                return Err(AgentError::Unsupported {
                    option: "model".into(),
                    reason: format!("{ID} has no model `{requested_model}`"),
                });
            };
            let model = model_spec.id.to_string();
            let shared = self.execution().await?;
            if let Some(id) = &opts.resume {
                if !id.starts_with("vv-") || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    return Err(AgentError::Rejected(format!("session_not_found: {id}")));
                }
                let conv = worker_conversation(id);
                match shared
                    .store()
                    .read_async(move |tx| Box::pin(async move { tx.conversation_async(&conv).await }))
                    .await
                {
                    Err(crate::agent::durable::Error::Missing(_)) => {
                        return Err(AgentError::Rejected(format!("session_not_found: {id}")));
                    }
                    Ok(_) => (),
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
            let dirs = default_skill_dirs(&opts.cwd);
            let skills = scan_skills(&dirs);
            if !skills.is_empty() {
                system.push_str("\n\n## 技能\n");
                system.push_str(&skill_index(&skills, 160));
            }
            let workspace = Workspace {
                env: opts.env.clone(),
                ..Workspace::new(&opts.cwd)
            };
            let mut brain = Brain::new(self.client(), &model, system);
            brain.effort = opts.effort.clone();
            brain.cwd = Some(opts.cwd.clone());
            brain.tools = if opts.permission_mode == PermissionMode::Plan {
                read_only_tools(&workspace)
            } else {
                coding_tools(&workspace)
            };
            brain.tools.push(Box::new(LoadSkill {
                skills: Box::new(move || scan_skills(&dirs)),
            }));
            brain.tools.extend(todo_tools(Default::default()));
            if opts.permission_mode != PermissionMode::Plan {
                brain.tools.push(Box::new(TypedToolAdapter(SpawnAgent { parent: "VibeValley".into() })));
            }
            if !opts.mcp_servers.is_empty() {
                let config: McpConfig = serde_json::from_value(mcp_config(&opts.mcp_servers)).map_err(|e| AgentError::Unsupported {
                    option: "mcp_servers".into(),
                    reason: e.to_string(),
                })?;
                // The tools keep their servers alive; a server that failed to
                // connect is simply absent, as in VibeValley's connectAll.
                brain.tools.extend(McpHub::connect(&config).await.tools());
            }
            brain.tools.retain(|t| !opts.disallowed_tools.iter().any(|name| *name == t.spec().name));
            let file = record::open_file(opts.record_to.as_deref())?;
            let recorder = Recorder::start(file, ID, &session_id, &opts.cwd, Some(&model));
            let core = crate::oar::core::SessionCore::new(ID, &session_id, recorder);
            core.emit_root(EventKind::SessionStarted {
                session_id: session_id.clone(),
                model: Some(model.clone()),
            });
            driver::WorkerDriver::open(shared, &session_id, brain, core, opts.cwd, opts.permission_mode, self.capabilities()).await
        })
    }
}
