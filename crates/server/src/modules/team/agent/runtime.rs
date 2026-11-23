//! The runtimes the profiles run on: what is installed, its models, and
//! what stops it taking work.
//!
//! VibeValley's runtime ids are kept on the wire; one that `vibevalley-oar`
//! registers as `acp:<id>` (opencode) is found under it. Runtimes the
//! registry has beyond VibeValley's list (for example `scripted` in tests)
//! are listed after them under their own ids.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Agent, AgentProblem, AgentProblemLevel, ApiError, BizCode, Installation, InstallationAvailable, InstallationChecking, InstallationNotFound,
    InstallationUnsupported, JsNumber, LOCAL_MACHINE_ID, ModelEntry, NoticeLevel, RuntimeInfo, RuntimeRef, RuntimeSettings, Via,
};
use vibevalley_runtime::machine::{MachineRegistry, MachineStatus as RtMachineStatus};
use vibevalley_runtime::oar::{Registry, Runtime};

use super::presets::{
    Candidate, agent_problems, choose_agent, money_stop, preset_of, quota_of, runtime_ids, runtime_label, runtime_reports_model_efforts, session_options,
    support_of,
};
use super::profile::Profiles;
use crate::base::Ticker;
use crate::{Hub, now};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

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

/// `RuntimeFleet`.
pub struct Fleet {
    registry: Arc<Registry>,
    machines: Arc<MachineRegistry>,
    profiles: Arc<Profiles>,
    hub: Weak<Hub>,
    held: Mutex<HashMap<String, Observation>>,
    spend: Mutex<DailySpend>,
    probing: Mutex<HashSet<String>>,
    reads: AtomicU64,
    closed: AtomicBool,
    cancel: CancellationToken,
    usage_task: Mutex<Option<Ticker>>,
    sub: Mutex<Option<crate::event_bus::Subscription>>,
}

/// Runs `f` on its own thread; none when it takes longer than `limit`.
fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = flume::bounded(1);
    std::thread::Builder::new()
        .name("vibevalley-runtime-probe".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .ok()?;
    rx.recv_timeout(limit).ok()
}

/// A runtime's usage is read again this often, and this long after a
/// session on it reports.
const USAGE_EVERY: Duration = Duration::from_secs(5 * 60);
const USAGE_AFTER_RUN: Duration = Duration::from_secs(20);

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

impl Fleet {
    /// The fleet over `registry`. With `background`, every runtime is
    /// probed now, off the caller's thread.
    pub fn new(registry: Arc<Registry>, profiles: Arc<Profiles>, hub: &Arc<Hub>, background: bool) -> Arc<Fleet> {
        let machines = Arc::new(MachineRegistry::with_local(registry.clone()));
        Self::new_with_machines(registry, machines, profiles, hub, background)
    }

    /// The fleet backed by a shared `MachineRegistry` for local and remote dispatch.
    pub fn new_with_machines(registry: Arc<Registry>, machines: Arc<MachineRegistry>, profiles: Arc<Profiles>, hub: &Arc<Hub>, background: bool) -> Arc<Fleet> {
        let cancel = hub.child_token();
        let fleet = Arc::new(Fleet {
            registry,
            machines,
            profiles,
            hub: Arc::downgrade(hub),
            held: Mutex::default(),
            spend: Mutex::new(DailySpend::new()),
            probing: Mutex::default(),
            reads: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            cancel,
            usage_task: Mutex::new(None),
            sub: Mutex::new(None),
        });
        {
            let f = Arc::downgrade(&fleet);
            let sub = hub.subscribe_transitions("runtime-usage", move |_, tr| {
                let vibevalley_protocol::Fact::SessionReported(r) = &tr.fact else { return };
                let Some(fleet) = f.upgrade() else { return };
                if let Some(s) = tr.after.sessions.iter().chain(&tr.before.sessions).find(|s| s.id == r.id) {
                    if let Some(cny) = r.spent.as_ref().and_then(|sp| sp.cny).map(JsNumber::get)
                        && cny.is_finite()
                        && cny > 0.0
                    {
                        fleet.record_spend(&s.runtime, cny);
                    }
                    if background {
                        fleet.usage_soon(&s.runtime);
                    }
                }
            });
            let prev = fleet.sub.lock().replace(sub);
            drop(prev);
        }
        if background {
            for id in fleet.ids() {
                fleet.probe_later(&id);
            }
            let f = Arc::downgrade(&fleet);
            let ticker = Ticker::spawn_on(hub, USAGE_EVERY, false, move || {
                let Some(fleet) = f.upgrade() else { return false };
                if fleet.closed.load(Ordering::Relaxed) {
                    return false;
                }
                for id in fleet.ids() {
                    fleet.refresh_usage(&id);
                }
                true
            });
            *fleet.usage_task.lock() = Some(ticker);
        }
        fleet
    }

