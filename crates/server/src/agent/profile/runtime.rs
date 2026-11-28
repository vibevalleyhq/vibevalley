//! The runtimes the profiles run on: what is installed, its models, and
//! what stops it taking work.
//!
//! VibeValley's runtime ids are kept on the wire; one that `vibevalley-oar`
//! registers as `acp:<id>` (opencode) is found under it. Runtimes the
//! registry has beyond VibeValley's list (for example `scripted` in tests)
//! are listed after them under their own ids.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_mcp::McpTransportSpec;
use vibevalley_protocol::{
    Agent, AgentProblem, AgentProblemLevel, ApiError, BizCode, Installation, InstallationAvailable, InstallationChecking, InstallationNotFound,
    InstallationUnsupported, InventoryEntry, JsNumber, LOCAL_MACHINE_ID, McpHostId, McpServerEntry, McpTransportKind, ModelEntry, NoticeLevel, RuntimeInfo,
    RuntimeRef, RuntimeSettings, Via,
};
use vibevalley_runtime::machine::{MachineRegistry, MachineStatus as RtMachineStatus};
use vibevalley_runtime::oar::{HostMcpServer, Registry, Runtime};

use super::preset::{
    Candidate, agent_problems, choose_agent, money_stop, preset_of, quota_of, runtime_ids, runtime_label, runtime_reports_model_efforts, session_options,
    support_of,
};
use super::profile::ProfileStore;
use crate::context::Context;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_CONCURRENCY: usize = 4;

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::RuntimeRefused, text)
}

/// What a session on a profile is opened with (`Resolved`).
pub struct Resolved {
    pub runtime: Arc<dyn Runtime>,
    pub machine_id: String,
    pub is_local: bool,
    pub bin_path: String,
    pub model: String,
    pub effort: String,
    pub env: BTreeMap<String, String>,
}

/// A profile against what its runtime was last seen as.
pub struct Assessment {
    pub agent: Agent,
    pub info: Option<RuntimeInfo>,
    pub problems: Vec<AgentProblem>,
    pub blocking: Vec<AgentProblem>,
}

impl Assessment {
    pub fn usable(&self) -> bool {
        self.agent.enabled && self.blocking.is_empty()
    }
}

#[derive(Clone)]
struct Observation {
    info: RuntimeInfo,
    locale: String,
    read: u64,
}

/// Per-runtime CNY spend accumulated during the current local calendar day.
struct DailySpend {
    day: jiff::civil::Date,
    by_runtime: HashMap<String, f64>,
}

impl DailySpend {
    fn today() -> jiff::civil::Date {
        jiff::ZonedDateTime::now().date()
    }

    fn new() -> Self {
        Self {
            day: Self::today(),
            by_runtime: HashMap::new(),
        }
    }

    fn sync_day(&mut self) {
        let today = Self::today();
        if self.day != today {
            self.day = today;
            self.by_runtime.clear();
        }
    }

    fn add(&mut self, runtime: &str, cny: f64) -> f64 {
        self.sync_day();
        let key = runtime.strip_prefix("acp:").unwrap_or(runtime);
        let entry = self.by_runtime.entry(key.to_string()).or_insert(0.0);
        *entry += cny;
        *entry
    }

    fn get(&mut self, runtime: &str) -> Option<JsNumber> {
        self.sync_day();
        let key = runtime.strip_prefix("acp:").unwrap_or(runtime);
        self.by_runtime.get(key).copied().filter(|v| *v > 0.0).map(JsNumber::from)
    }
}

const HELD_OBSERVATION_CACHE_CAPACITY: std::num::NonZeroUsize = std::num::NonZeroUsize::new(128).expect("non-zero capacity");

struct FleetState {
    held: vibevalley_kit::cache::LruCache<String, Observation>,
    spend: DailySpend,
    probing: HashSet<String>,
}

/// Probed runtime fleet backing agent profiles across local and remote machines.
pub struct RuntimeFleet {
    registry: Arc<Registry>,
    machines: Arc<MachineRegistry>,
    profiles: Arc<ProfileStore>,
    ctx: Arc<Context>,
    background: bool,
    state: Mutex<FleetState>,
    reads: AtomicU64,
    cancel: CancellationToken,
}

/// Runs an async OAR trait probe with a hard `PROBE_TIMEOUT` and immediate wakeup on `cancel`.
async fn probe_with_timeout<T>(cancel: &CancellationToken, fut: impl std::future::Future<Output = T>) -> Option<T> {
    if cancel.is_cancelled() {
        return None;
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        res = tokio::time::timeout(PROBE_TIMEOUT, fut) => res.ok(),
    }
}

/// A runtime's usage is read again this often, and this long after a
/// session on it reports.
const USAGE_EVERY: Duration = Duration::from_secs(5 * 60);
const USAGE_AFTER_RUN: Duration = Duration::from_secs(20);

fn format_stdio_target(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        format!("stdio · {command}")
    } else {
        format!("stdio · {command} {}", args.join(" "))
    }
}

fn inventory_entry_from_host_mcp(server: HostMcpServer) -> InventoryEntry {
    let description = match &server.transport {
        McpTransportSpec::Stdio { command, args, .. } => format_stdio_target(command, args),
        McpTransportSpec::StreamableHttp { url, .. } => format!("streamableHttp · {url}"),
    };
    InventoryEntry {
        name: server.name,
        description,
        source: server.config_path.to_string_lossy().into_owned(),
        enabled: server.enabled,
    }
}

