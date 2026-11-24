//! The whole server in one call: one shared `ServerDb`, the runtimes, the settings,
//! the profiles, the board and every module's endpoints wired bottom-up (L0 -> L1 -> L2 -> L3)
//! on one hub with zero post-init cycle-breaking hooks.

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_runtime::oar::Registry;

use crate::Hub;
use crate::app::hub::ports::{ChannelQuotePort, CronOrchestratorPort};
use crate::db::ServerDb;
use crate::{
    collab, content, infra,
    infra::setting::{Setting, SettingConfig},
    skin, team,
    team::agent::Agents,
    work,
    work::issue::Board,
    work::ledger::BoardConfig,
};

/// What the server starts with (VibeValley's `ServerConfig`, the parts
/// VibeValley reads).
#[derive(Clone)]
pub struct ServerConfig {
    /// The farm's home: `settings.json`, `config.json`, `server.db`,
    /// `issues/` (records, reports).
    pub home: PathBuf,
    /// Repos and worktrees live under it.
    pub work_root: PathBuf,
    pub version: String,
    /// Given outside the settings file (`DEEPSEEK_API_KEY`); the file's wins.
    pub deepseek_api_key: String,
    /// Built-in templates a new farm installs beside its orchestrator.
    pub starters: Vec<String>,
    /// The runtimes; none is every built-in one, VibeValley's own reading
    /// the DeepSeek key from the settings.
    pub registry: Option<Arc<Registry>>,
    pub tool_permissions: vibevalley_runtime::agent::extensions::governance::Permissions,
    /// Probe every runtime at start, in the background.
    pub probe_runtimes: bool,
    /// Optional hosted-branch publisher override (offline tests).
    pub publisher: Option<Arc<work::pull::Publisher>>,
    /// Poll open PRs every N seconds (`None` disables the background poller).
    pub poll_pulls: Option<u64>,
    /// Runs due crons every 20 s (`tickCrons`).
    pub tick_crons: bool,
    /// Reads link previews for chat messages off the web.
    pub link_previews: bool,
    /// Commits by these addresses count as the user's too (`gitEmails`).
    pub git_emails: Vec<String>,
    /// The vendors answered offline (the page's tests): `offline::network()`.
    pub offline_media: bool,
    /// How the media vendor is reached and its results fetched, in place of the network: a test keeps one across
    /// restarts, so the vendor remembers what it was asked.
    pub media_network: Option<(Arc<dyn infra::http::Fetch>, Arc<dyn infra::http::Fetch>)>,
    /// The orchestrator and built-in workers can share an offline model.
    pub model_client: Option<Arc<dyn vibevalley_runtime::agent::ModelClient>>,
    /// The orchestrator hears the farm (VibeValley `listen`); a test without
    /// a model turns it off, so nothing answers in the chat.
    pub orchestrator_listens: bool,
    /// How the chat apps are reached and paced; tests point it at local stubs.
    pub connector: collab::connector::Options,
    /// Enables DevTools diagnostics (`debug.*` endpoints, timeline observer, fault gate).
    pub debug_enabled: bool,
    /// Optional database URL (`VIBEVALLEY_DATABASE_URL`, `--database-url`) overriding `<home>/server.db`.
    pub database_url: Option<String>,
    /// Wall clock for domain timers/TTLs (`cron`, `remote`, `media`, `issue`, `game`).
    pub clock: vibevalley_core::SharedClock,
}

impl ServerConfig {
    /// The space: `VIBEVALLEY_WORK_ROOT`, else `~/vibevalley-dev`.
    pub fn work_root_from(said: Option<std::ffi::OsString>, user_home: Option<std::ffi::OsString>) -> PathBuf {
        if let Some(root) = said.filter(|v| !v.is_empty()) {
            return PathBuf::from(root);
        }
        user_home.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/")).join("vibevalley-dev")
    }

    pub fn default_work_root() -> PathBuf {
        Self::work_root_from(std::env::var_os("VIBEVALLEY_WORK_ROOT"), std::env::var_os("HOME"))
    }

    /// A farm whose home and work root are both `dir`.
    pub fn under(dir: impl Into<PathBuf>) -> ServerConfig {
        let dir = dir.into();
        ServerConfig {
            home: dir.clone(),
            work_root: dir,
            version: env!("CARGO_PKG_VERSION").into(),
            deepseek_api_key: String::new(),
            starters: vec![],
            registry: None,
            tool_permissions: Default::default(),
            probe_runtimes: true,
            publisher: None,
            poll_pulls: None,
            tick_crons: true,
            link_previews: true,
            git_emails: vec![],
            model_client: None,
            offline_media: false,
            media_network: None,
            orchestrator_listens: true,
            connector: collab::connector::Options::default(),
            debug_enabled: false,
            database_url: None,
            clock: vibevalley_core::system_clock(),
        }
    }

