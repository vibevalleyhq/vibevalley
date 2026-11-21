#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use crate::wire::*;

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorEvalRequest {
    /// The orchestrator whose log it is, by its profile id; the default one when none is given.
    pub agent: Option<String>,
    pub on: JsNumber,
    pub want: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorEval {
    pub id: String,
    pub file: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStopInput {
    pub agent: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorApprovalListInput {
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorApproval {
    pub conversation_id: String,
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_json: String,
    pub reason: String,
    pub requested_at_ms: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorApprovalResolveInput {
    pub conversation_id: String,
    pub task_id: String,
    pub tool_call_id: String,
    pub approved: bool,
    pub reason: Option<String>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "orchestrator";
    types: [OrchestratorEvalRequest,
    OrchestratorEval,
    OrchestratorStopInput,
    OrchestratorApprovalListInput,
    OrchestratorApproval,
    OrchestratorApprovalResolveInput];
    aliases: [];
}
