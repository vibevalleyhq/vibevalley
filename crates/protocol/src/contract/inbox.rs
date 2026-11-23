#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum InboxKind {
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "ask")]
    Ask,
    #[serde(rename = "fix")]
    Fix,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "conflict")]
    Conflict,
    #[serde(rename = "quiet")]
    Quiet,
    #[serde(rename = "mention")]
    Mention,
    #[serde(rename = "cron-ask")]
    CronAsk,
    #[serde(rename = "budget_reached")]
    BudgetReached,
}

impl InboxKind {
    pub const ALL: [InboxKind; 9] = [
        InboxKind::Review,
        InboxKind::Ask,
        InboxKind::Fix,
        InboxKind::Interrupted,
        InboxKind::Conflict,
        InboxKind::Quiet,
        InboxKind::Mention,
        InboxKind::CronAsk,
        InboxKind::BudgetReached,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            InboxKind::Review => "review",
            InboxKind::Ask => "ask",
            InboxKind::Fix => "fix",
            InboxKind::Interrupted => "interrupted",
            InboxKind::Conflict => "conflict",
            InboxKind::Quiet => "quiet",
            InboxKind::Mention => "mention",
            InboxKind::CronAsk => "cron-ask",
            InboxKind::BudgetReached => "budget_reached",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxFromSession {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub name: String,
    pub agent: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxFromOrchestrator {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxFromRuntime {}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum InboxFrom {
    #[serde(rename = "session")]
    Session(InboxFromSession),
    #[serde(rename = "orchestrator")]
    Orchestrator(InboxFromOrchestrator),
    #[serde(rename = "runtime")]
    Runtime(InboxFromRuntime),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetSession {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetIssue {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
    pub id: IssueId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetChat {
    pub channel: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetRuntime {
    pub task_id: String,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
    pub session_id: Option<SessionId>,
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum InboxTarget {
    #[serde(rename = "session")]
    Session(InboxTargetSession),
    #[serde(rename = "issue")]
    Issue(InboxTargetIssue),
    #[serde(rename = "chat")]
    Chat(InboxTargetChat),
    #[serde(rename = "runtime")]
    Runtime(InboxTargetRuntime),
}

/// What an item says on each route the user hears it on.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxWords {
    pub label: String,
    pub title: String,
    pub body: String,
    pub tray: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: InboxKind,
    pub from: InboxFrom,
    /// Who it is from, as the routes say it: the helper's name, or the orchestrator.
    pub who: String,
    pub text: String,
    pub at: i64,
    pub target: InboxTarget,
    pub words: InboxWords,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "inbox";
    types: [InboxKind,
    InboxFromSession,
    InboxFromOrchestrator,
    InboxFromRuntime,
    InboxFrom,
    InboxTargetSession,
    InboxTargetIssue,
    InboxTargetChat,
    InboxTargetRuntime,
    InboxTarget,
    InboxWords,
    InboxItem];
    aliases: [];
}
