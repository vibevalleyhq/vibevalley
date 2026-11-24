//! Bottom-up composition root (`L0 -> L1 -> L2 -> L3`) building [`App`] and
//! [`ServerDoor`] with zero late-binding `attach_*` setters, zero `ShutdownList`,
//! and deterministic cooperative `Runtime` shutdown.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use vibevalley_core::SliceMask;
use vibevalley_runtime::oar::Registry;

use crate::app::App;
use crate::app::door::{DoorParts, ServerDoor};
use crate::app::live::LiveOverlay;
use crate::app::outbox::Outbox;
use crate::app::port::{ChannelQuotePort, CronOrchestratorPort, MemoryRecallPort};
use crate::app::projection::{debug_state_snapshot_async, project_slice_json};
use crate::app::runtime::Runtime;
use crate::app::runtime_inbox::RuntimeInboxObserver;
use crate::app::slice::SliceProjector;
use crate::db::ServerDb;
use crate::transport::api::{BoxFuture, Server, SharedHostDebug};
use crate::{
    collab, content, infra,
    infra::setting::{Setting, SettingConfig},
    skin, team,
    team::agent::AgentStore,
    team::memory::FinishedRun,
    work,
    work::issue::IssueStore,
    work::ledger::BoardConfig,
};

const SHUTDOWN_DRAIN_GRACE: Duration = Duration::from_secs(10);
const RUNTIME_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Server configuration read from environment or test harness.
#[derive(Clone)]
pub struct ServerConfig {
    /// Home directory holding `settings.json`, `config.json`, `server.db`, and `issues/`.
    pub home: PathBuf,
    /// Work root holding `repos/` and `worktrees/`.
    pub work_root: PathBuf,
    pub version: String,
    /// Optional fallback API key outside `settings.json` (`DEEPSEEK_API_KEY`).
    pub deepseek_api_key: String,
    /// Built-in templates installed beside the orchestrator on a fresh farm.
    pub starters: Vec<String>,
    /// Override runtime registry (tests inject `ScriptedRuntime` here).
    pub registry: Option<Arc<Registry>>,
    pub tool_permissions: vibevalley_runtime::agent::extensions::governance::Permissions,
    /// Probe every runtime at boot in the background.
    pub probe_runtimes: bool,
    /// Optional hosted-branch publisher override (offline tests).
    pub publisher: Option<Arc<work::pull::Publisher>>,
    /// Poll open PRs every N seconds (`None` disables the background poller).
    pub poll_pulls: Option<u64>,
    /// Runs due crons every 20 s.
    pub tick_crons: bool,
    /// Reads link previews for chat messages off the web.
    pub link_previews: bool,
    /// Extra author emails counted as the user's commits.
    pub git_emails: Vec<String>,
    /// Answers MOSS media/voice vendors offline (`app::fake::moss::network()`).
    pub offline_media: bool,
    /// Explicit vendor + download fetchers overriding the network.
    pub media_network: Option<(Arc<dyn infra::http::Fetch>, Arc<dyn infra::http::Fetch>)>,
    /// Shared offline model client for orchestrator and built-in workers.
    pub model_client: Option<Arc<dyn vibevalley_runtime::agent::ModelClient>>,
    /// Whether orchestrator listens to incoming channel dispatches.
    pub orchestrator_listens: bool,
    /// External chat app connector configuration.
    pub connector: collab::connector::Options,
    /// Enables DevTools diagnostics (`debug.*` endpoints, timeline observer, fault gate).
    pub debug_enabled: bool,
    /// Optional GPUI shell debug bridge attached at startup (immutable on [`ServerDoor`]).
    pub host_debug: Option<SharedHostDebug>,
    /// Optional database URL overriding `<home>/server.db`.
    pub database_url: Option<String>,
    /// Wall clock for domain timers/TTLs (`cron`, `remote`, `media`, `issue`, `game`).
    pub clock: vibevalley_core::SharedClock,
}

impl ServerConfig {
    /// Resolves `VIBEVALLEY_WORK_ROOT`, defaulting to `~/vibevalley-dev`.
    pub fn work_root_from(said: Option<std::ffi::OsString>, user_home: Option<std::ffi::OsString>) -> PathBuf {
        if let Some(root) = said.filter(|v| !v.is_empty()) {
            return PathBuf::from(root);
        }
        user_home.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/")).join("vibevalley-dev")
    }

