#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SpaceState {
    pub call: CallState,
    pub call_reason: String,
    pub media: Option<Vec<MediaJob>>,
    pub chat: Option<Chat>,
    pub commits: Option<CommitCount>,
    pub progress: Option<Progress>,
    pub issues: Vec<Issue>,
    /// Each chat app's status, as the connectors say it whenever it changes; their home is the connectors, not state.json.
    pub connectors: Vec<ConnectorStatus>,
    /// The machines helpers work on, as the machine module says them.
    pub machines: Vec<Machine>,
    /// Each orchestrator not at rest, by its profile id, as its last orchestrator fact says; one not here is idle.
    pub sessions: Vec<Session>,
    pub crons: Vec<Cron>,
    /// The farm scene's station and step history, by session; no business rule reads it.
    pub plays: Option<BTreeMap<String, SessionPlay>>,
    /// Durable runtime inbox alerts projected into `InboxSlice` via `Fact::RuntimeInboxChanged`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<Vec<InboxItem>>"))]
    pub runtime_inbox_items: Vec<InboxItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SliceKind {
    Board,
    Sessions,
    Collab,
    Inbox,
    Ops,
    Farm,
}

impl SliceKind {
    pub const ALL: [SliceKind; 6] = [
        SliceKind::Board,
        SliceKind::Sessions,
        SliceKind::Collab,
        SliceKind::Inbox,
        SliceKind::Ops,
        SliceKind::Farm,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SliceKind::Board => "board",
            SliceKind::Sessions => "sessions",
            SliceKind::Collab => "collab",
            SliceKind::Inbox => "inbox",
            SliceKind::Ops => "ops",
            SliceKind::Farm => "farm",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<SliceKind> {
        match s {
            "board" => Some(SliceKind::Board),
            "sessions" => Some(SliceKind::Sessions),
            "collab" => Some(SliceKind::Collab),
            "inbox" => Some(SliceKind::Inbox),
            "ops" => Some(SliceKind::Ops),
            "farm" => Some(SliceKind::Farm),
            _ => None,
        }
    }
}

impl std::str::FromStr for SliceKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        SliceKind::from_str(s).ok_or(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum NoticeLevel {
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "error")]
    Error,
}

