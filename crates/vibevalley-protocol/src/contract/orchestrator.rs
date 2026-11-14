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
pub struct OrchestratorEvalRequest {
    /// The orchestrator whose log it is, by its profile id; the default one when none is given.
    pub agent: Option<String>,
    pub on: JsNumber,
    pub want: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorEval {
    pub id: String,
    pub file: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStopInput {
    pub agent: Option<String>,
}

crate::typescript::module! {
    "orchestrator";
    types: [OrchestratorEvalRequest,
    OrchestratorEval,
    OrchestratorStopInput];
    aliases: [];
}
