use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{ExecutionPolicy, NoticeLevel, ORCHESTRATOR_RUNTIME, Session, SessionController};
use vibevalley_runtime::agent::extensions::governance::Permissions;
use vibevalley_runtime::agent::{ModelClient, OpenAiClient};

use super::execution::{Execution, PendingExecution};
use super::inbox::RuntimeInboxObserver;
use super::mcp;
use super::types::Instance;
use crate::agent::memory::Memory;
use crate::agent::profile::Profile;
use crate::agent::tool::{Route, ToolRegistry};
use crate::channel::Chat;
use crate::context::Context;
use crate::issue::Board;
use crate::note::Manager as NoteManager;
use crate::repo::Repo;
use crate::runtime::Runtime;

const DEFAULT_MODEL: &str = "deepseek-flash";
const SKILLS: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets/orchestrator/skills");

/// A live answer: the turn's words as they are said, ending with the turn.
/// Dropped, it stops waiting.
pub struct Reply {
    pub(super) id: String,
    pub(super) words: mpsc::UnboundedReceiver<String>,
    pub(super) orchestrator: Weak<Orchestrator>,
}

impl Reply {
    /// The next words, none once the turn is over or nothing came in `wait`.
    pub async fn next_async(&mut self, wait: std::time::Duration) -> Option<String> {
        tokio::time::timeout(wait, self.words.recv()).await.ok().flatten()
    }

    /// Everything said until the turn ends, or what came within `wait` of each other.
    pub async fn whole_async(&mut self, wait: std::time::Duration) -> String {
        let mut said = vec![];
        while let Some(words) = self.next_async(wait).await {
            said.push(words);
        }
        said.join("\n").trim().to_string()
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if let Some(o) = self.orchestrator.upgrade() {
            o.ports.lock().remove(&self.id);
        }
    }
}

pub struct Orchestrator {
    pub(super) me: Weak<Orchestrator>,
    pub(super) ctx: Arc<Context>,
    pub(super) tool: Arc<ToolRegistry>,
    pub(super) profile: Arc<Profile>,
    pub(super) chat: Arc<Chat>,
    pub(super) issue: Arc<Board>,
    pub(super) runtime: Arc<Runtime>,
    pub(super) repo: Arc<Repo>,
    pub(super) memory: Arc<Memory>,
    pub(super) note: Arc<NoteManager>,
    pub(super) home: PathBuf,
    pub(super) key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub(super) client: Option<Arc<dyn ModelClient>>,
    pub(super) instances: Mutex<HashMap<String, Arc<Instance>>>,
    pub execution: Execution,
    pub(super) mcp: mcp::ProfileServers,
    /// The live answers not yet taken by a turn.
    pub(super) ports: Mutex<HashMap<String, mpsc::UnboundedSender<String>>>,
    pub(super) chat_listener: Mutex<Option<(CancellationToken, TaskHandle<()>)>>,
    pub(super) closed: AtomicBool,
}

/// Dependencies required to open [`Orchestrator`].
pub struct Parts {
    pub ctx: Arc<Context>,
    pub pending_execution: Option<PendingExecution>,
    pub permissions: Permissions,
    pub tool: Arc<ToolRegistry>,
    pub profile: Arc<Profile>,
    pub chat: Arc<Chat>,
    pub issue: Arc<Board>,
    pub runtime: Arc<Runtime>,
    pub repo: Arc<Repo>,
    pub memory: Arc<Memory>,
    pub note: Arc<NoteManager>,
    pub home: PathBuf,
    /// The DeepSeek key, read at each turn.
    pub key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Talks to this model instead of DeepSeek (tests).
    pub client: Option<Arc<dyn ModelClient>>,
    /// Whether to start listening to orchestrator-targeted dispatches from `chat` on open.
    pub listen_chat: bool,
}

impl Orchestrator {
    /// Starts projecting durable `pi.inbox` alerts into `ctx.live` and `SliceMask::INBOX`.
    pub async fn start_inbox_observer(&self) -> vibevalley_runtime::agent::durable::Result<()> {
        RuntimeInboxObserver::start_async(self.execution.store(), &self.ctx).await
    }

    pub async fn ensure_open_async(&self) {
        for a in self.profile.orchestrators() {
            self.keep_on_duty_async(&a).await;
        }
    }

