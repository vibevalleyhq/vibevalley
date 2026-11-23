//! The whole server in one call: the store, the runtimes, the settings,
//! the profiles, the board and every module's endpoints on one hub.

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_runtime::oar::Registry;

use crate::Hub;
use crate::modules::{
    self,
    infra::setting::{Setting, SettingConfig},
    team::agent::Agents,
    work::issue::Board,
    work::ledger::BoardConfig,
};

/// What the server starts with (VibeValley's `ServerConfig`, the parts
/// VibeValley reads).
#[derive(Clone)]
pub struct ServerConfig {
    /// The farm's home: `settings.json`, `config.json`, `state.db`,
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
    pub publisher: Option<Arc<modules::work::pull::Publisher>>,
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
    pub media_network: Option<(Arc<dyn modules::infra::http::Fetch>, Arc<dyn modules::infra::http::Fetch>)>,
    /// The orchestrator and built-in workers can share an offline model.
    pub model_client: Option<Arc<dyn vibevalley_runtime::agent::ModelClient>>,
    /// The orchestrator hears the farm (VibeValley `listen`); a test without
    /// a model turns it off, so nothing answers in the chat.
    pub orchestrator_listens: bool,
    /// How the chat apps are reached and paced; tests point it at local stubs.
    pub connector: modules::collab::connector::Options,
    /// Enables DevTools diagnostics (`debug.*` endpoints, timeline observer, fault gate).
    pub debug_enabled: bool,
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
            connector: modules::collab::connector::Options::default(),
            debug_enabled: false,
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
            ..Self::under(home)
        };
        if env_str("VIBEVALLEY_TEST_RUNTIMES").as_deref() == Some("1") {
            crate::testing::configure(&mut config, env_str("VIBEVALLEY_TEST_MODEL_PORT").as_deref());
        }
        config
    }
}

/// The started server. The hub is what the bridge and the HTTP adapter
/// take; the rest is for the app's own use.
pub struct Started {
    pub hub: Arc<Hub>,
    pub setting: Arc<Setting>,
    pub agents: Arc<Agents>,
    pub board: Board,
    pub registry: Arc<Registry>,
    pub repos: Arc<modules::work::repo::Repos>,
    pub pulls: Arc<modules::work::pull::Pulls>,
    pub crons: Arc<modules::work::cron::Crons>,
    pub game: Arc<modules::skin::game::Game>,
    pub attachments: Arc<modules::content::attachment::Attachments>,
    pub chat: Arc<modules::collab::channel::Chat>,
    /// Issue thread lifecycle, reports, and per-issue chat delivery.
    pub issue_chat: Arc<modules::work::issue::IssueChat>,
    /// Session seating, channel removal guard, and direct-channel talk delivery.
    pub session_chat: Arc<modules::work::session::SessionChat>,
    /// The assistants: what the chat and the crons say to them.
    pub orchestrator: Arc<modules::team::orchestrator::Orchestrator>,
    /// Session trajectories on disk and in memory.
    pub trajectories: Arc<modules::work::session::Trajectories>,
    /// What the agents remember.
    pub memories: Arc<modules::team::memory::Memories>,
    /// Pages the user and the agents make.
    pub artifacts: Arc<modules::content::artifact::Artifacts>,
    /// Durable media jobs and their executor.
    pub media: Arc<modules::content::media::jobs::Jobs>,
    /// Media reservations, binary uploads and job references.
    pub media_inputs: Arc<modules::content::media::inputs::Inputs>,
    /// Kept attachments as material.
    pub library: Arc<modules::content::library::Library>,
    /// `vv://` reads for the orchestrator's and the helpers' `resource_read`.
    pub resources: Arc<modules::team::mcp::Resources>,
    /// What the orchestrator's and the helpers' tools reach.
    pub farm: Arc<modules::team::tool::Farm>,
    /// MOSS Live voice calls.
    pub voice: Arc<modules::collab::voice::Voice>,
    /// The chat apps tied to channels.
    pub connectors: Arc<modules::collab::connector::Connectors>,
    /// DevTools diagnostics kit (`debug.*` endpoints, timeline collector, fault gate).
    pub debug: Arc<modules::infra::debug::DebugKit>,
    /// Remote mobile access listener, pairing codes, and device tokens.
    pub remote: Arc<modules::infra::remote::Remote>,
}