    fn record_spend(&self, runtime: &str, cny: f64) {
        let key = runtime.strip_prefix("acp:").unwrap_or(runtime);
        self.spend.lock().add(key, cny);
        let updated = self.held(key).map(|hit| {
            let settings = self.profiles.settings(key);
            self.shown(RuntimeInfo { settings, ..hit.info })
        });
        if let (Some(info), Some(hub)) = (updated, self.hub.upgrade()) {
            hub.runtime(info);
        }
    }

    /// `usageSoon`: the runtime's usage read again 20 s from now (several
    /// runs share one read).
    pub fn usage_soon(self: &Arc<Self>, id: &str) {
        let key = format!("usage:{id}");
        if self.closed.load(Ordering::Relaxed) || !self.probing.lock().insert(key.clone()) {
            return;
        }
        let fleet = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let id = id.to_string();
        vibevalley_runtime::rt::handle().spawn(async move {
            let stopped = tokio::select! {
                biased;
                _ = cancel.cancelled() => true,
                _ = tokio::time::sleep(USAGE_AFTER_RUN) => false,
            };
            let Some(fleet) = fleet.upgrade() else { return };
            fleet.probing.lock().remove(&key);
            if !stopped {
                let _ = tokio::task::spawn_blocking(move || fleet.refresh_usage(&id)).await;
            }
        });
    }

    /// `refreshUsage` (blocking): a runtime found available has its usage
    /// read again; kept and told when it changed and no newer probe landed.
    pub fn refresh_usage(&self, id: &str) {
        let Some(before) = self.held(id) else { return };
        if !matches!(before.info.installation, Installation::Available(_)) || self.closed.load(Ordering::Relaxed) {
            return;
        }
        let Some(runtime) = self.runtime(id) else { return };
        let Some(usage) = within(PROBE_TIMEOUT, move || runtime.account_usage()).and_then(Result::ok).map(usage_from_oar) else {
            return;
        };
        let mut held = self.held.lock();
        let Some(now_held) = held.get_mut(id) else { return };
        if now_held.read != before.read || now_held.info.usage.as_ref() == Some(&usage) {
            return;
        }
        now_held.info.usage = Some(usage);
        now_held.info.checked_at = now();
        let info = self.shown(now_held.info.clone());
        drop(held);
        if let Some(hub) = self.hub.upgrade() {
            hub.runtime(info);
        }
    }

