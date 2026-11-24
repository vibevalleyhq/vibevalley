//! Shallow composition root (`Config`, `create_app`, `App`) assembling the
//! server bottom-up from [`Context`] + [`Service`] and flat domain modules.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::json;
use tokio::sync::broadcast;
use vibevalley_core::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, OpsInput, SessionInput, derive_issues, overlay_sessions, project_board, project_collab, project_farm,
    project_inbox, project_ops, project_sessions,
};
use vibevalley_core::{SharedClock, SliceMask};
use vibevalley_protocol::{
    ApiError, ArtifactCard, ArtifactListRequest, Caller, ChatMessage, DebugRuntimeSummary, DebugTrajectoryKind, Phase, SessionEvent, SliceKind,
};
use vibevalley_runtime::agent::ModelClient;
use vibevalley_runtime::agent::extensions::governance::Permissions;
use vibevalley_runtime::agent::harness::SharedExecution;
use vibevalley_runtime::agent::runtime::VibeValleyRuntime;
use vibevalley_runtime::oar::{Registry, set_observer};

use crate::BoxFuture;
use crate::agent::{Agent, AgentDriver, Mcp, Memory, Orchestrator, OrchestratorParts, Profile, Resource, ToolRegistry};
use crate::artifact::{ChannelAnnounce, Manager as ArtifactManager};
use crate::channel::{ChannelMessageEvent, Chat};
use crate::connector::{Connector, Options as ConnectorOptions};
use crate::context::port::{CronOrchestratorPort, MemoryRecallPort};
use crate::context::{Context, Fetch, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup, encode_slice, install_tls};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::{DebugDataSource, DebugKit, DebugParts, DebugStateSnapshot, RuntimeProbeSnapshot};
use crate::game::Game;
use crate::gateway::api::{GatewayPorts, Server, SharedHostDebug, SharedInvokeObserver};
use crate::gateway::remote::Remote;
use crate::issue::{Board, IssueChat, Publisher, Pull, SessionChat};
use crate::machine::Machine;
use crate::provider::Provider;
use crate::repo::Repo;
use crate::router::{Router, RouterParts};
use crate::runtime::{OUTBOX_SESSION_REPORTED, OutboxSessionReported, Runtime, RuntimeConfig, SessionDriver, SessionLifecycleEvent};
use crate::service::Service;
use crate::setting::{Setting, SettingConfig};
use crate::storage::Storage;
use crate::voice::moss::Realtime;
use crate::voice::{Parts as VoiceParts, Voice};

const SHUTDOWN_DRAIN_GRACE: Duration = Duration::from_secs(10);
const RUNTIME_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Server configuration read from environment or test harness.
#[derive(Clone)]
pub struct Config {
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
    pub tool_permissions: Permissions,
    /// Probe every runtime at boot in the background.
    pub probe_runtimes: bool,
    /// Optional hosted-branch publisher override (offline tests).
    pub publisher: Option<Arc<Publisher>>,
    /// Poll open PRs every N seconds (`None` disables the background poller).
    pub poll_pulls: Option<u64>,
    /// Runs due crons every 20 s.
    pub tick_crons: bool,
    /// Reads link previews for chat messages off the web.
    pub link_previews: bool,
    /// Extra author emails counted as the user's commits.
    pub git_emails: Vec<String>,
    /// Answers MOSS media/voice vendors offline (`crate::fake::moss::network()`).
    pub offline_media: bool,
    /// Explicit vendor + download fetchers overriding the network.
    pub media_network: Option<(Arc<dyn Fetch>, Arc<dyn Fetch>)>,
    /// Shared offline model client for orchestrator and built-in workers.
    pub model_client: Option<Arc<dyn ModelClient>>,
    /// Whether orchestrator listens to incoming channel dispatches.
    pub orchestrator_listens: bool,
    /// External chat app connector configuration.
    pub connector: ConnectorOptions,
    /// Enables DevTools diagnostics (`debug.*` endpoints, timeline observer, fault gate).
    pub debug_enabled: bool,
    /// Optional GPUI shell debug bridge attached at startup (immutable on [`Router`]).
    pub host_debug: Option<SharedHostDebug>,
    /// Optional MOSS realtime probe override for offline voice tests.
    pub voice_realtime: Option<Arc<dyn Realtime>>,
    /// Optional RPC invoke observer override for telemetry tests.
    pub invoke_observer: Option<SharedInvokeObserver>,
    /// Optional database URL overriding `<home>/server.db`.
    pub database_url: Option<String>,
    /// Wall clock for domain timers/TTLs (`cron`, `remote`, `media`, `issue`, `game`).
    pub clock: SharedClock,
}

