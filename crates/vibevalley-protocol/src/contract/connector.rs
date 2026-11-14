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
pub enum ConnectorID {
    #[serde(rename = "weixin")]
    Weixin,
    #[serde(rename = "feishu")]
    Feishu,
    #[serde(rename = "qq")]
    Qq,
}

impl ConnectorID {
    pub const ALL: [ConnectorID; 3] = [ConnectorID::Weixin, ConnectorID::Feishu, ConnectorID::Qq];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectorID::Weixin => "weixin",
            ConnectorID::Feishu => "feishu",
            ConnectorID::Qq => "qq",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum ConnectorState {
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(rename = "scanned")]
    Scanned,
    #[serde(rename = "verify")]
    Verify,
    #[serde(rename = "pairing")]
    Pairing,
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "paused")]
    Paused,
}

impl ConnectorState {
    pub const ALL: [ConnectorState; 7] = [
        ConnectorState::Off,
        ConnectorState::Waiting,
        ConnectorState::Scanned,
        ConnectorState::Verify,
        ConnectorState::Pairing,
        ConnectorState::Connected,
        ConnectorState::Paused,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectorState::Off => "off",
            ConnectorState::Waiting => "waiting",
            ConnectorState::Scanned => "scanned",
            ConnectorState::Verify => "verify",
            ConnectorState::Pairing => "pairing",
            ConnectorState::Connected => "connected",
            ConnectorState::Paused => "paused",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub id: ConnectorID,
    pub state: ConnectorState,
    pub qr: String,
    pub pair_code: String,
    pub channel: Option<String>,
    pub user: Option<String>,
    pub since: Option<i64>,
    pub last_inbound: Option<i64>,
    pub paused_until: Option<i64>,
    pub pending: i64,
    pub error: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorLogin {
    pub force: Option<bool>,
    pub app_id: Option<String>,
    pub secret: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub code: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsChannelRequest {
    pub channel: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactConnectorChanged {
    pub at: i64,
    pub status: ConnectorStatus,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorLoginInput {
    pub id: String,
    pub force: Option<bool>,
    pub app_id: Option<String>,
    pub secret: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorVerifyInput {
    pub id: String,
    pub code: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorLogoutInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorChannelSetInput {
    pub id: String,
    pub channel: String,
}

crate::typescript::module! {
    "connector";
    types: [ConnectorID,
    ConnectorState,
    ConnectorStatus,
    ConnectorLogin,
    VerifyRequest,
    ConnectorsChannelRequest,
    FactConnectorChanged,
    ConnectorLoginInput,
    ConnectorVerifyInput,
    ConnectorLogoutInput,
    ConnectorChannelSetInput];
    aliases: [];
}