impl NoticeLevel {
    pub const ALL: [NoticeLevel; 3] = [NoticeLevel::Info, NoticeLevel::Warn, NoticeLevel::Error];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            NoticeLevel::Info => "info",
            NoticeLevel::Warn => "warn",
            NoticeLevel::Error => "error",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BoardSlice {
    pub seq: i64,
    pub issues: Vec<Issue>,
    pub board_summary: Option<BoardSummary>,
    pub commits: Option<CommitCount>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionsSlice {
    pub seq: i64,
    pub sessions: Vec<SessionView>,
    pub machines: Vec<Machine>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CollabSlice {
    pub seq: i64,
    pub chat: Option<Chat>,
    pub channel_summary: Option<ChannelSummary>,
    pub connectors: Vec<ConnectorStatus>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxSlice {
    pub seq: i64,
    pub items: Vec<InboxItem>,
    pub call: CallState,
    pub call_reason: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OpsSlice {
    pub seq: i64,
    pub crons: Vec<CronView>,
    pub media: Option<Vec<MediaJob>>,
    pub media_summary: Option<MediaSummary>,
}

/// Offline snapshot, scenario, and fixture bundle; never served as an HTTP endpoint.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SliceBundle {
    pub seq: i64,
    pub board: BoardSlice,
    pub sessions: SessionsSlice,
    pub collab: CollabSlice,
    pub inbox: InboxSlice,
    pub ops: OpsSlice,
    pub farm: FarmFrame,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: String,
}

/// Told apart by `type`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum Fact {
    #[serde(rename = "callChanged")]
    CallChanged(FactCallChanged),
    #[serde(rename = "sessionToolChanged")]
    SessionToolChanged(FactSessionToolChanged),
    #[serde(rename = "sessionToolsReset")]
    SessionToolsReset(FactSessionToolsReset),
    #[serde(rename = "sessionSubagentsChanged")]
    SessionSubagentsChanged(FactSessionSubagentsChanged),
    #[serde(rename = "sessionPhaseChanged")]
    SessionPhaseChanged(FactSessionPhaseChanged),
    #[serde(rename = "messageChanged")]
    MessageChanged(FactMessageChanged),
    #[serde(rename = "channelChanged")]
    ChannelChanged(FactChannelChanged),
    #[serde(rename = "userMentionsChanged")]
    UserMentionsChanged(FactUserMentionsChanged),
    #[serde(rename = "sessionChanged")]
    SessionChanged(FactSessionChanged),
    #[serde(rename = "sessionReported")]
    SessionReported(FactSessionReported),
    #[serde(rename = "sessionLeft")]
    SessionLeft(FactSessionLeft),
    #[serde(rename = "progressChanged")]
    ProgressChanged(FactProgressChanged),
    #[serde(rename = "issueChanged")]
    IssueChanged(FactIssueChanged),
    #[serde(rename = "issueRemoved")]
    IssueRemoved(FactIssueRemoved),
    #[serde(rename = "channelRemoved")]
    ChannelRemoved(FactChannelRemoved),
    #[serde(rename = "cronChanged")]
    CronChanged(FactCronChanged),
    #[serde(rename = "cronRemoved")]
    CronRemoved(FactCronRemoved),
    #[serde(rename = "connectorChanged")]
    ConnectorChanged(FactConnectorChanged),
    #[serde(rename = "machineChanged")]
    MachineChanged(FactMachineChanged),
    #[serde(rename = "machineRemoved")]
    MachineRemoved(FactMachineRemoved),
    #[serde(rename = "mediaChanged")]
    MediaChanged(FactMediaChanged),
    #[serde(rename = "runtimeInboxChanged")]
    RuntimeInboxChanged(FactRuntimeInboxChanged),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LiveEventSession {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub activity: SessionEvent,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LiveEventNotice {
    pub at: i64,
    pub level: NoticeLevel,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LiveEventRuntime {
    pub at: i64,
    pub info: RuntimeInfo,
}

/// Told apart by `type`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum LiveEvent {
    #[serde(rename = "event")]
    Event(LiveEventSession),
    #[serde(rename = "notice")]
    Notice(LiveEventNotice),
    #[serde(rename = "runtime")]
    Runtime(LiveEventRuntime),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelFollowPayload {
    pub id: String,
    pub after: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelReportsPayload {
    pub after: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFollowPayload {
    pub id: String,
    pub after: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionFollowPayload {
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum RetroWindow {
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "14d")]
    Days14,
    #[serde(rename = "30d")]
    Days30,
    #[serde(rename = "all")]
    All,
}

impl RetroWindow {
    pub const ALL: [RetroWindow; 4] = [RetroWindow::Days7, RetroWindow::Days14, RetroWindow::Days30, RetroWindow::All];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            RetroWindow::Days7 => "7d",
            RetroWindow::Days14 => "14d",
            RetroWindow::Days30 => "30d",
            RetroWindow::All => "all",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct IssueRetroGetInput {
    pub window: Option<RetroWindow>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RetroDurationStats {
    pub sample_count: i64,
    pub median_ms: Option<i64>,
    pub p90_ms: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RetroOverdueItem {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
    pub id: IssueId,
    pub number: i64,
    pub title: String,
    pub status: IssueStatus,
    pub repo: Option<String>,
    pub agent: Option<String>,
    pub due_at: i64,
    pub closed_at: Option<i64>,
    pub overdue_ms: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RetroReworkItem {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
    pub id: IssueId,
    pub number: i64,
    pub title: String,
    pub status: IssueStatus,
    pub repo: Option<String>,
    pub agent: Option<String>,
    pub findings_count: i64,
    pub unresolved_count: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RetroBreakdownBucket {
    pub key: String,
    pub total_count: i64,
    pub completed_count: i64,
    pub canceled_count: i64,
    pub overdue_count: i64,
    pub rework_count: i64,
    pub median_cycle_ms: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct IssueRetroReport {
    pub window: RetroWindow,
    pub generated_at: i64,
    pub window_start_at: Option<i64>,
    pub total_issues: i64,
    pub open_count: i64,
    pub completed_count: i64,
    pub canceled_count: i64,
    pub completion_rate_pct: Option<crate::JsNumber>,
    pub cycle_time: RetroDurationStats,
    pub review_wait: RetroDurationStats,
    pub with_due_count: i64,
    pub without_due_count: i64,
    pub on_time_count: i64,
    pub overdue_count: i64,
    pub upcoming_due_count: i64,
    pub on_time_rate_pct: Option<crate::JsNumber>,
    pub overdue_rate_pct: Option<crate::JsNumber>,
    pub rework_issue_count: i64,
    pub total_findings_count: i64,
    pub unresolved_findings_count: i64,
    pub rework_rate_pct: Option<crate::JsNumber>,
    pub overdue_items: Vec<RetroOverdueItem>,
    pub rework_items: Vec<RetroReworkItem>,
    pub by_repo: Vec<RetroBreakdownBucket>,
    pub by_tag: Vec<RetroBreakdownBucket>,
    pub by_agent: Vec<RetroBreakdownBucket>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "core";
    types: [SpaceState,
    SliceKind,
    NoticeLevel,
    BoardSlice,
    SessionsSlice,
    CollabSlice,
    InboxSlice,
    OpsSlice,
    SliceBundle,
    Health,
    Fact,
    LiveEventSession,
    LiveEventNotice,
    LiveEventRuntime,
    LiveEvent,
    ChannelFollowPayload,
    ChannelReportsPayload,
    ArtifactFollowPayload,
    ArtifactSuggestionFollowPayload,
    RetroWindow,
    IssueRetroGetInput,
    RetroDurationStats,
    RetroOverdueItem,
    RetroReworkItem,
    RetroBreakdownBucket,
    IssueRetroReport];
    aliases: [];
}
