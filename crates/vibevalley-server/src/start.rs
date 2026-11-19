//! The whole server in one call: the store, the runtimes, the settings,
//! the profiles, the board and every module's endpoints on one hub.

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_oar::Registry;

use crate::Hub;
use crate::modules::issue::Board;
use crate::modules::ledger::BoardConfig;
use crate::modules::{
    self,
    agent::Agents,
    setting::{Setting, SettingConfig},
};

/// What the server starts with (VibeValley's `ServerConfig`, the parts
/// VibeValley reads).
#[derive(Clone)]
pub struct ServerConfig {
    /// The farm's home: `settings.json`, `config.json`, `state.db`,
    /// `issues/` (records, reports).
    pub home: PathBuf,
    /// Repos, worktrees and notes live under it.
    pub work_root: PathBuf,
    pub version: String,
    /// Given outside the settings file (`DEEPSEEK_API_KEY`); the file's wins.
    pub deepseek_api_key: String,
    pub agora_app_id: String,
    pub agora_app_certificate: String,
    pub voice_id: String,
    /// Built-in templates a new farm installs beside its orchestrator.
    pub starters: Vec<String>,
    /// The runtimes; none is every built-in one, VibeValley's own reading
    /// the DeepSeek key from the settings.
    pub registry: Option<Arc<Registry>>,
    pub tool_permissions: vibevalley_agent::generation::governance::Permissions,
    /// Probe every runtime at start, in the background.
    pub probe_runtimes: bool,
    /// Override whether `gh` and repository PR capabilities are probed at boot
    /// (`None` follows `probe_runtimes`).
    pub probe_github: Option<bool>,
    /// Optional hosted-branch publisher override (offline tests).
    pub publisher: Option<Arc<modules::publish::Publisher>>,
    /// Runs due crons every 20 s (`tickCrons`).
    pub tick_crons: bool,
    /// Reads link previews for chat messages off the web.
    pub link_previews: bool,
    /// Commits by these addresses count as the user's too (`gitEmails`).
    pub git_emails: Vec<String>,
    /// Media execution backend; defaults to MOSS. Tests inject a deterministic backend.
    pub media_backend: Option<Arc<dyn modules::media::image_provider::ImageBackend>>,
    /// The vendors answered offline (the page's tests): `testing::OfflineImages`.
    pub offline_media: bool,
    /// How the media vendor is reached and its results fetched, in place of the network: a test keeps one across
    /// restarts, so the vendor remembers what it was asked.
    pub media_network: Option<(Arc<dyn modules::media::vendor::Fetch>, Arc<dyn modules::media::vendor::Fetch>)>,
    /// The orchestrator and built-in workers can share an offline model.
    pub model_client: Option<Arc<dyn vibevalley_agent::ModelClient>>,
    /// The orchestrator hears the farm (VibeValley `listen`); a test without
    /// a model turns it off, so nothing answers in the chat.
    pub orchestrator_listens: bool,
    /// The notes' vault (VibeValley `pkm.root`); none is `<work_root>/pkm`.
    pub pkm_root: Option<PathBuf>,
    /// Rescans the vault when a file in it changes (VibeValley's own).
    pub watch_pkm: bool,
    /// Where the voice line listens and how Agora reaches it.
    pub voice_line: modules::voice::LineConfig,
    /// How the chat apps are reached and paced; tests point it at local stubs.
    pub connector: modules::connector::Options,
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
            agora_app_id: String::new(),
            agora_app_certificate: String::new(),
            voice_id: String::new(),
            starters: vec![],
            registry: None,
            tool_permissions: Default::default(),
            probe_runtimes: true,
            probe_github: None,
            publisher: None,
            tick_crons: true,
            link_previews: true,
            git_emails: vec![],
            model_client: None,
            media_backend: None,
            offline_media: false,
            media_network: None,
            orchestrator_listens: true,
            pkm_root: None,
            watch_pkm: true,
            voice_line: Default::default(),
            connector: modules::connector::Options::default(),
        }
    }

    /// Reads the process environment (`VIBEVALLEY_*`, `DEEPSEEK_API_KEY`,
    /// `AGORA_*`) so standalone `vibevalley-server` and `vibevalley-mac` share
    /// one configuration path.
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
            agora_app_id: env_str("AGORA_APP_ID").unwrap_or_default(),
            agora_app_certificate: env_str("AGORA_APP_CERTIFICATE").unwrap_or_default(),
            voice_id: env_str("VIBEVALLEY_VOICE_ID").unwrap_or_default(),
            starters: csv("VIBEVALLEY_AGENT_STARTERS"),
            git_emails: csv("VIBEVALLEY_GIT_EMAILS"),
            pkm_root: env_str("VIBEVALLEY_PKM_ROOT").map(PathBuf::from),
            ..Self::under(home)
        };
        config.voice_line.url = env_str("VIBEVALLEY_VOICE_LINE_URL").unwrap_or_default();
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
    pub repos: Arc<modules::repo::Repos>,
    pub crons: Arc<modules::cron::Crons>,
    pub game: Arc<modules::game::Game>,
    pub attachments: Arc<modules::attachment::Attachments>,
    pub chat: Arc<modules::channel::Chat>,
    /// Routes the chat to the sessions and opens their threads.
    pub watch: Arc<modules::watch::Watch>,
    /// The assistants: what the chat and the crons say to them.
    pub orchestrator: Arc<modules::orchestrator::Orchestrator>,
    /// Session trajectories on disk and in memory.
    pub trajectories: Arc<modules::session::Trajectories>,
    /// What the agents remember.
    pub memories: Arc<modules::memory::Memories>,
    /// Pages the user and the agents make.
    pub artifacts: Arc<modules::artifact::Artifacts>,
    /// The user's notes.
    pub pkm: Arc<modules::pkm::Pkm>,
    /// Durable media jobs and their executor.
    pub media: Arc<modules::media::jobs::Jobs>,
    /// Media reservations, binary uploads and job references.
    pub media_inputs: Arc<modules::media::inputs::Inputs>,
    /// Kept attachments as material.
    pub library: Arc<modules::library::Library>,
    /// `vv://` reads for the orchestrator's and the helpers' `resource_read`.
    pub resources: Arc<modules::mcp::Resources>,
    /// What the orchestrator's and the helpers' tools reach.
    pub farm: Arc<modules::tool::Farm>,
    /// Dictation, grants and calls.
    pub voice: Arc<modules::voice::Voice>,
    /// The chat apps tied to channels.
    pub connectors: Arc<modules::connector::Connectors>,
}

