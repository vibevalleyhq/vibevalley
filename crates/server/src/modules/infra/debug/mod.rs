//! `debug.*`: built-in DevTools diagnostics module (timeline collector,
//! fault-injection overrides, read-only trajectory inspector, live topology
//! graph, state/cache telemetry, and redacted `debug-bundle.zip` exporter).
//!
//! Disabled by default (`debug_enabled = false`): all 9 `debug.*` endpoints
//! refuse with `BizCode::Refused`, and zero observer/fault-gate hooks are
//! attached to `Hub` or `oar`.

pub mod bundle;
pub mod collector;
pub mod redact;
pub mod trajectory;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_protocol::{
    ApiError, BizCode, DebugBundleResult, DebugCacheStat, DebugGraph, DebugGraphClient, DebugGraphSession, DebugOverrideConfig, DebugOverview,
    DebugRuntimeSummary, DebugSnapshot, DebugStateCache, DebugStateCounts, DebugTimelinePage, DebugTimelineQuery, DebugTrajectoryDetail,
    DebugTrajectoryGetRequest, DebugTrajectoryKind, DebugTrajectorySummary, SessionEvent, SpaceState, ops,
};

use self::bundle::BundlePayloads;
use self::collector::DebugCollector;
use self::redact::Redactor;
use crate::modules::infra::setting::Setting;
use crate::{Hub, Server};

const SNAPSHOT_RECENT_TIMELINE_LIMIT: usize = 16;

/// Snapshot of runtime probe status and profile counts injected from `start.rs`
/// so `modules::infra::debug` stays free of upward business-domain imports.
#[derive(Debug, Clone, Default)]
pub struct RuntimeProbeSnapshot {
    pub runtimes: Vec<DebugRuntimeSummary>,
    pub agent_count: u32,
    pub orchestrator_ids: Vec<String>,
}

/// Narrow read-only data provider implemented in `start.rs` bridging
/// `Trajectories`, `Agents`, `Repos`, `Artifacts`, and `Orchestrator`.
pub trait DebugDataSource: Send + Sync {
    fn trajectory_events(&self, session_id: &str) -> Vec<SessionEvent>;
    fn open_trajectory_ids(&self) -> Vec<String>;
    fn system_prompt(&self, session_id: &str, kind: DebugTrajectoryKind) -> Option<String>;
    fn runtime_probe(&self) -> RuntimeProbeSnapshot;
    fn repo_count(&self) -> u32;
    fn artifact_count(&self) -> u32;
}

/// Empty source used in unit tests when no domain modules are attached.
#[derive(Default)]
pub struct EmptyDebugDataSource;

impl DebugDataSource for EmptyDebugDataSource {
    fn trajectory_events(&self, _session_id: &str) -> Vec<SessionEvent> {
        vec![]
    }

    fn open_trajectory_ids(&self) -> Vec<String> {
        vec![]
    }

    fn system_prompt(&self, _session_id: &str, _kind: DebugTrajectoryKind) -> Option<String> {
        None
    }

    fn runtime_probe(&self) -> RuntimeProbeSnapshot {
        RuntimeProbeSnapshot::default()
    }

    fn repo_count(&self) -> u32 {
        0
    }

    fn artifact_count(&self) -> u32 {
        0
    }
}