    pub fn default_work_root() -> PathBuf {
        Self::work_root_from(std::env::var_os("VIBEVALLEY_WORK_ROOT"), std::env::var_os("HOME"))
    }

    /// Config rooted under a single temporary or dedicated directory `dir`.
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
            host_debug: None,
            database_url: None,
            clock: vibevalley_core::system_clock(),
        }
    }

    /// Reads the process environment (`VIBEVALLEY_*`, `DEEPSEEK_API_KEY`) so
    /// standalone `vibevalley-server` and `vibevalley-mac` share one configuration path.
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
            crate::app::fake::runtime::configure(&mut config, env_str("VIBEVALLEY_TEST_MODEL_PORT").as_deref());
        }
        config
    }
}

/// Started server handle returned by [`start`] / [`start_async`].
pub struct Started {
    pub door: Arc<ServerDoor>,
}

/// White-box test view over `Started` internals for `crates/server/tests/*`.
#[doc(hidden)]
pub struct TestInternals<'a> {
    pub db: &'a Arc<ServerDb>,
    pub setting: &'a Arc<Setting>,
    pub agent: &'a Arc<AgentStore>,
    pub issue: &'a Arc<IssueStore>,
    pub session: &'a Arc<work::session::SessionStore>,
    pub registry: &'a Arc<Registry>,
    pub repo: &'a Arc<work::repo::RepoStore>,
    pub pull: &'a Arc<work::pull::PullStore>,
    pub cron: &'a Arc<work::cron::CronStore>,
    pub game: &'a Arc<skin::game::Game>,
    pub attachment: &'a Arc<content::attachment::AttachmentStore>,
    pub channel: &'a Arc<collab::channel::Chat>,
    pub issue_chat: &'a Arc<work::chat::IssueChat>,
    pub session_chat: &'a Arc<work::chat::SessionChat>,
    pub orchestrator: &'a Arc<team::orchestrator::Orchestrator>,
    pub trajectory: &'a Arc<work::session::TrajectoryStore>,
    pub memory: &'a Arc<team::memory::MemoryStore>,
    pub artifact: &'a Arc<content::artifact::ArtifactStore>,
    pub media: &'a Arc<content::media::jobs::MediaStore>,
    pub media_input: &'a Arc<content::media::inputs::MediaInputStore>,
    pub library: &'a Arc<content::library::LibraryStore>,
    pub resource: &'a Arc<team::mcp::ResourceStore>,
    pub tool: &'a Arc<team::tool::ToolBox>,
    pub voice: &'a Arc<collab::voice::Voice>,
    pub connector: &'a Arc<collab::connector::Connector>,
    pub debug: &'a Arc<infra::debug::DebugKit>,
    pub remote: &'a Arc<infra::remote::Remote>,
    pub machine: &'a Arc<infra::machine::MachineStore>,
}

impl Started {
    /// Returns the typed [`Server`] trait handle.
    pub fn server(&self) -> Arc<dyn Server> {
        self.door.clone()
    }

    /// Sets the local MCP door URL handed to issue sessions.
    pub fn set_mcp_url(&self, url: impl Into<String>) {
        self.door.app.session.set_mcp_url(url.into());
    }

    /// Notifies subscribed subsystems that the host system woke from sleep.
    pub fn on_system_wake(&self) {
        self.door.on_system_wake();
    }

