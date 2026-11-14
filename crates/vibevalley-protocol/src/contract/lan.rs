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
pub struct LanPaired {
    pub device: String,
    pub key: String,
    pub host_name: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LanPairRequest {
    pub code: String,
    pub name: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LanPairing {
    pub code: String,
    pub link: String,
    pub expires_at: i64,
    pub asking: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub open: bool,
    pub host_name: String,
    pub url: Option<String>,
    pub problem: String,
    pub pairing: Option<LanPairing>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenRequest {
    pub open: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPairingRequest {
    pub allow: bool,
}

crate::typescript::module! {
    "lan";
    types: [LanPaired,
    LanPairRequest,
    LanPairing,
    LanStatus,
    SetOpenRequest,
    AnswerPairingRequest];
    aliases: [];
}