impl Started {
    /// Lets the farm go, so `start()` can open the same home again in this
    /// process: the tickers, probes, assistants and watcher stop, the
    /// board's agents stop and its lock is released. The hub stays usable
    /// for reads; it serves nothing that needs the board afterwards.
    pub fn close(&self) {
        if self.debug.is_enabled() {
            self.hub.attach_observer(None);
            self.hub.attach_fault_gate(None);
            vibevalley_runtime::oar::set_observer(None);
        }
        self.hub.attach_remote_auth(None);
        self.remote.close();
        self.hub.shutdown_token().cancel();
        self.connectors.close();
        self.pulls.close();
        self.crons.close();
        self.voice.close();
        self.hub.close_bus();
        self.issue_chat.close();
        self.session_chat.close();
        self.orchestrator.close();
        self.hub.runtime_inbox.stop();
        self.agents.fleet.close();
        self.repos.close();
        self.artifacts.close();
        self.media.close();
        self.media_inputs.close();
        self.library.close();
        self.game.close();
        self.board.close();
        self.trajectories.close();
        self.hub.close();
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
    trajectories: Arc<modules::work::session::Trajectories>,
    agents: Arc<Agents>,
    repos: Arc<modules::work::repo::Repos>,
    artifacts: Arc<modules::content::artifact::Artifacts>,
    orchestrator: Arc<modules::team::orchestrator::Orchestrator>,
}

impl modules::infra::debug::DebugDataSource for ServerDebugSources {
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

