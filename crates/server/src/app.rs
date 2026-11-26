//! Shallow composition root (`create_app`, `App`) assembling the
//! server bottom-up from [`Context`] + [`Service`] and flat domain modules.

use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, OnceLock};

use crate::agent::{Agent, AgentDriver, Mcp, Memory, Orchestrator, OrchestratorParts, PendingExecution, Profile, Resource, ToolRegistry};
use crate::artifact::Manager as ArtifactManager;
use crate::boot::{
    LazyCronOrchestrator, build_runtimes, register_session_reported_outbox, seat_orchestrators_and_watch, seed_starter_issues_on_boot,
    spawn_chat_artifact_bridge, spawn_skin_event_bridge,
};
use crate::channel::Chat;
use crate::config::failed;
pub use crate::config::{Config, StartError, StartErrorKind};
use crate::connector::Connector;
use crate::context::port::{CronOrchestratorPort, MemoryRecallPort};
use crate::context::{Context, Fetch, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup, install_tls};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::DebugKit;
use crate::debug_sources::build_debug_kit;
use crate::game::Game;
use crate::gateway::api::{GatewayMeta, GatewayPorts, Server};
use crate::gateway::remote::Remote;
use crate::issue::{Board, IssueChat, Publisher, Pull, SessionChat};
use crate::machine::Machine;
use crate::projection::finish_boot_and_start_feeds;
use crate::provider::Provider;
use crate::repo::Repo;
use crate::router::{AppCore, Router};
use crate::runtime::{Runtime, RuntimeConfig, SessionDriver};
use crate::service::Service;
use crate::setting::{Setting, SettingConfig};
use crate::storage::{Storage, StorageConfig};
use crate::voice::{Parts as VoiceParts, Voice};

/// White-box test view over [`App`] internals for `crates/server/tests/*`.
#[doc(hidden)]
pub struct TestInternals<'a> {
    pub ctx: &'a Arc<Context>,
    pub service: &'a Arc<Service>,
    pub registry: &'a Arc<vibevalley_runtime::oar::Registry>,
    pub setting: &'a Arc<Setting>,
    pub provider: &'a Arc<Provider>,
    pub storage: &'a Arc<Storage>,
    pub repo: &'a Arc<Repo>,
    pub runtime: &'a Arc<Runtime>,
    pub board: &'a Arc<Board>,
    pub pull: &'a Arc<Pull>,
    pub issue_chat: &'a Arc<IssueChat>,
    pub session_chat: &'a Arc<SessionChat>,
    pub agent: &'a Arc<Agent>,
    pub artifact: &'a Arc<ArtifactManager>,
    pub channel: &'a Arc<Chat>,
    pub connector: &'a Arc<Connector>,
    pub cron: &'a Arc<CronScheduler>,
    pub voice: &'a Arc<Voice>,
    pub machine: &'a Arc<Machine>,
    pub remote: &'a Arc<Remote>,
    pub debug: &'a Arc<DebugKit>,
    pub game: &'a Arc<Game>,
}

/// Assembled server handle returned by [`create_app`] / [`create_app_blocking`].
pub struct App {
    router: Arc<Router>,
}

impl App {
    pub fn server(&self) -> Arc<dyn Server> {
        self.router.clone()
    }
    pub fn router(&self) -> &Arc<Router> {
        &self.router
    }
    pub fn ctx(&self) -> &Arc<Context> {
        &self.router.core.ctx
    }
    pub fn set_mcp_url(&self, url: impl Into<String>) {
        self.router.core.runtime.set_mcp_url(url.into());
    }
    pub fn on_system_wake(&self) {
        self.router.core.ctx.task.notify_wake();
    }

