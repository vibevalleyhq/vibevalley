//! Shallow composition root (`create_app`, `App`) assembling the
//! server bottom-up from [`Context`] + [`Service`], deep domain capability modules,
//! and the L4 [`Orchestration`] workflow layer.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use crate::agent::{Agent, AgentAssemblyParts, AgentDriver, Memory, PendingExecution, Profile};
pub use crate::boot::Overrides;
use crate::boot::{
    apply_env_overrides, build_runtimes, open_context, register_session_reported_outbox, seat_orchestrators_and_watch, seed_starter_issues_on_boot,
    spawn_skin_event_bridge,
};
use crate::channel::Chat;
use crate::config::failed;
pub use crate::config::{Config, StartError, StartErrorKind};
use crate::connector::Connector;
use crate::context::{Context, install_tls};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::DebugKit;
use crate::debug_sources::build_debug_kit;
use crate::game::Game;
use crate::gateway::api::{GatewayMeta, GatewayPorts, Server};
use crate::gateway::remote::Remote;
use crate::issue::{Board, Pull};
use crate::machine::Machine;
use crate::note::Manager as NoteManager;
use crate::orchestration::{IssueChat, Orchestration, OrchestrationParts, SessionChat};
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
    pub note: &'a Arc<NoteManager>,
    pub channel: &'a Arc<Chat>,
    pub connector: &'a Arc<Connector>,
    pub cron: &'a Arc<CronScheduler>,
    pub voice: &'a Arc<Voice>,
    pub orchestration: &'a Arc<Orchestration>,
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
            issue_chat: &c.orchestration.issue_chat,
            session_chat: &c.orchestration.session_chat,
            agent: &c.agent,
            note: &c.note,
            channel: &c.channel,
            connector: &c.connector,
            cron: &c.cron,
            voice: &c.voice,
            orchestration: &c.orchestration,
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
    create_app_with_overrides(config, Overrides::default()).await
}

/// Opens and starts the full server asynchronously with domain [`Overrides`].
pub async fn create_app_with_overrides(config: Config, overrides: Overrides) -> Result<App, StartError> {
    let storage_config = StorageConfig::from_env(&config.home).map_err(|e| failed("the storage")(&e))?;
    Box::pin(create_app_inner(config, storage_config, overrides)).await
}

/// Opens and starts the full server asynchronously with an explicit [`StorageConfig`].
pub async fn create_app_with_storage(config: Config, storage_config: StorageConfig) -> Result<App, StartError> {
    Box::pin(create_app_inner(config, storage_config, Overrides::default())).await
}