    /// Reads the process environment (`VIBEVALLEY_*`, `DEEPSEEK_API_KEY`) so
    /// standalone `vibevalley-server` and `vibevalley-mac` share one
    /// configuration path.
    pub fn from_env(home: impl Into<PathBuf>, version: impl Into<String>) -> ServerConfig {
        let env_str = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let csv = |name: &str| -> Vec<String> {
            env_str(name)
                .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
                .unwrap_or_default()
        };
        let home = home.into();
        let mut config = ServerConfig {
            work_root: Self::default_work_root(),
            version: version.into(),
            deepseek_api_key: env_str("DEEPSEEK_API_KEY").unwrap_or_default(),
            starters: csv("VIBEVALLEY_AGENT_STARTERS"),
            git_emails: csv("VIBEVALLEY_GIT_EMAILS"),
            poll_pulls: Some(env_str("VIBEVALLEY_GITHUB_PR_POLL_SECONDS").and_then(|s| s.parse::<u64>().ok()).unwrap_or(180)),
            debug_enabled: env_str("VIBEVALLEY_DEBUG").as_deref() == Some("1"),
            database_url: env_str("VIBEVALLEY_DATABASE_URL"),
            ..Self::under(home)
        };
        if env_str("VIBEVALLEY_TEST_RUNTIMES").as_deref() == Some("1") {
            crate::app::fakes::runtime::configure(&mut config, env_str("VIBEVALLEY_TEST_MODEL_PORT").as_deref());
        }
        config
    }
}