    fn runtime_probe(&self) -> modules::infra::debug::RuntimeProbeSnapshot {
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
        modules::infra::debug::RuntimeProbeSnapshot {
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

/// Builds the whole server. Blocking (opens files); call it off the UI
/// thread.
pub fn start(config: ServerConfig) -> Result<Started, StartError> {
    let boot_started = std::time::Instant::now();
    crate::install_tls();
    std::fs::create_dir_all(&config.home).map_err(|e| failed("the home")(&e))?;
    std::fs::create_dir_all(&config.work_root).map_err(|e| failed("the work root")(&e))?;
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees")] {
        std::fs::create_dir_all(&dir).map_err(|e| failed("the work root")(&e))?;
    }
    let hub = Hub::new(vibevalley_core::empty_space_state());
    modules::infra::install_health_version(&hub, &config.version);
    let setting = Setting::open(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
    });
    modules::infra::setting::install(&hub, setting.clone());
    let game = modules::skin::game::Game::open(&config.home, &hub);
    modules::skin::game::install(&hub, game.clone());
    // How MOSS is reached, and its results fetched; the page's tests answer it offline.
    let (vendor, download): (Arc<dyn modules::infra::http::Fetch>, Arc<dyn modules::infra::http::Fetch>) = if let Some(network) = &config.media_network {
        network.clone()
    } else if config.offline_media {
        crate::offline::network()
    } else {
        (Arc::new(modules::infra::http::Http), Arc::new(modules::infra::http::PublicDownload))
    };
    modules::infra::provider::install(&hub, Arc::new(modules::infra::provider::Provider::new(setting.clone(), vendor.clone())));
    let voice_fetch = vendor.clone();
    let execution = Arc::new(std::sync::OnceLock::new());
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(runtimes(&setting, &config.home, execution.clone(), config.model_client.clone())));
    let agents = Agents::open(&hub, &config.home, &config.starters, registry.clone(), config.probe_runtimes).map_err(|e| failed("the profiles")(&e))?;
    modules::team::agent::install(&hub, agents.clone());
    let board_config = BoardConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..BoardConfig::under(&config.home)
    };
    let repos = modules::work::repo::Repos::open(&config.work_root, board_config.per_repo).map_err(|e| failed("the repos")(&e))?;
    modules::work::repo::install(&hub, repos.clone());
    if config.probe_runtimes {
        repos.probe_in_background();
    }
    game.count_commits(repos.clone(), config.git_emails.clone());
    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(modules::work::pull::Publisher::default()));
    let memories = modules::team::memory::Memories::open(&config.home, agents.clone()).map_err(|e| failed("the memory")(&e.message))?;
    modules::team::memory::install(&hub, memories.clone());
    agents.attach_memories(&memories);
    let trajectories = modules::work::session::Trajectories::open(&config.home, &hub);
    let board = Board::open_with(
        &config.home.join("server.db"),
        agents.clone(),
        board_config,
        Arc::new(Arc::downgrade(&hub)),
        |sessions| {
            let trajectories = trajectories.clone();
            sessions.on_news(move |news| {
                if let modules::work::session::News::Step { session, cwd, step } = news {
                    trajectories.step(session, cwd, step.clone());
                }
            });
            memories.observe_sessions(sessions);
        },
    )
    .map_err(|e| failed("the board")(&e))?;
    let pulls = modules::work::pull::Pulls::open(&config.home, publisher, Some(repos.clone()), Some(board.clone()), None, None)
        .map_err(|e| failed("the pulls")(&e.message))?;
    modules::work::pull::install(&hub, pulls.clone(), config.poll_pulls);
    let attachments = modules::content::attachment::Attachments::open(&config.home).map_err(|e| failed("the attachments")(&e))?;
    modules::content::attachment::install(&hub, attachments.clone());
    modules::work::issue::install_on(&hub, board.clone(), Some(agents.clone()));
    modules::work::session::install(&hub, board.clone(), trajectories.clone(), Some(attachments.clone()));
    modules::work::repo::install_templates(&hub, repos.clone(), board.clone(), agents.clone());
    let crons = modules::work::cron::Crons::open(&config.home, &hub, board.clone(), agents.clone()).map_err(|e| failed("the crons")(&e.message))?;
    modules::work::cron::install(&hub, crons.clone(), config.tick_crons);
    let media_inputs = modules::content::media::inputs::Inputs::open(&config.home, attachments.clone()).map_err(|e| failed("the media inputs")(&e.message))?;
    modules::content::media::inputs::install(&hub, media_inputs.clone());
    let chat =
        modules::collab::channel::Chat::open(&config.home, &hub, attachments.clone(), config.link_previews).map_err(|e| failed("the chat")(&e.message))?;
    let library = modules::content::library::Library::open(&config.home, attachments.clone()).map_err(|e| failed("the library")(&e.message))?;
    modules::content::library::install(&hub, library.clone(), &chat);
    let media = modules::content::media::jobs::Jobs::open(modules::content::media::jobs::Parts {
        home: config.home.clone(),
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        files: attachments.clone(),
        inputs: media_inputs.clone(),
        chat: chat.clone(),
        vendor,
        download,
    })
    .map_err(|e| failed("media jobs")(&e.message))?;
    modules::content::media::jobs::install(&hub, media.clone());
    hub.attach_speech_streams(media.clone());
    {
        let g = game.clone();
        modules::collab::channel::install(&hub, chat.clone(), agents.clone(), Some(Arc::new(move |station| g.want(station))));
    }
    crons.attach_chat(&chat);
    let artifacts =
        modules::content::artifact::Artifacts::open(&config.home, attachments.clone(), chat.clone()).map_err(|e| failed("the artifacts")(&e.message))?;
    modules::content::artifact::install(&hub, artifacts.clone(), board.clone());
    {
        let a = Arc::downgrade(&artifacts);
        chat.set_quoter(Arc::new(move |refs| a.upgrade().map(|a| a.quote(refs)).unwrap_or_default()));
    }
    let resources = modules::team::mcp::Resources::with_pulls(board.clone(), chat.clone(), trajectories.clone(), pulls.clone());
    let farm = Arc::new(modules::team::tool::Farm {
        board: board.clone(),
        chat: chat.clone(),
        agents: agents.clone(),
        repos: repos.clone(),
        pulls: pulls.clone(),
        crons: crons.clone(),
        memories: memories.clone(),
        media: media.clone(),
        artifacts: artifacts.clone(),
        library: library.clone(),
        resources: resources.clone(),
    });
    hub.attach_mcp(modules::team::mcp::Door::new(farm.clone(), config.version.clone()));
    modules::work::issue::install_conversation(&hub, board.clone(), chat.clone());
    {
        let g = game.clone();
        modules::work::issue::install_reviewed(&hub, board.clone(), Arc::new(move |session| g.reviewed(session)));
    }
    let key = setting.clone();
    let orchestrator = modules::team::orchestrator::Orchestrator::open(modules::team::orchestrator::Parts {
        hub: Arc::downgrade(&hub),
        farm: farm.clone(),
        home: config.home.clone(),
        trajectories: trajectories.clone(),
        permissions: config.tool_permissions.clone(),
        key: Arc::new(move || key.deepseek_api_key()),
        client: config.model_client.clone(),
    })
    .map_err(|e| failed("durable execution")(&e))?;
    let _ = execution.set(vibevalley_runtime::agent::harness::SharedExecution::new(orchestrator.execution.harness.clone()));
    hub.runtime_inbox
        .attach(orchestrator.execution.store(), &hub)
        .map_err(|e| failed("durable projection")(&e))?;
    modules::team::orchestrator::install(&hub, orchestrator.clone());
    board.refresh_queue().map_err(|e| failed("the queue")(&e))?;
    let listening = config.orchestrator_listens.then(|| orchestrator.clone());
    let issue_chat = modules::work::issue::IssueChat::start(&hub, board.clone(), chat.clone());
    let session_chat = {
        let ic = issue_chat.clone();
        modules::work::session::SessionChat::start(
            &hub,
            board.clone(),
            chat.clone(),
            agents.clone(),
            Arc::new(move |session| ic.ensure_session_thread(session)),
        )
    };
    if let Some(o) = &listening {
        crons.attach_orchestrator(o);
        o.listen_chat(chat.clone());
    }
    let voice = modules::collab::voice::Voice::open(modules::collab::voice::Parts {
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        chat: chat.clone(),
        orchestrator: orchestrator.clone(),
        fetch: voice_fetch,
        realtime: None,
    });
    modules::collab::voice::install(&hub, voice.clone());
    hub.attach_voice(voice.clone());
    let connectors = modules::collab::connector::Connectors::open(&config.home, &hub, chat.clone(), config.connector.clone())
        .map_err(|e| failed("the connectors")(&e.message))?;
    modules::collab::connector::install(&hub, connectors.clone());
    let debug = modules::infra::debug::DebugKit::new(modules::infra::debug::DebugParts {
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
    modules::infra::debug::install(&hub, debug.clone());
    if config.debug_enabled {
        hub.attach_observer(Some(debug.collector()));
        hub.attach_fault_gate(Some(debug.collector()));
        vibevalley_runtime::oar::set_observer(Some(debug.collector()));
    }
    let remote =
        modules::infra::remote::Remote::open(&config.home, Arc::downgrade(&hub), config.version.clone()).map_err(|e| failed("remote access")(&e.message))?;
    hub.attach_remote_auth(Some(remote.clone()));
    modules::infra::remote::install(&hub, remote.clone());
    remote.restore_if_enabled();
    Ok(Started {
        hub,
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
        farm,
        media_inputs,
        media,
        voice,
        connectors,
        debug,
        remote,
    })
}