async fn create_app_inner(mut config: Config, storage_config: StorageConfig, overrides: Overrides) -> Result<App, StartError> {
    let boot_started = std::time::Instant::now();
    install_tls();
    apply_env_overrides(&mut config);
    let ctx = open_context(&config).await?;
    let active_subscriptions = Arc::new(AtomicUsize::new(0));

    let setting = Setting::open_async(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
        github_token: config.github_token.clone(),
        storage_backend: Some(storage_config.kind().to_string()),
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
    let remote = Box::pin(Remote::open(ctx.clone(), setting.clone(), config.version.clone()))
        .await
        .map_err(|e| failed("remote access")(&e.message))?;

    let memory = Memory::open(ctx.clone(), profile.clone());
    memory.register_outbox();

    let channel = Box::pin(Chat::open_async(ctx.clone(), storage.clone(), config.link_previews))
        .await
        .map_err(|e| failed("the chat")(&e.message))?;
    Box::pin(seat_orchestrators_and_watch(&ctx, &profile, &channel)).await;

    let note = Box::pin(NoteManager::open_async(ctx.clone(), setting.clone(), storage.clone()))
        .await
        .map_err(|e| failed("notes")(&e.message))?;

    let repo = Box::pin(Repo::open_with_setting_async(
        &config.work_root,
        RuntimeConfig::under(&config.home).per_repo,
        Some(setting.clone()),
    ))
    .await
    .map_err(|e| failed("the repos")(&e))?;
    if config.probe_runtimes {
        repo.probe_in_context(&ctx);
    }
    let board_config = RuntimeConfig {
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        repo: Some(repo.clone()),
        ..RuntimeConfig::under(&config.home)
    };

    let drivers: Arc<dyn SessionDriver> = Arc::new(AgentDriver::new(profile.clone(), Some(memory.clone())));
    let paused_issues = Board::paused_issue_ids_async(&ctx).await.map_err(|e| failed("the board")(&e))?;
    let (runtime, opened) = Box::pin(Runtime::open_with_paused_async(ctx.clone(), drivers, board_config, &paused_issues))
        .await
        .map_err(|e| failed("the runtime")(&e))?;
    let board = Box::pin(Board::with_storage(
        ctx.clone(),
        runtime.clone(),
        opened,
        Some(repo.clone()),
        Some(storage.clone()),
    ))
    .await
    .map_err(|e| failed("the board")(&e))?;
    seed_starter_issues_on_boot(&config, &setting, &board).await;
    let publisher = overrides.publisher.unwrap_or_else(|| Arc::new(crate::issue::Publisher::from_setting(&setting)));
    let pull = Box::pin(Pull::open_async(ctx.clone(), publisher, Some(repo.clone()), Some(board.clone()), None, None))
        .await
        .map_err(|e| failed("the pulls")(&e.message))?;
    pull.start_poller(config.poll_pulls);

    let cron = CronScheduler::open_async(ctx.clone()).await.map_err(|e| failed("the crons")(&e.message))?;
    let voice = Voice::open(VoiceParts {
        ctx: ctx.clone(),
        setting: setting.clone(),
        realtime: overrides.voice_realtime,
        transcriber: overrides.voice_transcriber,
    });

    let agent = Box::pin(Agent::assemble_async(AgentAssemblyParts {
        ctx: ctx.clone(),
        setting: setting.clone(),
        profile: profile.clone(),
        memory,
        channel: channel.clone(),
        board: board.clone(),
        runtime: runtime.clone(),
        repo: repo.clone(),
        pull: pull.clone(),
        cron: cron.clone(),
        note: note.clone(),
        storage: storage.clone(),
        pending_execution,
        permissions: config.tool_permissions.clone(),
        home: config.home.clone(),
        version: config.version.clone(),
        model_client: config.model_client.clone(),
    }))
    .await
    .map_err(|(what, e)| failed(what)(&e))?;

    let (orchestration, connector) = Box::pin(Orchestration::start_async(OrchestrationParts {
        ctx: ctx.clone(),
        setting: setting.clone(),
        channel: channel.clone(),
        board: board.clone(),
        runtime: runtime.clone(),
        cron: cron.clone(),
        pull: pull.clone(),
        note: note.clone(),
        voice: voice.clone(),
        profile,
        orchestrator: agent.orchestrator.clone(),
        orchestrator_listens: config.orchestrator_listens,
        tick_crons: config.tick_crons,
        connector_options: overrides.connector.unwrap_or_default(),
        connector_notify: overrides.connector_notify.unwrap_or_default(),
    }))
    .await
    .map_err(|e| failed("the connectors")(&e.message))?;

    let game = Game::open_async(&config.home, ctx.clone(), repo.clone()).await;
    game.count_commits(config.git_emails.clone());
    spawn_skin_event_bridge(&ctx, &game, &runtime, &channel).await;
    register_session_reported_outbox(
        &ctx,
        &orchestration.issue_chat,
        &orchestration.session_chat,
        &agent,
        &game,
        &runtime,
        &orchestration.connector,
    );

    let debug = build_debug_kit(
        &ctx,
        &runtime,
        &board,
        &agent,
        &repo,
        &note,
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
        mcp: Some(agent.mcp.clone()),
        remote: Some(remote.clone()),
        machine: Some(machine.bus()),
        media_input: Some(storage.clone()),
        voice: Some(orchestration.voice.clone()),
        speech: Some(note.speech_streams()),
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
        agent,
        note,
        channel,
        connector,
        cron,
        voice,
        orchestration,
        machine,
        debug,
        game,
    });
    let observer = config.invoke_observer.or_else(|| config.debug_enabled.then(|| core.debug.collector() as _));
    let fault_gate = config.debug_enabled.then(|| core.debug.collector() as _);
    let gw = GatewayMeta::new(ports, observer, fault_gate, config.host_debug, active_subscriptions);
    let router = Router::new(core.clone(), remote.clone(), gw);

    finish_boot_and_start_feeds(&core.ctx, &core.board, &core.channel, &core.cron, &core.note, &core.game, &core.repo);
    core.orchestration.note.backfill_issue_bodies_async().await;
    core.ctx.feed.flush().await;
    core.board.refresh_queue_async().await.map_err(|e| failed("the queue")(&e))?;
    remote.restore_if_enabled_async(router.clone()).await;

    Ok(App { router })
}

/// Blocking wrapper around [`create_app`] for process boundaries and synchronous tests.
pub fn create_app_blocking(config: Config) -> Result<App, StartError> {
    create_app_with_overrides_blocking(config, Overrides::default())
}

/// Blocking wrapper around [`create_app_with_overrides`] for synchronous tests.
pub fn create_app_with_overrides_blocking(config: Config, overrides: Overrides) -> Result<App, StartError> {
    vibevalley_runtime::rt::block_on(create_app_with_overrides(config, overrides))
}