impl Config {
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
    pub fn under(dir: impl Into<PathBuf>) -> Config {
        let dir = dir.into();
        Config {
            home: dir.clone(),
            work_root: dir,
            version: env!("CARGO_PKG_VERSION").into(),
            deepseek_api_key: String::new(),
            starters: vec![],
            registry: None,
            tool_permissions: Permissions::default(),
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
            connector: ConnectorOptions::default(),
            debug_enabled: false,
            host_debug: None,
            voice_realtime: None,
            invoke_observer: None,
            database_url: None,
            clock: vibevalley_core::system_clock(),
        }
    }

    /// Reads the process environment (`VIBEVALLEY_*`, `DEEPSEEK_API_KEY`) so
    /// standalone `vibevalley-server` and `vibevalley-mac` share one configuration path.
    pub fn from_env(home: impl Into<PathBuf>, version: impl Into<String>) -> Config {
        let env_str = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let csv = |name: &str| -> Vec<String> {
            env_str(name)
                .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
                .unwrap_or_default()
        };
        let home = home.into();
        let mut config = Config {
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
            crate::fake::runtime::configure(&mut config, env_str("VIBEVALLEY_TEST_MODEL_PORT").as_deref());
        }
        config
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

pub(crate) struct AppCore {
    pub ctx: Arc<Context>,
    pub registry: Arc<Registry>,
    pub version: String,
    pub setting: Arc<Setting>,
    pub provider: Arc<Provider>,
    pub storage: Arc<Storage>,
    pub repo: Arc<Repo>,
    pub runtime: Arc<Runtime>,
    pub board: Arc<Board>,
    pub pull: Arc<Pull>,
    pub issue_chat: Arc<IssueChat>,
    pub session_chat: Arc<SessionChat>,
    pub agent: Arc<Agent>,
    pub artifact: Arc<ArtifactManager>,
    pub channel: Arc<Chat>,
    pub connector: Arc<Connector>,
    pub cron: Arc<CronScheduler>,
    pub voice: Arc<Voice>,
    pub machine: Arc<Machine>,
    pub remote: Arc<Remote>,
    pub debug: Arc<DebugKit>,
    pub game: Arc<Game>,
}

/// Assembled server handle returned by [`create_app`] / [`create_app_blocking`].
pub struct App {
    router: Arc<Router>,
}

/// White-box test view over [`App`] internals for `crates/server/tests/*`.
#[doc(hidden)]
pub struct TestInternals<'a> {
    pub ctx: &'a Arc<Context>,
    pub service: &'a Arc<Service>,
    pub registry: &'a Arc<Registry>,
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

impl App {
    /// Returns the typed [`Server`] trait handle.
    pub fn server(&self) -> Arc<dyn Server> {
        self.router.clone()
    }

    /// Returns the concrete [`Router`].
    pub fn router(&self) -> &Arc<Router> {
        &self.router
    }

    /// Returns the shared [`Context`].
    pub fn ctx(&self) -> &Arc<Context> {
        &self.router.core.ctx
    }

    /// Sets the local MCP door URL handed to issue sessions.
    pub fn set_mcp_url(&self, url: impl Into<String>) {
        self.router.core.runtime.set_mcp_url(url.into());
    }

    /// Notifies subscribed subsystems that the host system woke from sleep.
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
            remote: &c.remote,
            debug: &c.debug,
            game: &c.game,
        }
    }