    #[doc(hidden)]
    pub fn test_internals(&self) -> TestInternals<'_> {
        let app = &self.door.app;
        TestInternals {
            db: &app.db,
            setting: &app.setting,
            agent: &app.agent,
            issue: &app.issue,
            session: &app.session,
            registry: &app.registry,
            repo: &app.repo,
            pull: &app.pull,
            cron: &app.cron,
            game: &app.game,
            attachment: &app.attachment,
            channel: &app.channel,
            issue_chat: &app.issue_chat,
            session_chat: &app.session_chat,
            orchestrator: &app.orchestrator,
            trajectory: &app.trajectory,
            memory: &app.memory,
            artifact: &app.artifact,
            media: &app.media,
            media_input: &app.media_input,
            library: &app.library,
            resource: &app.resource,
            tool: &app.tool,
            voice: &app.voice,
            connector: &app.connector,
            debug: &app.debug,
            remote: &app.remote,
            machine: &app.machine,
        }
    }

    /// Cooperatively shuts down every module concurrently, drains all tracked
    /// [`Runtime`] tasks, flushes trajectories, and closes the shared [`ServerDb`].
    pub async fn close_async(&self) {
        let app = &self.door.app;
        vibevalley_runtime::oar::set_observer(None);
        app.runtime.token().cancel();
        self.door.close_subscriptions();

        let mut set = tokio::task::JoinSet::new();
        {
            let remote = app.remote.clone();
            set.spawn(async move { remote.close_async().await });
            let machine = app.machine.clone();
            set.spawn_blocking(move || machine.close());
            let fleet = app.agent.fleet.clone();
            set.spawn_blocking(move || fleet.close());
            let game = app.game.clone();
            set.spawn(async move { game.close_async().await });
            let artifact = app.artifact.clone();
            set.spawn_blocking(move || artifact.close());
            let library = app.library.clone();
            set.spawn(async move { library.close_async().await });
            let media_input = app.media_input.clone();
            set.spawn_blocking(move || media_input.close());
            let media = app.media.clone();
            set.spawn_blocking(move || media.close());
            let repo = app.repo.clone();
            set.spawn_blocking(move || repo.close());
            let issue = app.issue.clone();
            set.spawn_blocking(move || issue.close());
            let session = app.session.clone();
            set.spawn_blocking(move || session.close());
            let pull = app.pull.clone();
            set.spawn(async move { pull.close_async().await });
            let issue_chat = app.issue_chat.clone();
            set.spawn(async move { issue_chat.close_async().await });
            let session_chat = app.session_chat.clone();
            set.spawn(async move { session_chat.close_async().await });
            let orchestrator = app.orchestrator.clone();
            set.spawn(async move { orchestrator.close_async().await });
            let cron = app.cron.clone();
            set.spawn(async move { cron.close_async().await });
            let voice = app.voice.clone();
            set.spawn_blocking(move || voice.close());
            let connector = app.connector.clone();
            set.spawn(async move { connector.close_async().await });
        }

        if tokio::time::timeout(SHUTDOWN_DRAIN_GRACE, async { while set.join_next().await.is_some() {} })
            .await
            .is_err()
        {
            tracing::warn!(timeout_secs = SHUTDOWN_DRAIN_GRACE.as_secs(), "server.close timed out waiting for modules");
        }

        let _ = app.runtime.shutdown(RUNTIME_SHUTDOWN_GRACE).await;
        app.trajectory.close_async().await;
        app.db.close_async().await;
    }

    /// Blocking shutdown wrapper for process exit and synchronous tests.
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
    trajectory: Arc<work::session::TrajectoryStore>,
    agent: Arc<AgentStore>,
    repo: Arc<work::repo::RepoStore>,
    artifact: Arc<content::artifact::ArtifactStore>,
    orchestrator: Arc<team::orchestrator::Orchestrator>,
    issue: Arc<IssueStore>,
    session: Arc<work::session::SessionStore>,
    channel: Arc<collab::channel::Chat>,
    media: Arc<content::media::jobs::MediaStore>,
    cron: Arc<work::cron::CronStore>,
    live: Arc<LiveOverlay>,
}

impl infra::debug::DebugDataSource for ServerDebugSources {
    fn trajectory_events(&self, session_id: &str) -> Vec<vibevalley_protocol::SessionEvent> {
        self.trajectory.events(session_id, None).unwrap_or_default()
    }

    fn open_trajectory_ids(&self) -> Vec<String> {
        self.trajectory.open_session_ids()
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
            .agent
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
        let agent_count = self.agent.profiles.all().len() as u32;
        let orchestrator_ids = self.agent.profiles.orchestrators().into_iter().map(|a| a.id).collect();
        infra::debug::RuntimeProbeSnapshot {
            runtimes,
            agent_count,
            orchestrator_ids,
        }
    }

    fn repo_count(&self) -> u32 {
        self.repo.list_cached().len() as u32
    }

    fn artifact_count(&self) -> u32 {
        self.artifact.cached_count()
    }

    fn state_snapshot_async(&self) -> BoxFuture<'_, infra::debug::DebugStateSnapshot> {
        Box::pin(debug_state_snapshot_async(
            &self.issue,
            &self.session,
            &self.channel,
            &self.media,
            &self.cron,
            &self.live,
        ))
    }
}

/// Builds the whole server bottom-up (`L0 -> L1 -> L2 -> L3`). Blocking; call off the UI thread.
pub fn start(config: ServerConfig) -> Result<Started, StartError> {
    vibevalley_runtime::rt::block_on(start_async(config))
}

