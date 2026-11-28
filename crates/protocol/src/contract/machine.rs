#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::Millis;

/// Machine id for the execution host co-located in the control plane process.
pub const LOCAL_MACHINE_ID: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum MachinePlatform {
    Macos,
    Linux,
    Container,
    Other,
}

impl MachinePlatform {
    pub const ALL: [MachinePlatform; 4] = [
        MachinePlatform::Macos,
        MachinePlatform::Linux,
        MachinePlatform::Container,
        MachinePlatform::Other,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MachinePlatform::Macos => "macos",
            MachinePlatform::Linux => "linux",
            MachinePlatform::Container => "container",
            MachinePlatform::Other => "other",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<MachinePlatform> {
        match s {
            "macos" => Some(MachinePlatform::Macos),
            "linux" => Some(MachinePlatform::Linux),
            "container" => Some(MachinePlatform::Container),
            "other" => Some(MachinePlatform::Other),
            _ => None,
        }
    }
}

impl FromStr for MachinePlatform {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        MachinePlatform::from_str(s).ok_or(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum MachineStatus {
    Online,
    Offline,
    Draining,
}

impl MachineStatus {
    pub const ALL: [MachineStatus; 3] = [MachineStatus::Online, MachineStatus::Offline, MachineStatus::Draining];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MachineStatus::Online => "online",
            MachineStatus::Offline => "offline",
            MachineStatus::Draining => "draining",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<MachineStatus> {
        match s {
            "online" => Some(MachineStatus::Online),
            "offline" => Some(MachineStatus::Offline),
            "draining" => Some(MachineStatus::Draining),
            _ => None,
        }
    }
}

impl FromStr for MachineStatus {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        MachineStatus::from_str(s).ok_or(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeRefParseError {
    InvalidFormat(String),
    EmptyMachineId(String),
    EmptyRuntimeId(String),
}

impl fmt::Display for RuntimeRefParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeRefParseError::InvalidFormat(raw) => write!(f, "runtime ref `{raw}` must be formatted as `<machine_id>/<runtime_id>`"),
            RuntimeRefParseError::EmptyMachineId(raw) => write!(f, "runtime ref `{raw}` has an empty machine_id"),
            RuntimeRefParseError::EmptyRuntimeId(raw) => write!(f, "runtime ref `{raw}` has an empty runtime_id"),
        }
    }
}

impl std::error::Error for RuntimeRefParseError {}

/// Composite routing target `<machine_id>/<runtime_id>`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRef {
    pub machine_id: String,
    pub runtime_id: String,
}

impl RuntimeRef {
    pub fn new(machine_id: impl Into<String>, runtime_id: impl Into<String>) -> Self {
        Self {
            machine_id: machine_id.into(),
            runtime_id: runtime_id.into(),
        }
    }

    pub fn local(runtime_id: impl Into<String>) -> Self {
        Self::new(LOCAL_MACHINE_ID, runtime_id)
    }

    pub fn parse(raw: &str) -> Result<Self, RuntimeRefParseError> {
        raw.parse()
    }

    pub fn is_local(&self) -> bool {
        self.machine_id == LOCAL_MACHINE_ID
    }
}

impl fmt::Display for RuntimeRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.machine_id, self.runtime_id)
    }
}

