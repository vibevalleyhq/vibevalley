//! `debug.*`: built-in DevTools diagnostics module (timeline collector,
//! fault-injection overrides, read-only trajectory inspector, live topology
//! graph, state/cache telemetry, and redacted `debug-bundle.zip` exporter).
//!
//! Disabled by default (`debug_enabled = false`): all 9 `debug.*` endpoints
//! refuse with `BizCode::Refused`, and zero observer/fault-gate hooks are
//! attached to `Router` or `oar`.

pub mod bundle;
pub mod collector;
pub mod redact;
pub mod trajectory;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_protocol::{
    ApiError, BizCode, DebugBundleResult, DebugCacheStat, DebugGraph, DebugGraphClient, DebugGraphSession, DebugOverrideConfig, DebugOverview,
    DebugRuntimeSummary, DebugSnapshot, DebugStateCache, DebugStateCounts, DebugTimelinePage, DebugTimelineQuery, DebugTrajectoryDetail,
    DebugTrajectoryGetRequest, DebugTrajectoryKind, DebugTrajectorySummary, EndpointId, Issue, Op, Session, SessionEvent, ops,
};

use self::bundle::BundlePayloads;
use self::collector::DebugCollector;
use self::redact::Redactor;
use crate::context::Context;
use crate::gateway::api::{BoxFuture, SharedHostDebug};
use crate::setting::Setting;

const SNAPSHOT_RECENT_TIMELINE_LIMIT: usize = 16;

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_json::from_value(payload).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

/// Snapshot of runtime probe status and profile counts injected from `app.rs`
/// so `debug` stays free of upward business-domain imports.
#[derive(Debug, Clone, Default)]
pub struct RuntimeProbeSnapshot {
    pub runtimes: Vec<DebugRuntimeSummary>,
    pub agent_count: u32,
    pub orchestrator_ids: Vec<String>,
}

/// Live domain counts and overlaid records fetched on demand for `debug.*`.
#[derive(Debug, Clone, Default)]
pub struct DebugStateSnapshot {
    pub issues: Vec<Issue>,
    pub sessions: Vec<Session>,
    pub channel_count: u32,
    pub repo_count: u32,
    pub artifact_count: u32,
    pub media_job_count: u32,
    pub inbox_count: u32,
    pub state_cache_json: Value,
}

/// Narrow read-only data provider implemented in `app.rs` bridging
/// `Trajectory`, `Agent`, `Repo`, `Artifact`, and `Orchestrator`.
pub trait DebugDataSource: Send + Sync {
    fn trajectory_events(&self, session_id: &str) -> Vec<SessionEvent>;
    fn open_trajectory_ids(&self) -> Vec<String>;
    fn system_prompt(&self, session_id: &str, kind: DebugTrajectoryKind) -> Option<String>;
    fn runtime_probe(&self) -> RuntimeProbeSnapshot;
    fn state_snapshot_async(&self) -> BoxFuture<'_, DebugStateSnapshot>;
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

    fn state_snapshot_async(&self) -> BoxFuture<'_, DebugStateSnapshot> {
        Box::pin(async { DebugStateSnapshot::default() })
    }
}

pub struct DebugParts {
    pub ctx: Arc<Context>,
    pub active_subscriptions: Arc<dyn Fn() -> u32 + Send + Sync>,
    pub host_debug: Option<SharedHostDebug>,
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
    ctx: Arc<Context>,
    active_subscriptions: Arc<dyn Fn() -> u32 + Send + Sync>,
    host_debug: Option<SharedHostDebug>,
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
    repos: u32,
    artifacts: u32,
    media_jobs: u32,
    inbox: u32,
    active_sessions: u32,
}

fn extract_state_metrics(snap: &DebugStateSnapshot) -> StateMetrics {
    StateMetrics {
        issues: snap.issues.len() as u32,
        sessions: snap.sessions.len() as u32,
        channels: snap.channel_count,
        repos: snap.repo_count,
        artifacts: snap.artifact_count,
        media_jobs: snap.media_job_count,
        inbox: snap.inbox_count,
        active_sessions: snap.sessions.iter().filter(|s| s.phase.is_working()).count() as u32,
    }
}

