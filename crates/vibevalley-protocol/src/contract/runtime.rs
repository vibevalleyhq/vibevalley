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
pub struct RuntimeQuota {
    pub left: Option<JsNumber>,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreset {
    pub id: String,
    pub label: String,
    pub blurb: String,
    pub look: Look,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum RuntimeCapability {
    #[serde(rename = "listModels")]
    ListModels,
    #[serde(rename = "accountUsage")]
    AccountUsage,
    #[serde(rename = "checkUpdate")]
    CheckUpdate,
    #[serde(rename = "upgrade")]
    Upgrade,
    #[serde(rename = "skills")]
    Skills,
    #[serde(rename = "mcpServers")]
    McpServers,
    #[serde(rename = "tools")]
    Tools,
}

impl RuntimeCapability {
    pub const ALL: [RuntimeCapability; 7] = [
        RuntimeCapability::ListModels,
        RuntimeCapability::AccountUsage,
        RuntimeCapability::CheckUpdate,
        RuntimeCapability::Upgrade,
        RuntimeCapability::Skills,
        RuntimeCapability::McpServers,
        RuntimeCapability::Tools,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeCapability::ListModels => "listModels",
            RuntimeCapability::AccountUsage => "accountUsage",
            RuntimeCapability::CheckUpdate => "checkUpdate",
            RuntimeCapability::Upgrade => "upgrade",
            RuntimeCapability::Skills => "skills",
            RuntimeCapability::McpServers => "mcpServers",
            RuntimeCapability::Tools => "tools",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSupport {
    pub steer: bool,
    pub refused: BTreeMap<String, String>,
    pub capabilities: Vec<RuntimeCapability>,
    pub in_process: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum Via {
    #[serde(rename = "executable")]
    Executable,
    #[serde(rename = "bundled")]
    Bundled,
}

impl Via {
    pub const ALL: [Via; 2] = [Via::Executable, Via::Bundled];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Executable => "executable",
            Via::Bundled => "bundled",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InstallationAvailable {
    pub via: Via,
    pub command: String,
    #[serialize_always]
    #[ts(optional = false)]
    pub version: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InstallationNotFound {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InstallationChecking {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InstallationUnsupported {
    pub reason: String,
}

/// Told apart by `status`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "status")]
pub enum Installation {
    #[serde(rename = "available")]
    Available(InstallationAvailable),
    #[serde(rename = "not_found")]
    NotFound(InstallationNotFound),
    #[serde(rename = "checking")]
    Checking(InstallationChecking),
    #[serde(rename = "unsupported")]
    Unsupported(InstallationUnsupported),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub effort_levels: Vec<String>,
    pub is_default: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: JsNumber,
    #[serialize_always]
    #[ts(optional = false)]
    pub resets_at: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub currency: String,
    pub amount: JsNumber,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageOk {
    #[serialize_always]
    #[ts(optional = false)]
    pub subscription: Option<String>,
    pub windows: Vec<UsageWindow>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageBalance {
    pub provider: String,
    pub available: bool,
    pub balances: Vec<Balance>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageLoginRequired {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageUnavailable {
    pub reason: String,
}

/// Told apart by `status`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "status")]
pub enum AccountUsage {
    #[serde(rename = "ok")]
    Ok(AccountUsageOk),
    #[serde(rename = "balance")]
    Balance(AccountUsageBalance),
    #[serde(rename = "login_required")]
    LoginRequired(AccountUsageLoginRequired),
    #[serde(rename = "unavailable")]
    Unavailable(AccountUsageUnavailable),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub name: String,
    pub description: String,
    pub source: String,
    pub enabled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub enabled: bool,
    pub bin_path: String,
    pub default_model: String,
    pub default_effort: String,
    pub env: BTreeMap<String, String>,
    pub daily_budget: Option<JsNumber>,
    pub max_working: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub preset: RuntimePreset,
    pub support: RuntimeSupport,
    pub installation: Installation,
    #[serialize_always]
    #[ts(optional = false)]
    pub models: Option<Vec<ModelEntry>>,
    #[serialize_always]
    #[ts(optional = false)]
    pub usage: Option<AccountUsage>,
    #[serialize_always]
    #[ts(optional = false)]
    pub skills: Option<Vec<InventoryEntry>>,
    #[serialize_always]
    #[ts(optional = false)]
    pub mcp_servers: Option<Vec<InventoryEntry>>,
    #[serialize_always]
    #[ts(optional = false)]
    pub tools: Option<Vec<InventoryEntry>>,
    pub settings: RuntimeSettings,
    pub spent_today: Option<JsNumber>,
    pub quota: Option<RuntimeQuota>,
    pub stop: String,
    pub checked_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRefreshInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingUpdateInput {
    pub id: String,
    pub enabled: bool,
    pub bin_path: String,
    pub default_model: String,
    pub default_effort: String,
    pub env: BTreeMap<String, String>,
    pub daily_budget: Option<JsNumber>,
    pub max_working: Option<i64>,
}

crate::typescript::module! {
    "runtime";
    types: [RuntimeQuota,
    RuntimePreset,
    RuntimeCapability,
    RuntimeSupport,
    Via,
    InstallationAvailable,
    InstallationNotFound,
    InstallationChecking,
    InstallationUnsupported,
    Installation,
    ModelEntry,
    UsageWindow,
    Balance,
    AccountUsageOk,
    AccountUsageBalance,
    AccountUsageLoginRequired,
    AccountUsageUnavailable,
    AccountUsage,
    InventoryEntry,
    RuntimeSettings,
    RuntimeInfo,
    RuntimeRefreshInput,
    RuntimeSettingUpdateInput];
    aliases: [];
}
