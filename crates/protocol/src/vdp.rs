//! VibeValley DevTools Protocol (VDP) — typed wire contract for live remote inspection
//! and automation over loopback HTTP + WebSocket JSON-RPC 2.0.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// Current VDP wire protocol version written to `$VIBEVALLEY_HOME/debug.json` and `/json/version`.
pub const VDP_PROTOCOL_VERSION: &str = "1";

/// Loopback discovery record written atomically with `0600` permissions to `$VIBEVALLEY_HOME/debug.json`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpEndpointInfo {
    pub protocol_version: String,
    pub pid: u32,
    pub channel: String,
    pub app_version: String,
    pub home: String,
    pub port: u16,
    pub http_url: String,
    pub ws_url: String,
    pub token: String,
    pub started_at: i64,
}

impl VdpEndpointInfo {
    /// Safe HTTP `/json/version` projection that deliberately excludes `token`.
    pub fn version_info(&self) -> VdpVersionInfo {
        VdpVersionInfo {
            protocol_version: self.protocol_version.clone(),
            pid: self.pid,
            channel: self.channel.clone(),
            app_version: self.app_version.clone(),
            home: self.home.clone(),
            port: self.port,
            http_url: self.http_url.clone(),
            ws_url: self.ws_url.clone(),
            started_at: self.started_at,
        }
    }

    /// WebSocket URL with the bearer token encoded as the `token` query parameter.
    pub fn ws_url_with_token(&self) -> String {
        if self.ws_url.contains('?') {
            format!("{}&token={}", self.ws_url, self.token)
        } else {
            format!("{}?token={}", self.ws_url, self.token)
        }
    }
}

impl fmt::Debug for VdpEndpointInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VdpEndpointInfo")
            .field("protocol_version", &self.protocol_version)
            .field("pid", &self.pid)
            .field("channel", &self.channel)
            .field("app_version", &self.app_version)
            .field("home", &self.home)
            .field("port", &self.port)
            .field("http_url", &self.http_url)
            .field("ws_url", &self.ws_url)
            .field("token", &"<redacted>")
            .field("started_at", &self.started_at)
            .finish()
    }
}

/// Public metadata returned by `GET /json/version`; excludes `token` by type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpVersionInfo {
    pub protocol_version: String,
    pub pid: u32,
    pub channel: String,
    pub app_version: String,
    pub home: String,
    pub port: u16,
    pub http_url: String,
    pub ws_url: String,
    pub started_at: i64,
}

/// Kind of inspectable target exposed by `GET /json/list` and `Target.list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VdpTargetKind {
    Shell,
    View,
    Diorama,
    Webview,
    Server,
}

impl VdpTargetKind {
    pub const ALL: [VdpTargetKind; 5] = [
        VdpTargetKind::Shell,
        VdpTargetKind::View,
        VdpTargetKind::Diorama,
        VdpTargetKind::Webview,
        VdpTargetKind::Server,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            VdpTargetKind::Shell => "shell",
            VdpTargetKind::View => "view",
            VdpTargetKind::Diorama => "diorama",
            VdpTargetKind::Webview => "webview",
            VdpTargetKind::Server => "server",
        }
    }
}

/// One inspectable target inside a running VibeValley instance.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpTarget {
    pub id: String,
    pub kind: VdpTargetKind,
    pub title: String,
    #[serde(default)]
    pub url: Option<String>,
    pub attached: bool,
}

/// Structured JSON-RPC 2.0 error returned in a [`VdpResponse`].
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

impl VdpError {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const UNAVAILABLE: i32 = -32000;
    pub const TIMEOUT: i32 = -32001;
    pub const UNAUTHORIZED: i32 = -32002;

    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(Self::PARSE_ERROR, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_REQUEST, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(Self::METHOD_NOT_FOUND, format!("unknown VDP method: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Self::INTERNAL_ERROR, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(Self::UNAVAILABLE, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(Self::TIMEOUT, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(Self::UNAUTHORIZED, message)
    }
}

impl fmt::Display for VdpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VDP error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for VdpError {}

/// Client-to-host JSON-RPC 2.0 request frame.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpRequest {
    pub id: u64,
    pub method: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub params: serde_json::Value,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl VdpRequest {
    pub fn new(id: u64, method: impl Into<String>, params: serde_json::Value, session_id: Option<String>) -> Self {
        Self {
            id,
            method: method.into(),
            params,
            session_id,
        }
    }

    pub fn from_command(id: u64, command: &VdpCommand, session_id: Option<String>) -> Self {
        Self {
            id,
            method: command.method().to_owned(),
            params: command.to_params(),
            session_id,
        }
    }

    pub fn decode_command(&self) -> Result<VdpCommand, VdpError> {
        VdpCommand::from_wire(&self.method, self.params.clone())
    }
}

/// Host-to-client JSON-RPC 2.0 response frame.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpResponse {
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<VdpError>,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl VdpResponse {
    pub fn ok(id: u64, result: serde_json::Value, session_id: Option<String>) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
            session_id,
        }
    }

    pub fn err(id: u64, error: VdpError, session_id: Option<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
            session_id,
        }
    }

    pub fn into_result(self) -> Result<serde_json::Value, VdpError> {
        if let Some(error) = self.error {
            Err(error)
        } else {
            Ok(self.result.unwrap_or(serde_json::Value::Null))
        }
    }
}

/// Host-to-client unsolicited notification frame.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpEvent {
    pub method: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub params: serde_json::Value,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl VdpEvent {
    pub fn from_notification(notification: &VdpNotification, session_id: Option<String>) -> Self {
        Self {
            method: notification.method().to_owned(),
            params: notification.to_params(),
            session_id,
        }
    }

    pub fn decode_notification(&self) -> Result<VdpNotification, VdpError> {
        VdpNotification::from_wire(&self.method, self.params.clone())
    }
}

