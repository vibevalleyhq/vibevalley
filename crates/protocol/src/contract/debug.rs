#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::Millis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum DebugTimelineLane {
    CoreApply,
    BridgeRpc,
    OarWire,
    GpuiFrame,
}

impl DebugTimelineLane {
    pub const ALL: [DebugTimelineLane; 4] = [
        DebugTimelineLane::CoreApply,
        DebugTimelineLane::BridgeRpc,
        DebugTimelineLane::OarWire,
        DebugTimelineLane::GpuiFrame,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            DebugTimelineLane::CoreApply => "core_apply",
            DebugTimelineLane::BridgeRpc => "bridge_rpc",
            DebugTimelineLane::OarWire => "oar_wire",
            DebugTimelineLane::GpuiFrame => "gpui_frame",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTimelineEvent {
    pub id: i64,
    pub time: Millis,
    pub lane: DebugTimelineLane,
    pub kind: String,
    pub trace_id: Option<i64>,
    pub duration_us: Option<i64>,
    pub summary: String,
    #[cfg_attr(feature = "ts-gen", ts(optional, type = "unknown"))]
    pub detail: Option<serde_json::Value>,
    pub slow: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTimelineQuery {
    pub lane: Option<DebugTimelineLane>,
    pub after_id: Option<i64>,
    pub limit: Option<u32>,
    pub search: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTimelinePage {
    pub events: Vec<DebugTimelineEvent>,
    pub latest_id: i64,
    pub dropped: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum DebugTrajectoryKind {
    IssueSession,
    WorkspaceChat,
    Orchestrator,
}

impl DebugTrajectoryKind {
    pub const ALL: [DebugTrajectoryKind; 3] = [
        DebugTrajectoryKind::IssueSession,
        DebugTrajectoryKind::WorkspaceChat,
        DebugTrajectoryKind::Orchestrator,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            DebugTrajectoryKind::IssueSession => "issue_session",
            DebugTrajectoryKind::WorkspaceChat => "workspace_chat",
            DebugTrajectoryKind::Orchestrator => "orchestrator",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTrajectorySummary {
    pub id: String,
    pub kind: DebugTrajectoryKind,
    pub title: String,
    pub runtime: String,
    pub status: String,
    pub updated_at: Millis,
    pub event_count: u32,
    pub has_voyage_record: bool,
    pub has_silent_error: bool,
    pub tokens: Option<EventTokens>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTrajectoryRawEntry {
    pub seq: i64,
    pub time: Millis,
    pub kind: String,
    pub frame_type: Option<String>,
    pub agent_path: Vec<String>,
    pub trace_id: Option<i64>,
    pub summary: String,
    pub payload: Option<String>,
    pub original_bytes: u32,
    pub truncated: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTrajectoryTurn {
    pub index: u32,
    pub prompt: Option<String>,
    pub started_at: Millis,
    pub ended_at: Option<Millis>,
    pub duration_ms: Option<i64>,
    pub events: Vec<SessionEvent>,
    pub raw_entries: Vec<DebugTrajectoryRawEntry>,
    pub tokens: Option<EventTokens>,
    pub silent_errors: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTrajectoryDetail {
    pub summary: DebugTrajectorySummary,
    pub system_prompt: Option<String>,
    pub turns: Vec<DebugTrajectoryTurn>,
    pub subagent_paths: Vec<String>,
    pub voyage_record_count: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugTrajectoryGetRequest {
    pub id: String,
    pub kind: Option<DebugTrajectoryKind>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugRuntimeSummary {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub ready: bool,
    pub version: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugOverview {
    pub channel: String,
    pub version: String,
    pub loopback_url: Option<String>,
    pub home_path: String,
    pub work_root: String,
    pub db_path: String,
    pub bundle_mode: Option<String>,
    pub boot_ms: Option<i64>,
    pub active_sessions: u32,
    pub active_clients: u32,
    pub active_subscriptions: u32,
    pub latest_seq: i64,
    pub last_frame_ms: Option<f64>,
    pub runtimes: Vec<DebugRuntimeSummary>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugGraphClient {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub watches: Vec<String>,
    pub subscriptions: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugGraphSession {
    pub session_id: String,
    pub issue_id: Option<i64>,
    pub title: String,
    pub runtime: String,
    pub status: String,
    pub worktree: Option<String>,
    pub kind: DebugTrajectoryKind,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugGraph {
    pub clients: Vec<DebugGraphClient>,
    pub sessions: Vec<DebugGraphSession>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugCacheStat {
    pub name: String,
    pub entries: u32,
    pub detail: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugStateCounts {
    pub issues: u32,
    pub sessions: u32,
    pub channels: u32,
    pub agents: u32,
    pub repos: u32,
    pub artifacts: u32,
    pub inbox: u32,
    pub media_jobs: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugStateCache {
    pub seq: i64,
    pub slice_seqs: BTreeMap<String, i64>,
    pub slice_watchers: BTreeMap<String, u32>,
    pub counts: DebugStateCounts,
    pub caches: Vec<DebugCacheStat>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugOverrideConfig {
    pub rpc_delay_ms: u32,
    pub slice_delay_ms: u32,
    pub target_filter: Option<String>,
    pub disconnect_topic: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugBundleResult {
    pub path: String,
    pub size_bytes: i64,
    pub files: Vec<String>,
    pub redacted_count: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DebugSnapshot {
    pub overview: DebugOverview,
    #[cfg_attr(feature = "ts-gen", ts(type = "unknown"))]
    pub routes: serde_json::Value,
    pub overrides: DebugOverrideConfig,
    pub graph: DebugGraph,
    pub state_cache: DebugStateCache,
    pub recent_timeline: Vec<DebugTimelineEvent>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "debug";
    types: [DebugTimelineLane,
    DebugTimelineEvent,
    DebugTimelineQuery,
    DebugTimelinePage,
    DebugTrajectoryKind,
    DebugTrajectorySummary,
    DebugTrajectoryRawEntry,
    DebugTrajectoryTurn,
    DebugTrajectoryDetail,
    DebugTrajectoryGetRequest,
    DebugRuntimeSummary,
    DebugOverview,
    DebugGraphClient,
    DebugGraphSession,
    DebugGraph,
    DebugCacheStat,
    DebugStateCounts,
    DebugStateCache,
    DebugOverrideConfig,
    DebugBundleResult,
    DebugSnapshot];
    aliases: [];
}