type Closer = (&'static str, Box<dyn FnOnce() + Send>);
type AsyncCloser = (&'static str, std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>);

enum Finalizer {
    Sync(Closer),
    Async(AsyncCloser),
}

/// Ordered shutdown registry populated beside each module's construction in [`start`].
///
/// Drains in three deterministic phases:
/// 1. `pre_drain` (FIFO): cancel the root shutdown token and detach hub hooks before stopping modules.
/// 2. `concurrent` (parallel `JoinSet`, bounded by `grace`): drain every registered module closer.
/// 3. `finalizers` (LIFO): flush buffered state and close spine resources last (`trajectories` -> `hub` -> `db`).
#[derive(Default)]
pub(crate) struct ShutdownList {
    pre_drain: Vec<Closer>,
    concurrent: Vec<Closer>,
    concurrent_async: Vec<AsyncCloser>,
    finalizers: Vec<Finalizer>,
}

impl ShutdownList {
    pub(crate) fn push_pre_drain(&mut self, name: &'static str, close: impl FnOnce() + Send + 'static) {
        self.pre_drain.push((name, Box::new(close)));
    }

    pub(crate) fn push_concurrent(&mut self, name: &'static str, close: impl FnOnce() + Send + 'static) {
        self.concurrent.push((name, Box::new(close)));
    }

    pub(crate) fn push_concurrent_async(&mut self, name: &'static str, close: impl std::future::Future<Output = ()> + Send + 'static) {
        self.concurrent_async.push((name, Box::pin(close)));
    }

    pub(crate) fn push_finalizer(&mut self, name: &'static str, close: impl FnOnce() + Send + 'static) {
        self.finalizers.push(Finalizer::Sync((name, Box::new(close))));
    }

    pub(crate) fn push_finalizer_async(&mut self, name: &'static str, close: impl std::future::Future<Output = ()> + Send + 'static) {
        self.finalizers.push(Finalizer::Async((name, Box::pin(close))));
    }

    /// Runs all registered shutdown phases once and returns whether the concurrent drain timed out.
    pub(crate) async fn drain_async(&mut self, grace: std::time::Duration) -> bool {
        for (name, close) in self.pre_drain.drain(..) {
            tracing::trace!(module = name, "server.close pre-drain");
            close();
        }

        let concurrent = std::mem::take(&mut self.concurrent);
        let concurrent_async = std::mem::take(&mut self.concurrent_async);
        let timed_out = if concurrent.is_empty() && concurrent_async.is_empty() {
            false
        } else {
            let mut set = tokio::task::JoinSet::new();
            for (name, close) in concurrent.into_iter().rev() {
                set.spawn_blocking(move || {
                    tracing::trace!(module = name, "server.close draining module");
                    close();
                });
            }
            for (name, close) in concurrent_async.into_iter().rev() {
                set.spawn(async move {
                    tracing::trace!(module = name, "server.close draining module");
                    close.await;
                });
            }
            tokio::time::timeout(grace, async { while set.join_next().await.is_some() {} }).await.is_err()
        };
        if timed_out {
            tracing::warn!(timeout_secs = grace.as_secs(), "server.close timed out waiting for modules to drain");
        }

        for finalizer in self.finalizers.drain(..).rev() {
            match finalizer {
                Finalizer::Sync((name, close)) => {
                    tracing::trace!(module = name, "server.close finalizer");
                    close();
                }
                Finalizer::Async((name, close)) => {
                    tracing::trace!(module = name, "server.close finalizer");
                    close.await;
                }
            }
        }
        timed_out
    }

    /// Runs all registered shutdown phases once and returns whether the concurrent drain timed out.
    #[cfg(test)]
    pub(crate) fn drain(&mut self, grace: std::time::Duration) -> bool {
        vibevalley_runtime::rt::block_on(self.drain_async(grace))
    }
}

/// The started server. Production callers use `hub`, `set_mcp_url`, and `close`.
pub struct Started {
    pub hub: Arc<Hub>,
    pub(crate) db: Arc<ServerDb>,
    pub(crate) setting: Arc<Setting>,
    pub(crate) agents: Arc<Agents>,
    pub(crate) board: Board,
    pub(crate) registry: Arc<Registry>,
    pub(crate) repos: Arc<work::repo::Repos>,
    pub(crate) pulls: Arc<work::pull::Pulls>,
    pub(crate) crons: Arc<work::cron::Crons>,
    pub(crate) game: Arc<skin::game::Game>,
    pub(crate) attachments: Arc<content::attachment::Attachments>,
    pub(crate) chat: Arc<collab::channel::Chat>,
    pub(crate) issue_chat: Arc<work::chat::IssueChat>,
    pub(crate) session_chat: Arc<work::chat::SessionChat>,
    pub(crate) orchestrator: Arc<team::orchestrator::Orchestrator>,
    pub(crate) trajectories: Arc<work::session::Trajectories>,
    pub(crate) memories: Arc<team::memory::Memories>,
    pub(crate) artifacts: Arc<content::artifact::Artifacts>,
    pub(crate) media: Arc<content::media::jobs::Jobs>,
    pub(crate) media_inputs: Arc<content::media::inputs::Inputs>,
    pub(crate) library: Arc<content::library::Library>,
    pub(crate) resources: Arc<team::mcp::Resources>,
    pub(crate) tools: Arc<team::tool::ToolBox>,
    pub(crate) voice: Arc<collab::voice::Voice>,
    pub(crate) connectors: Arc<collab::connector::Connectors>,
    pub(crate) debug: Arc<infra::debug::DebugKit>,
    pub(crate) remote: Arc<infra::remote::Remote>,
    pub(crate) machines: Arc<infra::machine::MachineManager>,
    shutdown: parking_lot::Mutex<ShutdownList>,
}

/// White-box test view over `Started` internals for `crates/server/tests/*`.
#[doc(hidden)]
pub struct TestInternals<'a> {
    pub db: &'a Arc<ServerDb>,
    pub setting: &'a Arc<Setting>,
    pub agents: &'a Arc<Agents>,
    pub board: &'a Board,
    pub registry: &'a Arc<Registry>,
    pub repos: &'a Arc<work::repo::Repos>,
    pub pulls: &'a Arc<work::pull::Pulls>,
    pub crons: &'a Arc<work::cron::Crons>,
    pub game: &'a Arc<skin::game::Game>,
    pub attachments: &'a Arc<content::attachment::Attachments>,
    pub chat: &'a Arc<collab::channel::Chat>,
    pub issue_chat: &'a Arc<work::chat::IssueChat>,
    pub session_chat: &'a Arc<work::chat::SessionChat>,
    pub orchestrator: &'a Arc<team::orchestrator::Orchestrator>,
    pub trajectories: &'a Arc<work::session::Trajectories>,
    pub memories: &'a Arc<team::memory::Memories>,
    pub artifacts: &'a Arc<content::artifact::Artifacts>,
    pub media: &'a Arc<content::media::jobs::Jobs>,
    pub media_inputs: &'a Arc<content::media::inputs::Inputs>,
    pub library: &'a Arc<content::library::Library>,
    pub resources: &'a Arc<team::mcp::Resources>,
    pub tools: &'a Arc<team::tool::ToolBox>,
    pub voice: &'a Arc<collab::voice::Voice>,
    pub connectors: &'a Arc<collab::connector::Connectors>,
    pub debug: &'a Arc<infra::debug::DebugKit>,
    pub remote: &'a Arc<infra::remote::Remote>,
    pub machines: &'a Arc<infra::machine::MachineManager>,
}

impl Started {
    /// Sets the local MCP door URL handed to issue sessions.
    pub fn set_mcp_url(&self, url: impl Into<String>) {
        self.board.sessions().set_mcp_url(url.into());
    }

    #[doc(hidden)]
    pub fn test_internals(&self) -> TestInternals<'_> {
        TestInternals {
            db: &self.db,
            setting: &self.setting,
            agents: &self.agents,
            board: &self.board,
            registry: &self.registry,
            repos: &self.repos,
            pulls: &self.pulls,
            crons: &self.crons,
            game: &self.game,
            attachments: &self.attachments,
            chat: &self.chat,
            issue_chat: &self.issue_chat,
            session_chat: &self.session_chat,
            orchestrator: &self.orchestrator,
            trajectories: &self.trajectories,
            memories: &self.memories,
            artifacts: &self.artifacts,
            media: &self.media,
            media_inputs: &self.media_inputs,
            library: &self.library,
            resources: &self.resources,
            tools: &self.tools,
            voice: &self.voice,
            connectors: &self.connectors,
            debug: &self.debug,
            remote: &self.remote,
            machines: &self.machines,
        }
    }

    pub async fn close_async(&self) {
        const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
        let mut shutdown = std::mem::take(&mut *self.shutdown.lock());
        shutdown.drain_async(SHUTDOWN_GRACE).await;
    }

    /// Lets the farm go, so `start()` can open the same home again in this
    /// process: cancels the root shutdown token immediately, drains modules
    /// concurrently (bounded by a grace timeout), flushes trajectories and
    /// tracked hub tasks, and checkpoints WAL (`TRUNCATE`) + optimizes before
    /// closing the shared `ServerDb`.
    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }
}

