use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use crate::Millis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum RemotePlatform {
    Ios,
    Android,
    Other,
}

impl RemotePlatform {
    pub const ALL: [RemotePlatform; 3] = [RemotePlatform::Ios, RemotePlatform::Android, RemotePlatform::Other];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            RemotePlatform::Ios => "ios",
            RemotePlatform::Android => "android",
            RemotePlatform::Other => "other",
        }
    }
}

/// Public metadata for a paired remote device; never exposes `token_hash`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceSummary {
    pub id: String,
    pub name: String,
    pub platform: RemotePlatform,
    pub scope: String,
    pub created_at: Millis,
    pub last_seen_at: Option<Millis>,
    pub revoked_at: Option<Millis>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub listening: bool,
    pub bind_addr: Option<String>,
    pub port: u16,
    pub tailscale_ip: Option<String>,
    pub tailscale_host: Option<String>,
    pub tailscale_online: bool,
    pub url: Option<String>,
    pub devices: Vec<RemoteDeviceSummary>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RemoteEnableRequest {
    pub bind_addr: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RemotePairCode {
    pub code: String,
    pub pair_url: String,
    pub url: String,
    pub expires_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RemotePairExchangeRequest {
    pub code: String,
    pub device_name: String,
    pub platform: RemotePlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RemotePairExchangeResult {
    pub device: RemoteDeviceSummary,
    pub token: String,
    pub server_name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceRevokeRequest {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RemoteWhoami {
    pub device: Option<RemoteDeviceSummary>,
    pub caller: String,
    pub server_name: String,
    pub version: String,
    pub channel: String,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "remote";
    types: [
        RemotePlatform,
        RemoteDeviceSummary,
        RemoteStatus,
        RemoteEnableRequest,
        RemotePairCode,
        RemotePairExchangeRequest,
        RemotePairExchangeResult,
        RemoteDeviceRevokeRequest,
        RemoteWhoami,
    ];
    aliases: [];
}