fn inventory_entry_from_mcp_entry(server: &McpServerEntry) -> InventoryEntry {
    let description = match server.transport {
        McpTransportKind::Stdio => format_stdio_target(server.command.as_deref().unwrap_or_default(), &server.args),
        McpTransportKind::StreamableHttp => format!("streamableHttp · {}", server.url.as_deref().unwrap_or_default()),
    };
    InventoryEntry {
        name: server.name.clone(),
        description,
        source: server.config_path.clone(),
        enabled: server.enabled,
    }
}

/// `fromOar`: oar's account usage as VibeValley shows it.
pub fn usage_from_oar(usage: vibevalley_runtime::oar::AccountUsage) -> vibevalley_protocol::AccountUsage {
    use vibevalley_protocol::{AccountUsage as U, AccountUsageLoginRequired, AccountUsageOk, AccountUsageUnavailable, UsageWindow};
    match usage {
        vibevalley_runtime::oar::AccountUsage::ReauthRequired { .. } => U::LoginRequired(AccountUsageLoginRequired {}),
        vibevalley_runtime::oar::AccountUsage::Unsupported { reason } => U::Unavailable(AccountUsageUnavailable {
            reason: if reason.is_empty() { t("server.runtime.noUsage", &[]) } else { reason },
        }),
        vibevalley_runtime::oar::AccountUsage::Available { plan, windows, .. } => U::Ok(AccountUsageOk {
            subscription: plan.filter(|p| !p.is_empty()),
            windows: windows
                .into_iter()
                .map(|w| UsageWindow {
                    label: w.label,
                    used_percent: ((w.used_ratio * 100.0).round()).into(),
                    resets_at: w.resets_at.and_then(|at| at.parse::<jiff::Timestamp>().ok()).map(|at| at.as_millisecond()),
                })
                .collect(),
        }),
    }
}

impl RuntimeFleet {
    /// The fleet over `registry`. With `background`, every runtime is
    /// probed now, off the caller's thread.
    pub fn new(registry: Arc<Registry>, profiles: Arc<ProfileStore>, ctx: Arc<Context>, background: bool) -> Arc<RuntimeFleet> {
        let machines = Arc::new(MachineRegistry::with_local(registry.clone()));
        Self::new_with_machines(registry, machines, profiles, ctx, background)
    }