    async fn ensure_skills_dir_async(&self, id: &str) {
        let skills_dir = self.home.join("agent").join(id).join("skills");
        if tokio::fs::try_exists(&skills_dir).await.unwrap_or(false) {
            return;
        }
        let _ = tokio::fs::create_dir_all(&skills_dir).await;
        let _ = crate::log::spawn_blocking_traced(move || SKILLS.extract(&skills_dir)).await;
    }

    /// `keepOnDuty`: ensures an orchestrator's standing session is persisted.
    pub(super) async fn keep_on_duty_async(&self, a: &vibevalley_protocol::Agent) {
        self.ensure_skills_dir_async(&a.id).await;
        let name = if a.name.trim().is_empty() {
            t("server.channel.name.orchestrator", &[])
        } else {
            a.name.trim().to_string()
        };
        let kept = self.ctx.service.session.get(&a.id).await.ok().flatten();
        if kept.as_ref().is_some_and(|k| k.name == name) {
            return;
        }
        let at = self.ctx.now();
        let session = match kept {
            Some(k) => Session { name, ..k },
            None => {
                let mut s = Session::new(
                    &a.id,
                    SessionController::Orchestrator,
                    name,
                    ORCHESTRATOR_RUNTIME,
                    ExecutionPolicy::SandboxDir,
                    at,
                );
                s.profile = Some(a.id.clone());
                s.brief = a.duty.clone();
                s
            }
        };
        if let Err(e) = self.runtime.upsert_orchestrator_async(&session).await {
            self.ctx.live.publish_notice(at, NoticeLevel::Warn, e.to_string());
            return;
        }
        self.ctx.mark_dirty(SliceMask::SESSIONS | SliceMask::BOARD | SliceMask::FARM);
    }

    /// The orchestrator `agent` names, or the default one.
    pub(super) fn target(&self, agent: Option<&str>) -> String {
        match agent {
            Some(a) if self.profile.is_orchestrator(a) => a.to_string(),
            _ => vibevalley_protocol::DEFAULT_ORCHESTRATOR.to_string(),
        }
    }

    pub(super) fn route_of(&self, id: &str) -> Arc<Mutex<Route>> {
        if let Some(i) = self.instances.lock().get(id) {
            return i.route.clone();
        }
        Arc::new(Mutex::new(Route {
            channel: self.chat.default_channel(),
            ..Route::default()
        }))
    }

    pub(super) fn get_or_insert_instance(&self, id: &str) -> (Arc<Instance>, bool) {
        let mut all = self.instances.lock();
        if let Some(i) = all.get(id) {
            return (i.clone(), false);
        }
        let me = Arc::new(Instance {
            id: id.to_string(),
            pending: AtomicBool::new(false),
            more: Arc::new(Notify::new()),
            route: Arc::new(Mutex::new(Route {
                channel: self.chat.default_channel(),
                ..Route::default()
            })),
            shown: ArcSwap::from_pointee(String::new()),
            cannot: Default::default(),
            news: Default::default(),
        });
        all.insert(id.to_string(), me.clone());
        (me, true)
    }

    pub(super) fn open_port(self: &Arc<Self>) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, words) = mpsc::unbounded_channel();
        self.ports.lock().insert(id.clone(), tx);
        Reply {
            id,
            words,
            orchestrator: Arc::downgrade(self),
        }
    }

    /// `stop`: ends its turn under way and drops what waits for it.
    pub async fn stop_async(&self, agent: Option<&str>) {
        let id = self.target(agent);
        let Some(me) = self.instances.lock().get(&id).cloned() else { return };
        me.pending.store(false, Ordering::SeqCst);
        let _ = self.execution.stop_async(&id).await;
    }

    pub(super) fn model_of(&self, id: &str) -> Result<String, String> {
        let configured = self.profile.agent(id).map(|a| a.model.trim().to_string()).unwrap_or_default();
        if configured.is_empty() {
            return Ok(DEFAULT_MODEL.into());
        }
        match configured.split_once('/') {
            None => Ok(configured),
            Some(("deepseek", m)) => Ok(m.to_string()),
            Some(_) => Err(t("server.orchestrator.onlyDeepseek", &[("configured", configured.clone().into())])),
        }
    }

    pub(super) fn client(&self) -> Arc<dyn ModelClient> {
        self.client.clone().unwrap_or_else(|| {
            let key = self.key.clone();
            Arc::new(OpenAiClient::deepseek(move || key()))
        })
    }
}
