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

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RecallPreview {
    pub lines: Vec<String>,
    pub chars: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum MemoryKind {
    #[serde(rename = "note")]
    Note,
    #[serde(rename = "issue")]
    Issue,
}

impl MemoryKind {
    pub const ALL: [MemoryKind; 2] = [MemoryKind::Note, MemoryKind::Issue];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryKind::Note => "note",
            MemoryKind::Issue => "issue",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub agent: String,
    pub kind: MemoryKind,
    pub text: String,
    pub author: ActorKind,
    pub repo: Option<String>,
    #[ts(as = "Option<crate::typescript::SessionId>")]
    pub session: Option<SessionId>,
    pub at: i64,
    pub recalled: i64,
    pub recalled_at: Option<i64>,
    pub fading: bool,
    pub source: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRequest {
    pub text: String,
    pub repo: Option<String>,
    /// The client's key for this request: the same key again within a while returns the first one's result and does it once (a retry after a lost reply).
    pub request_key: Option<String>,
}

/// "unknown": the source did not declare a scope.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "kind")]
pub enum MemoryScope {
    #[serde(rename = "global")]
    Global {},
    #[serde(rename = "repo", rename_all = "camelCase")]
    Repo { repo: String },
    #[serde(rename = "unknown")]
    Unknown {},
}

/// A memory a search found, with the source it came from and how well it matched.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFound {
    pub id: String,
    pub agent: String,
    pub kind: MemoryKind,
    pub text: String,
    pub author: ActorKind,
    pub repo: Option<String>,
    #[ts(as = "Option<crate::typescript::SessionId>")]
    pub session: Option<SessionId>,
    pub at: i64,
    pub recalled: i64,
    pub recalled_at: Option<i64>,
    pub fading: bool,
    pub source: String,
    pub score: JsNumber,
    pub scope: MemoryScope,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearch {
    pub found: Vec<MemoryFound>,
    /// The sources asked, as each says it covered the search.
    pub coverage: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryList {
    pub memories: Vec<Memory>,
    pub sources: Vec<MemorySourceInfo>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListInput {
    pub agent: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallInput {
    pub agent: String,
    pub repo: Option<String>,
    pub text: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCreateInput {
    pub agent: String,
    pub text: String,
    pub repo: Option<String>,
    pub request_key: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchInput {
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub text: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteInput {
    pub agent: String,
    pub memory: String,
}

crate::typescript::module! {
    "memory";
    types: [RecallPreview,
    MemoryKind,
    Memory,
    MemoryRequest,
    MemoryScope,
    MemoryFound,
    MemorySearch,
    MemoryList,
    MemoryListInput,
    MemoryRecallInput,
    MemoryCreateInput,
    MemorySearchInput,
    MemoryDeleteInput];
    aliases: [];
}