    /// The fleet backed by a shared `MachineRegistry` for local and remote dispatch.
    pub fn new_with_machines(
        registry: Arc<Registry>,
        machines: Arc<MachineRegistry>,
        profiles: Arc<ProfileStore>,
        ctx: Arc<Context>,
        background: bool,
    ) -> Arc<RuntimeFleet> {
        let cancel = ctx.task.child_token();
        let fleet = Arc::new(RuntimeFleet {
            registry,
            machines,
            profiles,
            ctx,
            background,
            state: Mutex::new(FleetState {
                held: vibevalley_kit::cache::LruCache::new(HELD_OBSERVATION_CACHE_CAPACITY),
                spend: DailySpend::new(),
                probing: HashSet::new(),
            }),
            reads: AtomicU64::new(0),
            cancel,
        });
        if background {
            let ids = fleet.ids();
            let startup_fleet = Arc::downgrade(&fleet);
            fleet.ctx.spawn("agent.fleet.probe_all", async move {
                let Some(fleet) = startup_fleet.upgrade() else { return };
                fleet.probe_all_async(ids).await;
            });
            let f = Arc::downgrade(&fleet);
            let cancel = fleet.cancel.clone();
            fleet.ctx.spawn("agent.fleet.usage_poll", async move {
                let mut tick = vibevalley_kit::task::Ticker::periodic_delayed(USAGE_EVERY).with_delay_behavior();
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        _ = tick.tick() => {}
                    }
                    let Some(fleet) = f.upgrade() else { break };
                    fleet.refresh_all_usage_async().await;
                }
            });
        }
        fleet
    }

    /// Records CNY spend reported by a finished session and schedules usage refresh when `background`.
    pub(crate) fn on_session_reported(self: &Arc<Self>, runtime_id: &str, cny: Option<f64>) {
        if let Some(cny) = cny
            && cny.is_finite()
            && cny > 0.0
        {
            self.record_spend(runtime_id, cny);
        }
        if self.background {
            self.usage_soon(runtime_id);
        }
    }

    async fn probe_all_async(self: &Arc<Self>, ids: Vec<String>) {
        let sem = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
        let mut set = JoinSet::new();
        for id in ids {
            if self.cancel.is_cancelled() || !self.state.lock().probing.insert(id.clone()) {
                continue;
            }
            let fleet = self.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let permit = tokio::select! {
                    biased;
                    _ = fleet.cancel.cancelled() => None,
                    p = sem.acquire_owned() => p.ok(),
                };
                if let Some(_permit) = permit
                    && !fleet.cancel.is_cancelled()
                {
                    fleet.lookup_async(&id).await;
                }
                fleet.state.lock().probing.remove(&id);
            });
        }
        while set.join_next().await.is_some() {}
    }

    fn record_spend(&self, runtime: &str, cny: f64) {
        let key = runtime.strip_prefix("acp:").unwrap_or(runtime);
        let (hit, spent_today) = {
            let mut state = self.state.lock();
            state.spend.add(key, cny);
            let hit = state.held.get(key).cloned();
            let spent_today = state.spend.get(key);
            (hit, spent_today)
        };
        let updated = hit.map(|hit| {
            let settings = self.profiles.settings(key);
            Self::shown_with_spend(RuntimeInfo { settings, ..hit.info }, spent_today)
        });
        if let Some(info) = updated {
            self.ctx.live.publish_runtime(self.ctx.now(), info);
        }
    }

    /// `usageSoon`: the runtime's usage read again 20 s from now (several
    /// runs share one read).
    pub fn usage_soon(self: &Arc<Self>, id: &str) {
        let key = format!("usage:{id}");
        if self.cancel.is_cancelled() || !self.state.lock().probing.insert(key.clone()) {
            return;
        }
        let fleet = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let id = id.to_string();
        self.ctx.spawn("agent.fleet.usage_soon", async move {
            let stopped = tokio::select! {
                biased;
                _ = cancel.cancelled() => true,
                _ = tokio::time::sleep(USAGE_AFTER_RUN) => false,
            };
            let Some(fleet) = fleet.upgrade() else { return };
            fleet.state.lock().probing.remove(&key);
            if !stopped {
                fleet.refresh_usage_async(&id).await;
            }
        });
    }

    pub async fn refresh_usage_async(&self, id: &str) {
        let Some(before) = self.held(id) else { return };
        if !matches!(before.info.installation, Installation::Available(_)) || self.cancel.is_cancelled() {
            return;
        }
        let Some(runtime) = self.runtime(id) else { return };
        let Some(usage) = probe_with_timeout(&self.cancel, runtime.account_usage())
            .await
            .and_then(Result::ok)
            .map(usage_from_oar)
        else {
            return;
        };
        let info = {
            let mut state = self.state.lock();
            let Some(now_held) = state.held.get_mut(id) else { return };
            if now_held.read != before.read || now_held.info.usage.as_ref() == Some(&usage) {
                return;
            }
            now_held.info.usage = Some(usage);
            now_held.info.checked_at = self.ctx.now();
            let raw = now_held.info.clone();
            let spent_today = state.spend.get(&raw.id);
            Self::shown_with_spend(raw, spent_today)
        };
        self.ctx.live.publish_runtime(self.ctx.now(), info);
    }

    /// Refreshes usage across all available runtimes in parallel with bounded concurrency.
    async fn refresh_all_usage_async(self: &Arc<Self>) {
        let ids = self.ids();
        let fleet = self.clone();
        let sem = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
        let mut set = JoinSet::new();
        for id in ids {
            if fleet.cancel.is_cancelled() {
                break;
            }
            let fleet = fleet.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let permit = tokio::select! {
                    biased;
                    _ = fleet.cancel.cancelled() => return,
                    p = sem.acquire_owned() => match p {
                        Ok(p) => p,
                        Err(_) => return,
                    },
                };
                let _permit = permit;
                fleet.refresh_usage_async(&id).await;
            });
        }
        while set.join_next().await.is_some() {}
    }

    /// Stops answering with new probes (`close`).
    pub fn close(&self) {
        self.cancel.cancel();
    }

    /// The registry's runtime for a wire id.
    pub fn runtime(&self, id: &str) -> Option<Arc<dyn Runtime>> {
        self.registry.get(id).or_else(|| self.registry.get(&format!("acp:{id}")))
    }

    /// VibeValley's runtimes, then the registry's others.
    pub fn ids(&self) -> Vec<String> {
        let mut ids = runtime_ids();
        for r in self.registry.list() {
            let id = r.id();
            let covered = ids.iter().any(|known| known == id || format!("acp:{known}") == id);
            if !covered {
                ids.push(id.to_string());
            }
        }
        ids
    }

    fn known(&self, id: &str) -> bool {
        self.ids().iter().any(|k| k == id)
    }

    fn placeholder(&self, id: &str, checked_at: i64) -> RuntimeInfo {
        RuntimeInfo {
            id: id.into(),
            machine_id: None,
            preset: preset_of(id),
            support: support_of(id),
            installation: Installation::Checking(InstallationChecking {}),
            models: None,
            usage: None,
            skills: None,
            mcp_servers: None,
            tools: None,
            settings: self.profiles.settings(id),
            spent_today: self.state.lock().spend.get(id),
            quota: None,
            stop: String::new(),
            checked_at,
        }
    }

    fn shown_with_spend(info: RuntimeInfo, spent_today: Option<JsNumber>) -> RuntimeInfo {
        let mut out = RuntimeInfo { spent_today, ..info };
        out.stop = money_stop(Some(&out));
        out.quota = Some(quota_of(out.usage.as_ref()));
        out
    }

    /// `withSpend`: the stop, daily spend, and quota from what is known now.
    fn shown(&self, info: RuntimeInfo) -> RuntimeInfo {
        let spent_today = self.state.lock().spend.get(&info.id);
        Self::shown_with_spend(info, spent_today)
    }

    /// Points the runtime's binary at the saved `binPath`; empty searches
    /// PATH (`probeInstallation`).
    fn use_binary(id: &str, bin_path: &str) {
        let bare = id.strip_prefix("acp:").unwrap_or(id);
        let command = vibevalley_runtime::oar::runtime_spec(bare).and_then(|s| s.binary).unwrap_or(bare);
        let path = Some(bin_path.trim()).filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
        vibevalley_runtime::oar::set_binary(command, path);
    }

    /// One probe of the machine (async; probes models and account usage in parallel).
    async fn probe_async(&self, id: &str) -> RuntimeInfo {
        let mut info = self.placeholder(id, self.ctx.now());
        Self::use_binary(id, &info.settings.bin_path);
        let Some(runtime) = self.runtime(id) else {
            let reason = if id == "cursor" {
                t("server.runtime.cursor", &[])
            } else {
                t("server.runtime.oarUnknown", &[])
            };
            info.installation = Installation::Unsupported(InstallationUnsupported { reason, sign_in_command: None });
            return info;
        };
        let installation = probe_with_timeout(&self.cancel, runtime.installation())
            .await
            .unwrap_or_else(|| vibevalley_runtime::oar::Installation::Unusable {
                reason: t("server.runtime.probeTimeout", &[]),
            });
        info.installation = match installation {
            vibevalley_runtime::oar::Installation::LoginRequired { path } => Installation::Unsupported(InstallationUnsupported {
                reason: t("server.runtime.signInRequired", &[("runtime", info.preset.label.clone().into())]),
                sign_in_command: Some(path.to_string_lossy().into_owned()),
            }),
            vibevalley_runtime::oar::Installation::NotInstalled => Installation::NotFound(InstallationNotFound {}),
            vibevalley_runtime::oar::Installation::Unusable { reason } => Installation::Unsupported(InstallationUnsupported { reason, sign_in_command: None }),
            vibevalley_runtime::oar::Installation::Available { version, path } => {
                if info.support.in_process || path.as_os_str() == "(built in)" {
                    Installation::Available(InstallationAvailable {
                        via: Via::Bundled,
                        command: id.into(),
                        version: None,
                    })
                } else {
                    Installation::Available(InstallationAvailable {
                        via: Via::Executable,
                        command: path.to_string_lossy().into_owned(),
                        version: version.filter(|v| !v.is_empty()),
                    })
                }
            }
        };
        if !matches!(info.installation, Installation::Available(_)) {
            return info;
        }
        let (models_res, usage_res, mcp_res) = tokio::join!(
            probe_with_timeout(&self.cancel, runtime.list_models()),
            probe_with_timeout(&self.cancel, runtime.account_usage()),
            probe_with_timeout(&self.cancel, runtime.list_mcp_servers()),
        );
        info.models = models_res.and_then(Result::ok).map(|models| {
            models
                .into_iter()
                .map(|m| ModelEntry {
                    name: if m.display_name.is_empty() { m.id.clone() } else { m.display_name },
                    id: m.id,
                    effort_levels: m.effort_levels,
                    default_effort: m.default_effort,
                    is_default: m.is_default,
                })
                .collect()
        });
        info.usage = usage_res.and_then(Result::ok).map(usage_from_oar);
        info.mcp_servers = match mcp_res {
            Some(Ok(Some(servers))) => Some(servers.into_iter().map(inventory_entry_from_host_mcp).collect()),
            Some(Ok(None)) | None => None,
            Some(Err(err)) => {
                tracing::warn!(runtime = %id, error = %err, "failed to probe host MCP servers");
                None
            }
        };
        info
    }

    /// Updates cached `RuntimeInfo.mcp_servers` after a host MCP mutation and publishes a live update.
    pub fn sync_host_mcp_servers(&self, host: McpHostId, servers: &[McpServerEntry]) {
        let runtime_id = match host {
            McpHostId::Antigravity => "antigravity",
            McpHostId::Claude => "claude",
            McpHostId::Codex => "codex",
            McpHostId::Cursor => "cursor",
        };
        let entries: Vec<InventoryEntry> = servers.iter().map(inventory_entry_from_mcp_entry).collect();
        let info = {
            let mut state = self.state.lock();
            let Some(obs) = state.held.get_mut(runtime_id) else {
                return;
            };
            obs.info.mcp_servers = Some(entries);
            obs.info.checked_at = self.ctx.now();
            let raw = obs.info.clone();
            let spent_today = state.spend.get(&raw.id);
            Self::shown_with_spend(raw, spent_today)
        };
        self.ctx.live.publish_runtime(self.ctx.now(), info);
    }

    /// A new lookup, kept and told on the live stream.
    async fn lookup_async(&self, id: &str) -> RuntimeInfo {
        let read = self.reads.fetch_add(1, Ordering::Relaxed) + 1;
        let info = self.shown(self.probe_async(id).await);
        {
            let mut state = self.state.lock();
            // A slower older lookup does not overwrite a newer one.
            if state.held.get(id).is_none_or(|o| o.read < read) {
                state.held.insert(
                    id.into(),
                    Observation {
                        info: info.clone(),
                        locale: vibevalley_i18n::locale(),
                        read,
                    },
                );
            }
        }
        self.ctx.live.publish_runtime(self.ctx.now(), info.clone());
        info
    }

    fn probe_later(self: &Arc<Self>, id: &str) {
        if self.cancel.is_cancelled() || !self.state.lock().probing.insert(id.to_string()) {
            return;
        }
        let fleet = self.clone();
        let id = id.to_string();
        self.ctx.spawn("agent.fleet.probe_one", async move {
            fleet.lookup_async(&id).await;
            fleet.state.lock().probing.remove(&id);
        });
    }

    fn held(&self, id: &str) -> Option<Observation> {
        self.state.lock().held.get(id).cloned()
    }

    /// Active (available and enabled) runtimes sort ahead of disabled or
    /// unavailable ones, preserving preset order within each group.
    fn runtime_order(info: &RuntimeInfo) -> u8 {
        match info.installation {
            Installation::Available(_) if info.settings.enabled => 0,
            Installation::Available(_) => 1,
            _ => 2,
        }
    }

    /// `runtimes`: at once, with `checking` for the ones not probed yet
    /// while they are probed in the background.
    pub fn runtimes(self: &Arc<Self>) -> Vec<RuntimeInfo> {
        let locale = vibevalley_i18n::locale();
        let mut out: Vec<RuntimeInfo> = self
            .ids()
            .into_iter()
            .map(|id| match self.held(&id) {
                Some(hit) => {
                    if hit.locale != locale {
                        self.probe_later(&id);
                    }
                    let settings = self.profiles.settings(&id);
                    self.shown(RuntimeInfo { settings, ..hit.info })
                }
                None => {
                    self.probe_later(&id);
                    self.placeholder(&id, 0)
                }
            })
            .collect();
        out.sort_by_key(Self::runtime_order);
        out
    }

    /// Pure read-only view of cached runtime probes without spawning background probes.
    pub fn cached_runtimes(&self) -> Vec<RuntimeInfo> {
        let mut out: Vec<RuntimeInfo> = self
            .ids()
            .into_iter()
            .map(|id| match self.held(&id) {
                Some(hit) => {
                    let settings = self.profiles.settings(&id);
                    self.shown(RuntimeInfo { settings, ..hit.info })
                }
                None => self.placeholder(&id, 0),
            })
            .collect();
        out.sort_by_key(Self::runtime_order);
        out
    }

    pub async fn refresh_async(&self, id: &str) -> Option<RuntimeInfo> {
        if !self.known(id) || self.cancel.is_cancelled() {
            return None;
        }
        Some(self.lookup_async(id).await)
    }

    /// What is kept in the farm's language, else a new probe.
    pub async fn info_async(&self, id: &str) -> Option<RuntimeInfo> {
        match self.held(id) {
            Some(hit) if hit.locale == vibevalley_i18n::locale() => Some(self.shown(hit.info)),
            _ => self.refresh_async(id).await,
        }
    }

    /// Cached runtime probe in the current locale without blocking on a fresh probe.
    pub fn cached_info(&self, id: &str) -> Option<RuntimeInfo> {
        self.held(id).map(|hit| self.shown(hit.info))
    }

    pub async fn update_async(&self, id: &str, settings: RuntimeSettings) -> Result<Option<RuntimeInfo>, ApiError> {
        if !self.known(id) {
            return Ok(None);
        }
        let _ = self
            .profiles
            .save_settings_async(id, settings)
            .await
            .map_err(|e| refused(t("server.runtime.notSaved", &[("id", id.into()), ("why", e.message.into())])))?;
        Ok(self.refresh_async(id).await)
    }

    /// The probe with the settings saved now laid over it.
    async fn configuration_async(&self, id: &str) -> (RuntimeSettings, Option<RuntimeInfo>) {
        let observed = self.info_async(id).await;
        let settings = self.profiles.settings(id);
        (settings.clone(), observed.map(|i| self.shown(RuntimeInfo { settings, ..i })))
    }

    /// Cached probe with current settings overlaid, without blocking on I/O.
    fn configuration_cached(&self, id: &str) -> (RuntimeSettings, Option<RuntimeInfo>) {
        let observed = self.cached_info(id);
        let settings = self.profiles.settings(id);
        (settings.clone(), observed.map(|i| self.shown(RuntimeInfo { settings, ..i })))
    }

    pub async fn assess_async(&self, agent: &Agent) -> Assessment {
        let (_, info) = self.configuration_async(&agent.runtime).await;
        let problems = agent_problems(agent, info.as_ref());
        let blocking = problems.iter().filter(|p| p.level == AgentProblemLevel::Error).cloned().collect();
        Assessment {
            agent: agent.clone(),
            info,
            problems,
            blocking,
        }
    }

    pub async fn assess_from_cache_async(&self, agent: &Agent) -> Assessment {
        let (settings, cached) = self.configuration_cached(&agent.runtime);
        let info = match cached {
            Some(c) => Some(c),
            None => match self.runtime(&agent.runtime) {
                None => None,
                Some(runtime) => {
                    let mut info = self.placeholder(&agent.runtime, 0);
                    info.settings = settings;
                    info.installation = match runtime.installation().await {
                        vibevalley_runtime::oar::Installation::Available { version, path } => Installation::Available(InstallationAvailable {
                            via: if info.support.in_process || path.as_os_str() == "(built in)" {
                                Via::Bundled
                            } else {
                                Via::Executable
                            },
                            command: path.to_string_lossy().into_owned(),
                            version: version.filter(|v| !v.is_empty()),
                        }),
                        vibevalley_runtime::oar::Installation::NotInstalled => Installation::NotFound(InstallationNotFound {}),
                        vibevalley_runtime::oar::Installation::LoginRequired { path } => Installation::Unsupported(InstallationUnsupported {
                            reason: t("server.runtime.signInRequired", &[("runtime", info.preset.label.clone().into())]),
                            sign_in_command: Some(path.to_string_lossy().into_owned()),
                        }),
                        vibevalley_runtime::oar::Installation::Unusable { reason } => {
                            Installation::Unsupported(InstallationUnsupported { reason, sign_in_command: None })
                        }
                    };
                    Some(self.shown(info))
                }
            },
        };
        let problems = agent_problems(agent, info.as_ref());
        let blocking = problems.iter().filter(|p| p.level == AgentProblemLevel::Error).cloned().collect();
        Assessment {
            agent: agent.clone(),
            info,
            problems,
            blocking,
        }
    }

    pub async fn problems_of_async(&self, agent: &Agent) -> Vec<AgentProblem> {
        self.assess_async(agent).await.problems
    }

    pub async fn candidates_async(&self) -> Vec<Candidate> {
        let agents = self.profiles.managed_workers();
        let mut out = Vec::with_capacity(agents.len());
        for agent in agents {
            let usable = self.assess_async(&agent).await.usable();
            out.push(Candidate { agent, usable });
        }
        out
    }

    pub async fn candidates_from_cache_async(&self) -> Vec<Candidate> {
        let agents = self.profiles.managed_workers();
        let mut out = Vec::with_capacity(agents.len());
        for agent in agents {
            let usable = self.assess_from_cache_async(&agent).await.usable();
            out.push(Candidate { agent, usable });
        }
        out
    }

    pub async fn choose_async(&self, brief: &str, named: &str, picked: &str) -> Option<Agent> {
        let candidates = self.candidates_async().await;
        choose_agent(&candidates, brief, named, picked)
    }

    pub async fn choose_from_cache_async(&self, brief: &str, named: &str, picked: &str) -> Option<Agent> {
        let candidates = self.candidates_from_cache_async().await;
        choose_agent(&candidates, brief, named, picked)
    }

    /// Shared execution-layer `MachineRegistry` for resolving local and remote runtimes.
    pub fn machines(&self) -> &Arc<MachineRegistry> {
        &self.machines
    }

    /// Resolves an explicit non-local `(machine_id, runtime_id)` pair from `MachineRegistry`.
    async fn resolve_remote_target_async(&self, machine_id: &str, runtime_id: &str) -> Result<(Arc<dyn Runtime>, bool), ApiError> {
        let machine = self
            .machines
            .get(machine_id)
            .ok_or_else(|| refused(format!("execution machine `{machine_id}` is not registered")))?;
        let desc = machine.descriptor();
        if desc.status != RtMachineStatus::Online {
            return Err(refused(format!("execution machine `{machine_id}` is currently {:?}", desc.status)));
        }
        let runtime = machine
            .runtime(runtime_id)
            .ok_or_else(|| refused(format!("runtime `{runtime_id}` is not available on execution machine `{machine_id}`")))?;
        match runtime.installation().await {
            vibevalley_runtime::oar::Installation::Available { .. } => Ok((runtime, desc.local)),
            vibevalley_runtime::oar::Installation::NotInstalled => Err(refused(format!("runtime `{runtime_id}` is not installed on machine `{machine_id}`"))),
            vibevalley_runtime::oar::Installation::LoginRequired { .. } => {
                Err(refused(format!("runtime `{runtime_id}` requires sign-in on machine `{machine_id}`")))
            }
            vibevalley_runtime::oar::Installation::Unusable { reason } => {
                Err(refused(format!("runtime `{runtime_id}` on machine `{machine_id}` is unusable: {reason}")))
            }
        }
    }

    /// What a session on `agent` opens with (async probe if uncached); refused
    /// when its options cannot be honoured.
    pub async fn resolve_async(&self, agent: &Agent) -> Result<Resolved, ApiError> {
        self.resolve_on_machine_async(agent, None).await
    }

    /// Async resolution of `agent` against an explicit `machine_override`.
    pub async fn resolve_on_machine_async(&self, agent: &Agent, machine_override: Option<&str>) -> Result<Resolved, ApiError> {
        let (ref_machine, bare_runtime) = match RuntimeRef::parse(agent.runtime.trim()) {
            Ok(parsed) => (Some(parsed.machine_id), parsed.runtime_id),
            Err(_) => (None, agent.runtime.trim().to_string()),
        };
        let target_machine = machine_override
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .or_else(|| agent.machine_id.as_deref().map(str::trim).filter(|m| !m.is_empty()))
            .or(ref_machine.as_deref())
            .unwrap_or(LOCAL_MACHINE_ID);

        if target_machine != LOCAL_MACHINE_ID {
            return self.resolve_remote_agent_async(agent, target_machine, &bare_runtime).await;
        }

        let (settings, info) = self.configuration_async(&bare_runtime).await;
        self.resolve_local_agent(agent, &bare_runtime, settings, info)
    }

    /// Non-blocking resolution of `agent` using cached runtime metadata.
    pub async fn resolve_from_cache_async(&self, agent: &Agent) -> Result<Resolved, ApiError> {
        self.resolve_on_machine_from_cache_async(agent, None).await
    }

    /// Non-blocking resolution of `agent` against an explicit `machine_override`
    /// (`Issue.machine_id`), falling back to `agent.machine_id`, any `RuntimeRef`
    /// machine prefix on `agent.runtime`, and finally `"local"`.
    pub async fn resolve_on_machine_from_cache_async(&self, agent: &Agent, machine_override: Option<&str>) -> Result<Resolved, ApiError> {
        let (ref_machine, bare_runtime) = match RuntimeRef::parse(agent.runtime.trim()) {
            Ok(parsed) => (Some(parsed.machine_id), parsed.runtime_id),
            Err(_) => (None, agent.runtime.trim().to_string()),
        };
        let target_machine = machine_override
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .or_else(|| agent.machine_id.as_deref().map(str::trim).filter(|m| !m.is_empty()))
            .or(ref_machine.as_deref())
            .unwrap_or(LOCAL_MACHINE_ID);

        if target_machine != LOCAL_MACHINE_ID {
            return self.resolve_remote_agent_async(agent, target_machine, &bare_runtime).await;
        }

        let (settings, info) = self.configuration_cached(&bare_runtime);
        self.resolve_local_agent(agent, &bare_runtime, settings, info)
    }

    async fn resolve_remote_agent_async(&self, agent: &Agent, target_machine: &str, bare_runtime: &str) -> Result<Resolved, ApiError> {
        let (runtime, is_local) = self.resolve_remote_target_async(target_machine, bare_runtime).await?;
        let settings = self.profiles.settings(bare_runtime);
        let model = if !agent.model.trim().is_empty() {
            agent.model.trim().to_string()
        } else {
            settings.default_model
        };
        let effort = if !agent.effort.trim().is_empty() {
            agent.effort.trim().to_string()
        } else {
            settings.default_effort
        };
        let mut env = settings.env;
        env.extend(agent.env.clone());
        Ok(Resolved {
            runtime,
            machine_id: target_machine.to_string(),
            is_local,
            bin_path: String::new(),
            model,
            effort,
            env,
        })
    }

    fn resolve_local_agent(&self, agent: &Agent, bare_runtime: &str, settings: RuntimeSettings, info: Option<RuntimeInfo>) -> Result<Resolved, ApiError> {
        let runtime = self
            .machines
            .get(LOCAL_MACHINE_ID)
            .and_then(|m| m.runtime(bare_runtime))
            .or_else(|| self.runtime(bare_runtime))
            .ok_or_else(|| refused(t("server.runtime.cannotDrive", &[("runtime", bare_runtime.to_string().into())])))?;
        let mut local_agent = agent.clone();
        local_agent.runtime = bare_runtime.to_string();
        Self::use_binary(bare_runtime, &settings.bin_path);
        let options = session_options(&local_agent, Some(&settings), info.as_ref());
        if let Some(problem) = options.problems.iter().find(|p| p.level == AgentProblemLevel::Error) {
            return Err(refused(t(
                "server.runtime.cannotSend",
                &[("name", agent.name.clone().into()), ("why", problem.text.clone().into())],
            )));
        }
        if !options.missing_model.is_empty() {
            self.ctx.live.publish_notice(
                self.ctx.now(),
                NoticeLevel::Warn,
                t(
                    "server.runtime.defaultModel",
                    &[
                        ("runtime", runtime_label(bare_runtime).into()),
                        ("model", options.missing_model.clone().into()),
                        ("name", agent.name.clone().into()),
                    ],
                ),
            );
        }
        Ok(Resolved {
            runtime,
            machine_id: LOCAL_MACHINE_ID.to_string(),
            is_local: true,
            bin_path: settings.bin_path,
            model: options.model,
            effort: options.effort,
            env: options.env,
        })
    }

    /// What a direct workspace session on `runtime_id` opens with, using
    /// saved runtime settings (binary path, env, defaults) without blocking on
    /// a full background model probe. Accepts either `<runtime_id>` (local) or
    /// `<machine_id>/<runtime_id>` (`RuntimeRef`).
    pub async fn resolve_runtime_async(&self, runtime_id: &str, model: Option<&str>, effort: Option<&str>) -> Result<Resolved, ApiError> {
        if let Ok(parsed) = RuntimeRef::parse(runtime_id.trim())
            && !parsed.is_local()
        {
            let (runtime, is_local) = self.resolve_remote_target_async(&parsed.machine_id, &parsed.runtime_id).await?;
            let settings = self.profiles.settings(&parsed.runtime_id);
            let model = model
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(String::from)
                .unwrap_or(settings.default_model);
            let effort = effort
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(String::from)
                .unwrap_or(settings.default_effort);
            return Ok(Resolved {
                runtime,
                machine_id: parsed.machine_id,
                is_local,
                bin_path: String::new(),
                model,
                effort,
                env: settings.env,
            });
        }

        let bare_id = RuntimeRef::parse(runtime_id.trim())
            .map(|r| r.runtime_id)
            .unwrap_or_else(|_| runtime_id.trim().to_string());
        let runtime_id = bare_id.as_str();
        let runtime = self
            .machines
            .get(LOCAL_MACHINE_ID)
            .and_then(|m| m.runtime(runtime_id))
            .or_else(|| self.runtime(runtime_id))
            .ok_or_else(|| refused(t("server.runtime.cannotDrive", &[("runtime", runtime_id.into())])))?;
        let settings = self.profiles.settings(runtime_id);
        Self::use_binary(runtime_id, &settings.bin_path);
        let held = self
            .held(runtime_id)
            .or_else(|| runtime_id.strip_prefix("acp:").and_then(|wire| self.held(wire)));
        if let Some(obs) = &held {
            match &obs.info.installation {
                Installation::NotFound(_) => {
                    return Err(refused(t(
                        "server.runtime.cannotSend",
                        &[
                            ("name", runtime_label(runtime_id).into()),
                            ("why", format!("{runtime_id} is not installed").into()),
                        ],
                    )));
                }
                Installation::Unsupported(u) => {
                    return Err(refused(t(
                        "server.runtime.cannotSend",
                        &[("name", runtime_label(runtime_id).into()), ("why", u.reason.clone().into())],
                    )));
                }
                Installation::Available(_) | Installation::Checking(_) => {}
            }
        }
        let cached_models = held.and_then(|obs| obs.info.models);
        let model = model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(String::from)
            .unwrap_or_else(|| settings.default_model.clone());
        let mut effort = effort
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(String::from)
            .unwrap_or_else(|| settings.default_effort.clone());
        if let Some(models) = cached_models.as_deref()
            && !effort.is_empty()
            && runtime_reports_model_efforts(models)
        {
            let found = models.iter().find(|m| if model.is_empty() { m.is_default } else { m.id == model });
            if let Some(m) = found
                && !m.effort_levels.contains(&effort)
            {
                effort.clear();
            }
        }
        Ok(Resolved {
            runtime,
            machine_id: LOCAL_MACHINE_ID.to_string(),
            is_local: true,
            bin_path: settings.bin_path,
            model,
            effort,
            env: settings.env,
        })
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;

    #[test]
    fn oar_usage_reads_as_vibevalley_shows_it() {
        let ok = usage_from_oar(vibevalley_runtime::oar::AccountUsage::Available {
            plan: Some("max".into()),
            email: None,
            rate_limited: false,
            windows: vec![vibevalley_runtime::oar::UsageWindow {
                label: "5 hours".into(),
                used_ratio: 0.426,
                resets_at: Some("2026-11-13T10:00:00Z".into()),
                id: None,
                duration_ms: None,
            }],
        });
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "status": "ok", "subscription": "max", "windows": [{ "label": "5 hours", "usedPercent": 43, "resetsAt": 1_794_564_000_000_i64 }] })
        );
        let login = usage_from_oar(vibevalley_runtime::oar::AccountUsage::ReauthRequired {
            reason: "not_authenticated".into(),
        });
        assert_eq!(serde_json::to_value(&login).unwrap(), serde_json::json!({ "status": "login_required" }));
        let none = usage_from_oar(vibevalley_runtime::oar::AccountUsage::Unsupported {
            reason: "capability_unavailable".into(),
        });
        assert_eq!(serde_json::to_value(&none).unwrap()["reason"], "capability_unavailable");
    }

    #[tokio::test]
    async fn spent_today_accumulates_reported_cny_and_enforces_daily_budget() {
        let home = tempfile::tempdir().unwrap();
        let service = Service::open(home.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let mut registry = Registry::new();
        registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let profiles = ProfileStore::open_async(home.path(), &[]).await.unwrap();
        let fleet = RuntimeFleet::new(Arc::new(registry), profiles, ctx.clone(), false);
        fleet
            .update_async(
                "scripted",
                RuntimeSettings {
                    daily_budget: Some(5.0.into()),
                    ..super::super::preset::default_settings()
                },
            )
            .await
            .unwrap();
        let before = fleet.refresh_async("scripted").await.unwrap();
        assert_eq!(before.spent_today, None);
        assert!(before.stop.is_empty());

        fleet.on_session_reported("scripted", Some(3.5));
        fleet.on_session_reported("scripted", Some(2.0));

        let after = fleet.refresh_async("scripted").await.unwrap();
        assert!((after.spent_today.map(JsNumber::get).unwrap_or(0.0) - 5.5).abs() < 1e-6);
        assert!(!after.stop.is_empty(), "daily budget stop should trigger at 5.5 >= 5.0");
        fleet.close();
        service.close().await;
    }

    #[tokio::test]
    async fn probe_async_populates_mcp_servers_from_oar_and_syncs_updates() {
        struct AntigravityMcpStub;
        impl Runtime for AntigravityMcpStub {
            fn id(&self) -> &str {
                "acp:antigravity"
            }
            fn display_name(&self) -> &str {
                "Antigravity"
            }
            fn capabilities(&self) -> vibevalley_runtime::oar::Capabilities {
                vibevalley_runtime::oar::Capabilities::default()
            }
            fn installation(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Installation> {
                Box::pin(async {
                    vibevalley_runtime::oar::Installation::Available {
                        version: Some("1.0.0".into()),
                        path: std::path::PathBuf::from("/usr/local/bin/agy"),
                    }
                })
            }
            fn list_models(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<vibevalley_runtime::oar::ModelInfo>>> {
                Box::pin(async { Ok(Vec::new()) })
            }
            fn open(
                &self,
                _opts: vibevalley_runtime::oar::SessionOptions,
            ) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn vibevalley_runtime::oar::Session>>> {
                Box::pin(async { Err(vibevalley_runtime::oar::AgentError::NotAvailable("stub".into())) })
            }
            fn list_mcp_servers(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Option<Vec<HostMcpServer>>>> {
                Box::pin(async {
                    Ok(Some(vec![
                        HostMcpServer {
                            host: vibevalley_runtime::oar::McpHostId::Antigravity,
                            name: "github".into(),
                            transport: McpTransportSpec::Stdio {
                                command: "npx".into(),
                                args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()],
                                env: BTreeMap::new(),
                            },
                            enabled: true,
                            config_path: std::path::PathBuf::from("/Users/test/.gemini/config/mcp_config.json"),
                        },
                        HostMcpServer {
                            host: vibevalley_runtime::oar::McpHostId::Antigravity,
                            name: "linear".into(),
                            transport: McpTransportSpec::StreamableHttp {
                                url: "https://mcp.linear.app/mcp".into(),
                                headers: BTreeMap::new(),
                                stateless: false,
                            },
                            enabled: false,
                            config_path: std::path::PathBuf::from("/Users/test/.gemini/config/mcp_config.json"),
                        },
                    ]))
                })
            }
        }

        let home = tempfile::tempdir().unwrap();
        let service = Service::open(home.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let mut registry = Registry::new();
        registry.register(Arc::new(AntigravityMcpStub));
        let profiles = ProfileStore::open_async(home.path(), &[]).await.unwrap();
        let fleet = RuntimeFleet::new(Arc::new(registry), profiles, ctx.clone(), false);

        let probed = fleet.refresh_async("antigravity").await.unwrap();
        let entries = probed.mcp_servers.expect("mcp_servers populated instead of None/unreported");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "github");
        assert_eq!(entries[0].description, "stdio · npx -y @modelcontextprotocol/server-github");
        assert_eq!(entries[0].source, "/Users/test/.gemini/config/mcp_config.json");
        assert!(entries[0].enabled);
        assert_eq!(entries[1].name, "linear");
        assert_eq!(entries[1].description, "streamableHttp · https://mcp.linear.app/mcp");
        assert!(!entries[1].enabled);

        // sync_host_mcp_servers updates cached RuntimeInfo without re-running subprocess probes.
        fleet.sync_host_mcp_servers(
            McpHostId::Antigravity,
            &[McpServerEntry {
                host: McpHostId::Antigravity,
                name: "context7".into(),
                transport: McpTransportKind::Stdio,
                command: Some("npx".into()),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
                enabled: true,
                config_path: "/Users/test/.gemini/config/mcp_config.json".into(),
            }],
        );
        let updated = fleet.cached_info("antigravity").unwrap();
        let updated_entries = updated.mcp_servers.unwrap();
        assert_eq!(updated_entries.len(), 1);
        assert_eq!(updated_entries[0].name, "context7");

        fleet.close();
        service.close().await;
    }
}