impl Started {
    /// Lets the farm go, so `start()` can open the same home again in this
    /// process: the tickers, probes, assistants and watcher stop, the
    /// board's agents stop and its lock is released. The hub stays usable
    /// for reads; it serves nothing that needs the board afterwards.
    pub fn close(&self) {
        self.connectors.close();
        self.crons.close();
        self.voice.close();
        self.watch.close();
        self.orchestrator.close();
        self.hub.space.stop();
        self.agents.fleet.close();
        self.repos.close();
        self.artifacts.close();
        self.pkm.close();
        self.media.close();
        self.media_inputs.close();
        self.library.close();
        self.game.close();
        self.board.close();
        self.trajectories.close();
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
    execution: Arc<std::sync::OnceLock<vibevalley_agent::generation::workers::SharedExecution>>,
    model: Option<Arc<dyn vibevalley_agent::ModelClient>>,
) -> Registry {
    let mut registry = Registry::new();
    for r in vibevalley_oar::default_runtimes().list() {
        if r.id() != vibevalley_oar::vibevalley::ID {
            registry.register(r.clone());
        }
    }
    let s = setting.clone();
    let builtin =
        vibevalley_oar::vibevalley::VibeValleyRuntime::new(Arc::new(move || s.deepseek_api_key()), home.join("conversations")).with_execution(execution);
    registry.register(Arc::new(match model {
        Some(model) => builtin.with_client(model),
        None => builtin,
    }));
    registry
}

/// Builds the whole server. Blocking (opens files); call it off the UI
/// thread.
pub fn start(config: ServerConfig) -> Result<Started, StartError> {
    crate::install_tls();
    std::fs::create_dir_all(&config.home).map_err(|e| failed("the home")(&e))?;
    std::fs::create_dir_all(&config.work_root).map_err(|e| failed("the work root")(&e))?;
    let pkm_root = config
        .pkm_root
        .clone()
        .filter(|r| !r.as_os_str().is_empty())
        .unwrap_or_else(|| config.work_root.join("pkm"));
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees"), pkm_root.clone()] {
        std::fs::create_dir_all(&dir).map_err(|e| failed("the work root")(&e))?;
    }
    let hub = Hub::new(vibevalley_core::empty_space_state());
    modules::core::install_version(&hub, &config.version);
    let setting = Setting::open(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
        agora_app_id: config.agora_app_id.clone(),
        agora_app_certificate: config.agora_app_certificate.clone(),
        voice_id: config.voice_id.clone(),
    });
    modules::setting::install(&hub, setting.clone());
    let game = modules::game::Game::open(&config.home, &hub);
    modules::game::install(&hub, game.clone());
    // How MOSS is reached, and its results fetched; the page's tests answer it offline.
    let (vendor, download): (Arc<dyn modules::media::vendor::Fetch>, Arc<dyn modules::media::vendor::Fetch>) = if let Some(network) = &config.media_network {
        network.clone()
    } else if config.offline_media {
        crate::offline::network()
    } else {
        (Arc::new(modules::media::vendor::Ureq), Arc::new(modules::media::vendor::Ureq))
    };
    modules::provider::install(&hub, Arc::new(modules::provider::Provider::new(setting.clone(), vendor.clone())));
    let voice_fetch = vendor.clone();
    let execution = Arc::new(std::sync::OnceLock::new());
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(runtimes(&setting, &config.home, execution.clone(), config.model_client.clone())));
    let agents = Agents::open(&hub, &config.home, &config.starters, registry.clone(), config.probe_runtimes).map_err(|e| failed("the profiles")(&e))?;
    modules::agent::install(&hub, agents.clone());
    let board_config = BoardConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..BoardConfig::under(&config.home)
    };
    let repos = modules::repo::Repos::open(&config.work_root, board_config.per_repo).map_err(|e| failed("the repos")(&e))?;
    modules::repo::install(&hub, repos.clone());
    if config.probe_github.unwrap_or(config.probe_runtimes) {
        repos.probe_in_background();
    }
    game.count_commits(repos.clone(), config.git_emails.clone());
    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(modules::publish::Publisher::default()));
    let memories = modules::memory::Memories::open(&config.home, agents.clone()).map_err(|e| failed("the memory")(&e.message))?;
    modules::memory::install(&hub, memories.clone());
    agents.attach_memories(&memories);
    let trajectories = modules::session::Trajectories::open(&config.home, &hub);
    let board = Board::open_with(
        &config.home.join("server.db"),
        agents.clone(),
        board_config,
        Arc::new(Arc::downgrade(&hub)),
        |sessions| {
            let trajectories = trajectories.clone();
            sessions.on_news(move |news| {
                if let modules::session::News::Step { session, cwd, step } = news {
                    trajectories.step(session, cwd, step.clone());
                }
            });
            memories.observe_sessions(sessions);
        },
    )
    .map_err(|e| failed("the board")(&e))?;
    modules::publish::install_with_board(&hub, publisher.clone(), Some(board.clone()));
    modules::issue::install_on(&hub, board.clone(), Some(agents.clone()));
    modules::session::install(&hub, board.clone(), trajectories.clone());
    modules::repo::install_templates(&hub, repos.clone(), board.clone(), agents.clone());
    let crons = modules::cron::Crons::open(&config.home, &hub, board.clone(), agents.clone());
    modules::cron::install(&hub, crons.clone(), config.tick_crons);
    let attachments = modules::attachment::Attachments::open(&config.home).map_err(|e| failed("the attachments")(&e))?;
    modules::attachment::install(&hub, attachments.clone());
    let media_inputs = modules::media::inputs::Inputs::open(&config.home, attachments.clone()).map_err(|e| failed("the media inputs")(&e.message))?;
    modules::media::inputs::install(&hub, media_inputs.clone());
    let chat = modules::channel::Chat::open(&config.home, &hub, attachments.clone(), config.link_previews).map_err(|e| failed("the chat")(&e.message))?;
    let library = modules::library::Library::open(&config.home, attachments.clone()).map_err(|e| failed("the library")(&e.message))?;
    modules::library::install(&hub, library.clone());
    let media = modules::media::jobs::Jobs::open(modules::media::jobs::Parts {
        home: config.home.clone(),
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        files: attachments.clone(),
        inputs: media_inputs.clone(),
        chat: chat.clone(),
        images: config
            .media_backend
            .clone()
            .unwrap_or_else(|| -> Arc<dyn modules::media::image_provider::ImageBackend> {
                if config.offline_media {
                    crate::testing::OfflineImages::new(setting.clone())
                } else {
                    Arc::new(modules::media::image_provider::Moss::new(setting.clone()))
                }
            }),
        vendor,
        download,
    })
    .map_err(|e| failed("media jobs")(&e.message))?;
    modules::media::jobs::install(&hub, media.clone());
    hub.attach_speech_streams(media.clone());
    modules::channel::install(&hub, chat.clone(), agents.clone(), Some(game.clone()));
    crons.attach_chat(&chat);
    let artifacts = modules::artifact::Artifacts::open(&config.home, attachments.clone(), chat.clone()).map_err(|e| failed("the artifacts")(&e.message))?;
    modules::artifact::install(&hub, artifacts.clone(), agents.clone(), board.clone());
    {
        let a = Arc::downgrade(&artifacts);
        chat.set_quoter(Arc::new(move |refs| a.upgrade().map(|a| a.quote(refs)).unwrap_or_default()));
    }
    let pkm = modules::pkm::Pkm::open(&config.home, &pkm_root).map_err(|e| failed("the notes")(&e.message))?;
    modules::pkm::install(&hub, pkm.clone());
    if config.watch_pkm {
        pkm.watch();
    }
    let resources = modules::mcp::Resources::new(board.clone(), chat.clone(), trajectories.clone());
    let farm = Arc::new(modules::tool::Farm {
        board: board.clone(),
        chat: chat.clone(),
        agents: agents.clone(),
        repos: repos.clone(),
        publisher,
        crons: crons.clone(),
        memories: memories.clone(),
        media: media.clone(),
        pkm: pkm.clone(),
        artifacts: artifacts.clone(),
        library: library.clone(),
        resources: resources.clone(),
    });
    hub.attach_mcp(modules::mcp::Door::new(farm.clone(), config.version.clone()));
    modules::issue::install_conversation(&hub, board.clone(), chat.clone());
    modules::issue::install_reviewed(&hub, board.clone(), game.clone());
    let key = setting.clone();
    let orchestrator = modules::orchestrator::Orchestrator::open(modules::orchestrator::Parts {
        hub: Arc::downgrade(&hub),
        farm: farm.clone(),
        home: config.home.clone(),
        trajectories: trajectories.clone(),
        permissions: config.tool_permissions.clone(),
        key: Arc::new(move || key.deepseek_api_key()),
        client: config.model_client.clone(),
    })
    .map_err(|e| failed("durable execution")(&e))?;
    let _ = execution.set(vibevalley_agent::generation::workers::SharedExecution {
        generation: orchestrator.execution.generation.clone(),
        scheduler: orchestrator.execution.scheduler.clone(),
    });
    let _ = hub.execution.set(Arc::downgrade(&orchestrator));
    hub.space.attach(orchestrator.execution.store()).map_err(|e| failed("durable projection")(&e))?;
    modules::orchestrator::install(&hub, orchestrator.clone());
    board.refresh_queue().map_err(|e| failed("the queue")(&e))?;
    let listening = config.orchestrator_listens.then(|| orchestrator.clone());
    if let Some(o) = &listening {
        crons.attach_orchestrator(o);
    }
    let watch = modules::watch::Watch::start_with(&hub, chat.clone(), board.clone(), agents.clone(), listening);
    let voice = modules::voice::Voice::open(modules::voice::Parts {
        hub: Arc::downgrade(&hub),
        setting: setting.clone(),
        chat: chat.clone(),
        orchestrator: orchestrator.clone(),
        fetch: voice_fetch,
        realtime: None,
        line: config.voice_line.clone(),
        pause: None,
    });
    modules::voice::install(&hub, voice.clone());
    let connectors =
        modules::connector::Connectors::open(&config.home, &hub, chat.clone(), config.connector.clone()).map_err(|e| failed("the connectors")(&e.message))?;
    modules::connector::install(&hub, connectors.clone());
    Ok(Started {
        hub,
        setting,
        agents,
        board,
        registry,
        repos,
        crons,
        game,
        attachments,
        chat,
        watch,
        orchestrator,
        trajectories,
        memories,
        artifacts,
        pkm,
        library,
        resources,
        farm,
        media_inputs,
        media,
        voice,
        connectors,
    })
}