    #[doc(hidden)]
    pub fn test_internals(&self) -> TestInternals<'_> {
        let c = &self.router.core;
        TestInternals {
            ctx: &c.ctx,
            service: &c.ctx.service,
            registry: &c.registry,
            setting: &c.setting,
            provider: &c.provider,
            storage: &c.storage,
            repo: &c.repo,
            runtime: &c.runtime,
            board: &c.board,
            pull: &c.pull,
            issue_chat: &c.issue_chat,
            session_chat: &c.session_chat,
            agent: &c.agent,
            artifact: &c.artifact,
            channel: &c.channel,
            connector: &c.connector,
            cron: &c.cron,
            voice: &c.voice,
            machine: &c.machine,
            remote: &self.router.remote,
            debug: &c.debug,
            game: &c.game,
        }
    }

    /// Cooperatively shuts down every module concurrently, drains all tracked
    /// [`TaskGroup`] tasks, flushes trajectories, and closes the database pools.
    pub async fn close(&self) {
        self.router.close_subscriptions();
        self.router.remote.close_async().await;
        self.router.core.close_all_async().await;
    }

    /// Blocking shutdown wrapper for synchronous callers and tests.
    pub fn close_blocking(&self) {
        vibevalley_runtime::rt::block_on(self.close());
    }
}

/// Opens and starts the full server asynchronously, reading optional
/// `VIBEVALLEY_STORAGE_URL` (defaulting to local filesystem at `config.home`).
pub async fn create_app(config: Config) -> Result<App, StartError> {
    let storage_config = StorageConfig::from_env(&config.home).map_err(|e| failed("the storage")(&e))?;
    Box::pin(create_app_inner(config, storage_config)).await
}

/// Opens and starts the full server asynchronously with an explicit [`StorageConfig`].
pub async fn create_app_with_storage(config: Config, storage_config: StorageConfig) -> Result<App, StartError> {
    Box::pin(create_app_inner(config, storage_config)).await
}