    /// Stops answering with new probes (`close`).
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.cancel.cancel();
        let prev = self.sub.lock().take();
        drop(prev);
        if let Some(ticker) = self.usage_task.lock().take() {
            ticker.stop();
        }
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
            spent_today: self.spend.lock().get(id),
            quota: None,
            stop: String::new(),
            checked_at,
        }
    }

    /// `withSpend`: the stop, daily spend, and quota from what is known now.
    fn shown(&self, info: RuntimeInfo) -> RuntimeInfo {
        let spent_today = self.spend.lock().get(&info.id);
        let mut out = RuntimeInfo { spent_today, ..info };
        out.stop = money_stop(Some(&out));
        out.quota = Some(quota_of(out.usage.as_ref()));
        out
    }

    /// Points the runtime's binary at the saved `binPath`; empty searches
    /// PATH (`probeInstallation`).
    fn use_binary(id: &str, bin_path: &str) {
        let bare = id.strip_prefix("acp:").unwrap_or(id);
        let command = vibevalley_runtime::oar::runtime_spec(bare).and_then(|s| s.binary).unwrap_or(bare);
        let path = Some(bin_path.trim()).filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
        vibevalley_runtime::oar::set_binary(command, path);
    }

    /// One probe of the machine (blocking).
    fn probe(&self, id: &str) -> RuntimeInfo {
        let mut info = self.placeholder(id, now());
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
        let probed = runtime.clone();
        let installation = within(PROBE_TIMEOUT, move || probed.installation()).unwrap_or_else(|| vibevalley_runtime::oar::Installation::Unusable {
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
        let listed = runtime.clone();
        info.models = within(PROBE_TIMEOUT, move || listed.list_models()).and_then(Result::ok).map(|models| {
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
        let read = runtime.clone();
        info.usage = within(PROBE_TIMEOUT, move || read.account_usage()).and_then(Result::ok).map(usage_from_oar);
        info
    }

    /// A new lookup, kept and told on the live stream.
    fn lookup(&self, id: &str) -> RuntimeInfo {
        let read = self.reads.fetch_add(1, Ordering::Relaxed) + 1;
        let info = self.shown(self.probe(id));
        let mut held = self.held.lock();
        // A slower older lookup does not overwrite a newer one.
        if held.get(id).is_none_or(|o| o.read < read) {
            held.insert(
                id.into(),
                Observation {
                    info: info.clone(),
                    locale: vibevalley_i18n::locale(),
                    read,
                },
            );
        }
        drop(held);
        if let Some(hub) = self.hub.upgrade() {
            hub.runtime(info.clone());
        }
        info
    }

    fn probe_later(self: &Arc<Self>, id: &str) {
        if self.closed.load(Ordering::Relaxed) || !self.probing.lock().insert(id.to_string()) {
            return;
        }
        let fleet = self.clone();
        let id = id.to_string();
        let _ = std::thread::Builder::new().name(format!("vibevalley-runtime-{id}")).spawn(move || {
            fleet.lookup(&id);
            fleet.probing.lock().remove(&id);
        });
    }

    fn held(&self, id: &str) -> Option<Observation> {
        self.held.lock().get(id).cloned()
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

    /// `refresh` (blocking): none for a runtime the farm does not know.
    pub fn refresh(&self, id: &str) -> Option<RuntimeInfo> {
        if !self.known(id) || self.closed.load(Ordering::Relaxed) {
            return None;
        }
        Some(self.lookup(id))
    }

    /// What is kept in the farm's language, else a new probe.
    pub fn info(&self, id: &str) -> Option<RuntimeInfo> {
        match self.held(id) {
            Some(hit) if hit.locale == vibevalley_i18n::locale() => Some(self.shown(hit.info)),
            _ => self.refresh(id),
        }
    }

    pub fn update(&self, id: &str, settings: RuntimeSettings) -> Result<Option<RuntimeInfo>, ApiError> {
        if !self.known(id) {
            return Ok(None);
        }
        self.profiles
            .save_settings(id, settings)
            .map_err(|e| refused(t("server.runtime.notSaved", &[("id", id.into()), ("why", e.message.into())])))?;
        Ok(self.refresh(id))
    }

    /// The probe with the settings saved now laid over it.
    fn configuration(&self, id: &str) -> (RuntimeSettings, Option<RuntimeInfo>) {
        let observed = self.info(id);
        let settings = self.profiles.settings(id);
        (settings.clone(), observed.map(|i| self.shown(RuntimeInfo { settings, ..i })))
    }

    pub fn assess(&self, agent: &Agent) -> Assessment {
        let (_, info) = self.configuration(&agent.runtime);
        let problems = agent_problems(agent, info.as_ref());
        let blocking = problems.iter().filter(|p| p.level == AgentProblemLevel::Error).cloned().collect();
        Assessment {
            agent: agent.clone(),
            info,
            problems,
            blocking,
        }
    }

    pub fn problems_of(&self, agent: &Agent) -> Vec<AgentProblem> {
        self.assess(agent).problems
    }

    pub fn candidates(&self) -> Vec<Candidate> {
        self.profiles
            .agents()
            .into_iter()
            .map(|agent| {
                let usable = self.assess(&agent).usable();
                Candidate { agent, usable }
            })
            .collect()
    }

    pub fn choose(&self, brief: &str, named: &str, picked: &str) -> Option<Agent> {
        choose_agent(&self.candidates(), brief, named, picked)
    }

    /// Shared execution-layer `MachineRegistry` for resolving local and remote runtimes.
    pub fn machines(&self) -> &Arc<MachineRegistry> {
        &self.machines
    }

    /// Resolves an explicit non-local `(machine_id, runtime_id)` pair from `MachineRegistry`.
    fn resolve_remote_target(&self, machine_id: &str, runtime_id: &str) -> Result<(Arc<dyn Runtime>, bool), ApiError> {
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
        match runtime.installation() {
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

    /// What a session on `agent` opens with; refused when its options
    /// cannot be honoured.
    pub fn resolve(&self, agent: &Agent) -> Result<Resolved, ApiError> {
        self.resolve_on_machine(agent, None)
    }

    /// Resolves `agent` against an explicit `machine_override` (e.g. `Issue.machine_id`),
    /// falling back to `agent.machine_id`, any `RuntimeRef` machine prefix on `agent.runtime`,
    /// and finally `"local"`.
    pub fn resolve_on_machine(&self, agent: &Agent, machine_override: Option<&str>) -> Result<Resolved, ApiError> {
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
            let (runtime, is_local) = self.resolve_remote_target(target_machine, &bare_runtime)?;
            let settings = self.profiles.settings(&bare_runtime);
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
            return Ok(Resolved {
                runtime,
                machine_id: target_machine.to_string(),
                is_local,
                bin_path: String::new(),
                model,
                effort,
                env,
            });
        }

        let runtime = self
            .machines
            .get(LOCAL_MACHINE_ID)
            .and_then(|m| m.runtime(&bare_runtime))
            .or_else(|| self.runtime(&bare_runtime))
            .ok_or_else(|| refused(t("server.runtime.cannotDrive", &[("runtime", bare_runtime.clone().into())])))?;
        let mut local_agent = agent.clone();
        local_agent.runtime = bare_runtime.clone();
        let (settings, info) = self.configuration(&bare_runtime);
        Self::use_binary(&bare_runtime, &settings.bin_path);
        let options = session_options(&local_agent, Some(&settings), info.as_ref());
        if let Some(problem) = options.problems.iter().find(|p| p.level == AgentProblemLevel::Error) {
            return Err(refused(t(
                "server.runtime.cannotSend",
                &[("name", agent.name.clone().into()), ("why", problem.text.clone().into())],
            )));
        }
        if !options.missing_model.is_empty()
            && let Some(hub) = self.hub.upgrade()
        {
            hub.notice(
                NoticeLevel::Warn,
                t(
                    "server.runtime.defaultModel",
                    &[
                        ("runtime", runtime_label(&bare_runtime).into()),
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
    pub fn resolve_runtime(&self, runtime_id: &str, model: Option<&str>, effort: Option<&str>) -> Result<Resolved, ApiError> {
        if let Ok(parsed) = RuntimeRef::parse(runtime_id.trim())
            && !parsed.is_local()
        {
            let (runtime, is_local) = self.resolve_remote_target(&parsed.machine_id, &parsed.runtime_id)?;
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

    #[test]
    fn spent_today_accumulates_reported_cny_and_enforces_daily_budget() {
        use std::time::Instant;
        use vibevalley_protocol::{ExecutionPolicy, Fact, FactSessionChanged, FactSessionReported, Outcome, Session, SessionController, Spent};

        let home = tempfile::tempdir().unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let mut registry = Registry::new();
        registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let profiles = Profiles::open(home.path(), &[]).unwrap();
        let fleet = Fleet::new(Arc::new(registry), profiles, &hub, false);
        fleet
            .update(
                "scripted",
                RuntimeSettings {
                    daily_budget: Some(5.0.into()),
                    ..super::super::presets::default_settings()
                },
            )
            .unwrap();
        let before = fleet.info("scripted").unwrap();
        assert_eq!(before.spent_today, None);
        assert!(before.stop.is_empty());

        let session = Session::new(
            "s1",
            SessionController::IssueBoard,
            "Worker",
            "scripted",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: None,
            },
            1,
        );
        hub.apply(vec![Fact::SessionChanged(FactSessionChanged { at: 1, session })]);
        for (at, cny) in [(2, 3.5), (3, 2.0)] {
            hub.apply(vec![Fact::SessionReported(FactSessionReported {
                at,
                id: "s1".into(),
                run: None,
                outcome: Outcome::Completed,
                phase: None,
                summary: "done".into(),
                runs: 1,
                spent: Some(Spent {
                    tokens: 100,
                    cny: Some(cny.into()),
                }),
                questions: vec![],
                checks: vec![],
                answer: None,
            })]);
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        let after = loop {
            let info = fleet.info("scripted").unwrap();
            if info.spent_today.map(JsNumber::get).unwrap_or(0.0) >= 5.5 {
                break info;
            }
            assert!(Instant::now() < deadline, "spent_today did not accumulate: {:?}", info.spent_today);
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(!after.stop.is_empty(), "daily budget stop should trigger at 5.5 >= 5.0");
        fleet.close();
        hub.close_bus();
    }
}