fn extract_graph_sessions(issues: &[Issue], sessions: &[Session], orchestrator_ids: &[String]) -> Vec<RawGraphSession> {
    if sessions.is_empty() {
        return Vec::new();
    }
    let issue_by_id: HashMap<&str, (i64, &str)> = issues.iter().map(|i| (i.id.as_str(), (i.number, i.title.as_str()))).collect();
    let issue_exec_sessions: HashSet<&str> = issues.iter().flat_map(|i| i.executions().map(|e| e.session())).collect();

    sessions
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
            ctx: parts.ctx,
            active_subscriptions: parts.active_subscriptions,
            host_debug: parts.host_debug,
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

    /// Dispatches all 9 `Debug*` protocol endpoints for `router.rs`.
    pub(crate) async fn dispatch(&self, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::DebugSnapshot => ok_json(self.snapshot_async().await?),
            EndpointId::DebugTimelineList => {
                let req: <ops::DebugTimelineList as Op>::Input = decode(payload)?;
                ok_json(self.timeline_list(&req)?)
            }
            EndpointId::DebugTimelineClear => {
                self.timeline_clear()?;
                Ok(Value::Null)
            }
            EndpointId::DebugTrajectoryList => ok_json(self.trajectory_list_async().await?),
            EndpointId::DebugTrajectoryGet => {
                let req: <ops::DebugTrajectoryGet as Op>::Input = decode(payload)?;
                ok_json(self.trajectory_get_async(&req).await?)
            }
            EndpointId::DebugGraph => ok_json(self.graph_async().await?),
            EndpointId::DebugOverrideGet => ok_json(self.override_get()?),
            EndpointId::DebugOverrideSet => {
                let req: <ops::DebugOverrideSet as Op>::Input = decode(payload)?;
                ok_json(self.override_set(req)?)
            }
            EndpointId::DebugBundleExport => ok_json(self.bundle_export_async().await?),
            other => Err(ApiError::new(BizCode::RouteNotFound, format!("unexpected debug endpoint {}", other.as_op()))),
        }
    }

    fn ensure_enabled(&self) -> Result<(), ApiError> {
        if !self.debug_enabled {
            return Err(ApiError::new(BizCode::Refused, vibevalley_i18n::t("server.debug.disabled", &[])));
        }
        Ok(())
    }

    fn read_host_payload(&self, redactor: &Redactor, redacted_count: &mut u32) -> HostDebugPayload {
        let Some(bridge) = &self.host_debug else {
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

    fn slice_seqs_btree(&self) -> BTreeMap<String, i64> {
        self.ctx.feed.slice_seqs()
    }

    fn slice_watchers_btree(&self) -> BTreeMap<String, u32> {
        self.ctx.feed.watcher_counts()
    }

    fn build_state_cache(&self, metrics: &StateMetrics, mut caches: Vec<DebugCacheStat>, agent_count: u32) -> DebugStateCache {
        caches.extend(self.collector.cache_stats());
        DebugStateCache {
            seq: self.ctx.feed.seq(),
            slice_seqs: self.slice_seqs_btree(),
            slice_watchers: self.slice_watchers_btree(),
            counts: DebugStateCounts {
                issues: metrics.issues,
                sessions: metrics.sessions,
                channels: metrics.channels,
                agents: agent_count,
                repos: metrics.repos,
                artifacts: metrics.artifacts,
                inbox: metrics.inbox,
                media_jobs: metrics.media_jobs,
            },
            caches,
        }
    }

    fn build_overview(&self, active_sessions: u32, active_clients: u32, host: &mut HostDebugPayload, runtimes: Vec<DebugRuntimeSummary>) -> DebugOverview {
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
            active_subscriptions: (self.active_subscriptions)(),
            latest_seq: self.ctx.feed.seq(),
            last_frame_ms: host.last_frame_ms,
            runtimes,
        }
    }

    pub async fn snapshot_async(&self) -> Result<DebugSnapshot, ApiError> {
        self.ensure_enabled()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        let mut host = self.read_host_payload(&redactor, &mut count);
        let probe = self.sources.runtime_probe();
        let snap = self.sources.state_snapshot_async().await;
        let metrics = extract_state_metrics(&snap);
        let raw_sessions = extract_graph_sessions(&snap.issues, &snap.sessions, &probe.orchestrator_ids);
        let active_clients = host.clients.len() as u32;
        let graph = finish_graph(raw_sessions, std::mem::take(&mut host.clients), &redactor, &mut count);
        let state_cache = self.build_state_cache(&metrics, std::mem::take(&mut host.caches), probe.agent_count);
        let overview = self.build_overview(metrics.active_sessions, active_clients, &mut host, probe.runtimes);
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
        if let Some(bridge) = &self.host_debug {
            self.collector.ingest_host_frames(&bridge.snapshot());
        }
        Ok(self.collector.query(q))
    }

    pub fn timeline_clear(&self) -> Result<(), ApiError> {
        self.ensure_enabled()?;
        self.collector.clear();
        Ok(())
    }

    pub async fn trajectory_list_async(&self) -> Result<Vec<DebugTrajectorySummary>, ApiError> {
        self.ensure_enabled()?;
        let snap = self.sources.state_snapshot_async().await;
        let index = trajectory::extract_trajectory_index(&snap.issues, &snap.sessions);
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

    pub async fn trajectory_get_async(&self, req: &DebugTrajectoryGetRequest) -> Result<DebugTrajectoryDetail, ApiError> {
        self.ensure_enabled()?;
        let id = req.id.trim();
        if !trajectory::is_safe_id(id) {
            return Err(ApiError::new(BizCode::InvalidInput, "invalid trajectory id"));
        }
        let snap = self.sources.state_snapshot_async().await;
        let meta = trajectory::extract_session_meta(&snap.issues, &snap.sessions, id);
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

    pub async fn graph_async(&self) -> Result<DebugGraph, ApiError> {
        self.ensure_enabled()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        let host = self.read_host_payload(&redactor, &mut count);
        let probe = self.sources.runtime_probe();
        let snap = self.sources.state_snapshot_async().await;
        let raw_sessions = extract_graph_sessions(&snap.issues, &snap.sessions, &probe.orchestrator_ids);
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

    pub async fn bundle_export_async(&self) -> Result<DebugBundleResult, ApiError> {
        self.ensure_enabled()?;
        let redactor = Redactor::from_setting(&self.setting);
        let mut prior_redactions = 0u32;
        let mut host = self.read_host_payload(&redactor, &mut prior_redactions);
        let probe = self.sources.runtime_probe();
        let snap = self.sources.state_snapshot_async().await;
        let raw_sessions = extract_graph_sessions(&snap.issues, &snap.sessions, &probe.orchestrator_ids);
        let metrics = extract_state_metrics(&snap);
        let index = trajectory::extract_trajectory_index(&snap.issues, &snap.sessions);
        let active_clients = host.clients.len() as u32;
        let graph = finish_graph(raw_sessions, std::mem::take(&mut host.clients), &redactor, &mut prior_redactions);
        let state_cache = self.build_state_cache(&metrics, std::mem::take(&mut host.caches), probe.agent_count);
        let overview = self.build_overview(metrics.active_sessions, active_clients, &mut host, probe.runtimes);
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
