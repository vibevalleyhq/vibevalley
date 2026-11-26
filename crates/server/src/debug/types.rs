use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use vibevalley_protocol::{DebugRuntimeSummary, DebugTrajectoryKind, Issue, Session, SessionEvent};

use crate::context::Context;
use crate::context::api::{BoxFuture, SharedHostDebug};
use crate::setting::Setting;

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
    fn system_prompt_async<'a>(&'a self, session_id: &'a str, kind: DebugTrajectoryKind) -> BoxFuture<'a, Option<String>>;
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

    fn system_prompt_async<'a>(&'a self, _session_id: &'a str, _kind: DebugTrajectoryKind) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
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
