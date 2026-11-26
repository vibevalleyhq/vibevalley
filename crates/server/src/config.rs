//! Server startup configuration (`Config`) and error ([`StartError`]).

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_core::SharedClock;
use vibevalley_runtime::agent::ModelClient;
use vibevalley_runtime::agent::extensions::governance::Permissions;
use vibevalley_runtime::oar::Registry;

use crate::context::Fetch;
use crate::context::api::SharedHostDebug;
use crate::log::SharedInvokeObserver;

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
    /// Enables DevTools diagnostics (`debug.*` endpoints, timeline observer, fault gate).
    pub debug_enabled: bool,
    /// Optional GPUI shell debug bridge attached at startup (immutable on [`crate::Router`]).
    pub host_debug: Option<SharedHostDebug>,
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
            poll_pulls: None,
            tick_crons: true,
            link_previews: true,
            git_emails: vec![],
            model_client: None,
            offline_media: false,
            media_network: None,
            orchestrator_listens: true,
            debug_enabled: false,
            host_debug: None,
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
        Config {
            work_root: Self::default_work_root(),
            version: version.into(),
            deepseek_api_key: env_str("DEEPSEEK_API_KEY").unwrap_or_default(),
            starters: csv("VIBEVALLEY_AGENT_STARTERS"),
            git_emails: csv("VIBEVALLEY_GIT_EMAILS"),
            poll_pulls: Some(env_str("VIBEVALLEY_GITHUB_PR_POLL_SECONDS").and_then(|s| s.parse::<u64>().ok()).unwrap_or(180)),
            debug_enabled: env_str("VIBEVALLEY_DEBUG").as_deref() == Some("1"),
            database_url: env_str("VIBEVALLEY_DATABASE_URL"),
            ..Self::under(home)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartErrorKind {
    DatabaseSchema,
    Database,
    Storage,
    Boot,
}

#[derive(Debug, Clone)]
pub struct StartError {
    pub kind: StartErrorKind,
    pub message: String,
    pub detail: Option<String>,
    pub db_path: Option<PathBuf>,
}

impl StartError {
    pub fn new(kind: StartErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: None,
            db_path: None,
        }
    }
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the server did not start: {}", self.message)
    }
}

impl std::error::Error for StartError {}

pub(crate) fn failed(what: &str) -> impl Fn(&dyn std::fmt::Display) -> StartError + '_ {
    let kind = if what == "the storage" {
        StartErrorKind::Storage
    } else {
        StartErrorKind::Boot
    };
    move |e| StartError::new(kind, format!("{what}: {e}"))
}