#[derive(Debug)]
pub struct StartError(pub String);

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the server did not start: {}", self.0)
    }
}

impl std::error::Error for StartError {}

fn failed(what: &str) -> impl Fn(&dyn std::fmt::Display) -> StartError + '_ {
    move |e| StartError(format!("{what}: {e}"))
}

/// Every built-in runtime, VibeValley's own on the settings' DeepSeek key.
fn runtimes(
    setting: &Arc<Setting>,
    home: &std::path::Path,
    execution: Arc<std::sync::OnceLock<vibevalley_runtime::agent::harness::SharedExecution>>,
    model: Option<Arc<dyn vibevalley_runtime::agent::ModelClient>>,
) -> Registry {
    let mut registry = Registry::new();
    for r in vibevalley_runtime::oar::default_runtimes().list() {
        if r.id() != vibevalley_runtime::agent::runtime::ID && r.id() != "scripted" {
            registry.register(r.clone());
        }
    }
    let s = setting.clone();
    let builtin = vibevalley_runtime::agent::runtime::VibeValleyRuntime::new(Arc::new(move || s.deepseek_api_key()), home.join("conversations"))
        .with_execution(execution);
    registry.register(Arc::new(match model {
        Some(model) => builtin.with_client(model),
        None => builtin,
    }));
    registry
}

struct ServerDebugSources {
    trajectories: Arc<work::session::Trajectories>,
    agents: Arc<Agents>,
    repos: Arc<work::repo::Repos>,
    artifacts: Arc<content::artifact::Artifacts>,
    orchestrator: Arc<team::orchestrator::Orchestrator>,
}

impl infra::debug::DebugDataSource for ServerDebugSources {
    fn trajectory_events(&self, session_id: &str) -> Vec<vibevalley_protocol::SessionEvent> {
        self.trajectories.events(session_id, None).unwrap_or_default()
    }

    fn open_trajectory_ids(&self) -> Vec<String> {
        self.trajectories.open_session_ids()
    }

    fn system_prompt(&self, session_id: &str, kind: vibevalley_protocol::DebugTrajectoryKind) -> Option<String> {
        match kind {
            vibevalley_protocol::DebugTrajectoryKind::Orchestrator => {
                let prompt = self.orchestrator.system_prompt_snapshot(session_id);
                (!prompt.trim().is_empty()).then_some(prompt)
            }
            vibevalley_protocol::DebugTrajectoryKind::IssueSession | vibevalley_protocol::DebugTrajectoryKind::WorkspaceChat => None,
        }
    }