    /// Cooperatively shuts down every module concurrently, drains all tracked
    /// [`TaskGroup`] tasks, flushes trajectories, and closes the database pools.
    pub async fn close(&self) {
        let c = &self.router.core;
        set_observer(None);
        c.ctx.token().cancel();
        self.router.close_subscriptions();

        let mut set = tokio::task::JoinSet::new();
        {
            let remote = c.remote.clone();
            set.spawn(async move { remote.close_async().await });
            let machine = c.machine.clone();
            set.spawn_blocking(move || machine.close());
            let game = c.game.clone();
            set.spawn(async move { game.close_async().await });
            let artifact = c.artifact.clone();
            set.spawn_blocking(move || artifact.close());
            let storage = c.storage.clone();
            set.spawn(async move { storage.close_async().await });
            let repo = c.repo.clone();
            set.spawn(async move { repo.close_async().await });
            let board = c.board.clone();
            set.spawn_blocking(move || board.close());
            let pull = c.pull.clone();
            set.spawn(async move { pull.close_async().await });
            let issue_chat = c.issue_chat.clone();
            set.spawn(async move { issue_chat.close_async().await });
            let session_chat = c.session_chat.clone();
            set.spawn(async move { session_chat.close_async().await });
            let agent = c.agent.clone();
            set.spawn(async move { agent.close_async().await });
            let cron = c.cron.clone();
            set.spawn(async move { cron.close_async().await });
            let voice = c.voice.clone();
            set.spawn_blocking(move || voice.close());
            let connector = c.connector.clone();
            set.spawn(async move { connector.close_async().await });
        }

        if tokio::time::timeout(SHUTDOWN_DRAIN_GRACE, async { while set.join_next().await.is_some() {} })
            .await
            .is_err()
        {
            tracing::warn!(timeout_secs = SHUTDOWN_DRAIN_GRACE.as_secs(), "server.close timed out waiting for modules");
        }

        let _ = c.ctx.shutdown(RUNTIME_SHUTDOWN_GRACE).await;
        c.runtime.close_async().await;
        c.ctx.service.close().await;
    }

    /// Blocking shutdown wrapper for synchronous callers and tests.
    pub fn close_blocking(&self) {
        vibevalley_runtime::rt::block_on(self.close());
    }
}

fn runtimes(setting: &Arc<Setting>, home: &std::path::Path, execution: Arc<OnceLock<SharedExecution>>, model: Option<Arc<dyn ModelClient>>) -> Registry {
    let mut registry = Registry::new();
    for r in vibevalley_runtime::oar::default_runtimes().list() {
        if r.id() != vibevalley_runtime::agent::runtime::ID && r.id() != "scripted" {
            registry.register(r.clone());
        }
    }
    let s = setting.clone();
    let builtin = VibeValleyRuntime::new(Arc::new(move || s.deepseek_api_key()), home.join("conversations")).with_execution(execution);
    registry.register(Arc::new(match model {
        Some(model) => builtin.with_client(model),
        None => builtin,
    }));
    registry
}

struct LazyCronOrchestrator(Arc<OnceLock<Arc<dyn CronOrchestratorPort>>>);

impl CronOrchestratorPort for LazyCronOrchestrator {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool {
        self.0.get().is_some_and(|o| o.hear_cron(agent, channel, line))
    }
}

struct ChannelAnnounceAdapter(Arc<Chat>);

impl ChannelAnnounce for ChannelAnnounceAdapter {
    fn place_exists(&self, id: &str) -> bool {
        self.0.place_exists(id)
    }

    fn orchestrator_in(&self, channel: &str) -> String {
        self.0.orchestrator_in(channel)
    }

    fn place_of_async<'a>(&'a self, who: &'a str, target: &'a str) -> BoxFuture<'a, Result<String, ApiError>> {
        Box::pin(self.0.place_of_async(who, target))
    }

    fn post_card_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        card: ArtifactCard,
        run: Option<String>,
        send_key: String,
    ) -> BoxFuture<'a, Result<ChatMessage, ApiError>> {
        Box::pin(self.0.post_card_async(from, channel, text, card, run, send_key))
    }

    fn post_attachments_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        attachments: Vec<String>,
        send_key: String,
    ) -> BoxFuture<'a, Result<ChatMessage, ApiError>> {
        Box::pin(self.0.post_attachments_async(from, channel, text, attachments, send_key))
    }
}