async fn create_app_inner(config: Config, storage_config: StorageConfig) -> Result<App, StartError> {
    let boot_started = std::time::Instant::now();
    install_tls();
    tokio::fs::create_dir_all(&config.home).await.map_err(|e| failed("the home")(&e))?;
    for dir in [config.work_root.clone(), config.work_root.join("repos"), config.work_root.join("worktrees")] {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| failed("the work root")(&e))?;
    }

    let service = match config.database_url.as_deref() {
        Some(url) => Box::pin(Service::open_url(url)).await.map_err(|e| StartError::from_db_error(e, None))?,
        None => Box::pin(Service::open(&config.home))
            .await
            .map_err(|e| StartError::from_db_error(e, Some(config.home.join("server.db"))))?,
    };
    let (http, download): (Arc<dyn Fetch>, Arc<dyn Fetch>) = match &config.media_network {
        Some(network) => network.clone(),
        None if config.offline_media => crate::fake::moss::network(),
        None => (Arc::new(Http), Arc::new(PublicDownload)),
    };
    let (live, outbox, feed) = (Arc::new(LiveState::new()), Arc::new(Outbox::new(service.clone())), Arc::new(StateFeed::new()));
    let clock = config.clock.clone();
    let ctx = Arc::new(Context::new(service, TaskGroup::new(), live, outbox, feed, clock, http, download));
    let active_subscriptions = Arc::new(AtomicUsize::new(0));

    let setting = Setting::open_async(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
    })
    .await;
    let provider = Arc::new(Provider::new(setting.clone(), ctx.http.clone()));
    let storage = Storage::open_with_config_async(&config.home, &storage_config, ctx.clone())
        .await
        .map_err(|e| failed("the storage")(&e.message))?;

    let durable_store = ctx.service.durable().await.map_err(|e| failed("durable execution")(&e))?;
    let pending_execution = PendingExecution::prepare(durable_store, config.tool_permissions.clone());
    let shared_execution = pending_execution.shared();
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(build_runtimes(&setting, &config.home, shared_execution, config.model_client.clone())));
    let machine = Machine::open(ctx.clone(), registry.clone(), storage.clone(), config.version.clone());
    let profile = Box::pin(Profile::open_with_machines_async(
        ctx.clone(),
        &config.home,
        &config.starters,
        registry.clone(),
        machine.registry().clone(),
        config.probe_runtimes,
    ))
    .await
    .map_err(|e| failed("the profiles")(&e))?;
    let remote = Box::pin(Remote::open(ctx.clone(), config.version.clone()))
        .await
        .map_err(|e| failed("remote access")(&e.message))?;

    let memory = Memory::open(ctx.clone(), profile.clone());
    memory.register_outbox();

    let channel = Box::pin(Chat::open_async(ctx.clone(), storage.clone(), config.link_previews))
        .await
        .map_err(|e| failed("the chat")(&e.message))?;
    Box::pin(seat_orchestrators_and_watch(&ctx, &profile, &channel)).await;

    let chat_msg_rx = spawn_chat_artifact_bridge(&ctx, &channel);
    let artifact = Box::pin(ArtifactManager::open_async(
        ctx.clone(),
        setting.clone(),
        storage.clone(),
        channel.clone(),
        Some(chat_msg_rx),
    ))
    .await
    .map_err(|e| failed("artifacts")(&e.message))?;

    let board_config = RuntimeConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..RuntimeConfig::under(&config.home)
    };
    let repo = Box::pin(Repo::open_async(&config.work_root, board_config.per_repo))
        .await
        .map_err(|e| failed("the repos")(&e))?;
    if config.probe_runtimes {
        repo.probe_in_context(&ctx);
    }

    let drivers: Arc<dyn SessionDriver> = Arc::new(AgentDriver::new(profile.clone(), Some(memory.clone() as Arc<dyn MemoryRecallPort>)));
    let (runtime, opened) = Box::pin(Runtime::open_async(ctx.clone(), drivers, board_config))
        .await
        .map_err(|e| failed("the runtime")(&e))?;
    let board = Box::pin(Board::with_storage(
        ctx.clone(),
        runtime.clone(),
        opened,
        Some(repo.clone()),
        Some(channel.clone()),
        Some(storage.clone()),
    ))
    .await
    .map_err(|e| failed("the board")(&e))?;
    seed_starter_issues_on_boot(&config, &setting, &board).await;
    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(Publisher::default()));
    let pull = Box::pin(Pull::open_async(ctx.clone(), publisher, Some(repo.clone()), Some(board.clone()), None, None))
        .await
        .map_err(|e| failed("the pulls")(&e.message))?;
    pull.start_poller(config.poll_pulls);

    let issue_chat = IssueChat::start(ctx.clone(), board.clone(), channel.clone());
    let session_chat = SessionChat::start(ctx.clone(), board.clone(), channel.clone(), Some(issue_chat.clone()));

    let cron_orch_slot = Arc::new(OnceLock::<Arc<dyn CronOrchestratorPort>>::new());
    let cron_orchestrator = config
        .orchestrator_listens
        .then(|| Arc::new(LazyCronOrchestrator(cron_orch_slot.clone())) as Arc<dyn CronOrchestratorPort>);
    let cron = CronScheduler::open_async(ctx.clone(), board.clone(), profile.clone(), Some(channel.clone()), cron_orchestrator)
        .await
        .map_err(|e| failed("the crons")(&e.message))?;

    let resource = Resource::with_pull(ctx.clone(), channel.clone(), runtime.clone(), pull.clone());
    let tool = Arc::new(ToolRegistry {
        ctx: ctx.clone(),
        resource: resource.clone(),
        cron: cron.clone(),
        profile: profile.clone(),
        memory: memory.clone(),
        issue: board.clone(),
        runtime: runtime.clone(),
        repo: repo.clone(),
        chat: channel.clone(),
        pull: pull.clone(),
        artifact: artifact.clone(),
        storage: storage.clone(),
        repos_root: repo.root().to_path_buf(),
    });
    let mcp = Mcp::new(tool.clone(), config.version.clone());

    let key = setting.clone();
    let orchestrator = Box::pin(Orchestrator::open_async(OrchestratorParts {
        ctx: ctx.clone(),
        pending_execution: Some(pending_execution),
        permissions: config.tool_permissions.clone(),
        tool: tool.clone(),
        profile: profile.clone(),
        chat: channel.clone(),
        issue: board.clone(),
        runtime: runtime.clone(),
        repo: repo.clone(),
        memory: memory.clone(),
        artifact: artifact.clone(),
        home: config.home.clone(),
        key: Arc::new(move || key.deepseek_api_key()),
        client: config.model_client.clone(),
        listen_chat: config.orchestrator_listens,
    }))
    .await
    .map_err(|e| failed("durable execution")(&e))?;
    orchestrator.start_inbox_observer().await.map_err(|e| failed("durable projection")(&e))?;
    if config.orchestrator_listens {
        let _ = cron_orch_slot.set(orchestrator.clone() as Arc<dyn CronOrchestratorPort>);
    }
    cron.start_ticker(config.tick_crons);

    let agent = Agent::new(profile, memory, mcp.clone(), resource, tool, orchestrator);
    let voice = Voice::open(VoiceParts {
        ctx: ctx.clone(),
        setting: setting.clone(),
        chat: channel.clone(),
        orchestrator: agent.orchestrator.clone(),
        realtime: config.voice_realtime,
    });
    let connector = Connector::open_async(ctx.clone(), setting.clone(), channel.clone(), config.connector.clone())
        .await
        .map_err(|e| failed("the connectors")(&e.message))?;

    let game = Game::open_async(&config.home, ctx.clone(), repo.clone()).await;
    game.count_commits(config.git_emails.clone());
    spawn_skin_event_bridge(&ctx, &game, &runtime, &channel).await;
    register_session_reported_outbox(&ctx, &issue_chat, &session_chat, &agent, &game, &runtime);

    let debug = build_debug_kit(
        &ctx,
        &runtime,
        &board,
        &agent,
        &repo,
        &artifact,
        &channel,
        &cron,
        &setting,
        config.host_debug.clone(),
        config.home.clone(),
        config.work_root.clone(),
        config.version.clone(),
        config.debug_enabled,
        active_subscriptions.clone(),
        boot_started,
    );

    let ports = GatewayPorts {
        mcp: Some(mcp),
        remote: Some(remote.clone()),
        machine: Some(machine.bus()),
        media_input: Some(storage.clone()),
        voice: Some(voice.clone()),
        speech: Some(artifact.speech_streams()),
    };
    let core = Arc::new(AppCore {
        ctx,
        registry,
        version: config.version,
        setting,
        provider,
        storage,
        repo,
        runtime,
        board,
        pull,
        issue_chat,
        session_chat,
        agent,
        artifact,
        channel,
        connector,
        cron,
        voice,
        machine,
        debug,
        game,
    });
    let observer = config.invoke_observer.or_else(|| config.debug_enabled.then(|| core.debug.collector() as _));
    let fault_gate = config.debug_enabled.then(|| core.debug.collector() as _);
    let gw = GatewayMeta::new(ports, observer, fault_gate, config.host_debug, active_subscriptions);
    let router = Router::new(core.clone(), remote.clone(), gw);

    finish_boot_and_start_feeds(&core.ctx, &core.board, &core.channel, &core.cron, &core.artifact, &core.game);
    core.ctx.feed.flush().await;
    core.board.refresh_queue_async().await.map_err(|e| failed("the queue")(&e))?;
    remote.restore_if_enabled_async(router.clone()).await;

    Ok(App { router })
}

/// Blocking wrapper around [`create_app`] for process boundaries and synchronous tests.
pub fn create_app_blocking(config: Config) -> Result<App, StartError> {
    vibevalley_runtime::rt::block_on(create_app(config))
}
