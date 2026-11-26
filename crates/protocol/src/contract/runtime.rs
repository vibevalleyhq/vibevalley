#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeQuota {
    pub left: Option<JsNumber>,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreset {
    pub id: String,
    pub label: String,
    pub blurb: String,
    pub look: Look,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSupport {
    pub steer: bool,
    pub refused: BTreeMap<String, String>,
    pub capabilities: Vec<RuntimeCapability>,
    pub in_process: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
    pub in_session_config: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InstallationAvailable {
    pub via: Via,
    pub command: String,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub version: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InstallationNotFound {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InstallationChecking {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InstallationUnsupported {
    pub reason: String,
    pub sign_in_command: Option<String>,
}

/// Told apart by `status`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub effort_levels: Vec<String>,
    pub default_effort: Option<String>,
    pub is_default: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: JsNumber,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub resets_at: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub currency: String,
    pub amount: JsNumber,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageOk {
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub subscription: Option<String>,
    pub windows: Vec<UsageWindow>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageBalance {
    pub provider: String,
    pub available: bool,
    pub balances: Vec<Balance>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageLoginRequired {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageUnavailable {
    pub reason: String,
}

/// Told apart by `status`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub name: String,
    pub description: String,
    pub source: String,
    pub enabled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    /// Execution host id (`"local"` or omitted for the server's own machine).
    #[serde(default)]
    pub machine_id: Option<String>,
    pub preset: RuntimePreset,
    pub support: RuntimeSupport,
    pub installation: Installation,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub models: Option<Vec<ModelEntry>>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub usage: Option<AccountUsage>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub skills: Option<Vec<InventoryEntry>>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub mcp_servers: Option<Vec<InventoryEntry>>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub tools: Option<Vec<InventoryEntry>>,
    pub settings: RuntimeSettings,
    pub spent_today: Option<JsNumber>,
    pub quota: Option<RuntimeQuota>,
    pub stop: String,
    pub checked_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRefreshInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum McpHostId {
    #[serde(rename = "antigravity")]
    Antigravity,
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "cursor")]
    Cursor,
}

impl McpHostId {
    pub const ALL: [McpHostId; 4] = [McpHostId::Antigravity, McpHostId::Claude, McpHostId::Codex, McpHostId::Cursor];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            McpHostId::Antigravity => "antigravity",
            McpHostId::Claude => "claude",
            McpHostId::Codex => "codex",
            McpHostId::Cursor => "cursor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum McpTransportKind {
    #[serde(rename = "stdio")]
    Stdio,
    #[serde(rename = "streamableHttp")]
    StreamableHttp,
}

impl McpTransportKind {
    pub const ALL: [McpTransportKind; 2] = [McpTransportKind::Stdio, McpTransportKind::StreamableHttp];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            McpTransportKind::Stdio => "stdio",
            McpTransportKind::StreamableHttp => "streamableHttp",
        }
    }
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpInstallStatus {
    NotInstalled,
    Installed { transport: McpTransportKind },
    Outdated { current: McpTransportKind, reason: String },
    Unsupported { reason: String },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpHostInfo {
    pub id: McpHostId,
    pub label: String,
    pub installed: bool,
    pub config_path: Option<String>,
    pub status: McpInstallStatus,
    pub supports_stdio: bool,
    pub supports_http: bool,
    pub stdio_snippet: String,
    pub http_snippet: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpListInput {
    pub transport: Option<McpTransportKind>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpListResult {
    pub server_name: String,
    pub stdio_command: String,
    pub stdio_args: Vec<String>,
    pub http_url: Option<String>,
    pub hosts: Vec<McpHostInfo>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpInstallInput {
    pub host: McpHostId,
    pub transport: Option<McpTransportKind>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpUninstallInput {
    pub host: McpHostId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub host: McpHostId,
    pub name: String,
    pub transport: McpTransportKind,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub enabled: bool,
    pub config_path: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerListInput {
    pub host: McpHostId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerListResult {
    pub host: McpHostId,
    pub config_path: Option<String>,
    pub servers: Vec<McpServerEntry>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerSaveInput {
    pub host: McpHostId,
    pub previous_name: Option<String>,
    pub name: String,
    pub transport: McpTransportKind,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub enabled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerToggleInput {
    pub host: McpHostId,
    pub name: String,
    pub enabled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct McpServerRemoveInput {
    pub host: McpHostId,
    pub name: String,
}

#[cfg(feature = "ts-gen")]
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
    RuntimeSettingUpdateInput,
    McpHostId,
    McpTransportKind,
    McpInstallStatus,
    McpHostInfo,
    McpListInput,
    McpListResult,
    McpInstallInput,
    McpUninstallInput,
    McpServerEntry,
    McpServerListInput,
    McpServerListResult,
    McpServerSaveInput,
    McpServerToggleInput,
    McpServerRemoveInput];
    aliases: [];
}