pub struct DebugParts {
    pub hub: Weak<Hub>,
    pub setting: Arc<Setting>,
    pub sources: Arc<dyn DebugDataSource>,
    pub home: PathBuf,
    pub work_root: PathBuf,
    pub version: String,
    pub boot_started: Instant,
    pub debug_enabled: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct HostDebugPayload {
    routes: Option<Value>,
    clients: Vec<DebugGraphClient>,
    bundle_mode: Option<String>,
    loopback_url: Option<String>,
    boot_ms: Option<i64>,
    last_frame_ms: Option<f64>,
    caches: Vec<DebugCacheStat>,
}

pub struct DebugKit {
    hub: Weak<Hub>,
    setting: Arc<Setting>,
    sources: Arc<dyn DebugDataSource>,
    collector: Arc<DebugCollector>,
    home: PathBuf,
    work_root: PathBuf,
    version: String,
    boot_duration_ms: i64,
    debug_enabled: bool,
}

struct RawGraphSession {
    session_id: String,
    issue_id: Option<i64>,
    title: String,
    runtime: String,
    status: &'static str,
    worktree: Option<String>,
    kind: DebugTrajectoryKind,
}

struct StateMetrics {
    issues: u32,
    sessions: u32,
    channels: u32,
    media_jobs: u32,
    active_sessions: u32,
}

fn extract_state_metrics(state: &SpaceState) -> StateMetrics {
    StateMetrics {
        issues: state.issues.len() as u32,
        sessions: state.sessions.len() as u32,
        channels: state.chat.as_ref().map(|c| c.channels.len() as u32).unwrap_or(0),
        media_jobs: state.media.as_ref().map(|m| m.len() as u32).unwrap_or(0),
        active_sessions: state.sessions.iter().filter(|s| s.phase.is_working()).count() as u32,
    }
}

fn extract_graph_sessions(state: &SpaceState, orchestrator_ids: &[String]) -> Vec<RawGraphSession> {
    if state.sessions.is_empty() {
        return Vec::new();
    }
    let issue_by_id: HashMap<&str, (i64, &str)> = state.issues.iter().map(|i| (i.id.as_str(), (i.number, i.title.as_str()))).collect();
    let issue_exec_sessions: HashSet<&str> = state.issues.iter().flat_map(|i| i.executions().map(|e| e.session())).collect();

    state
        .sessions
        .iter()
        .map(|s| {
            let matched_issue = s.issue_id().and_then(|iid| issue_by_id.get(iid).copied());
            let title = matched_issue.map(|(_, t)| t).filter(|t| !t.is_empty()).unwrap_or(s.name.as_str()).to_string();
            let kind = trajectory::classify_live_session(s, orchestrator_ids, issue_exec_sessions.contains(s.id.as_str()));
            RawGraphSession {
                session_id: s.id.clone(),
                issue_id: matched_issue.map(|(num, _)| num),
                title,
                runtime: s.runtime.clone(),
                status: trajectory::phase_status_str(&s.phase),
                worktree: s.cwd.clone(),
                kind,
            }
        })
        .collect()
}

fn finish_graph(raw: Vec<RawGraphSession>, clients: Vec<DebugGraphClient>, redactor: &Redactor, count: &mut u32) -> DebugGraph {
    let sessions = raw
        .into_iter()
        .map(|s| DebugGraphSession {
            session_id: s.session_id,
            issue_id: s.issue_id,
            title: redactor.redact_owned(s.title, count),
            runtime: s.runtime,
            status: s.status.to_string(),
            worktree: redactor.redact_opt_str(s.worktree, count),
            kind: s.kind,
        })
        .collect();
    DebugGraph { clients, sessions }
}

impl DebugKit {
    pub fn new(parts: DebugParts) -> Arc<Self> {
        let collector = DebugCollector::new(parts.setting.clone());
        Arc::new(Self {
            hub: parts.hub,
            setting: parts.setting,
            sources: parts.sources,
            collector,
            home: parts.home,
            work_root: parts.work_root,
            version: parts.version,
            boot_duration_ms: parts.boot_started.elapsed().as_millis() as i64,
            debug_enabled: parts.debug_enabled,
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.debug_enabled
    }

    pub fn collector(&self) -> Arc<DebugCollector> {
        self.collector.clone()
    }

    fn ensure_enabled(&self) -> Result<(), ApiError> {
        if !self.debug_enabled {
            return Err(ApiError::new(BizCode::Refused, vibevalley_i18n::t("server.debug.disabled", &[])));
        }
        Ok(())
    }

    fn hub(&self) -> Result<Arc<Hub>, ApiError> {
        self.hub.upgrade().ok_or_else(|| ApiError::new(BizCode::ServiceUnavailable, "hub is closed"))
    }

    fn read_host_payload(&self, hub: &Hub, redactor: &Redactor, redacted_count: &mut u32) -> HostDebugPayload {
        let Some(bridge) = hub.host_debug() else {
            return HostDebugPayload::default();
        };
        let mut raw = bridge.snapshot();
        self.collector.ingest_host_frames_with(&raw, redactor, redacted_count);
        // Frames are already ingested/redacted into the timeline ring and omitted from HostDebugPayload.
        if let Some(obj) = raw.as_object_mut() {
            obj.remove("frames");
        }
        let clean = redactor.redact_value(raw, redacted_count);
        serde_json::from_value(clean).unwrap_or_default()
    }

    fn default_routes() -> Value {
        json!({
            "current": "",
            "nativeWorkspace": false,
            "panel": Value::Null,
            "inspectorOpen": false,
            "projects": [],
        })
    }

    fn build_state_cache(&self, hub: &Hub, metrics: &StateMetrics, mut caches: Vec<DebugCacheStat>, agent_count: u32) -> DebugStateCache {
        caches.extend(self.collector.cache_stats());
        DebugStateCache {
            seq: hub.seq(),
            slice_seqs: hub.slice_seqs(),
            slice_watchers: hub.slice_watcher_counts(),
            counts: DebugStateCounts {
                issues: metrics.issues,
                sessions: metrics.sessions,
                channels: metrics.channels,
                agents: agent_count,
                repos: self.sources.repo_count(),
                artifacts: self.sources.artifact_count(),
                inbox: hub.inbox_slice().items.len() as u32,
                media_jobs: metrics.media_jobs,
            },
            caches,
        }
    }

    fn build_overview(
        &self,
        hub: &Hub,
        active_sessions: u32,
        active_clients: u32,
        host: &mut HostDebugPayload,
        runtimes: Vec<DebugRuntimeSummary>,
    ) -> DebugOverview {
        DebugOverview {
            channel: vibevalley_protocol::home::current_channel().as_str().to_string(),
            version: self.version.clone(),
            loopback_url: host.loopback_url.take().or_else(|| vibevalley_protocol::home::announced(&self.home)),
            home_path: self.home.display().to_string(),
            work_root: self.work_root.display().to_string(),
            db_path: self.home.join("server.db").display().to_string(),
            bundle_mode: host.bundle_mode.take(),
            boot_ms: host.boot_ms.or(Some(self.boot_duration_ms)),
            active_sessions,
            active_clients,
            active_subscriptions: hub.active_subscription_count(),
            latest_seq: hub.seq(),
            last_frame_ms: host.last_frame_ms,
            runtimes,
        }
    }

    pub fn snapshot(&self) -> Result<DebugSnapshot, ApiError> {
        self.ensure_enabled()?;
        let hub = self.hub()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        let mut host = self.read_host_payload(&hub, &redactor, &mut count);
        let probe = self.sources.runtime_probe();
        let (raw_sessions, metrics) = hub.read(|state| (extract_graph_sessions(state, &probe.orchestrator_ids), extract_state_metrics(state)));
        let active_clients = host.clients.len() as u32;
        let graph = finish_graph(raw_sessions, std::mem::take(&mut host.clients), &redactor, &mut count);
        let state_cache = self.build_state_cache(&hub, &metrics, std::mem::take(&mut host.caches), probe.agent_count);
        let overview = self.build_overview(&hub, metrics.active_sessions, active_clients, &mut host, probe.runtimes);
        let routes = host.routes.unwrap_or_else(Self::default_routes);
        let overrides = self.collector.overrides();
        let recent_timeline = self.collector.recent(SNAPSHOT_RECENT_TIMELINE_LIMIT);
        Ok(DebugSnapshot {
            overview,
            routes,
            overrides,
            graph,
            state_cache,
            recent_timeline,
        })
    }

    pub fn timeline_list(&self, q: &DebugTimelineQuery) -> Result<DebugTimelinePage, ApiError> {
        self.ensure_enabled()?;
        let hub = self.hub()?;
        if let Some(bridge) = hub.host_debug() {
            self.collector.ingest_host_frames(&bridge.snapshot());
        }
        Ok(self.collector.query(q))
    }

    pub fn timeline_clear(&self) -> Result<(), ApiError> {
        self.ensure_enabled()?;
        self.collector.clear();
        Ok(())
    }

    pub fn trajectory_list(&self) -> Result<Vec<DebugTrajectorySummary>, ApiError> {
        self.ensure_enabled()?;
        let hub = self.hub()?;
        let index = hub.read(trajectory::extract_trajectory_index);
        let probe = self.sources.runtime_probe();
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        Ok(trajectory::list_summaries(
            &self.home,
            &index,
            self.sources.as_ref(),
            &redactor,
            &probe.orchestrator_ids,
            &mut count,
        ))
    }

    pub fn trajectory_get(&self, req: &DebugTrajectoryGetRequest) -> Result<DebugTrajectoryDetail, ApiError> {
        self.ensure_enabled()?;
        let id = req.id.trim();
        if !trajectory::is_safe_id(id) {
            return Err(ApiError::new(BizCode::InvalidInput, "invalid trajectory id"));
        }
        let hub = self.hub()?;
        let meta = hub.read(|state| trajectory::extract_session_meta(state, id));
        let probe = self.sources.runtime_probe();
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        trajectory::build_detail(
            &self.home,
            meta.as_ref(),
            self.sources.as_ref(),
            &redactor,
            req,
            &probe.orchestrator_ids,
            &mut count,
        )
    }

    pub fn graph(&self) -> Result<DebugGraph, ApiError> {
        self.ensure_enabled()?;
        let hub = self.hub()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        let host = self.read_host_payload(&hub, &redactor, &mut count);
        let probe = self.sources.runtime_probe();
        let raw_sessions = hub.read(|state| extract_graph_sessions(state, &probe.orchestrator_ids));
        Ok(finish_graph(raw_sessions, host.clients, &redactor, &mut count))
    }

    pub fn override_get(&self) -> Result<DebugOverrideConfig, ApiError> {
        self.ensure_enabled()?;
        Ok(self.collector.overrides())
    }

    pub fn override_set(&self, cfg: DebugOverrideConfig) -> Result<DebugOverrideConfig, ApiError> {
        self.ensure_enabled()?;
        Ok(self.collector.set_overrides(cfg))
    }

    pub fn bundle_export(&self) -> Result<DebugBundleResult, ApiError> {
        self.ensure_enabled()?;
        let hub = self.hub()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut prior_redactions = 0u32;
        let mut host = self.read_host_payload(&hub, &redactor, &mut prior_redactions);
        let probe = self.sources.runtime_probe();
        let (raw_sessions, metrics, index) = hub.read(|state| {
            (
                extract_graph_sessions(state, &probe.orchestrator_ids),
                extract_state_metrics(state),
                trajectory::extract_trajectory_index(state),
            )
        });
        let active_clients = host.clients.len() as u32;
        let graph = finish_graph(raw_sessions, std::mem::take(&mut host.clients), &redactor, &mut prior_redactions);
        let state_cache = self.build_state_cache(&hub, &metrics, std::mem::take(&mut host.caches), probe.agent_count);
        let overview = self.build_overview(&hub, metrics.active_sessions, active_clients, &mut host, probe.runtimes);
        let routes = host.routes.unwrap_or_else(Self::default_routes);
        let overrides = self.collector.overrides();
        let timeline = self.collector.all_events();
        let trajectories = trajectory::export_snapshot(
            &self.home,
            &index,
            self.sources.as_ref(),
            &redactor,
            &probe.orchestrator_ids,
            &mut prior_redactions,
        );

        let payloads = BundlePayloads {
            overview: serde_json::to_value(&overview).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?,
            routes,
            timeline: serde_json::to_value(&timeline).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?,
            graph: serde_json::to_value(&graph).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?,
            state_cache: serde_json::to_value(&state_cache).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?,
            overrides: serde_json::to_value(&overrides).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?,
            trajectories,
        };
        bundle::export_bundle(&self.home, &redactor, payloads, prior_redactions)
    }
}

pub fn install(hub: &Hub, debug: Arc<DebugKit>) {
    macro_rules! on {
        ($op:ty, |$d:ident, $input:pat_param| $body:expr) => {{
            let $d = debug.clone();
            hub.on::<$op>(move |_, $input| $body);
        }};
    }
    on!(ops::DebugSnapshot, |d, ()| d.snapshot());
    on!(ops::DebugTimelineList, |d, q| d.timeline_list(&q));
    on!(ops::DebugTimelineClear, |d, ()| d.timeline_clear());
    on!(ops::DebugTrajectoryList, |d, ()| d.trajectory_list());
    on!(ops::DebugTrajectoryGet, |d, req| d.trajectory_get(&req));
    on!(ops::DebugGraph, |d, ()| d.graph());
    on!(ops::DebugOverrideGet, |d, ()| d.override_get());
    on!(ops::DebugOverrideSet, |d, cfg| d.override_set(cfg));
    on!(ops::DebugBundleExport, |d, ()| d.bundle_export());
}