/// Incoming host-to-client WebSocket text frame: either a response (has `id`) or an event (has `method`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VdpWireMessage {
    Response(VdpResponse),
    Event(VdpEvent),
}

// ---------------------------------------------------------------------------
// Command parameters & structured results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpAckResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpTargetListResult {
    pub targets: Vec<VdpTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpTargetAttachParams {
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpTargetAttachResult {
    pub session_id: String,
    pub target: VdpTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpTargetDetachParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellNavigateParams {
    pub route: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellOpenPaneParams {
    pub kind: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellClosePaneParams {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub tab_id: Option<u64>,
    #[serde(default)]
    pub title_contains: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellResizeParams {
    pub width: f32,
    pub height: f32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellSetThemeParams {
    #[serde(default)]
    pub dark: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellGetTerminalGridParams {
    #[serde(default)]
    pub terminal_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellSendTerminalInputParams {
    pub text: String,
    #[serde(default)]
    pub enter: Option<bool>,
}

impl VdpShellSendTerminalInputParams {
    pub fn should_enter(&self) -> bool {
        self.enter.unwrap_or(true)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellDispatchActionParams {
    pub action: crate::HostAction,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellSetDioramaClockParams {
    #[serde(default)]
    pub seconds: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpShellRunCommandParams {
    pub command: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VdpScreenshotTarget {
    #[default]
    Shell,
    Webview,
}

impl VdpScreenshotTarget {
    pub const ALL: [VdpScreenshotTarget; 2] = [VdpScreenshotTarget::Shell, VdpScreenshotTarget::Webview];

    pub const fn as_str(self) -> &'static str {
        match self {
            VdpScreenshotTarget::Shell => "shell",
            VdpScreenshotTarget::Webview => "webview",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpCaptureScreenshotParams {
    #[serde(default)]
    pub target: Option<VdpScreenshotTarget>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpScreenshotResult {
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpPageMetrics {
    pub width: f32,
    pub height: f32,
    pub scale_factor: f32,
    pub theme_dark: bool,
    #[serde(default)]
    pub last_frame_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpDispatchKeyParams {
    pub keys: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpTypeTextParams {
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VdpMouseEventKind {
    Down,
    Up,
    Move,
    Click,
    Drag,
}

impl VdpMouseEventKind {
    pub const ALL: [VdpMouseEventKind; 5] = [
        VdpMouseEventKind::Down,
        VdpMouseEventKind::Up,
        VdpMouseEventKind::Move,
        VdpMouseEventKind::Click,
        VdpMouseEventKind::Drag,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            VdpMouseEventKind::Down => "down",
            VdpMouseEventKind::Up => "up",
            VdpMouseEventKind::Move => "move",
            VdpMouseEventKind::Click => "click",
            VdpMouseEventKind::Drag => "drag",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VdpMouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

impl VdpMouseButton {
    pub const ALL: [VdpMouseButton; 3] = [VdpMouseButton::Left, VdpMouseButton::Right, VdpMouseButton::Middle];

    pub const fn as_str(self) -> &'static str {
        match self {
            VdpMouseButton::Left => "left",
            VdpMouseButton::Right => "right",
            VdpMouseButton::Middle => "middle",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpDispatchMouseParams {
    pub kind: VdpMouseEventKind,
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub button: Option<VdpMouseButton>,
    #[serde(default)]
    pub end_x: Option<f32>,
    #[serde(default)]
    pub end_y: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpInputResult {
    pub handled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiGetTreeParams {
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub max_depth: Option<u32>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiQueryParams {
    #[serde(default)]
    pub test_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub view: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiPressParams {
    pub test_id: String,
    #[serde(default)]
    pub view: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiWaitForParams {
    #[serde(default)]
    pub test_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiNode {
    #[serde(default)]
    pub test_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub bounds: Option<VdpUiBounds>,
    #[serde(default)]
    pub pressable: Option<bool>,
    #[serde(default)]
    pub children: Option<Vec<VdpUiNode>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiInspectAtParams {
    pub x: f32,
    pub y: f32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiInspectAtResult {
    pub hit: bool,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub test_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub bounds: Option<VdpUiBounds>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiHighlightParams {
    #[serde(default)]
    pub test_id: Option<String>,
    #[serde(default)]
    pub bounds: Option<VdpUiBounds>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpUiInspectorModeParams {
    pub enabled: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiTreeResult {
    pub view: String,
    #[serde(default)]
    pub route: Option<String>,
    pub nodes: Vec<VdpUiNode>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiQueryResult {
    pub view: String,
    pub nodes: Vec<VdpUiNode>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiPressResult {
    pub view: String,
    pub test_id: String,
    pub pressed: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiWaitForResult {
    pub view: String,
    pub matched: bool,
    #[serde(default)]
    pub node: Option<VdpUiNode>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpServerSliceParams {
    pub name: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpServerInvokeParams {
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VdpLogGetEntriesParams {
    #[serde(default)]
    pub since_id: Option<u64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpBufferedEvent {
    pub id: u64,
    pub event: VdpEvent,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpLogEntriesResult {
    pub entries: Vec<VdpBufferedEvent>,
    pub latest_id: u64,
}

// ---------------------------------------------------------------------------
// Typed VdpCommand enum (decoded once at the boundary)
// ---------------------------------------------------------------------------

/// Every VDP JSON-RPC command, decoded once at the wire boundary into strongly typed payloads.
#[derive(Debug, Clone, PartialEq)]
pub enum VdpCommand {
    TargetList,
    TargetAttach(VdpTargetAttachParams),
    TargetDetach(VdpTargetDetachParams),
    ShellGetState,
    ShellNavigate(VdpShellNavigateParams),
    ShellOpenPane(VdpShellOpenPaneParams),
    ShellClosePane(VdpShellClosePaneParams),
    ShellResize(VdpShellResizeParams),
    ShellSetTheme(VdpShellSetThemeParams),
    ShellGetTerminalGrid(VdpShellGetTerminalGridParams),
    ShellSendTerminalInput(VdpShellSendTerminalInputParams),
    ShellRunCommand(VdpShellRunCommandParams),
    ShellDispatchAction(VdpShellDispatchActionParams),
    ShellSave,
    ShellQuit,
    ShellGetUpdateState,
    ShellSetDioramaClock(VdpShellSetDioramaClockParams),
    PageCaptureScreenshot(VdpCaptureScreenshotParams),
    PageDraw,
    PageGetMetrics,
    InputDispatchKey(VdpDispatchKeyParams),
    InputTypeText(VdpTypeTextParams),
    InputDispatchMouse(VdpDispatchMouseParams),
    UiGetTree(VdpUiGetTreeParams),
    UiQuery(VdpUiQueryParams),
    UiPress(VdpUiPressParams),
    UiWaitFor(VdpUiWaitForParams),
    UiInspectAt(VdpUiInspectAtParams),
    UiHighlight(VdpUiHighlightParams),
    UiSetInspectorMode(VdpUiInspectorModeParams),
    ServerSlice(VdpServerSliceParams),
    ServerInvoke(VdpServerInvokeParams),
    LogEnable,
    LogDisable,
    LogGetEntries(VdpLogGetEntriesParams),
}

impl VdpCommand {
    pub const METHOD_NAMES: &'static [&'static str] = &[
        "Target.list",
        "Target.attach",
        "Target.detach",
        "Shell.getState",
        "Shell.navigate",
        "Shell.openPane",
        "Shell.closePane",
        "Shell.resize",
        "Shell.setTheme",
        "Shell.getTerminalGrid",
        "Shell.sendTerminalInput",
        "Shell.runCommand",
        "Shell.dispatchAction",
        "Shell.save",
        "Shell.quit",
        "Shell.getUpdateState",
        "Shell.setDioramaClock",
        "Page.captureScreenshot",
        "Page.draw",
        "Page.getMetrics",
        "Input.dispatchKey",
        "Input.typeText",
        "Input.dispatchMouse",
        "UI.getTree",
        "UI.query",
        "UI.press",
        "UI.waitFor",
        "UI.inspectAt",
        "UI.highlight",
        "UI.setInspectorMode",
        "Server.slice",
        "Server.invoke",
        "Log.enable",
        "Log.disable",
        "Log.getEntries",
    ];

    pub const fn method(&self) -> &'static str {
        match self {
            VdpCommand::TargetList => "Target.list",
            VdpCommand::TargetAttach(_) => "Target.attach",
            VdpCommand::TargetDetach(_) => "Target.detach",
            VdpCommand::ShellGetState => "Shell.getState",
            VdpCommand::ShellNavigate(_) => "Shell.navigate",
            VdpCommand::ShellOpenPane(_) => "Shell.openPane",
            VdpCommand::ShellClosePane(_) => "Shell.closePane",
            VdpCommand::ShellResize(_) => "Shell.resize",
            VdpCommand::ShellSetTheme(_) => "Shell.setTheme",
            VdpCommand::ShellGetTerminalGrid(_) => "Shell.getTerminalGrid",
            VdpCommand::ShellSendTerminalInput(_) => "Shell.sendTerminalInput",
            VdpCommand::ShellRunCommand(_) => "Shell.runCommand",
            VdpCommand::ShellDispatchAction(_) => "Shell.dispatchAction",
            VdpCommand::ShellSave => "Shell.save",
            VdpCommand::ShellQuit => "Shell.quit",
            VdpCommand::ShellGetUpdateState => "Shell.getUpdateState",
            VdpCommand::ShellSetDioramaClock(_) => "Shell.setDioramaClock",
            VdpCommand::PageCaptureScreenshot(_) => "Page.captureScreenshot",
            VdpCommand::PageDraw => "Page.draw",
            VdpCommand::PageGetMetrics => "Page.getMetrics",
            VdpCommand::InputDispatchKey(_) => "Input.dispatchKey",
            VdpCommand::InputTypeText(_) => "Input.typeText",
            VdpCommand::InputDispatchMouse(_) => "Input.dispatchMouse",
            VdpCommand::UiGetTree(_) => "UI.getTree",
            VdpCommand::UiQuery(_) => "UI.query",
            VdpCommand::UiPress(_) => "UI.press",
            VdpCommand::UiWaitFor(_) => "UI.waitFor",
            VdpCommand::UiInspectAt(_) => "UI.inspectAt",
            VdpCommand::UiHighlight(_) => "UI.highlight",
            VdpCommand::UiSetInspectorMode(_) => "UI.setInspectorMode",
            VdpCommand::ServerSlice(_) => "Server.slice",
            VdpCommand::ServerInvoke(_) => "Server.invoke",
            VdpCommand::LogEnable => "Log.enable",
            VdpCommand::LogDisable => "Log.disable",
            VdpCommand::LogGetEntries(_) => "Log.getEntries",
        }
    }

    pub fn to_params(&self) -> serde_json::Value {
        match self {
            VdpCommand::TargetList
            | VdpCommand::ShellGetState
            | VdpCommand::ShellSave
            | VdpCommand::ShellQuit
            | VdpCommand::ShellGetUpdateState
            | VdpCommand::PageDraw
            | VdpCommand::PageGetMetrics
            | VdpCommand::LogEnable
            | VdpCommand::LogDisable => serde_json::json!({}),
            VdpCommand::TargetAttach(p) => serde_json::to_value(p).expect("serialize VdpTargetAttachParams"),
            VdpCommand::TargetDetach(p) => serde_json::to_value(p).expect("serialize VdpTargetDetachParams"),
            VdpCommand::ShellNavigate(p) => serde_json::to_value(p).expect("serialize VdpShellNavigateParams"),
            VdpCommand::ShellOpenPane(p) => serde_json::to_value(p).expect("serialize VdpShellOpenPaneParams"),
            VdpCommand::ShellClosePane(p) => serde_json::to_value(p).expect("serialize VdpShellClosePaneParams"),
            VdpCommand::ShellResize(p) => serde_json::to_value(p).expect("serialize VdpShellResizeParams"),
            VdpCommand::ShellSetTheme(p) => serde_json::to_value(p).expect("serialize VdpShellSetThemeParams"),
            VdpCommand::ShellGetTerminalGrid(p) => serde_json::to_value(p).expect("serialize VdpShellGetTerminalGridParams"),
            VdpCommand::ShellSendTerminalInput(p) => serde_json::to_value(p).expect("serialize VdpShellSendTerminalInputParams"),
            VdpCommand::ShellRunCommand(p) => serde_json::to_value(p).expect("serialize VdpShellRunCommandParams"),
            VdpCommand::ShellDispatchAction(p) => serde_json::to_value(p).expect("serialize VdpShellDispatchActionParams"),
            VdpCommand::ShellSetDioramaClock(p) => serde_json::to_value(p).expect("serialize VdpShellSetDioramaClockParams"),
            VdpCommand::PageCaptureScreenshot(p) => serde_json::to_value(p).expect("serialize VdpCaptureScreenshotParams"),
            VdpCommand::InputDispatchKey(p) => serde_json::to_value(p).expect("serialize VdpDispatchKeyParams"),
            VdpCommand::InputTypeText(p) => serde_json::to_value(p).expect("serialize VdpTypeTextParams"),
            VdpCommand::InputDispatchMouse(p) => serde_json::to_value(p).expect("serialize VdpDispatchMouseParams"),
            VdpCommand::UiGetTree(p) => serde_json::to_value(p).expect("serialize VdpUiGetTreeParams"),
            VdpCommand::UiQuery(p) => serde_json::to_value(p).expect("serialize VdpUiQueryParams"),
            VdpCommand::UiPress(p) => serde_json::to_value(p).expect("serialize VdpUiPressParams"),
            VdpCommand::UiWaitFor(p) => serde_json::to_value(p).expect("serialize VdpUiWaitForParams"),
            VdpCommand::UiInspectAt(p) => serde_json::to_value(p).expect("serialize VdpUiInspectAtParams"),
            VdpCommand::UiHighlight(p) => serde_json::to_value(p).expect("serialize VdpUiHighlightParams"),
            VdpCommand::UiSetInspectorMode(p) => serde_json::to_value(p).expect("serialize VdpUiInspectorModeParams"),
            VdpCommand::ServerSlice(p) => serde_json::to_value(p).expect("serialize VdpServerSliceParams"),
            VdpCommand::ServerInvoke(p) => serde_json::to_value(p).expect("serialize VdpServerInvokeParams"),
            VdpCommand::LogGetEntries(p) => serde_json::to_value(p).expect("serialize VdpLogGetEntriesParams"),
        }
    }

    pub fn from_wire(method: &str, params: serde_json::Value) -> Result<Self, VdpError> {
        fn decode<T: serde::de::DeserializeOwned>(method: &str, v: serde_json::Value) -> Result<T, VdpError> {
            serde_json::from_value(v).map_err(|e| VdpError::invalid_params(format!("{method}: {e}")))
        }
        let expect_empty = |v: &serde_json::Value| match v {
            serde_json::Value::Null => Ok(()),
            serde_json::Value::Object(map) if map.is_empty() => Ok(()),
            _ => Err(VdpError::invalid_params(format!("{method} takes no parameters"))),
        };
        let optional_object = |v: serde_json::Value| {
            if v.is_null() { serde_json::Value::Object(serde_json::Map::new()) } else { v }
        };

        match method {
            "Target.list" => expect_empty(&params).map(|()| VdpCommand::TargetList),
            "Target.attach" => decode(method, params).map(VdpCommand::TargetAttach),
            "Target.detach" => decode(method, params).map(VdpCommand::TargetDetach),
            "Shell.getState" => expect_empty(&params).map(|()| VdpCommand::ShellGetState),
            "Shell.navigate" => decode(method, params).map(VdpCommand::ShellNavigate),
            "Shell.openPane" => decode(method, params).map(VdpCommand::ShellOpenPane),
            "Shell.closePane" => decode(method, optional_object(params)).map(VdpCommand::ShellClosePane),
            "Shell.resize" => decode(method, params).map(VdpCommand::ShellResize),
            "Shell.setTheme" => decode(method, optional_object(params)).map(VdpCommand::ShellSetTheme),
            "Shell.getTerminalGrid" => decode(method, optional_object(params)).map(VdpCommand::ShellGetTerminalGrid),
            "Shell.sendTerminalInput" => decode(method, params).map(VdpCommand::ShellSendTerminalInput),
            "Shell.runCommand" => decode(method, params).map(VdpCommand::ShellRunCommand),
            "Shell.dispatchAction" => decode(method, params).map(VdpCommand::ShellDispatchAction),
            "Shell.save" => expect_empty(&params).map(|()| VdpCommand::ShellSave),
            "Shell.quit" => expect_empty(&params).map(|()| VdpCommand::ShellQuit),
            "Shell.getUpdateState" => expect_empty(&params).map(|()| VdpCommand::ShellGetUpdateState),
            "Shell.setDioramaClock" => decode(method, optional_object(params)).map(VdpCommand::ShellSetDioramaClock),
            "Page.captureScreenshot" => decode(method, optional_object(params)).map(VdpCommand::PageCaptureScreenshot),
            "Page.draw" => expect_empty(&params).map(|()| VdpCommand::PageDraw),
            "Page.getMetrics" => expect_empty(&params).map(|()| VdpCommand::PageGetMetrics),
            "Input.dispatchKey" => decode(method, params).map(VdpCommand::InputDispatchKey),
            "Input.typeText" => decode(method, params).map(VdpCommand::InputTypeText),
            "Input.dispatchMouse" => decode(method, params).map(VdpCommand::InputDispatchMouse),
            "UI.getTree" => decode(method, optional_object(params)).map(VdpCommand::UiGetTree),
            "UI.query" => decode(method, optional_object(params)).map(VdpCommand::UiQuery),
            "UI.press" => decode(method, params).map(VdpCommand::UiPress),
            "UI.waitFor" => decode(method, optional_object(params)).map(VdpCommand::UiWaitFor),
            "UI.inspectAt" => decode(method, params).map(VdpCommand::UiInspectAt),
            "UI.highlight" => decode(method, optional_object(params)).map(VdpCommand::UiHighlight),
            "UI.setInspectorMode" => decode(method, params).map(VdpCommand::UiSetInspectorMode),
            "Server.slice" => decode(method, params).map(VdpCommand::ServerSlice),
            "Server.invoke" => decode(method, params).map(VdpCommand::ServerInvoke),
            "Log.enable" => expect_empty(&params).map(|()| VdpCommand::LogEnable),
            "Log.disable" => expect_empty(&params).map(|()| VdpCommand::LogDisable),
            "Log.getEntries" => decode(method, optional_object(params)).map(VdpCommand::LogGetEntries),
            other => Err(VdpError::method_not_found(other)),
        }
    }
}

// ---------------------------------------------------------------------------
// Typed VdpNotification enum (host-pushed events)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VdpLogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl VdpLogLevel {
    pub const ALL: [VdpLogLevel; 5] = [VdpLogLevel::Trace, VdpLogLevel::Debug, VdpLogLevel::Info, VdpLogLevel::Warn, VdpLogLevel::Error];

    pub const fn as_str(self) -> &'static str {
        match self {
            VdpLogLevel::Trace => "trace",
            VdpLogLevel::Debug => "debug",
            VdpLogLevel::Info => "info",
            VdpLogLevel::Warn => "warn",
            VdpLogLevel::Error => "error",
        }
    }

    /// Maps JS console levels (`log`/`info`/`warn`/`error`/`debug`/`trace`) onto [`VdpLogLevel`].
    pub fn from_console_level(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "trace" => VdpLogLevel::Trace,
            "debug" => VdpLogLevel::Debug,
            "warn" | "warning" => VdpLogLevel::Warn,
            "error" | "err" => VdpLogLevel::Error,
            _ => VdpLogLevel::Info,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpTargetEvent {
    pub target: VdpTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpTargetDestroyedEvent {
    pub target_id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpLogEntry {
    pub level: VdpLogLevel,
    pub source: String,
    pub message: String,
    pub timestamp: i64,
    #[serde(default)]
    pub fields: Option<serde_json::Value>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpPageFrameEvent {
    pub frame_ms: f64,
    pub timestamp: i64,
    #[serde(default)]
    pub width: Option<f32>,
    #[serde(default)]
    pub height: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpUiConsoleEvent {
    pub view: String,
    pub level: VdpLogLevel,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdpServerEventPayload {
    pub topic: String,
    pub payload: serde_json::Value,
    pub timestamp: i64,
}

/// Every unsolicited notification pushed by a VDP host over WebSocket (and buffered for `Log.getEntries`).
#[derive(Debug, Clone, PartialEq)]
pub enum VdpNotification {
    TargetCreated(VdpTargetEvent),
    TargetDestroyed(VdpTargetDestroyedEvent),
    LogEntry(VdpLogEntry),
    PageFrame(VdpPageFrameEvent),
    UiConsole(VdpUiConsoleEvent),
    ServerEvent(VdpServerEventPayload),
}

impl VdpNotification {
    pub const METHOD_NAMES: &'static [&'static str] = &["Target.created", "Target.destroyed", "Log.entry", "Page.frame", "UI.console", "Server.event"];

    pub const fn method(&self) -> &'static str {
        match self {
            VdpNotification::TargetCreated(_) => "Target.created",
            VdpNotification::TargetDestroyed(_) => "Target.destroyed",
            VdpNotification::LogEntry(_) => "Log.entry",
            VdpNotification::PageFrame(_) => "Page.frame",
            VdpNotification::UiConsole(_) => "UI.console",
            VdpNotification::ServerEvent(_) => "Server.event",
        }
    }

    pub fn to_params(&self) -> serde_json::Value {
        match self {
            VdpNotification::TargetCreated(p) => serde_json::to_value(p).expect("serialize VdpTargetEvent"),
            VdpNotification::TargetDestroyed(p) => serde_json::to_value(p).expect("serialize VdpTargetDestroyedEvent"),
            VdpNotification::LogEntry(p) => serde_json::to_value(p).expect("serialize VdpLogEntry"),
            VdpNotification::PageFrame(p) => serde_json::to_value(p).expect("serialize VdpPageFrameEvent"),
            VdpNotification::UiConsole(p) => serde_json::to_value(p).expect("serialize VdpUiConsoleEvent"),
            VdpNotification::ServerEvent(p) => serde_json::to_value(p).expect("serialize VdpServerEventPayload"),
        }
    }

    pub fn from_wire(method: &str, params: serde_json::Value) -> Result<Self, VdpError> {
        fn decode<T: serde::de::DeserializeOwned>(method: &str, v: serde_json::Value) -> Result<T, VdpError> {
            serde_json::from_value(v).map_err(|e| VdpError::invalid_params(format!("{method}: {e}")))
        }
        match method {
            "Target.created" => decode(method, params).map(VdpNotification::TargetCreated),
            "Target.destroyed" => decode(method, params).map(VdpNotification::TargetDestroyed),
            "Log.entry" => decode(method, params).map(VdpNotification::LogEntry),
            "Page.frame" => decode(method, params).map(VdpNotification::PageFrame),
            "UI.console" => decode(method, params).map(VdpNotification::UiConsole),
            "Server.event" => decode(method, params).map(VdpNotification::ServerEvent),
            other => Err(VdpError::method_not_found(other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    #[test]
    fn endpoint_info_redacts_token_in_debug_and_excludes_it_from_version_info() {
        let info = VdpEndpointInfo {
            protocol_version: VDP_PROTOCOL_VERSION.into(),
            pid: 4242,
            channel: "dev".into(),
            app_version: "0.1.0-alpha.4".into(),
            home: "/tmp/vv-dev".into(),
            port: 9222,
            http_url: "http://127.0.0.1:9222".into(),
            ws_url: "ws://127.0.0.1:9222/devtools".into(),
            token: "super-secret-hex-token".into(),
            started_at: 1_700_000_000_000,
        };

        let debug = format!("{info:?}");
        assert!(!debug.contains("super-secret-hex-token"));
        assert!(debug.contains("<redacted>"));

        let version = info.version_info();
        let version_json = serde_json::to_value(&version).unwrap();
        assert!(version_json.get("token").is_none());
        assert_eq!(version_json["protocolVersion"], "1");
        assert_eq!(version_json["pid"], 4242);
        assert_eq!(version_json["wsUrl"], "ws://127.0.0.1:9222/devtools");

        assert_eq!(info.ws_url_with_token(), "ws://127.0.0.1:9222/devtools?token=super-secret-hex-token");
        let round_trip: VdpEndpointInfo = serde_json::from_value(serde_json::to_value(&info).unwrap()).unwrap();
        assert_eq!(round_trip, info);
    }

    #[test]
    fn every_vdp_command_round_trips_through_wire_envelope() {
        let cases: Vec<(VdpCommand, serde_json::Value)> = vec![
            (VdpCommand::TargetList, json!({})),
            (
                VdpCommand::TargetAttach(VdpTargetAttachParams { target_id: "shell".into() }),
                json!({ "targetId": "shell" }),
            ),
            (
                VdpCommand::TargetDetach(VdpTargetDetachParams { session_id: "sess-1".into() }),
                json!({ "sessionId": "sess-1" }),
            ),
            (VdpCommand::ShellGetState, json!({})),
            (
                VdpCommand::ShellNavigate(VdpShellNavigateParams { route: "/library".into() }),
                json!({ "route": "/library" }),
            ),
            (
                VdpCommand::ShellOpenPane(VdpShellOpenPaneParams {
                    kind: "hosted".into(),
                    params: Some(json!({ "module": "devtools" })),
                }),
                json!({ "kind": "hosted", "params": { "module": "devtools" } }),
            ),
            (
                VdpCommand::ShellClosePane(VdpShellClosePaneParams {
                    kind: Some("terminal".into()),
                    tab_id: Some(7),
                    title_contains: Some("zsh".into()),
                }),
                json!({ "kind": "terminal", "tabId": 7, "titleContains": "zsh" }),
            ),
            (
                VdpCommand::ShellResize(VdpShellResizeParams { width: 1440.0, height: 900.0 }),
                json!({ "width": 1440.0, "height": 900.0 }),
            ),
            (VdpCommand::ShellSetTheme(VdpShellSetThemeParams { dark: Some(true) }), json!({ "dark": true })),
            (
                VdpCommand::ShellGetTerminalGrid(VdpShellGetTerminalGridParams {
                    terminal_id: Some("t1".into()),
                }),
                json!({ "terminalId": "t1" }),
            ),
            (
                VdpCommand::ShellSendTerminalInput(VdpShellSendTerminalInputParams {
                    text: "ls -la".into(),
                    enter: Some(false),
                }),
                json!({ "text": "ls -la", "enter": false }),
            ),
            (
                VdpCommand::ShellRunCommand(VdpShellRunCommandParams {
                    command: "palette:commands".into(),
                }),
                json!({ "command": "palette:commands" }),
            ),
            (
                VdpCommand::ShellDispatchAction(VdpShellDispatchActionParams {
                    action: crate::HostAction::ActivatePath { path: "/tmp/repo".into() },
                }),
                json!({ "action": { "type": "activate_path", "path": "/tmp/repo" } }),
            ),
            (VdpCommand::ShellSave, json!({})),
            (VdpCommand::ShellQuit, json!({})),
            (VdpCommand::ShellGetUpdateState, json!({})),
            (
                VdpCommand::ShellSetDioramaClock(VdpShellSetDioramaClockParams { seconds: Some(1.5) }),
                json!({ "seconds": 1.5 }),
            ),
            (
                VdpCommand::PageCaptureScreenshot(VdpCaptureScreenshotParams {
                    target: Some(VdpScreenshotTarget::Webview),
                    width: Some(1280),
                    height: Some(720),
                }),
                json!({ "target": "webview", "width": 1280, "height": 720 }),
            ),
            (VdpCommand::PageDraw, json!({})),
            (VdpCommand::PageGetMetrics, json!({})),
            (
                VdpCommand::InputDispatchKey(VdpDispatchKeyParams { keys: "cmd-1".into() }),
                json!({ "keys": "cmd-1" }),
            ),
            (
                VdpCommand::InputTypeText(VdpTypeTextParams { text: "hello".into() }),
                json!({ "text": "hello" }),
            ),
            (
                VdpCommand::InputDispatchMouse(VdpDispatchMouseParams {
                    kind: VdpMouseEventKind::Drag,
                    x: 10.0,
                    y: 20.0,
                    button: Some(VdpMouseButton::Right),
                    end_x: Some(100.0),
                    end_y: Some(200.0),
                }),
                json!({ "kind": "drag", "x": 10.0, "y": 20.0, "button": "right", "endX": 100.0, "endY": 200.0 }),
            ),
            (
                VdpCommand::UiGetTree(VdpUiGetTreeParams {
                    view: Some("workbench".into()),
                    max_depth: Some(4),
                }),
                json!({ "view": "workbench", "maxDepth": 4 }),
            ),
            (
                VdpCommand::UiQuery(VdpUiQueryParams {
                    test_id: Some("nav-library".into()),
                    text: Some("Library".into()),
                    role: Some("button".into()),
                    view: Some("workbench".into()),
                }),
                json!({ "testId": "nav-library", "text": "Library", "role": "button", "view": "workbench" }),
            ),
            (
                VdpCommand::UiPress(VdpUiPressParams {
                    test_id: "nav-library".into(),
                    view: Some("workbench".into()),
                }),
                json!({ "testId": "nav-library", "view": "workbench" }),
            ),
            (
                VdpCommand::UiWaitFor(VdpUiWaitForParams {
                    test_id: Some("library-grid".into()),
                    text: None,
                    view: Some("workbench".into()),
                    timeout_ms: Some(5000),
                }),
                json!({ "testId": "library-grid", "view": "workbench", "timeoutMs": 5000 }),
            ),
            (
                VdpCommand::UiInspectAt(VdpUiInspectAtParams { x: 42.0, y: 84.0 }),
                json!({ "x": 42.0, "y": 84.0 }),
            ),
            (
                VdpCommand::UiHighlight(VdpUiHighlightParams {
                    test_id: Some("nav-issues".into()),
                    bounds: Some(VdpUiBounds {
                        x: 10.0,
                        y: 20.0,
                        width: 100.0,
                        height: 32.0,
                    }),
                    label: Some("Issues".into()),
                    source: Some("apps/mac/ui/app/Shell.tsx:42".into()),
                    surface: Some("workbench".into()),
                }),
                json!({
                    "testId": "nav-issues",
                    "bounds": { "x": 10.0, "y": 20.0, "width": 100.0, "height": 32.0 },
                    "label": "Issues",
                    "source": "apps/mac/ui/app/Shell.tsx:42",
                    "surface": "workbench"
                }),
            ),
            (
                VdpCommand::UiSetInspectorMode(VdpUiInspectorModeParams { enabled: true }),
                json!({ "enabled": true }),
            ),
            (
                VdpCommand::ServerSlice(VdpServerSliceParams { name: "board".into() }),
                json!({ "name": "board" }),
            ),
            (
                VdpCommand::ServerInvoke(VdpServerInvokeParams {
                    method: "debug.snapshot".into(),
                    params: Some(json!({})),
                }),
                json!({ "method": "debug.snapshot", "params": {} }),
            ),
            (VdpCommand::LogEnable, json!({})),
            (VdpCommand::LogDisable, json!({})),
            (
                VdpCommand::LogGetEntries(VdpLogGetEntriesParams {
                    since_id: Some(12),
                    limit: Some(50),
                }),
                json!({ "sinceId": 12, "limit": 50 }),
            ),
        ];

        let mut seen = BTreeSet::new();
        for (i, (cmd, expected_params)) in cases.into_iter().enumerate() {
            let method = cmd.method();
            assert_eq!(cmd.to_params(), expected_params, "{method}");
            let req = VdpRequest::from_command((i + 1) as u64, &cmd, Some("s1".into()));
            let wire = serde_json::to_string(&req).unwrap();
            let parsed_req: VdpRequest = serde_json::from_str(&wire).unwrap();
            assert_eq!(parsed_req.decode_command().unwrap(), cmd, "{method}");
            seen.insert(method);
        }
        assert_eq!(seen.len(), VdpCommand::METHOD_NAMES.len(), "every VdpCommand must be tested");
    }

    #[test]
    fn optional_and_unit_commands_accept_missing_or_null_params_and_reject_invalid() {
        for method in [
            "Target.list",
            "Shell.getState",
            "Shell.save",
            "Shell.quit",
            "Shell.getUpdateState",
            "Page.draw",
            "Page.getMetrics",
            "Log.enable",
            "Log.disable",
        ] {
            let req: VdpRequest = serde_json::from_value(json!({ "id": 1, "method": method })).unwrap();
            assert_eq!(req.decode_command().unwrap().method(), method);
            let err = VdpCommand::from_wire(method, json!({ "extra": 1 })).unwrap_err();
            assert_eq!(err.code, VdpError::INVALID_PARAMS);
        }

        for method in [
            "Shell.closePane",
            "Shell.setTheme",
            "Shell.getTerminalGrid",
            "Shell.setDioramaClock",
            "Page.captureScreenshot",
            "UI.getTree",
            "UI.query",
            "UI.waitFor",
            "UI.highlight",
            "Log.getEntries",
        ] {
            let decoded = VdpCommand::from_wire(method, serde_json::Value::Null).unwrap();
            assert_eq!(decoded.method(), method);
            let err = VdpCommand::from_wire(method, json!({ "unknownField": true })).unwrap_err();
            assert_eq!(err.code, VdpError::INVALID_PARAMS);
        }

        let err = VdpCommand::from_wire("Unknown.method", json!({})).unwrap_err();
        assert_eq!(err.code, VdpError::METHOD_NOT_FOUND);

        let input = VdpShellSendTerminalInputParams {
            text: "echo hi".into(),
            enter: None,
        };
        assert!(input.should_enter());
    }

    #[test]
    fn every_vdp_notification_round_trips_and_wire_message_distinguishes_response_vs_event() {
        let target = VdpTarget {
            id: "view:workbench".into(),
            kind: VdpTargetKind::View,
            title: "Workbench".into(),
            url: Some("/issues".into()),
            attached: false,
        };
        let cases = vec![
            VdpNotification::TargetCreated(VdpTargetEvent { target }),
            VdpNotification::TargetDestroyed(VdpTargetDestroyedEvent {
                target_id: "view:workbench".into(),
            }),
            VdpNotification::LogEntry(VdpLogEntry {
                level: VdpLogLevel::Warn,
                source: "shell".into(),
                message: "slow frame".into(),
                timestamp: 1234,
                fields: Some(json!({ "ms": 24 })),
            }),
            VdpNotification::PageFrame(VdpPageFrameEvent {
                frame_ms: 8.5,
                timestamp: 1235,
                width: Some(1440.0),
                height: Some(900.0),
            }),
            VdpNotification::UiConsole(VdpUiConsoleEvent {
                view: "workbench".into(),
                level: VdpLogLevel::Error,
                message: "boom".into(),
                timestamp: 1236,
            }),
            VdpNotification::ServerEvent(VdpServerEventPayload {
                topic: "live".into(),
                payload: json!({ "seq": 9 }),
                timestamp: 1237,
            }),
        ];

        let mut seen = BTreeSet::new();
        for notification in cases {
            let event = VdpEvent::from_notification(&notification, None);
            let wire = serde_json::to_string(&VdpWireMessage::Event(event.clone())).unwrap();
            let decoded: VdpWireMessage = serde_json::from_str(&wire).unwrap();
            match decoded {
                VdpWireMessage::Event(ev) => {
                    assert_eq!(ev, event);
                    assert_eq!(ev.decode_notification().unwrap(), notification);
                }
                VdpWireMessage::Response(_) => panic!("expected VdpWireMessage::Event"),
            }
            seen.insert(notification.method());
        }
        assert_eq!(seen.len(), VdpNotification::METHOD_NAMES.len());

        let ok_res = VdpResponse::ok(7, json!({ "ok": true }), Some("s1".into()));
        let wire_ok = serde_json::to_string(&VdpWireMessage::Response(ok_res.clone())).unwrap();
        match serde_json::from_str::<VdpWireMessage>(&wire_ok).unwrap() {
            VdpWireMessage::Response(res) => {
                assert_eq!(res, ok_res);
                assert_eq!(res.into_result().unwrap(), json!({ "ok": true }));
            }
            VdpWireMessage::Event(_) => panic!("expected VdpWireMessage::Response"),
        }

        let err_res = VdpResponse::err(8, VdpError::timeout("UI.waitFor timed out"), None);
        let wire_err = serde_json::to_string(&VdpWireMessage::Response(err_res.clone())).unwrap();
        match serde_json::from_str::<VdpWireMessage>(&wire_err).unwrap() {
            VdpWireMessage::Response(res) => {
                assert_eq!(res, err_res);
                assert_eq!(res.into_result().unwrap_err().code, VdpError::TIMEOUT);
            }
            VdpWireMessage::Event(_) => panic!("expected VdpWireMessage::Response"),
        }
    }

    #[test]
    fn target_kind_and_log_level_wire_values_stay_stable() {
        assert_eq!(VdpTargetKind::ALL.map(VdpTargetKind::as_str), ["shell", "view", "diorama", "webview", "server"]);
        assert_eq!(VdpScreenshotTarget::ALL.map(VdpScreenshotTarget::as_str), ["shell", "webview"]);
        assert_eq!(VdpMouseEventKind::ALL.map(VdpMouseEventKind::as_str), ["down", "up", "move", "click", "drag"]);
        assert_eq!(VdpMouseButton::ALL.map(VdpMouseButton::as_str), ["left", "right", "middle"]);
        assert_eq!(VdpLogLevel::ALL.map(VdpLogLevel::as_str), ["trace", "debug", "info", "warn", "error"]);
        assert_eq!(VdpLogLevel::from_console_level("log"), VdpLogLevel::Info);
        assert_eq!(VdpLogLevel::from_console_level("WARNING"), VdpLogLevel::Warn);
        assert_eq!(VdpLogLevel::from_console_level("err"), VdpLogLevel::Error);
    }
}
