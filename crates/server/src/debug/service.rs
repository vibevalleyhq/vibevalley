use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_protocol::{
    ApiError, BizCode, DebugBundleResult, DebugCacheStat, DebugCollabNoteState, DebugGraph, DebugGraphClient, DebugGraphSession, DebugOverrideConfig,
    DebugOverview, DebugRuntimeSummary, DebugSnapshot, DebugStateCache, DebugStateCounts, DebugTimelinePage, DebugTimelineQuery, DebugTrajectoryDetail,
    DebugTrajectoryExportRequest, DebugTrajectoryExportResult, DebugTrajectoryGetRequest, DebugTrajectoryKind, DebugTrajectorySummary, Issue, Session,
};

use super::bundle::{self, BundlePayloads};
use super::collector::DebugCollector;
use super::redact::Redactor;
use super::trajectory;
use super::types::{DebugDataSource, DebugParts, DebugStateSnapshot};
use crate::context::Context;
use crate::context::api::SharedHostDebug;
use crate::setting::Setting;

const SNAPSHOT_RECENT_TIMELINE_LIMIT: usize = 16;

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
    notes: u32,
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
        notes: snap.note_count,
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
        let raw_json = bridge.snapshot_json();
        self.collector.ingest_host_frames_with(&raw_json, redactor, redacted_count);
        let Ok(mut raw) = serde_json::from_str::<Value>(&raw_json) else {
            return HostDebugPayload::default();
        };
        // Frames are already ingested/redacted into the timeline ring and omitted from HostDebugPayload.
        if let Some(obj) = raw.as_object_mut() {
            obj.remove("frames");
        }
        let stripped_json = serde_json::to_string(&raw).unwrap_or_else(|_| "{}".to_string());
        let clean_json = redactor.redact_json_value(&stripped_json, redacted_count);
        serde_json::from_str(&clean_json).unwrap_or_default()
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

    fn redact_collab_states(collab: &[DebugCollabNoteState], redactor: &Redactor, count: &mut u32) -> Vec<DebugCollabNoteState> {
        collab
            .iter()
            .map(|c| {
                let mut next = c.clone();
                next.title = redactor.redact_owned(next.title, count);
                for p in &mut next.presence {
                    p.name = redactor.redact_owned(std::mem::take(&mut p.name), count);
                    p.status = redactor.redact_opt_str(p.status.take(), count);
                    p.node_id = redactor.redact_opt_str(p.node_id.take(), count);
                    p.path = redactor.redact_opt_str(p.path.take(), count);
                }
                next
            })
            .collect()
    }

    fn build_state_cache(
        &self,
        metrics: &StateMetrics,
        mut caches: Vec<DebugCacheStat>,
        agent_count: u32,
        collab: &[DebugCollabNoteState],
        redactor: &Redactor,
        count: &mut u32,
    ) -> DebugStateCache {
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
                notes: metrics.notes,
                inbox: metrics.inbox,
                media_jobs: metrics.media_jobs,
            },
            caches,
            collab: Self::redact_collab_states(collab, redactor, count),
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
        let mut prior_redactions = 0u32;
        let mut host = self.read_host_payload(&redactor, &mut prior_redactions);
        let probe = self.sources.runtime_probe();
        let snap = self.sources.state_snapshot_async().await;
        let metrics = extract_state_metrics(&snap);
        let raw_sessions = extract_graph_sessions(&snap.issues, &snap.sessions, &probe.orchestrator_ids);
        let active_clients = host.clients.len() as u32;
        let graph = finish_graph(raw_sessions, std::mem::take(&mut host.clients), &redactor, &mut prior_redactions);
        let outbox_failed = self.ctx.outbox.failed_count_async().await.unwrap_or(0);
        let mut caches = std::mem::take(&mut host.caches);
        caches.push(DebugCacheStat {
            name: "outbox.failed".into(),
            entries: outbox_failed.min(u32::MAX as u64) as u32,
            detail: Some(format!("dead-lettered outbox items ({outbox_failed})")),
        });
        let state_cache = self.build_state_cache(&metrics, caches, probe.agent_count, &snap.collab, &redactor, &mut prior_redactions);
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

    pub async fn outbox_failed_list_async(&self, limit: u64) -> Result<Vec<crate::context::OutboxDeadLetter>, ApiError> {
        self.ensure_enabled()?;
        self.ctx.outbox.list_failed_async(limit).await
    }

    pub async fn outbox_replay_async(&self, id: Option<i64>) -> Result<u64, ApiError> {
        self.ensure_enabled()?;
        match id {
            Some(item_id) => Ok(u64::from(self.ctx.outbox.replay_failed_async(item_id).await?)),
            None => self.ctx.outbox.replay_all_failed_async().await,
        }
    }

    pub fn timeline_list(&self, q: &DebugTimelineQuery) -> Result<DebugTimelinePage, ApiError> {
        self.ensure_enabled()?;
        if let Some(bridge) = &self.host_debug {
            self.collector.ingest_host_frames(&bridge.snapshot_json());
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
        Ok(trajectory::list_summaries_async(&self.home, &index, self.sources.as_ref(), &redactor, &probe.orchestrator_ids, &mut count).await)
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
        trajectory::build_detail_async(
            &self.home,
            meta.as_ref(),
            self.sources.as_ref(),
            &redactor,
            req,
            &probe.orchestrator_ids,
            &mut count,
        )
        .await
    }

    pub async fn trajectory_export_async(&self, req: &DebugTrajectoryExportRequest) -> Result<DebugTrajectoryExportResult, ApiError> {
        self.ensure_enabled()?;
        let id = req.id.trim();
        if !trajectory::is_safe_id(id) {
            return Err(ApiError::new(BizCode::InvalidInput, "invalid trajectory id"));
        }
        let snap = self.sources.state_snapshot_async().await;
        let meta = trajectory::extract_session_meta(&snap.issues, &snap.sessions, id);
        let probe = self.sources.runtime_probe();
        let redactor = Redactor::from_setting(&self.setting);
        trajectory::export_bundle_async(&self.home, meta.as_ref(), self.sources.as_ref(), &redactor, req, &probe.orchestrator_ids).await
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
        let outbox_failed = self.ctx.outbox.failed_count_async().await.unwrap_or(0);
        let mut caches = std::mem::take(&mut host.caches);
        caches.push(DebugCacheStat {
            name: "outbox.failed".into(),
            entries: outbox_failed.min(u32::MAX as u64) as u32,
            detail: Some(format!("dead-lettered outbox items ({outbox_failed})")),
        });
        let state_cache = self.build_state_cache(&metrics, caches, probe.agent_count, &snap.collab, &redactor, &mut prior_redactions);
        let overview = self.build_overview(metrics.active_sessions, active_clients, &mut host, probe.runtimes);
        let routes = host.routes.unwrap_or_else(Self::default_routes);
        let overrides = self.collector.overrides();
        let timeline = self.collector.all_events();
        let trajectories = trajectory::export_snapshot_async(
            &self.home,
            &index,
            self.sources.as_ref(),
            &redactor,
            &probe.orchestrator_ids,
            &mut prior_redactions,
        )
        .await;

        let ser = |val_res: Result<String, serde_json::Error>| val_res.map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()));
        let payloads = BundlePayloads {
            overview_json: ser(serde_json::to_string(&overview))?,
            routes_json: ser(serde_json::to_string(&routes))?,
            timeline_json: ser(serde_json::to_string(&timeline))?,
            graph_json: ser(serde_json::to_string(&graph))?,
            state_cache_json: ser(serde_json::to_string(&state_cache))?,
            overrides_json: ser(serde_json::to_string(&overrides))?,
            trajectories_json: ser(serde_json::to_string(&trajectories))?,
        };
        bundle::export_bundle_async(&self.home, &redactor, payloads, prior_redactions).await
    }
}
