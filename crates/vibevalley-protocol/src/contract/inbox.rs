#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

#[allow(unused_imports)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use ts_rs::TS;

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::wire::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
}

impl InboxKind {
    pub const ALL: [InboxKind; 8] = [
        InboxKind::Review,
        InboxKind::Ask,
        InboxKind::Fix,
        InboxKind::Interrupted,
        InboxKind::Conflict,
        InboxKind::Quiet,
        InboxKind::Mention,
        InboxKind::CronAsk,
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
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxFromSession {
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub name: String,
    pub agent: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxFromOrchestrator {}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "kind")]
pub enum InboxFrom {
    #[serde(rename = "session")]
    Session(InboxFromSession),
    #[serde(rename = "orchestrator")]
    Orchestrator(InboxFromOrchestrator),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetSession {
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetIssue {
    #[ts(as = "crate::typescript::IssueId")]
    pub id: IssueId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxTargetChat {
    pub channel: String,
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "kind")]
pub enum InboxTarget {
    #[serde(rename = "session")]
    Session(InboxTargetSession),
    #[serde(rename = "issue")]
    Issue(InboxTargetIssue),
    #[serde(rename = "chat")]
    Chat(InboxTargetChat),
}

/// What an item says on each route the user hears it on.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InboxWords {
    pub label: String,
    pub title: String,
    pub body: String,
    pub tray: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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

crate::typescript::module! {
    "inbox";
    types: [InboxKind,
    InboxFromSession,
    InboxFromOrchestrator,
    InboxFrom,
    InboxTargetSession,
    InboxTargetIssue,
    InboxTargetChat,
    InboxTarget,
    InboxWords,
    InboxItem];
    aliases: [];
}