/// Builds the whole server bottom-up (`L0 -> L1 -> L2 -> L3`) asynchronously.
pub async fn start_async(config: ServerConfig) -> Result<Started, StartError> {
    let boot_started = std::time::Instant::now();
    crate::install_tls();
    std::fs::create_dir_all(&config.home).map_err(|e| failed("the home")(&e))?;
    std::fs::create_dir_all(&config.work_root).map_err(|e| failed("the work root")(&e))?;
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees")] {
        std::fs::create_dir_all(&dir).map_err(|e| failed("the work root")(&e))?;
    }

    // L0: single shared database pool + Runtime + LiveOverlay + SliceProjector + Outbox
    let db = match config.database_url.as_deref() {
        Some(url) => ServerDb::open_url(url).map_err(|e| failed("the database")(&e))?,
        None => ServerDb::open(&config.home).map_err(|e| failed("the database")(&e))?,
    };
    let runtime = Arc::new(Runtime::new());
    let live = Arc::new(LiveOverlay::new());
    let projector = Arc::new(SliceProjector::new());
    let outbox = Arc::new(Outbox::new(db.clone()));
    let active_subscriptions = Arc::new(AtomicUsize::new(0));

    // L1: infra/*, content/attachment, team/agent
    let setting = Setting::open(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
    });
    let (vendor, download): (Arc<dyn infra::http::Fetch>, Arc<dyn infra::http::Fetch>) = if let Some(network) = &config.media_network {
        network.clone()
    } else if config.offline_media {
        crate::app::fake::moss::network()
    } else {
        (Arc::new(infra::http::Http), Arc::new(infra::http::PublicDownload))
    };
    let provider = Arc::new(infra::provider::Provider::new(setting.clone(), vendor.clone()));
    let voice_fetch = vendor.clone();
    let attachment = content::attachment::AttachmentStore::open(&config.home, db.clone());
    let execution = Arc::new(std::sync::OnceLock::new());
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(runtimes(&setting, &config.home, execution.clone(), config.model_client.clone())));
    let machine = infra::machine::MachineStore::open(
        runtime.clone(),
        live.clone(),
        projector.clone(),
        registry.clone(),
        attachment.clone(),
        config.version.clone(),
    );
    let agent = AgentStore::open_with_machines(
        &runtime,
        live.clone(),
        &config.home,
        &config.starters,
        registry.clone(),
        machine.registry().clone(),
        config.probe_runtimes,
    )
    .map_err(|e| failed("the profiles")(&e))?;
    let remote = infra::remote::Remote::open_with_clock_async(db.clone(), config.version.clone(), config.clock.clone())
        .await
        .map_err(|e| failed("remote access")(&e.message))?;

    // L2: team/memory, collab/channel, content/{artifact,library,media}, work/{repo,trajectory,issue,session,pull}
    let memory = team::memory::MemoryStore::open(db.clone(), agent.clone());
    outbox.register("memory.keep_run", {
        let memory = Arc::downgrade(&memory);
        move |delivery| {
            let memory = memory.clone();
            async move {
                let Some(memory) = memory.upgrade() else {
                    return Ok::<(), String>(());
                };
                let run: FinishedRun = serde_json::from_value(delivery.payload).map_err(|e| e.to_string())?;
                memory.keep_async(&run).await;
                Ok(())
            }
        }
    });

    let quoter: Arc<dyn ChannelQuotePort> = Arc::new(content::artifact::BlockQuoter::new(db.clone()));
    let channel = collab::channel::Chat::open_async(
        db.clone(),
        runtime.clone(),
        live.clone(),
        projector.clone(),
        attachment.clone(),
        Some(quoter),
        config.link_previews,
    )
    .await
    .map_err(|e| failed("the chat")(&e.message))?;
    collab::channel::seat_orchestrators_async(&channel, &agent).await;

    let artifact = content::artifact::ArtifactStore::open(
        db.clone(),
        runtime.clone(),
        attachment.clone(),
        channel.clone(),
    );
    let media_input = content::media::inputs::MediaInputStore::open_with_clock(
        &config.home,
        db.clone(),
        runtime.clone(),
        attachment.clone(),
        config.clock.clone(),
    )
    .map_err(|e| failed("the media inputs")(&e.message))?;
    let media = content::media::jobs::MediaStore::open_with_clock_async(
        content::media::jobs::Parts {
            db: db.clone(),
            runtime: runtime.clone(),
            live: live.clone(),
            projector: projector.clone(),
            setting: setting.clone(),
            files: attachment.clone(),
            inputs: media_input.clone(),
            channel: channel.clone(),
            vendor,
            download,
        },
        config.clock.clone(),
    )
    .await
    .map_err(|e| failed("media jobs")(&e.message))?;
    let library = content::library::LibraryStore::open(
        db.clone(),
        runtime.clone(),
        attachment.clone(),
        Some(channel.clone()),
        Some(media.clone()),
    );

    let board_config = BoardConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..BoardConfig::under(&config.home)
    };
    let repo = work::repo::RepoStore::open(&config.work_root, board_config.per_repo).map_err(|e| failed("the repos")(&e))?;
    if config.probe_runtimes {
        repo.probe_in_background(&runtime);
    }

    let trajectory = work::session::TrajectoryStore::open(db.clone(), runtime.clone());
    let drivers = Arc::new(work::session::AgentDrivers::new(
        agent.clone(),
        Some(memory.clone() as Arc<dyn MemoryRecallPort>),
    ));
    let (issue, session, ledger) = work::ledger::open_with_async(
        db.clone(),
        runtime.clone(),
        live.clone(),
        projector.clone(),
        outbox.clone(),
        drivers,
        board_config,
        config.clock.clone(),
        {
            let trajectory = trajectory.clone();
            move |news| {
                let work::session::News::Step { session, cwd, step } = news;
                trajectory.step(session, cwd, step.clone());
            }
        },
    )
    .await
    .map_err(|e| failed("the board")(&e))?;

    {
        let session = session.clone();
        channel.guard_removal(move |channel_id| {
            let session = session.clone();
            Box::pin(async move { session.channel_in_use_reasons_async(&channel_id).await })
        });
    }

    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(work::pull::Publisher::default()));
    let pull = work::pull::PullStore::open_async(
        db.clone(),
        runtime.clone(),
        projector.clone(),
        publisher,
        Some(repo.clone()),
        Some(issue.clone()),
        config.poll_pulls,
    )
    .await
    .map_err(|e| failed("the pulls")(&e.message))?;

    // L3: work/chat, team/mcp, team/tool, team/orchestrator, work/cron, collab/voice, collab/connector, skin/game
    let issue_chat = work::chat::IssueChat::start(runtime.clone(), ledger.clone(), issue.clone(), channel.clone());
    let session_chat = {
        let ic = issue_chat.clone();
        work::chat::SessionChat::start(
            runtime.clone(),
            ledger.clone(),
            session.clone(),
            channel.clone(),
            agent.clone(),
            Arc::new(move |s| ic.ensure_session_thread(s)),
        )
    };
    let cron = work::cron::CronStore::open_with_clock_async(
        db.clone(),
        runtime.clone(),
        projector.clone(),
        issue.clone(),
        agent.clone(),
        Some(channel.clone()),
        None,
        config.clock.clone(),
        false,
    )
    .await
    .map_err(|e| failed("the crons")(&e.message))?;

    let resource = team::mcp::ResourceStore::with_pulls(issue.clone(), session.clone(), channel.clone(), trajectory.clone(), pull.clone());
    let tool = Arc::new(team::tool::ToolBox {
        resource: resource.clone(),
        agent: agent.clone(),
        issue: issue.clone(),
        session: session.clone(),
        channel: channel.clone(),
        pull: pull.clone(),
        cron: cron.clone(),
        media: media.clone(),
        artifact: artifact.clone(),
        repos_root: repo.root().to_path_buf(),
    });
    let mcp_door = team::mcp::Door::new(tool.clone(), config.version.clone());

    let key = setting.clone();
    let orchestrator = team::orchestrator::Orchestrator::open(team::orchestrator::Parts {
        runtime: runtime.clone(),
        live: live.clone(),
        projector: projector.clone(),
        tool: tool.clone(),
        agent: agent.clone(),
        channel: channel.clone(),
        issue: issue.clone(),
        session: session.clone(),
        repo: repo.clone(),
        memory: memory.clone(),
        artifact: artifact.clone(),
        home: config.home.clone(),
        trajectory: trajectory.clone(),
        permissions: config.tool_permissions.clone(),
        key: Arc::new(move || key.deepseek_api_key()),
        client: config.model_client.clone(),
        listen_chat: config.orchestrator_listens,
    })
    .map_err(|e| failed("durable execution")(&e))?;
    let _ = execution.set(vibevalley_runtime::agent::harness::SharedExecution::new(orchestrator.execution.harness.clone()));
    RuntimeInboxObserver::start(orchestrator.execution.store(), &runtime, live.clone(), projector.clone())
        .map_err(|e| failed("durable projection")(&e))?;

    if config.orchestrator_listens {
        cron.attach_orchestrator(orchestrator.clone() as Arc<dyn CronOrchestratorPort>);
    }
    if config.tick_crons {
        cron.start_ticker();
    }

    let voice = collab::voice::Voice::open(collab::voice::Parts {
        runtime: runtime.clone(),
        live: live.clone(),
        setting: setting.clone(),
        chat: channel.clone(),
        orchestrator: orchestrator.clone(),
        fetch: voice_fetch,
        realtime: None,
    });
    let connector = collab::connector::Connector::open_async(
        db.clone(),
        runtime.clone(),
        live.clone(),
        projector.clone(),
        channel.clone(),
        config.connector.clone(),
    )
    .await
    .map_err(|e| failed("the connectors")(&e.message))?;

    let game = skin::game::Game::open_with_clock(
        &config.home,
        runtime.clone(),
        live.clone(),
        projector.clone(),
        ledger.subscribe_events(),
        channel.subscribe_message_events(),
        config.clock.clone(),
    );
    game.count_commits(&runtime, repo.clone(), config.git_emails.clone());

    let debug_sources = Arc::new(ServerDebugSources {
        trajectory: trajectory.clone(),
        agent: agent.clone(),
        repo: repo.clone(),
        artifact: artifact.clone(),
        orchestrator: orchestrator.clone(),
        issue: issue.clone(),
        session: session.clone(),
        channel: channel.clone(),
        media: media.clone(),
        cron: cron.clone(),
        live: live.clone(),
    });
    let subs_counter = active_subscriptions.clone();
    let debug = infra::debug::DebugKit::new(infra::debug::DebugParts {
        projector: projector.clone(),
        active_subscriptions: Arc::new(move || subs_counter.load(Ordering::Acquire) as u32),
        host_debug: config.host_debug.clone(),
        setting: setting.clone(),
        sources: debug_sources,
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        boot_started,
        debug_enabled: config.debug_enabled,
    });

    if config.debug_enabled {
        vibevalley_runtime::oar::set_observer(Some(debug.collector()));
    }

    let app = Arc::new(App {
        db,
        runtime,
        live,
        projector,
        outbox,
        registry,
        version: config.version.clone(),
        clock: config.clock.clone(),
        setting,
        provider,
        attachment,
        machine,
        agent,
        remote,
        debug,
        memory,
        channel,
        artifact,
        library,
        media_input,
        media,
        repo,
        trajectory,
        issue,
        session,
        pull,
        issue_chat,
        session_chat,
        resource,
        tool,
        orchestrator,
        cron,
        voice,
        connector,
        game,
    });

    let door = ServerDoor::new(DoorParts {
        app: app.clone(),
        mcp: mcp_door,
        remote: app.remote.clone(),
        machine: Arc::new(infra::machine::MachineBusAdapter(app.machine.clone())),
        media_input: app.media_input.clone(),
        voice: app.voice.clone(),
        speech: app.media.clone(),
        observer: config.debug_enabled.then(|| app.debug.collector() as _),
        fault_gate: config.debug_enabled.then(|| app.debug.collector() as _),
        host_debug: config.host_debug,
        active_subscriptions,
    });

    let server_arc: Arc<dyn Server> = door.clone();
    app.remote.bind_server(Arc::downgrade(&server_arc));

    // Start background spine loops and flush initial DB projections onto SliceFeeds before returning.
    app.outbox.start(&app.runtime);
    app.projector.start(&app.runtime, {
        let app = app.clone();
        move |kind, seq| {
            let app = app.clone();
            Box::pin(async move { project_slice_json(&app, kind, seq).await.map_err(|e| e.message) })
        }
    });
    app.projector.mark_dirty(SliceMask::all());
    app.projector.flush().await;

    app.issue.refresh_queue_async().await.map_err(|e| failed("the queue")(&e))?;
    app.remote.restore_if_enabled_async().await;

    Ok(Started { door })
}