struct ServerDebugSources {
    ctx: Arc<Context>,
    runtime: Arc<Runtime>,
    board: Arc<Board>,
    agent: Arc<Agent>,
    repo: Arc<Repo>,
    artifact: Arc<ArtifactManager>,
    channel: Arc<Chat>,
    cron: Arc<CronScheduler>,
}

impl DebugDataSource for ServerDebugSources {
    fn trajectory_events(&self, session_id: &str) -> Vec<SessionEvent> {
        self.runtime.trajectory().open_events(session_id)
    }

    fn open_trajectory_ids(&self) -> Vec<String> {
        self.runtime.trajectory().open_session_ids()
    }

    fn system_prompt(&self, session_id: &str, kind: DebugTrajectoryKind) -> Option<String> {
        match kind {
            DebugTrajectoryKind::IssueSession | DebugTrajectoryKind::WorkspaceChat => None,
            DebugTrajectoryKind::Orchestrator => Some(self.agent.orchestrator.system_prompt_snapshot(session_id)),
        }
    }

    fn runtime_probe(&self) -> RuntimeProbeSnapshot {
        let runtimes = self
            .agent
            .profile
            .runtimes()
            .into_iter()
            .map(|info| {
                let (installed, version) = match &info.installation {
                    vibevalley_protocol::Installation::Available(a) => (true, a.version.clone()),
                    vibevalley_protocol::Installation::NotFound(_)
                    | vibevalley_protocol::Installation::Checking(_)
                    | vibevalley_protocol::Installation::Unsupported(_) => (false, None),
                };
                let ready = installed && info.settings.enabled;
                DebugRuntimeSummary {
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
        let agent_count = self.agent.profile.all().len() as u32;
        let orchestrator_ids = self.agent.profile.orchestrators().into_iter().map(|a| a.id).collect();
        RuntimeProbeSnapshot {
            runtimes,
            agent_count,
            orchestrator_ids,
        }
    }

    fn state_snapshot_async(&self) -> BoxFuture<'_, DebugStateSnapshot> {
        Box::pin(async move {
            let raw_issues = self.board.raw_issues_async().await.unwrap_or_default();
            let raw_sessions = self.ctx.service.session.all().await.unwrap_or_default();
            let live_overlays = self.ctx.live.core_session_overlays();
            let sessions = overlay_sessions(&raw_sessions, &live_overlays);
            let issues = derive_issues(&raw_issues, &sessions);
            let channels = self.channel.channels_snapshot_async().await.unwrap_or_default();
            let user_mentions = self.channel.user_mentions_snapshot_async().await.unwrap_or_default();
            let artifacts = self.artifact.list_async(&ArtifactListRequest::default()).await.unwrap_or_default();
            let media_jobs = self.artifact.media.list_async().await.unwrap_or_default();
            let crons = self.cron.list();
            let (call, call_reason) = self.ctx.live.call_snapshot();
            let live_snap = self.ctx.live.to_core_snapshot(false);
            let inbox = project_inbox(
                &InboxInput {
                    issues: raw_issues,
                    sessions: raw_sessions,
                    crons,
                    user_mentions,
                    runtime_inbox_items: self.ctx.live.runtime_inbox_snapshot(),
                    call,
                    call_reason,
                },
                &live_snap,
                0,
            );
            DebugStateSnapshot {
                issues,
                sessions,
                channel_count: channels.len() as u32,
                repo_count: self.repo.list().len() as u32,
                artifact_count: artifacts.len() as u32,
                media_job_count: media_jobs.len() as u32,
                inbox_count: inbox.items.len() as u32,
                state_cache_json: json!({
                    "seq": self.ctx.feed.seq(),
                    "sliceSeqs": self.ctx.feed.slice_seqs(),
                    "watchers": self.ctx.feed.watcher_counts(),
                }),
            }
        })
    }
}

async fn project_slice_json(core: &AppCore, kind: SliceKind, seq: i64) -> Result<Arc<str>, String> {
    let err = |e: ApiError| e.message;
    let dberr = |e: crate::db::DbError| e.to_string();
    match kind {
        SliceKind::Board => {
            let (raw_issues, raw_sessions, channels) = tokio::join!(
                core.board.raw_issues_async(),
                core.ctx.service.session.all(),
                core.channel.channels_snapshot_async(),
            );
            let input = BoardInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                channels: channels.map_err(err)?,
                commits: core.ctx.live.commits_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_board(&input, &live, seq)).map_err(err)
        }
        SliceKind::Sessions => {
            let (raw_sessions, raw_issues) = tokio::join!(core.ctx.service.session.all(), core.board.raw_issues_async());
            let input = SessionInput {
                sessions: raw_sessions.map_err(dberr)?,
                issues: raw_issues.map_err(|e| e.to_string())?,
                machines: core.ctx.live.machines_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_sessions(&input, &live, seq)).map_err(err)
        }
        SliceKind::Collab => {
            let chat = core.channel.slice_chat_async().await.map_err(err)?;
            let input = CollabInput {
                chat: Some(chat),
                connectors: core.ctx.live.connectors_snapshot(),
            };
            encode_slice(&project_collab(&input, seq)).map_err(err)
        }
        SliceKind::Inbox => {
            let (raw_issues, raw_sessions, user_mentions) = tokio::join!(
                core.board.raw_issues_async(),
                core.ctx.service.session.all(),
                core.channel.user_mentions_snapshot_async(),
            );
            let crons = core.cron.list();
            let (call, call_reason) = core.ctx.live.call_snapshot();
            let input = InboxInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                crons,
                user_mentions: user_mentions.map_err(err)?,
                runtime_inbox_items: core.ctx.live.runtime_inbox_snapshot(),
                call,
                call_reason,
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_inbox(&input, &live, seq)).map_err(err)
        }
        SliceKind::Ops => {
            let crons = core.cron.list();
            let media = core.artifact.media.list_async().await.map_err(err)?;
            let input = OpsInput { crons, media: Some(media) };
            encode_slice(&project_ops(&input, seq)).map_err(err)
        }
        SliceKind::Farm => {
            let (raw_issues, raw_sessions) = tokio::join!(core.board.raw_issues_async(), core.ctx.service.session.all());
            let input = FarmInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                progress: core.ctx.live.progress_snapshot(),
                commits: core.ctx.live.commits_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(true);
            encode_slice(&project_farm(&input, &live, seq)).map_err(err)
        }
    }
}