    fn runtime_probe(&self) -> infra::debug::RuntimeProbeSnapshot {
        let runtimes = self
            .agents
            .fleet
            .cached_runtimes()
            .into_iter()
            .map(|info| {
                let (installed, version) = match &info.installation {
                    vibevalley_protocol::Installation::Available(a) => (true, a.version.clone()),
                    vibevalley_protocol::Installation::NotFound(_)
                    | vibevalley_protocol::Installation::Checking(_)
                    | vibevalley_protocol::Installation::Unsupported(_) => (false, None),
                };
                let ready = installed && info.settings.enabled && info.stop.is_empty();
                vibevalley_protocol::DebugRuntimeSummary {
                    id: info.id.clone(),
                    name: if info.preset.label.is_empty() {
                        info.id.clone()
                    } else {
                        info.preset.label.clone()
                    },
                    installed,
                    ready,
                    version,
                }
            })
            .collect();
        let agent_count = self.agents.profiles.all().len() as u32;
        let orchestrator_ids = self.agents.profiles.orchestrators().into_iter().map(|a| a.id).collect();
        infra::debug::RuntimeProbeSnapshot {
            runtimes,
            agent_count,
            orchestrator_ids,
        }
    }

    fn repo_count(&self) -> u32 {
        self.repos.list().len() as u32
    }

    fn artifact_count(&self) -> u32 {
        self.artifacts
            .list(&vibevalley_protocol::ArtifactListRequest {
                channel: None,
                issue: None,
                artifact_type: None,
            })
            .map(|list| list.len() as u32)
            .unwrap_or(0)
    }
}

/// Builds the whole server bottom-up (L0 -> L1 -> L2 -> L3). Blocking; call off the UI thread.
pub fn start(config: ServerConfig) -> Result<Started, StartError> {
    vibevalley_runtime::rt::block_on(start_async(config))
}