impl FromStr for RuntimeRef {
    type Err = RuntimeRefParseError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let Some((machine_id, runtime_id)) = raw.split_once('/') else {
            return Err(RuntimeRefParseError::InvalidFormat(raw.to_string()));
        };
        if runtime_id.contains('/') {
            return Err(RuntimeRefParseError::InvalidFormat(raw.to_string()));
        }
        let machine_id = machine_id.trim();
        let runtime_id = runtime_id.trim();
        if machine_id.is_empty() {
            return Err(RuntimeRefParseError::EmptyMachineId(raw.to_string()));
        }
        if runtime_id.is_empty() {
            return Err(RuntimeRefParseError::EmptyRuntimeId(raw.to_string()));
        }
        Ok(Self {
            machine_id: machine_id.to_string(),
            runtime_id: runtime_id.to_string(),
        })
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineRuntimeSummary {
    pub id: String,
    pub label: String,
    pub models: Vec<ModelEntry>,
    pub capabilities: Vec<RuntimeCapability>,
    pub available: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub id: String,
    pub name: String,
    pub platform: MachinePlatform,
    pub status: MachineStatus,
    pub here: bool,
    pub ephemeral: bool,
    pub joined_at: Millis,
    pub last_seen_at: Option<Millis>,
    pub runtimes: Vec<MachineRuntimeSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum MachineInputKind {
    Prompt,
    Steer,
    Queue,
    Abort,
    SetConfig,
    Dispose,
}

impl MachineInputKind {
    pub const ALL: [MachineInputKind; 6] = [
        MachineInputKind::Prompt,
        MachineInputKind::Steer,
        MachineInputKind::Queue,
        MachineInputKind::Abort,
        MachineInputKind::SetConfig,
        MachineInputKind::Dispose,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MachineInputKind::Prompt => "prompt",
            MachineInputKind::Steer => "steer",
            MachineInputKind::Queue => "queue",
            MachineInputKind::Abort => "abort",
            MachineInputKind::SetConfig => "setConfig",
            MachineInputKind::Dispose => "dispose",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<MachineInputKind> {
        match s {
            "prompt" => Some(MachineInputKind::Prompt),
            "steer" => Some(MachineInputKind::Steer),
            "queue" => Some(MachineInputKind::Queue),
            "abort" => Some(MachineInputKind::Abort),
            "setConfig" => Some(MachineInputKind::SetConfig),
            "dispose" => Some(MachineInputKind::Dispose),
            _ => None,
        }
    }
}

impl FromStr for MachineInputKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        MachineInputKind::from_str(s).ok_or(())
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineHello {
    pub machine_id: String,
    pub name: String,
    pub platform: MachinePlatform,
    pub ephemeral: bool,
    pub runtimes: Vec<MachineRuntimeSummary>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineHelloAck {
    pub machine_id: String,
    pub server_version: String,
    pub heartbeat_ms: u64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineInventory {
    pub machine_id: String,
    pub runtimes: Vec<MachineRuntimeSummary>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachinePing {
    pub ts: Millis,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachinePong {
    pub ts: Millis,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionOpen {
    pub request_id: String,
    pub session_id: String,
    pub runtime_id: String,
    pub repo_ref: Option<String>,
    pub workdir: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mcp_session_token: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionOpened {
    pub request_id: String,
    pub session_id: String,
    pub ok: bool,
    pub workdir: Option<String>,
    pub error: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionInput {
    pub request_id: String,
    pub session_id: String,
    pub input_id: String,
    pub kind: MachineInputKind,
    pub text: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionAck {
    pub request_id: String,
    pub session_id: String,
    pub input_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionRespond {
    pub request_id: String,
    pub session_id: String,
    pub target_id: String,
    pub allow: bool,
    pub answer: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionAttach {
    pub request_id: String,
    pub session_id: String,
    pub after_seq: u64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionEvent {
    pub session_id: String,
    pub seq: u64,
    pub at: Millis,
    pub event_json: String,
    pub terminal: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineSessionRecord {
    pub session_id: String,
    pub seq: u64,
    pub record_json: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineMcpRequest {
    pub request_id: String,
    pub session_id: String,
    pub session_token: String,
    pub method: String,
    pub path: String,
    pub body: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineMcpResponse {
    pub request_id: String,
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineAttachmentFetch {
    pub request_id: String,
    pub attachment_id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineAttachmentData {
    pub request_id: String,
    pub ok: bool,
    pub mime: Option<String>,
    pub bytes_b64: Option<String>,
    pub error: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MachineWireError {
    pub request_id: Option<String>,
    pub code: String,
    pub message: String,
}

/// Bidirectional WebSocket wire frame for `/api/v1/machine/ws`; told apart by `type`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum MachineWireFrame {
    #[serde(rename = "machine.hello")]
    MachineHello(MachineHello),
    #[serde(rename = "machine.helloAck")]
    MachineHelloAck(MachineHelloAck),
    #[serde(rename = "machine.inventory")]
    MachineInventory(MachineInventory),
    #[serde(rename = "machine.ping")]
    MachinePing(MachinePing),
    #[serde(rename = "machine.pong")]
    MachinePong(MachinePong),
    #[serde(rename = "session.open")]
    MachineSessionOpen(MachineSessionOpen),
    #[serde(rename = "session.opened")]
    MachineSessionOpened(MachineSessionOpened),
    #[serde(rename = "session.input")]
    MachineSessionInput(MachineSessionInput),
    #[serde(rename = "session.ack")]
    MachineSessionAck(MachineSessionAck),
    #[serde(rename = "session.respond")]
    MachineSessionRespond(MachineSessionRespond),
    #[serde(rename = "session.attach")]
    MachineSessionAttach(MachineSessionAttach),
    #[serde(rename = "session.event")]
    MachineSessionEvent(MachineSessionEvent),
    #[serde(rename = "session.record")]
    MachineSessionRecord(MachineSessionRecord),
    #[serde(rename = "mcp.request")]
    MachineMcpRequest(MachineMcpRequest),
    #[serde(rename = "mcp.response")]
    MachineMcpResponse(MachineMcpResponse),
    #[serde(rename = "attachment.fetch")]
    MachineAttachmentFetch(MachineAttachmentFetch),
    #[serde(rename = "attachment.data")]
    MachineAttachmentData(MachineAttachmentData),
    #[serde(rename = "error")]
    MachineWireError(MachineWireError),
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "machine";
    types: [
        MachinePlatform,
        MachineStatus,
        RuntimeRef,
        MachineRuntimeSummary,
        MachineInfo,
        MachineInputKind,
        MachineHello,
        MachineHelloAck,
        MachineInventory,
        MachinePing,
        MachinePong,
        MachineSessionOpen,
        MachineSessionOpened,
        MachineSessionInput,
        MachineSessionAck,
        MachineSessionRespond,
        MachineSessionAttach,
        MachineSessionEvent,
        MachineSessionRecord,
        MachineMcpRequest,
        MachineMcpResponse,
        MachineAttachmentFetch,
        MachineAttachmentData,
        MachineWireError,
        MachineWireFrame,
    ];
    aliases: [];
}