fn spawn_skin_event_bridge(ctx: &Context, game: &Arc<Game>, runtime: &Arc<Runtime>, channel: &Arc<Chat>) {
    let mut session_rx = runtime.subscribe_events();
    let mut message_rx = channel.subscribe_message_events();
    let game = Arc::downgrade(game);
    let runtime_ref = Arc::downgrade(runtime);
    let cancel = ctx.task.child_token();

    ctx.spawn("game.event_bridge", async move {
        let mut known_sessions: HashMap<String, vibevalley_protocol::Session> = HashMap::new();
        let mut was_working: HashSet<String> = HashSet::new();
        if let Some(rt) = runtime_ref.upgrade() {
            for s in rt.list_async().await {
                if s.phase.is_working() {
                    was_working.insert(s.id.clone());
                }
                known_sessions.insert(s.id.clone(), s);
            }
        }
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                ev = session_rx.recv() => match ev {
                    Ok(SessionLifecycleEvent::Changed(session)) => {
                        let Some(g) = game.upgrade() else { return };
                        let existed = known_sessions.contains_key(&session.id);
                        if !existed {
                            let others: Vec<&vibevalley_protocol::Session> = known_sessions.values().collect();
                            g.on_session_hired(&session, &others);
                        }
                        match &session.phase {
                            Phase::Working(w) => {
                                let was = was_working.contains(&session.id);
                                g.on_session_working(&session, was, &w.doing);
                                was_working.insert(session.id.clone());
                            }
                            Phase::Done(_) | Phase::Failed(_) | Phase::Resting(_) | Phase::Closed(_) => {
                                was_working.remove(&session.id);
                            }
                        }
                        known_sessions.insert(session.id.clone(), *session);
                    }
                    Ok(SessionLifecycleEvent::Left { id, .. }) => {
                        was_working.remove(&id);
                        if let Some(removed) = known_sessions.remove(&id)
                            && let Some(g) = game.upgrade()
                        {
                            g.on_session_left(&removed, None, None);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(rt) = runtime_ref.upgrade() {
                            known_sessions.clear();
                            was_working.clear();
                            for s in rt.list_async().await {
                                if s.phase.is_working() {
                                    was_working.insert(s.id.clone());
                                }
                                known_sessions.insert(s.id.clone(), s);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ev = message_rx.recv() => match ev {
                    Ok(ChannelMessageEvent::Posted { message, thread_issue_id, answers }) => {
                        let Some(g) = game.upgrade() else { return };
                        let thread_worker = thread_issue_id.as_deref().and_then(|iid| {
                            known_sessions
                                .values()
                                .find(|s| s.is_board_worker() && s.issue_id() == Some(iid))
                                .map(|s| s.id.as_str())
                        });
                        let mentioned_sessions: Vec<String> = message
                            .mentions
                            .iter()
                            .filter(|m| known_sessions.contains_key(m.as_str()))
                            .cloned()
                            .collect();
                        g.on_message_posted(&message.actor, thread_worker, &mentioned_sessions, answers.is_some());
                    }
                    Ok(ChannelMessageEvent::Edited(_)) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
}

/// Opens and starts the full server asynchronously.
pub async fn create_app(config: Config) -> Result<App, StartError> {
    Box::pin(create_app_inner(config)).await
}

async fn create_app_inner(config: Config) -> Result<App, StartError> {
    let boot_started = std::time::Instant::now();
    install_tls();
    std::fs::create_dir_all(&config.home).map_err(|e| failed("the home")(&e))?;
    std::fs::create_dir_all(&config.work_root).map_err(|e| failed("the work root")(&e))?;
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees")] {
        std::fs::create_dir_all(&dir).map_err(|e| failed("the work root")(&e))?;
    }

    // L0: shared Service + Context
    let service = match config.database_url.as_deref() {
        Some(url) => Service::open_url(url).await.map_err(|e| failed("the database")(&e))?,
        None => Service::open(&config.home).await.map_err(|e| failed("the database")(&e))?,
    };
    let task = TaskGroup::new();
    let live = Arc::new(LiveState::new());
    let feed = Arc::new(StateFeed::new());
    let outbox = Arc::new(Outbox::new(service.clone()));
    let (http, download): (Arc<dyn Fetch>, Arc<dyn Fetch>) = if let Some(network) = &config.media_network {
        network.clone()
    } else if config.offline_media {
        crate::fake::moss::network()
    } else {
        (Arc::new(Http), Arc::new(PublicDownload))
    };
    let ctx = Arc::new(Context::new(service, task, live, outbox, feed, config.clock.clone(), http, download));
    let active_subscriptions = Arc::new(AtomicUsize::new(0));

    // Base & storage
    let setting = Setting::open(SettingConfig {
        home: config.home.clone(),
        work_root: config.work_root.clone(),
        version: config.version.clone(),
        deepseek_api_key: config.deepseek_api_key.clone(),
    });
    let provider = Arc::new(Provider::new(setting.clone(), ctx.http.clone()));
    let storage = Storage::open_async(&config.home, ctx.clone())
        .await
        .map_err(|e| failed("the storage")(&e.message))?;

    let execution = Arc::new(OnceLock::new());
    let registry = config
        .registry
        .clone()
        .unwrap_or_else(|| Arc::new(runtimes(&setting, &config.home, execution.clone(), config.model_client.clone())));
    let machine = Machine::open(ctx.clone(), registry.clone(), storage.clone(), config.version.clone());
    let profile = Profile::open_with_machines(
        ctx.clone(),
        &config.home,
        &config.starters,
        registry.clone(),
        machine.registry().clone(),
        config.probe_runtimes,
    )
    .map_err(|e| failed("the profiles")(&e))?;
    let remote = Remote::open(ctx.clone(), config.version.clone())
        .await
        .map_err(|e| failed("remote access")(&e.message))?;

    // Domain services
    let memory = Memory::open(ctx.clone(), profile.clone());
    memory.register_outbox();

    let channel = Chat::open_async(ctx.clone(), storage.clone(), config.link_previews)
        .await
        .map_err(|e| failed("the chat")(&e.message))?;
    for orch in profile.orchestrators() {
        if let Err(e) = channel.seat_orchestrator_async(&orch).await {
            eprintln!("vibevalley-server: chat: seating {}: {}", orch.id, e.message);
        }
    }
    {
        let c = Arc::downgrade(&channel);
        let p = Arc::downgrade(&profile);
        let ctx_seat = ctx.clone();
        profile.store.when_kept(Arc::new(move |agent| {
            if let (Some(c), Some(p)) = (c.upgrade(), p.upgrade())
                && p.is_orchestrator(&agent.id)
            {
                let agent = agent.clone();
                ctx_seat.spawn("channel.seat_orchestrator", async move {
                    if let Err(e) = c.seat_orchestrator_async(&agent).await {
                        eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
                    }
                });
            }
            Ok(())
        }));
    }

    let (chat_msg_tx, chat_msg_rx) = broadcast::channel(256);
    {
        let mut msg_events = channel.subscribe_message_events();
        let cancel = ctx.task.child_token();
        ctx.spawn("artifact.chat_messages", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    res = msg_events.recv() => match res {
                        Ok(ChannelMessageEvent::Posted { message, .. } | ChannelMessageEvent::Edited(message)) => {
                            let _ = chat_msg_tx.send(message);
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
    }
    let artifact = ArtifactManager::open_async(
        ctx.clone(),
        setting.clone(),
        storage.clone(),
        Arc::new(ChannelAnnounceAdapter(channel.clone())),
        Some(chat_msg_rx),
    )
    .await
    .map_err(|e| failed("artifacts")(&e.message))?;

    let board_config = RuntimeConfig {
        worktrees_dir: config.work_root.join("worktrees"),
        data_dir: config.home.join("issues"),
        repos_dir: Some(config.work_root.join("repos")),
        ..RuntimeConfig::under(&config.home)
    };
    let repo = Repo::open(&config.work_root, board_config.per_repo).map_err(|e| failed("the repos")(&e))?;
    if config.probe_runtimes {
        repo.probe_in_context(&ctx);
    }

    let drivers: Arc<dyn SessionDriver> = Arc::new(AgentDriver::new(profile.clone(), Some(memory.clone() as Arc<dyn MemoryRecallPort>)));
    let (runtime, opened) = Runtime::open_async(ctx.clone(), drivers, board_config)
        .await
        .map_err(|e| failed("the runtime")(&e))?;
    {
        let mem = memory.clone();
        runtime.set_remember(Arc::new(move |input| {
            let mem = mem.clone();
            Box::pin(async move {
                let _ = mem.create_endpoint_async(Caller::Session, None, input).await?;
                Ok(())
            })
        }));
    }

    let board = Board::open_async(ctx.clone(), runtime.clone(), opened, Some(repo.clone()), Some(channel.clone()))
        .await
        .map_err(|e| failed("the board")(&e))?;
    {
        let rt = runtime.clone();
        channel.guard_removal(move |channel_id| {
            let rt = rt.clone();
            Box::pin(async move {
                let sessions = rt.sessions_async().await.unwrap_or_default();
                let busy = sessions
                    .iter()
                    .any(|x| (x.is_board_worker() || x.is_direct_talker()) && x.channel_id() == Some(channel_id.as_str()));
                if busy {
                    vec![vibevalley_i18n::t("server.channel.helpersThere", &[])]
                } else {
                    vec![]
                }
            })
        });
    }

    let publisher = config.publisher.clone().unwrap_or_else(|| Arc::new(Publisher::default()));
    let pull = Pull::open_async(ctx.clone(), publisher, Some(repo.clone()), Some(board.clone()), None, None)
        .await
        .map_err(|e| failed("the pulls")(&e.message))?;
    pull.start_poller(config.poll_pulls);

    let issue_chat = IssueChat::start(ctx.clone(), board.clone(), channel.clone());
    let session_chat = SessionChat::start(ctx.clone(), board.clone(), channel.clone(), Some(issue_chat.clone()));

    let cron_orch_slot = Arc::new(OnceLock::<Arc<dyn CronOrchestratorPort>>::new());
    let cron_orchestrator: Option<Arc<dyn CronOrchestratorPort>> = config
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
        repos_root: repo.root().to_path_buf(),
    });
    let mcp = Mcp::new(tool.clone(), config.version.clone());

    let key = setting.clone();
    let orchestrator = Orchestrator::open_async(OrchestratorParts {
        ctx: ctx.clone(),
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
    })
    .await
    .map_err(|e| failed("durable execution")(&e))?;
    let _ = execution.set(SharedExecution::new(orchestrator.execution.harness.clone()));
    orchestrator.start_inbox_observer().map_err(|e| failed("durable projection")(&e))?;

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

    let game = Game::open(&config.home, ctx.clone(), repo.clone());
    game.count_commits(config.git_emails.clone());
    spawn_skin_event_bridge(&ctx, &game, &runtime, &channel);

    // Fan out committed `work.session.reported` outbox deliveries to IssueChat,
    // SessionChat, Memory, Game, and RuntimeFleet.
    {
        let ic = Arc::downgrade(&issue_chat);
        let sc = Arc::downgrade(&session_chat);
        let ag = Arc::downgrade(&agent);
        let g = Arc::downgrade(&game);
        let rt = Arc::downgrade(&runtime);
        ctx.outbox.register(OUTBOX_SESSION_REPORTED, move |delivery| {
            let (ic, sc, ag, g, rt) = (ic.clone(), sc.clone(), ag.clone(), g.clone(), rt.clone());
            async move {
                let report: OutboxSessionReported =
                    serde_json::from_value(delivery.payload).map_err(|e| format!("invalid {OUTBOX_SESSION_REPORTED} payload: {e}"))?;
                if let Some(ic) = ic.upgrade() {
                    ic.handle_report_async(&report).await.map_err(|e| e.message)?;
                }
                if let Some(sc) = sc.upgrade() {
                    sc.handle_report_async(&report).await;
                }
                if let Some(rt) = rt.upgrade()
                    && let Some(reported_session) = rt.session_async(&report.id).await
                {
                    if let Some(ag) = ag.upgrade() {
                        ag.memory.keep_session_reported_async(&reported_session).await;
                        ag.profile
                            .fleet
                            .on_session_reported(&reported_session.runtime, report.spent.as_ref().and_then(|s| s.cny).map(|n| n.0));
                    }
                    if let Some(g) = g.upgrade() {
                        g.on_session_reported(&reported_session, report.outcome);
                    }
                }
                Ok::<(), String>(())
            }
        });
    }

    let debug_sources = Arc::new(ServerDebugSources {
        ctx: ctx.clone(),
        runtime: runtime.clone(),
        board: board.clone(),
        agent: agent.clone(),
        repo: repo.clone(),
        artifact: artifact.clone(),
        channel: channel.clone(),
        cron: cron.clone(),
    });
    let subs_counter = active_subscriptions.clone();
    let debug = DebugKit::new(DebugParts {
        ctx: ctx.clone(),
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
        set_observer(Some(debug.collector()));
    }

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
        remote,
        debug,
        game,
    });

    let router = Router::new(RouterParts {
        core: core.clone(),
        ports,
        observer: config.invoke_observer.or_else(|| config.debug_enabled.then(|| core.debug.collector() as _)),
        fault_gate: config.debug_enabled.then(|| core.debug.collector() as _),
        host_debug: config.host_debug,
        active_subscriptions,
    });

    let server_arc: Arc<dyn Server> = router.clone();
    core.remote.bind_server(Arc::downgrade(&server_arc));

    core.ctx.outbox.start(&core.ctx.task);
    core.ctx.feed.start(&core.ctx.task, {
        let core = core.clone();
        move |kind, seq| {
            let core = core.clone();
            Box::pin(async move { project_slice_json(&core, kind, seq).await })
        }
    });
    core.ctx.mark_dirty(SliceMask::ALL);
    core.ctx.feed.flush().await;

    core.board.refresh_queue_async().await.map_err(|e| failed("the queue")(&e))?;
    core.remote.restore_if_enabled_async().await;

    Ok(App { router })
}

/// Blocking wrapper around [`create_app`] for process boundaries and synchronous tests.
pub fn create_app_blocking(config: Config) -> Result<App, StartError> {
    vibevalley_runtime::rt::block_on(create_app(config))
}