/// Async version of [`start`].
pub async fn start_async(config: ServerConfig) -> Result<Started, StartError> {
    let boot_started = std::time::Instant::now();
    crate::install_tls();
    std::fs::create_dir_all(&config.home).map_err(|e| failed("the home")(&e))?;
    std::fs::create_dir_all(&config.work_root).map_err(|e| failed("the work root")(&e))?;
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees")] {
        std::fs::create_dir_all(&dir).map_err(|e| failed("the work root")(&e))?;
    }

    // L0: single shared database pool + Hub spine
    let mut shutdown = ShutdownList::default();
    let db = match config.database_url.as_deref() {
        Some(url) => ServerDb::open_url(url).map_err(|e| failed("the database")(&e))?,
        None => ServerDb::open(&config.home).map_err(|e| failed("the database")(&e))?,
    };
    shutdown.push_finalizer("db", {
        let db = db.clone();
        move || db.close()
    });
    let hub = Hub::new(vibevalley_core::empty_space_state());
    shutdown.push_pre_drain("hub.cancel", {
        let h = hub.clone();
        move || h.shutdown_token().cancel()
    });
    shutdown.push_concurrent("hub.bus", {
        let h = hub.clone();
        move || h.close_bus()
    });
    shutdown.push_finalizer("hub", {
        let h = hub.clone();
        move || h.close()
    });

    // L1: infra/*, content/attachment, team/agent
    infra::install_health_version(&hub, &config.version);
    let setting = Setting::open(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
    });
    infra::setting::install(&hub, setting.clone());
    let (vendor, download): (Arc<dyn infra::http::Fetch>, Arc<dyn infra::http::Fetch>) = if let Some(network) = &config.media_network {
        network.clone()
    } else if config.offline_media {
        crate::app::fakes::moss::network()
    } else {
        (Arc::new(infra::http::Http), Arc::new(infra::http::PublicDownload))
    };
    infra::provider::install(&hub, Arc::new(infra::provider::Provider::new(setting.clone(), vendor.clone())));
    let voice_fetch = vendor.clone();
    let attachments = content::attachment::Attachments::open(&config.home, db.clone());
    content::attachment::install(&hub, attachments.clone());
    let execution = Arc::new(std::sync::OnceLock::new());
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(runtimes(&setting, &config.home, execution.clone(), config.model_client.clone())));
    let machines = infra::machine::MachineManager::open(&hub, registry.clone(), attachments.clone(), config.version.clone());
    infra::machine::install(&hub, machines.clone());
    hub.attach_machine_bus(Some(Arc::new(infra::machine::MachineBusAdapter(machines.clone()))));
    shutdown.push_pre_drain("hub.machine_bus", {
        let h = hub.clone();
        move || h.attach_machine_bus(None)
    });
    shutdown.push_concurrent("machines", {
        let m = machines.clone();
        move || m.close()
    });
    let agents = Agents::open_with_machines(
        &hub,
        &config.home,
        &config.starters,
        registry.clone(),
        machines.registry().clone(),
        config.probe_runtimes,
    )
    .map_err(|e| failed("the profiles")(&e))?;
    shutdown.push_concurrent("agents.fleet", {
        let a = agents.clone();
        move || a.fleet.close()
    });
    team::agent::install(&hub, agents.clone());

    // Skin observer starts on the empty state so loaded facts replay cleanly.
    let game = skin::game::Game::open_with_clock(&config.home, &hub, config.clock.clone());
    shutdown.push_concurrent_async("game", {
        let g = game.clone();
        async move { g.close_async().await }
    });
    skin::game::install(&hub, game.clone());

    // L2: team/memory, collab/channel, content/{artifact,library,media}, work/{repo,session,issue,pull}
    let memories = team::memory::Memories::open(db.clone(), agents.clone());
    team::memory::install(&hub, memories.clone());

    let quoter: Arc<dyn ChannelQuotePort> = Arc::new(content::artifact::BlockQuoter::new(db.clone()));
    let chat =
        collab::channel::Chat::open(db.clone(), &hub, attachments.clone(), Some(quoter), config.link_previews).map_err(|e| failed("the chat")(&e.message))?;
    {
        let g = game.clone();
        collab::channel::install(&hub, chat.clone(), agents.clone(), Some(Arc::new(move |station| g.want(station))));
    }

    let artifacts = content::artifact::Artifacts::open(db.clone(), attachments.clone(), chat.clone());
    shutdown.push_concurrent("artifacts", {
        let a = artifacts.clone();
        move || a.close()
    });
    content::artifact::install(&hub, artifacts.clone());

    let library = content::library::Library::open(db.clone(), attachments.clone());
    shutdown.push_concurrent_async("library", {
        let l = library.clone();
        async move { l.close_async().await }
    });
    content::library::install(&hub, library.clone(), Some(chat.clone()));

    let media_inputs = content::media::inputs::Inputs::open_with_clock(&config.home, db.clone(), attachments.clone(), config.clock.clone())
        .map_err(|e| failed("the media inputs")(&e.message))?;
    shutdown.push_concurrent("media_inputs", {
        let mi = media_inputs.clone();
        move || mi.close()
    });
    content::media::inputs::install(&hub, media_inputs.clone());
    let media = content::media::jobs::Jobs::open_with_clock(
        content::media::jobs::Parts {
            db: db.clone(),
            hub: Arc::downgrade(&hub),
            setting: setting.clone(),
            files: attachments.clone(),
            inputs: media_inputs.clone(),
            channel: chat.clone(),
            vendor,
            download,
        },
        config.clock.clone(),
    )
    .map_err(|e| failed("media jobs")(&e.message))?;
    shutdown.push_concurrent("media", {
        let m = media.clone();
        move || m.close()
    });
    content::media::jobs::install(&hub, media.clone());
    hub.attach_speech_streams(media.clone());

    let board_config = BoardConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..BoardConfig::under(&config.home)
    };
    let repos = work::repo::Repos::open(&config.work_root, board_config.per_repo).map_err(|e| failed("the repos")(&e))?;
    shutdown.push_concurrent("repos", {
        let r = repos.clone();
        move || r.close()
    });
    work::repo::install(&hub, repos.clone());
    work::repo::install_templates(&hub, repos.clone(), agents.clone());
    if config.probe_runtimes {
        repos.probe_in_background();
    }
    game.count_commits(repos.clone(), config.git_emails.clone());

    let trajectories = work::session::Trajectories::open(db.clone(), &hub);
    shutdown.push_finalizer_async("trajectories", {
        let t = trajectories.clone();
        async move { t.close_async().await }
    });
    let drivers = Arc::new(work::session::AgentDrivers::new(agents.clone(), Some(memories.clone())));
    let board = Board::open_with_async(
        db.clone(),
        drivers,
        board_config,
        Arc::new(Arc::downgrade(&hub)),
        Some(Arc::downgrade(&hub)),
        |sessions| {
            let trajectories = trajectories.clone();
            sessions.on_news(move |news| {
                let work::session::News::Step { session, cwd, step } = news;
                trajectories.step(session, cwd, step.clone());
            });
        },
    )
    .await
    .map_err(|e| failed("the board")(&e))?;
    shutdown.push_concurrent("board", {
        let b = board.clone();
        move || b.close()
    });
    work::issue::install_on_with_clock(&hub, board.clone(), Some(agents.clone()), config.clock.clone());
    work::issue::install_conversation(&hub, board.clone(), chat.clone());
    {
        let g = game.clone();
        work::issue::install_reviewed(&hub, board.clone(), Arc::new(move |session| g.reviewed(session)));
    }
    work::session::install(&hub, board.sessions().clone(), trajectories.clone(), Some(attachments.clone()));

    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(work::pull::Publisher::default()));
    let pulls = work::pull::Pulls::open_async(db.clone(), publisher, Some(repos.clone()), Some(board.clone()), None, None)
        .await
        .map_err(|e| failed("the pulls")(&e.message))?;
    shutdown.push_concurrent_async("pulls", {
        let p = pulls.clone();
        async move { p.close_async().await }
    });
    work::pull::install(&hub, pulls.clone(), config.poll_pulls);

    // L3: work/chat, team/mcp, team/tool, team/orchestrator, work/cron + collab/voice & collab/connector
    let issue_chat = work::chat::IssueChat::start(&hub, board.clone(), chat.clone());
    shutdown.push_concurrent_async("issue_chat", {
        let ic = issue_chat.clone();
        async move { ic.close_async().await }
    });
    let session_chat = {
        let ic = issue_chat.clone();
        work::chat::SessionChat::start(
            &hub,
            board.clone(),
            chat.clone(),
            agents.clone(),
            Arc::new(move |session| ic.ensure_session_thread(session)),
        )
    };
    shutdown.push_concurrent_async("session_chat", {
        let sc = session_chat.clone();
        async move { sc.close_async().await }
    });

    let resources = team::mcp::Resources::with_pulls(board.clone(), chat.clone(), trajectories.clone(), pulls.clone());
    let tools = Arc::new(team::tool::ToolBox {
        hub: Arc::downgrade(&hub),
        resources: resources.clone(),
        agents: agents.clone(),
        board: board.clone(),
        chat: chat.clone(),
        pulls: pulls.clone(),
        media: media.clone(),
        artifacts: artifacts.clone(),
        repos_root: repos.root().to_path_buf(),
    });
    hub.attach_mcp(team::mcp::Door::new(tools.clone(), config.version.clone()));

    let key = setting.clone();
    let orchestrator = team::orchestrator::Orchestrator::open(team::orchestrator::Parts {
        hub: Arc::downgrade(&hub),
        tools: tools.clone(),
        agents: agents.clone(),
        chat: chat.clone(),
        board: board.clone(),
        repos: repos.clone(),
        memories: memories.clone(),
        artifacts: artifacts.clone(),
        home: config.home.clone(),
        trajectories: trajectories.clone(),
        permissions: config.tool_permissions.clone(),
        key: Arc::new(move || key.deepseek_api_key()),
        client: config.model_client.clone(),
        listen_chat: config.orchestrator_listens,
    })
    .map_err(|e| failed("durable execution")(&e))?;
    shutdown.push_concurrent_async("orchestrator", {
        let o = orchestrator.clone();
        async move { o.close_async().await }
    });
    let _ = execution.set(vibevalley_runtime::agent::harness::SharedExecution::new(orchestrator.execution.harness.clone()));
    hub.runtime_inbox
        .attach(orchestrator.execution.store(), &hub)
        .map_err(|e| failed("durable projection")(&e))?;
    shutdown.push_concurrent("hub.runtime_inbox", {
        let h = hub.clone();
        move || h.runtime_inbox.stop()
    });
    team::orchestrator::install(&hub, orchestrator.clone());

    let cron_orchestrator: Option<Arc<dyn CronOrchestratorPort>> = config.orchestrator_listens.then(|| orchestrator.clone() as Arc<dyn CronOrchestratorPort>);
    let crons = work::cron::Crons::open_with_clock_async(
        db.clone(),
        &hub,
        board.clone(),
        agents.clone(),
        Some(chat.clone()),
        cron_orchestrator,
        config.clock.clone(),
    )
    .await
    .map_err(|e| failed("the crons")(&e.message))?;
    shutdown.push_concurrent_async("crons", {
        let c = crons.clone();
        async move { c.close_async().await }
    });
    work::cron::install(&hub, crons.clone(), config.tick_crons);

    board.refresh_queue_async().await.map_err(|e| failed("the queue")(&e))?;

    let voice = collab::voice::Voice::open(collab::voice::Parts {
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        chat: chat.clone(),
        orchestrator: orchestrator.clone(),
        fetch: voice_fetch,
        realtime: None,
    });
    shutdown.push_concurrent("voice", {
        let v = voice.clone();
        move || v.close()
    });
    collab::voice::install(&hub, voice.clone());
    hub.attach_voice(voice.clone());

    let connectors =
        collab::connector::Connectors::open(db.clone(), &hub, chat.clone(), config.connector.clone()).map_err(|e| failed("the connectors")(&e.message))?;
    shutdown.push_concurrent_async("connectors", {
        let c = connectors.clone();
        async move { c.close_async().await }
    });
    collab::connector::install(&hub, connectors.clone());

    let debug = infra::debug::DebugKit::new(infra::debug::DebugParts {
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        sources: Arc::new(ServerDebugSources {
            trajectories: trajectories.clone(),
            agents: agents.clone(),
            repos: repos.clone(),
            artifacts: artifacts.clone(),
            orchestrator: orchestrator.clone(),
        }),
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        boot_started,
        debug_enabled: config.debug_enabled,
    });
    infra::debug::install(&hub, debug.clone());
    if config.debug_enabled {
        hub.attach_observer(Some(debug.collector()));
        hub.attach_fault_gate(Some(debug.collector()));
        vibevalley_runtime::oar::set_observer(Some(debug.collector()));
        shutdown.push_pre_drain("debug.detach", {
            let h = hub.clone();
            move || {
                h.attach_observer(None);
                h.attach_fault_gate(None);
                vibevalley_runtime::oar::set_observer(None);
            }
        });
    }

    let remote = infra::remote::Remote::open_with_clock(db.clone(), Arc::downgrade(&hub), config.version.clone(), config.clock.clone())
        .map_err(|e| failed("remote access")(&e.message))?;
    hub.attach_remote_auth(Some(remote.clone()));
    shutdown.push_pre_drain("hub.remote_auth", {
        let h = hub.clone();
        move || h.attach_remote_auth(None)
    });
    shutdown.push_concurrent("remote", {
        let r = remote.clone();
        move || r.close()
    });
    infra::remote::install(&hub, remote.clone());
    remote.restore_if_enabled();

    Ok(Started {
        hub,
        db,
        setting,
        agents,
        board,
        registry,
        repos,
        pulls,
        crons,
        game,
        attachments,
        chat,
        issue_chat,
        session_chat,
        orchestrator,
        trajectories,
        memories,
        artifacts,
        library,
        resources,
        tools,
        media_inputs,
        media,
        voice,
        connectors,
        debug,
        remote,
        machines,
        shutdown: parking_lot::Mutex::new(shutdown),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    use parking_lot::Mutex;

    use super::*;

    #[test]
    fn shutdown_list_runs_phases_in_order_and_drains_modules_concurrently() {
        let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        // A 2-party barrier inside two concurrent closers proves JoinSet runs them in parallel
        // (sequential execution would deadlock).
        let barrier = Arc::new(Barrier::new(2));

        let mut list = ShutdownList::default();
        list.push_pre_drain("pre_1", {
            let log = events.clone();
            move || log.lock().push("pre_1")
        });
        list.push_pre_drain("pre_2", {
            let log = events.clone();
            move || log.lock().push("pre_2")
        });
        list.push_finalizer("db", {
            let log = events.clone();
            move || log.lock().push("fin_db")
        });
        list.push_finalizer("hub", {
            let log = events.clone();
            move || log.lock().push("fin_hub")
        });
        list.push_finalizer("trajectories", {
            let log = events.clone();
            move || log.lock().push("fin_trajectories")
        });
        list.push_concurrent("mod_a", {
            let log = events.clone();
            let b = barrier.clone();
            move || {
                b.wait();
                log.lock().push("mod_a");
            }
        });
        list.push_concurrent("mod_b", {
            let log = events.clone();
            let b = barrier.clone();
            move || {
                b.wait();
                log.lock().push("mod_b");
            }
        });

        assert!(!list.drain(Duration::from_secs(5)), "concurrent barrier drain must not time out");
        // Second drain is a no-op.
        assert!(!list.drain(Duration::from_secs(5)));

        let trace = events.lock().clone();
        assert_eq!(trace.len(), 7, "{trace:?}");
        assert_eq!(&trace[..2], &["pre_1", "pre_2"]);
        let mut middle = trace[2..4].to_vec();
        middle.sort_unstable();
        assert_eq!(middle, vec!["mod_a", "mod_b"]);
        assert_eq!(&trace[4..], &["fin_trajectories", "fin_hub", "fin_db"]);
    }
}
