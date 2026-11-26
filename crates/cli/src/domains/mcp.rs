//! `mcp`: standard stdio MCP (Model Context Protocol) JSON-RPC 2.0 server exposing
//! VibeValley Issues (via server RPC) and live VDP debugging tools to external coding agents.
//!
//! Stdout is reserved strictly for newline-delimited JSON-RPC 2.0 responses;
//! all diagnostics go to stderr.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use clap::{Args, ValueEnum};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
#[cfg(test)]
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use vibevalley_protocol::home::ReleaseChannel;
use vibevalley_protocol::{
    AppliedIssue, Attachment, AttachmentUpload, Issue, IssueCommentCreateInput, IssueConversationGetInput, IssueFilter, IssueGetInput, IssueRequest,
    IssueStatus, IssueStatusUpdateInput, IssueUpdate, IssueUpdateInput, Priority, SayRequest, VdpCaptureScreenshotParams, VdpCommand, VdpDispatchKeyParams,
    VdpDispatchMouseParams, VdpInputResult, VdpMouseButton, VdpMouseEventKind, VdpScreenshotResult, VdpScreenshotTarget, VdpShellNavigateParams,
    VdpShellResizeParams, VdpShellSetThemeParams, VdpTargetListResult, VdpTypeTextParams, VdpUiPressParams, VdpUiPressResult, VdpUiQueryParams,
    VdpUiQueryResult, VdpVersionInfo, home, ops,
};

use crate::auth::{self, Secret};
use crate::client::{Client, Done, Failure, ServerSource, exit};
use crate::domains::debug::{self, DEFAULT_RPC_TIMEOUT, DebugTargetArgs, ResolvedEndpoint, VdpWsClient};
use crate::output::{guess_mime, issue_ref};

const DEFAULT_PROTOCOL_VERSION: &str = "2025-03-26";
const SERVER_NAME: &str = "vibevalley";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const JSONRPC_PARSE_ERROR: i64 = -32700;
const JSONRPC_INVALID_REQUEST: i64 = -32600;
const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
const JSONRPC_INVALID_PARAMS: i64 = -32602;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ChannelArg {
    Dev,
    Alpha,
    Beta,
    Release,
}

impl From<ChannelArg> for ReleaseChannel {
    fn from(arg: ChannelArg) -> Self {
        match arg {
            ChannelArg::Dev => ReleaseChannel::Dev,
            ChannelArg::Alpha => ReleaseChannel::Alpha,
            ChannelArg::Beta => ReleaseChannel::Beta,
            ChannelArg::Release => ReleaseChannel::Release,
        }
    }
}

#[derive(Debug, Clone, Default, Args)]
#[command(
    after_help = "Examples:\n  vibevalley mcp\n  vibevalley mcp --channel alpha\n  vibevalley mcp --home ~/.vibevalley-alpha --vdp-port 9223\n  vibevalley mcp --vdp-url ws://127.0.0.1:9223/devtools"
)]
pub struct McpCmd {
    /// Target release channel (resolves to that channel's canonical home and default port)
    #[arg(long, value_enum, conflicts_with = "home")]
    pub channel: Option<ChannelArg>,

    /// Default VibeValley home directory containing server.json and debug.json
    #[arg(long, value_name = "DIR", conflicts_with = "channel")]
    pub home: Option<PathBuf>,

    /// Default loopback VDP port
    #[arg(long, value_name = "PORT")]
    pub vdp_port: Option<u16>,

    /// Default explicit VDP WebSocket or HTTP URL (e.g. ws://127.0.0.1:9222/devtools)
    #[arg(long, value_name = "URL")]
    pub vdp_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

impl JsonRpcResponse {
    fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn err(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError { code, message: message.into() }),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    #[serde(default)]
    protocol_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum McpContent {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        data: String,
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpToolResult {
    content: Vec<McpContent>,
    #[serde(skip_serializing_if = "is_false")]
    is_error: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl McpToolResult {
    fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![McpContent::Text { text: text.into() }],
            is_error: false,
        }
    }

    fn json<T: Serialize>(value: &T) -> Self {
        match serde_json::to_string_pretty(value) {
            Ok(text) => Self::text(text),
            Err(err) => Self::error(format!("failed to serialize tool result: {err}")),
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![McpContent::Text { text: message.into() }],
            is_error: true,
        }
    }

    fn redact(mut self, secrets: &[&Secret]) -> Self {
        for block in &mut self.content {
            if let McpContent::Text { text } = block {
                *text = redact_text(text, secrets);
            }
        }
        self
    }
}

fn redact_text(input: &str, secrets: &[&Secret]) -> String {
    let mut out = input.to_string();
    for secret in secrets {
        let raw = secret.expose().trim();
        if !raw.is_empty() && out.contains(raw) {
            out = out.replace(raw, "[redacted]");
        }
    }
    out
}

/// Accepts an issue reference as either a JSON string (`"12"`, `"#12"`, `"iss_..."`) or integer (`12`).
fn deserialize_issue_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrInt {
        Str(String),
        Int(i64),
        Uint(u64),
    }

    match StringOrInt::deserialize(deserializer)? {
        StringOrInt::Str(s) => Ok(s),
        StringOrInt::Int(n) => Ok(n.to_string()),
        StringOrInt::Uint(n) => Ok(n.to_string()),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpOverrideArgs {
    #[serde(default)]
    home: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueListArgs {
    #[serde(default)]
    status: Option<IssueStatus>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    closed: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueGetArgs {
    #[serde(deserialize_with = "deserialize_issue_id")]
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueCreateArgs {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    priority: Option<Priority>,
    #[serde(default)]
    status: Option<IssueStatus>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    criteria: Option<Vec<String>>,
    #[serde(default)]
    attachments: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueUpdateArgs {
    #[serde(deserialize_with = "deserialize_issue_id")]
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<IssueStatus>,
    #[serde(default)]
    priority: Option<Priority>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    criteria: Option<Vec<String>>,
    #[serde(default)]
    attachments: Option<Vec<String>>,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueCommentArgs {
    #[serde(alias = "id", deserialize_with = "deserialize_issue_id")]
    issue_id: String,
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadArgs {
    path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    mime: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpDiscoverArgs {
    #[serde(default)]
    extra_homes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpNavigateArgs {
    route: String,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpResizeArgs {
    width: f32,
    height: f32,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThemeMode {
    Light,
    Dark,
    Toggle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpThemeArgs {
    mode: ThemeMode,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpUiQueryArgs {
    #[serde(default)]
    test_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    view: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpUiPressArgs {
    test_id: String,
    #[serde(default)]
    view: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpScreenshotArgs {
    #[serde(default)]
    target: Option<VdpScreenshotTarget>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    out_path: Option<String>,
    #[serde(default)]
    upload_attachment: bool,
    #[serde(default)]
    attachment_name: Option<String>,
    #[serde(flatten)]
    vdp: VdpOverrideArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InputKind {
    Key,
    Type,
    Click,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpInputArgs {
    kind: InputKind,
    #[serde(default)]
    keys: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    x: Option<f32>,
    #[serde(default)]
    y: Option<f32>,
    #[serde(default)]
    right: bool,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdpCallArgs {
    method: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(flatten)]
    target: VdpOverrideArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpTool {
    IssueList,
    IssueGet,
    IssueCreate,
    IssueUpdate,
    IssueComment,
    AttachmentUpload,
    VdpDiscover,
    VdpTargets,
    VdpState,
    VdpNavigate,
    VdpResize,
    VdpTheme,
    VdpUiQuery,
    VdpUiPress,
    VdpScreenshot,
    VdpInput,
    VdpCall,
}

impl McpTool {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "vv_issue_list" => Some(Self::IssueList),
            "vv_issue_get" => Some(Self::IssueGet),
            "vv_issue_create" => Some(Self::IssueCreate),
            "vv_issue_update" => Some(Self::IssueUpdate),
            "vv_issue_comment" => Some(Self::IssueComment),
            "vv_attachment_upload" => Some(Self::AttachmentUpload),
            "vv_vdp_discover" => Some(Self::VdpDiscover),
            "vv_vdp_targets" => Some(Self::VdpTargets),
            "vv_vdp_state" => Some(Self::VdpState),
            "vv_vdp_navigate" => Some(Self::VdpNavigate),
            "vv_vdp_resize" => Some(Self::VdpResize),
            "vv_vdp_theme" => Some(Self::VdpTheme),
            "vv_vdp_ui_query" => Some(Self::VdpUiQuery),
            "vv_vdp_ui_press" => Some(Self::VdpUiPress),
            "vv_vdp_screenshot" => Some(Self::VdpScreenshot),
            "vv_vdp_input" => Some(Self::VdpInput),
            "vv_vdp_call" => Some(Self::VdpCall),
            _ => None,
        }
    }
}

fn tool_definitions() -> Vec<Value> {
    let vdp_target_props = || {
        json!({
            "home": { "type": "string", "description": "Optional VibeValley home directory override containing debug.json." },
            "port": { "type": "integer", "minimum": 1, "maximum": 65535, "description": "Optional loopback VDP port override." }
        })
    };

    let merge_vdp_props = |mut props: serde_json::Map<String, Value>| -> Value {
        if let Value::Object(target_map) = vdp_target_props() {
            props.extend(target_map);
        }
        Value::Object(props)
    };

    vec![
        json!({
            "name": "vv_issue_list",
            "description": "List issues on the target VibeValley board with optional status, repo, or assigned agent filters.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Filter by issue status." },
                    "repo": { "type": "string", "description": "Filter by repository name." },
                    "agent": { "type": "string", "description": "Filter by assigned agent profile id or name." },
                    "text": { "type": "string", "description": "Optional title/description substring filter." },
                    "closed": { "type": "boolean", "description": "Include closed (done/canceled) issues." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum number of issues to return (default 50)." }
                }
            }
        }),
        json!({
            "name": "vv_issue_get",
            "description": "Read full details of a VibeValley issue, including description, acceptance criteria, questions, findings, and stage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id." }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "vv_issue_create",
            "description": "Create a new issue directly on the VibeValley board.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Concise issue title." },
                    "description": { "type": "string", "description": "Detailed description, repro steps, or visual findings." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low"], "description": "Issue priority level." },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Optional target status after creation (server defaults to backlog)." },
                    "repo": { "type": "string", "description": "Optional repository name." },
                    "agent": { "type": "string", "description": "Optional assigned agent profile id." },
                    "criteria": { "type": "array", "items": { "type": "string" }, "description": "Optional acceptance criteria list." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional uploaded attachment ids." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "vv_issue_update",
            "description": "Update an existing VibeValley issue's title, description, priority, repo, agent, criteria, attachments, or transition its status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id." },
                    "title": { "type": "string", "description": "Updated title." },
                    "description": { "type": "string", "description": "Updated description." },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Optional target status transition." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low"], "description": "Updated priority." },
                    "repo": { "type": "string", "description": "Updated repository name." },
                    "agent": { "type": "string", "description": "Updated assigned agent profile id." },
                    "criteria": { "type": "array", "items": { "type": "string" }, "description": "Replacement acceptance criteria list." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Replacement uploaded attachment ids." },
                    "comment": { "type": "string", "description": "Optional comment attached to a status transition." }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "vv_issue_comment",
            "description": "Post a comment (optionally with uploaded attachment ids or ```compare markdown blocks) to a VibeValley issue thread.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issueId": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id (alias: 'id')." },
                    "text": { "type": "string", "description": "Comment body text (Markdown, including ```compare blocks)." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional uploaded attachment ids to attach to the comment." }
                },
                "required": ["issueId", "text"]
            }
        }),
        json!({
            "name": "vv_attachment_upload",
            "description": "Read a local file (e.g. before/after PNG screenshot) from disk and upload it via attachment.create, returning { id, name, type, size }.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Local file path to read and upload." },
                    "name": { "type": "string", "description": "Optional display filename override." },
                    "mime": { "type": "string", "description": "Optional MIME type override (inferred from extension when omitted)." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "vv_vdp_discover",
            "description": "Discover running local debuggable VibeValley instances (never returns auth tokens).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "extraHomes": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional extra VibeValley home directories to scan for debug.json."
                    }
                }
            }
        }),
        json!({
            "name": "vv_vdp_targets",
            "description": "List live inspectable VDP targets (shell, view:*, diorama, webview, server) on a running VibeValley app.",
            "inputSchema": {
                "type": "object",
                "properties": vdp_target_props()
            }
        }),
        json!({
            "name": "vv_vdp_state",
            "description": "Get live Shell.getState snapshot (active route, theme, window bounds, panes) from a running VibeValley app.",
            "inputSchema": {
                "type": "object",
                "properties": vdp_target_props()
            }
        }),
        json!({
            "name": "vv_vdp_navigate",
            "description": "Navigate the live VibeValley desktop app to a route (e.g. /issues, /library, /farm, /chat, /settings).",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "route": { "type": "string", "description": "Target route path (e.g. /issues, /library, /farm)." }
                })).expect("static schema")),
                "required": ["route"]
            }
        }),
        json!({
            "name": "vv_vdp_resize",
            "description": "Resize the live VibeValley desktop window in logical pixels.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "width": { "type": "number", "exclusiveMinimum": 0, "description": "Target window width in logical pixels." },
                    "height": { "type": "number", "exclusiveMinimum": 0, "description": "Target window height in logical pixels." }
                })).expect("static schema")),
                "required": ["width", "height"]
            }
        }),
        json!({
            "name": "vv_vdp_theme",
            "description": "Switch or toggle the live VibeValley desktop theme.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "mode": { "type": "string", "enum": ["light", "dark", "toggle"], "description": "Target theme mode." }
                })).expect("static schema")),
                "required": ["mode"]
            }
        }),
        json!({
            "name": "vv_vdp_ui_query",
            "description": "Query mounted UI nodes and measured layout bounds by testId, text substring, or semantic role.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "testId": { "type": "string", "description": "Exact or matching testID." },
                    "text": { "type": "string", "description": "Text substring to match." },
                    "role": { "type": "string", "description": "Semantic/accessibility role." },
                    "view": { "type": "string", "description": "Optional view id (e.g. workbench)." }
                })).expect("static schema"))
            }
        }),
        json!({
            "name": "vv_vdp_ui_press",
            "description": "Press a mounted UI element in the live app by its testID without needing pixel coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "testId": { "type": "string", "description": "Element testID to press." },
                    "view": { "type": "string", "description": "Optional view id (e.g. workbench)." }
                })).expect("static schema")),
                "required": ["testId"]
            }
        }),
        json!({
            "name": "vv_vdp_screenshot",
            "description": "Capture a live PNG screenshot via Page.captureScreenshot, optionally save to outPath and/or upload as a VibeValley attachment, and return both an inline image block and a text summary.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "target": { "type": "string", "enum": ["shell", "webview"], "description": "Capture target surface (default shell)." },
                    "width": { "type": "integer", "minimum": 1, "description": "Optional capture width." },
                    "height": { "type": "integer", "minimum": 1, "description": "Optional capture height." },
                    "outPath": { "type": "string", "description": "Optional destination path to save the decoded PNG file." },
                    "uploadAttachment": { "type": "boolean", "description": "When true, upload the captured PNG via attachment.create and include attachmentId in the summary." },
                    "attachmentName": { "type": "string", "description": "Optional filename when uploadAttachment is true (default screenshot.png)." }
                })).expect("static schema"))
            }
        }),
        json!({
            "name": "vv_vdp_input",
            "description": "Inject keyboard or mouse input into the live VibeValley window.",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "kind": { "type": "string", "enum": ["key", "type", "click"], "description": "Input event kind." },
                    "keys": { "type": "string", "description": "Keystroke descriptor when kind is 'key' (e.g. cmd-k, enter, escape)." },
                    "text": { "type": "string", "description": "UTF-8 text to type when kind is 'type'." },
                    "x": { "type": "number", "description": "Logical X coordinate when kind is 'click'." },
                    "y": { "type": "number", "description": "Logical Y coordinate when kind is 'click'." },
                    "right": { "type": "boolean", "description": "Use right mouse button instead of left when kind is 'click'." }
                })).expect("static schema")),
                "required": ["kind"]
            }
        }),
        json!({
            "name": "vv_vdp_call",
            "description": "Send a raw VDP JSON-RPC 2.0 command (escape hatch for any VDP method).",
            "inputSchema": {
                "type": "object",
                "properties": merge_vdp_props(serde_json::from_value(json!({
                    "method": { "type": "string", "description": "VDP JSON-RPC method name (e.g. Page.getMetrics, UI.getTree, Server.slice)." },
                    "params": { "type": "object", "description": "Optional JSON params object." },
                    "sessionId": { "type": "string", "description": "Optional attached VDP target session id." }
                })).expect("static schema")),
                "required": ["method"]
            }
        }),
    ]
}

fn non_empty_trimmed(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn format_failure(failure: &Failure) -> String {
    let mut msg = format!("{}: {}", failure.tag, failure.text);
    if let Some(code) = failure.biz_code {
        msg.push_str(&format!(" (bizCode {code})"));
    }
    if let Some(status) = failure.status {
        msg.push_str(&format!(" (HTTP {status})"));
    }
    msg
}

struct McpServer {
    client: Client,
    channel: Option<ReleaseChannel>,
    defaults: DebugTargetArgs,
}

impl McpServer {
    fn new(base: &Client, cmd: McpCmd) -> Self {
        let channel = cmd.channel.map(ReleaseChannel::from);
        let explicit_home = cmd.home.or_else(|| channel.map(home::home_for));
        let effective_home = explicit_home.clone().unwrap_or_else(|| base.home.clone());
        let client = build_client_for_home(base, &effective_home, channel);
        let defaults = DebugTargetArgs {
            home: explicit_home,
            port: cmd.vdp_port,
            url: non_empty_trimmed(cmd.vdp_url),
        };
        Self { client, channel, defaults }
    }

    /// Re-checks `server.json` on the active home when no explicit `--server`/`VIBEVALLEY_SERVER`/`auth.json`
    /// is pinned, so long-lived MCP processes seamlessly follow restarted local VibeValley servers.
    fn refresh_issue_client(&mut self) {
        if matches!(self.client.server_source, ServerSource::Flag | ServerSource::Env | ServerSource::AuthFile) {
            return;
        }
        if let Some(announced) = home::announced(&self.client.home) {
            let normalized = auth::normalize_server_url_lossy(&announced);
            if normalized != self.client.server {
                self.client = build_client_for_home(&self.client, &self.client.home, self.channel);
            }
        }
    }

    fn resolve_vdp_target(&self, override_args: &VdpOverrideArgs) -> DebugTargetArgs {
        let override_home = non_empty_trimmed(override_args.home.clone()).map(PathBuf::from);
        if let Some(port) = override_args.port {
            DebugTargetArgs {
                home: override_home.or_else(|| self.defaults.home.clone()),
                port: Some(port),
                url: None,
            }
        } else if let Some(home_dir) = override_home {
            DebugTargetArgs {
                home: Some(home_dir),
                port: None,
                url: None,
            }
        } else {
            self.defaults.clone()
        }
    }

    fn known_secrets<'a>(&'a self, endpoint: Option<&'a ResolvedEndpoint>) -> Vec<&'a Secret> {
        let mut out = Vec::new();
        if let Some(tok) = self.client.token() {
            out.push(tok);
        }
        if let Some(tok) = self.client.flag_token() {
            out.push(tok);
        }
        if let Some(tok) = self.client.env_token() {
            out.push(tok);
        }
        if let Some(ep) = endpoint
            && let Some(tok) = ep.token.as_ref()
        {
            out.push(tok);
        }
        out
    }

    async fn handle_line(&mut self, line: &str) -> Option<JsonRpcResponse> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(err) => {
                return Some(JsonRpcResponse::err(Value::Null, JSONRPC_PARSE_ERROR, format!("parse error: {err}")));
            }
        };

        let is_notification = req.id.is_none();
        let id = req.id.unwrap_or(Value::Null);

        if let Some(version) = req.jsonrpc.as_deref()
            && version != "2.0"
        {
            return (!is_notification).then(|| JsonRpcResponse::err(id, JSONRPC_INVALID_REQUEST, format!("unsupported jsonrpc version: {version}")));
        }

        let Some(method) = req.method.as_deref().map(str::trim).filter(|m| !m.is_empty()) else {
            return (!is_notification).then(|| JsonRpcResponse::err(id, JSONRPC_INVALID_REQUEST, "missing JSON-RPC method"));
        };

        // Notifications must never produce a JSON-RPC response on stdout.
        if is_notification {
            if !method.starts_with("notifications/") {
                eprintln!("vibevalley mcp: ignoring notification for method {method}");
            }
            return None;
        }

        let response = match method {
            "initialize" => {
                let init: InitializeParams = serde_json::from_value(req.params).unwrap_or_default();
                let protocol_version = init
                    .protocol_version
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(DEFAULT_PROTOCOL_VERSION);
                JsonRpcResponse::ok(
                    id,
                    json!({
                        "protocolVersion": protocol_version,
                        "capabilities": { "tools": {} },
                        "serverInfo": {
                            "name": SERVER_NAME,
                            "version": SERVER_VERSION,
                        }
                    }),
                )
            }
            "notifications/initialized" | "ping" => JsonRpcResponse::ok(id, json!({})),
            "tools/list" => JsonRpcResponse::ok(id, json!({ "tools": tool_definitions() })),
            "tools/call" => match serde_json::from_value::<ToolCallParams>(req.params) {
                Ok(call) if !call.name.trim().is_empty() => {
                    let result = self.call_tool(call.name.trim(), call.arguments).await;
                    match serde_json::to_value(result) {
                        Ok(val) => JsonRpcResponse::ok(id, val),
                        Err(err) => JsonRpcResponse::err(id, -32603, format!("failed to encode tool response: {err}")),
                    }
                }
                Ok(_) => JsonRpcResponse::err(id, JSONRPC_INVALID_PARAMS, "tools/call requires a non-empty tool name"),
                Err(err) => JsonRpcResponse::err(id, JSONRPC_INVALID_PARAMS, format!("invalid tools/call params: {err}")),
            },
            other => JsonRpcResponse::err(id, JSONRPC_METHOD_NOT_FOUND, format!("method not found: {other}")),
        };

        Some(response)
    }

    async fn call_tool(&mut self, name: &str, raw_args: Value) -> McpToolResult {
        let Some(tool) = McpTool::from_name(name) else {
            return McpToolResult::error(format!("unknown tool: {name}"));
        };
        let args = if raw_args.is_null() { json!({}) } else { raw_args };

        match tool {
            McpTool::IssueList => self.tool_issue_list(args).await,
            McpTool::IssueGet => self.tool_issue_get(args).await,
            McpTool::IssueCreate => self.tool_issue_create(args).await,
            McpTool::IssueUpdate => self.tool_issue_update(args).await,
            McpTool::IssueComment => self.tool_issue_comment(args).await,
            McpTool::AttachmentUpload => self.tool_attachment_upload(args).await,
            McpTool::VdpDiscover => self.tool_vdp_discover(args),
            McpTool::VdpTargets => self.tool_vdp_targets(args).await,
            McpTool::VdpState => self.tool_vdp_state(args).await,
            McpTool::VdpNavigate => self.tool_vdp_navigate(args).await,
            McpTool::VdpResize => self.tool_vdp_resize(args).await,
            McpTool::VdpTheme => self.tool_vdp_theme(args).await,
            McpTool::VdpUiQuery => self.tool_vdp_ui_query(args).await,
            McpTool::VdpUiPress => self.tool_vdp_ui_press(args).await,
            McpTool::VdpScreenshot => self.tool_vdp_screenshot(args).await,
            McpTool::VdpInput => self.tool_vdp_input(args).await,
            McpTool::VdpCall => self.tool_vdp_call(args).await,
        }
    }

    fn decode_args<T: serde::de::DeserializeOwned>(tool_name: &str, args: Value) -> Result<T, McpToolResult> {
        serde_json::from_value(args).map_err(|err| McpToolResult::error(format!("invalid arguments for {tool_name}: {err}")))
    }

    async fn tool_issue_list(&mut self, raw_args: Value) -> McpToolResult {
        let args: IssueListArgs = match Self::decode_args("vv_issue_list", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.refresh_issue_client();
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let agent_filter = non_empty_trimmed(args.agent);
        let filter = IssueFilter {
            status: args.status,
            repo: non_empty_trimmed(args.repo),
            text: non_empty_trimmed(args.text),
            closed: args.closed,
            // Fetch extra rows before client-side agent filtering so matches are not cut off early.
            limit: Some(if agent_filter.is_some() { 200 } else { limit }),
            wants_user: None,
        };

        let result = match self.client.ask::<ops::IssueList>(&filter).await {
            Ok(mut issues) => {
                if let Some(agent) = agent_filter.as_deref() {
                    issues.retain(|issue| matches_agent(issue, agent));
                }
                issues.truncate(limit as usize);
                McpToolResult::json(&json!({
                    "count": issues.len(),
                    "issues": issues,
                }))
            }
            Err(failure) => McpToolResult::error(format_failure(&failure)),
        };
        result.redact(&self.known_secrets(None))
    }

    async fn tool_issue_get(&mut self, raw_args: Value) -> McpToolResult {
        let args: IssueGetArgs = match Self::decode_args("vv_issue_get", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.id.trim());
        if id.is_empty() {
            return McpToolResult::error("vv_issue_get requires a non-empty id");
        }
        self.refresh_issue_client();
        let result = match self.client.ask::<ops::IssueGet>(&IssueGetInput { id }).await {
            Ok(issue) => McpToolResult::json(&issue),
            Err(failure) => McpToolResult::error(format_failure(&failure)),
        };
        result.redact(&self.known_secrets(None))
    }

    async fn tool_issue_create(&mut self, raw_args: Value) -> McpToolResult {
        let args: IssueCreateArgs = match Self::decode_args("vv_issue_create", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let title = args.title.trim().to_string();
        if title.is_empty() {
            return McpToolResult::error("vv_issue_create requires a non-empty title");
        }
        self.refresh_issue_client();
        let request = IssueRequest {
            title,
            description: non_empty_trimmed(args.description),
            repo: non_empty_trimmed(args.repo),
            agent: non_empty_trimmed(args.agent),
            priority: args.priority,
            criteria: args.criteria.filter(|c| !c.is_empty()),
            attachments: args.attachments.filter(|a| !a.is_empty()),
            ..Default::default()
        };

        let created: AppliedIssue = match self.client.ask::<ops::IssueCreate>(&request).await {
            Ok(issue) => issue,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&self.known_secrets(None)),
        };

        let final_issue = if let Some(target_status) = args.status
            && target_status != created.status
        {
            let status_req = IssueStatusUpdateInput {
                revision: None,
                id: created.id.clone(),
                status: target_status,
                text: None,
                agent: None,
                edit: None,
                request_key: None,
            };
            match self.client.ask::<ops::IssueStatusUpdate>(&status_req).await {
                Ok(updated) => updated,
                Err(failure) => {
                    return McpToolResult::error(format!(
                        "created issue #{} ({}), but failed to set status to {}: {}",
                        created.number,
                        created.id,
                        target_status.as_str(),
                        format_failure(&failure)
                    ))
                    .redact(&self.known_secrets(None));
                }
            }
        } else {
            created
        };

        McpToolResult::json(&final_issue).redact(&self.known_secrets(None))
    }

    async fn tool_issue_update(&mut self, raw_args: Value) -> McpToolResult {
        let args: IssueUpdateArgs = match Self::decode_args("vv_issue_update", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.id.trim());
        if id.is_empty() {
            return McpToolResult::error("vv_issue_update requires a non-empty id");
        }
        let title = non_empty_trimmed(args.title);
        let description = args.description;
        let repo = non_empty_trimmed(args.repo);
        let agent = non_empty_trimmed(args.agent);
        let priority = args.priority;
        let criteria = args.criteria;
        let attachments = args.attachments;
        let comment = non_empty_trimmed(args.comment);

        let has_field_edits =
            title.is_some() || description.is_some() || repo.is_some() || agent.is_some() || priority.is_some() || criteria.is_some() || attachments.is_some();

        self.refresh_issue_client();
        let result = if let Some(target_status) = args.status {
            let edit = has_field_edits.then(|| IssueUpdate {
                title,
                description,
                repo,
                agent,
                priority,
                criteria,
                attachments,
                ..Default::default()
            });
            let req = IssueStatusUpdateInput {
                revision: None,
                id,
                status: target_status,
                text: comment,
                agent: None,
                edit,
                request_key: None,
            };
            match self.client.ask::<ops::IssueStatusUpdate>(&req).await {
                Ok(updated) => McpToolResult::json(&updated),
                Err(failure) => McpToolResult::error(format_failure(&failure)),
            }
        } else {
            if !has_field_edits {
                return McpToolResult::error(
                    "vv_issue_update requires at least one field to update (title, description, status, priority, repo, agent, criteria, or attachments)",
                );
            }
            let req = IssueUpdateInput {
                id,
                title,
                description,
                repo,
                agent,
                priority,
                criteria,
                attachments,
                ..Default::default()
            };
            match self.client.ask::<ops::IssueUpdate>(&req).await {
                Ok(updated) => McpToolResult::json(&updated),
                Err(failure) => McpToolResult::error(format_failure(&failure)),
            }
        };

        result.redact(&self.known_secrets(None))
    }

    async fn tool_issue_comment(&mut self, raw_args: Value) -> McpToolResult {
        let args: IssueCommentArgs = match Self::decode_args("vv_issue_comment", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.issue_id.trim());
        let text = args.text.trim().to_string();
        if id.is_empty() || text.is_empty() {
            return McpToolResult::error("vv_issue_comment requires non-empty issueId and text");
        }
        let attachments: Vec<String> = args.attachments.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();

        self.refresh_issue_client();
        let result = if attachments.is_empty() {
            let req = IssueCommentCreateInput {
                id: id.clone(),
                text,
                ..Default::default()
            };
            match self.client.ask::<ops::IssueCommentCreate>(&req).await {
                Ok(applied) => McpToolResult::json(&json!({
                    "ok": true,
                    "issueId": id,
                    "seq": applied.seq,
                })),
                Err(failure) => McpToolResult::error(format_failure(&failure)),
            }
        } else {
            match self
                .client
                .ask::<ops::IssueConversationGet>(&IssueConversationGetInput { id: id.clone() })
                .await
            {
                Ok(Some(channel_id)) => {
                    let say = SayRequest {
                        id: channel_id.clone(),
                        text,
                        attachments: Some(attachments.clone()),
                        ..Default::default()
                    };
                    match self.client.ask::<ops::ChannelMessageSend>(&say).await {
                        Ok(()) => McpToolResult::json(&json!({
                            "ok": true,
                            "issueId": id,
                            "channelId": channel_id,
                            "attachments": attachments,
                        })),
                        Err(failure) => McpToolResult::error(format_failure(&failure)),
                    }
                }
                Ok(None) => {
                    // Thread does not exist yet: post via `issue.comment.create` (which opens the thread)
                    // and also link the uploaded attachment ids onto the issue itself.
                    let req = IssueCommentCreateInput {
                        id: id.clone(),
                        text,
                        ..Default::default()
                    };
                    match self.client.ask::<ops::IssueCommentCreate>(&req).await {
                        Ok(applied) => {
                            if let Ok(issue) = self.client.ask::<ops::IssueGet>(&IssueGetInput { id: id.clone() }).await {
                                let mut merged: Vec<String> = issue.attachments.into_iter().map(|a| a.id).collect();
                                for att_id in &attachments {
                                    if !merged.contains(att_id) {
                                        merged.push(att_id.clone());
                                    }
                                }
                                let _ = self
                                    .client
                                    .ask::<ops::IssueUpdate>(&IssueUpdateInput {
                                        id: issue.id,
                                        attachments: Some(merged),
                                        ..Default::default()
                                    })
                                    .await;
                            }
                            McpToolResult::json(&json!({
                                "ok": true,
                                "issueId": id,
                                "seq": applied.seq,
                                "attachments": attachments,
                            }))
                        }
                        Err(failure) => McpToolResult::error(format_failure(&failure)),
                    }
                }
                Err(failure) => McpToolResult::error(format_failure(&failure)),
            }
        };
        result.redact(&self.known_secrets(None))
    }

    async fn tool_attachment_upload(&mut self, raw_args: Value) -> McpToolResult {
        let args: AttachmentUploadArgs = match Self::decode_args("vv_attachment_upload", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let path_str = args.path.trim();
        if path_str.is_empty() {
            return McpToolResult::error("vv_attachment_upload requires a non-empty path");
        }
        let file = PathBuf::from(path_str);
        let bytes = match std::fs::read(&file) {
            Ok(b) => b,
            Err(err) => return McpToolResult::error(format!("File: failed to read {}: {err}", file.display())),
        };
        let name = non_empty_trimmed(args.name)
            .or_else(|| file.file_name().and_then(|n| n.to_str()).map(ToString::to_string))
            .unwrap_or_else(|| "attachment".into());
        let mime = non_empty_trimmed(args.mime).unwrap_or_else(|| guess_mime(&file).to_string());
        let request = AttachmentUpload {
            name,
            r#type: mime,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        };
        self.refresh_issue_client();
        let result = match self.client.ask::<ops::AttachmentCreate>(&request).await {
            Ok(att) => McpToolResult::json(&att),
            Err(failure) => McpToolResult::error(format_failure(&failure)),
        };
        result.redact(&self.known_secrets(None))
    }

    fn tool_vdp_discover(&self, raw_args: Value) -> McpToolResult {
        let args: VdpDiscoverArgs = match Self::decode_args("vv_vdp_discover", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let mut extra: Vec<PathBuf> = args
            .extra_homes
            .into_iter()
            .filter_map(|p| {
                let trimmed = p.trim();
                (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
            })
            .collect();
        if let Some(default_home) = &self.defaults.home {
            extra.push(default_home.clone());
        }
        extra.push(self.client.home.clone());

        let discovered = home::discover_local_debug_endpoints(&extra);
        let tokens: Vec<Secret> = discovered.iter().map(|ep| Secret::new(ep.token.clone())).collect();
        // `VdpEndpointInfo::version_info()` structurally omits `token`.
        let instances: Vec<VdpVersionInfo> = discovered.into_iter().map(|ep| ep.version_info()).collect();
        let mut secrets = self.known_secrets(None);
        for tok in &tokens {
            secrets.push(tok);
        }
        McpToolResult::json(&json!({
            "count": instances.len(),
            "instances": instances,
        }))
        .redact(&secrets)
    }

    async fn with_vdp_ws<F, Fut>(&self, override_args: &VdpOverrideArgs, f: F) -> McpToolResult
    where
        F: FnOnce(VdpWsClient) -> Fut,
        Fut: std::future::Future<Output = Result<(McpToolResult, VdpWsClient), (Failure, VdpWsClient)>>,
    {
        let target = self.resolve_vdp_target(override_args);
        let endpoint = match debug::resolve_endpoint(&self.client, &target) {
            Ok(ep) => ep,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&self.known_secrets(None)),
        };
        let secrets = self.known_secrets(Some(&endpoint));
        let ws = match VdpWsClient::connect(&endpoint).await {
            Ok(ws) => ws,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&secrets),
        };
        let result = match f(ws).await {
            Ok((res, ws)) => {
                ws.close().await;
                res
            }
            Err((failure, ws)) => {
                ws.close().await;
                McpToolResult::error(format_failure(&failure))
            }
        };
        result.redact(&secrets)
    }

    async fn tool_vdp_targets(&self, raw_args: Value) -> McpToolResult {
        let args: VdpOverrideArgs = match Self::decode_args("vv_vdp_targets", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args, |mut ws| async move {
            match ws.call_typed::<VdpTargetListResult>(&VdpCommand::TargetList, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((McpToolResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_state(&self, raw_args: Value) -> McpToolResult {
        let args: VdpOverrideArgs = match Self::decode_args("vv_vdp_state", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args, |mut ws| async move {
            match ws.call_command(&VdpCommand::ShellGetState, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((McpToolResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_navigate(&self, raw_args: Value) -> McpToolResult {
        let args: VdpNavigateArgs = match Self::decode_args("vv_vdp_navigate", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let route = args.route.trim().to_string();
        if route.is_empty() {
            return McpToolResult::error("vv_vdp_navigate requires a non-empty route");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellNavigate(VdpShellNavigateParams { route });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((McpToolResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_resize(&self, raw_args: Value) -> McpToolResult {
        let args: VdpResizeArgs = match Self::decode_args("vv_vdp_resize", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        if !args.width.is_finite() || !args.height.is_finite() || args.width <= 0.0 || args.height <= 0.0 {
            return McpToolResult::error("vv_vdp_resize requires positive finite width and height");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellResize(VdpShellResizeParams {
                width: args.width,
                height: args.height,
            });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((McpToolResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_theme(&self, raw_args: Value) -> McpToolResult {
        let args: VdpThemeArgs = match Self::decode_args("vv_vdp_theme", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let dark = match args.mode {
            ThemeMode::Dark => Some(true),
            ThemeMode::Light => Some(false),
            ThemeMode::Toggle => None,
        };
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::ShellSetTheme(VdpShellSetThemeParams { dark });
            match ws.call_command(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((McpToolResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_ui_query(&self, raw_args: Value) -> McpToolResult {
        let args: VdpUiQueryArgs = match Self::decode_args("vv_vdp_ui_query", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::UiQuery(VdpUiQueryParams {
                test_id: non_empty_trimmed(args.test_id),
                text: non_empty_trimmed(args.text),
                role: non_empty_trimmed(args.role),
                view: non_empty_trimmed(args.view),
            });
            match ws.call_typed::<VdpUiQueryResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((McpToolResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_ui_press(&self, raw_args: Value) -> McpToolResult {
        let args: VdpUiPressArgs = match Self::decode_args("vv_vdp_ui_press", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let test_id = args.test_id.trim().to_string();
        if test_id.is_empty() {
            return McpToolResult::error("vv_vdp_ui_press requires a non-empty testId");
        }
        self.with_vdp_ws(&args.target, |mut ws| async move {
            let cmd = VdpCommand::UiPress(VdpUiPressParams {
                test_id,
                view: non_empty_trimmed(args.view),
            });
            match ws.call_typed::<VdpUiPressResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((McpToolResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_screenshot(&mut self, raw_args: Value) -> McpToolResult {
        let args: VdpScreenshotArgs = match Self::decode_args("vv_vdp_screenshot", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let out_path = non_empty_trimmed(args.out_path).map(PathBuf::from);
        let upload_attachment = args.upload_attachment;
        let attachment_name = non_empty_trimmed(args.attachment_name)
            .or_else(|| out_path.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()).map(ToString::to_string))
            .unwrap_or_else(|| "screenshot.png".into());

        if upload_attachment {
            self.refresh_issue_client();
        }

        let target = self.resolve_vdp_target(&args.vdp);
        let endpoint = match debug::resolve_endpoint(&self.client, &target) {
            Ok(ep) => ep,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&self.known_secrets(None)),
        };
        let secrets = self.known_secrets(Some(&endpoint));
        let mut ws = match VdpWsClient::connect(&endpoint).await {
            Ok(ws) => ws,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&secrets),
        };

        let cmd = VdpCommand::PageCaptureScreenshot(VdpCaptureScreenshotParams {
            target: args.target,
            width: args.width,
            height: args.height,
        });
        let shot_res: Result<VdpScreenshotResult, Failure> = ws.call_typed(&cmd, DEFAULT_RPC_TIMEOUT).await;
        ws.close().await;

        let shot = match shot_res {
            Ok(s) => s,
            Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&secrets),
        };

        let raw_b64 = shot.data.trim().to_string();
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&raw_b64) {
            Ok(b) => b,
            Err(err) => {
                return McpToolResult::error(format!("Decode: invalid screenshot base64 payload: {err}")).redact(&secrets);
            }
        };

        if let Some(ref path) = out_path {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
                && let Err(err) = std::fs::create_dir_all(parent)
            {
                return McpToolResult::error(format!("File: failed to create directory {}: {err}", parent.display())).redact(&secrets);
            }
            if let Err(err) = std::fs::write(path, &bytes) {
                return McpToolResult::error(format!("File: failed to write {}: {err}", path.display())).redact(&secrets);
            }
        }

        let mime = if shot.mime.trim().is_empty() { "image/png".to_string() } else { shot.mime };

        let uploaded: Option<Attachment> = if upload_attachment {
            let req = AttachmentUpload {
                name: attachment_name,
                r#type: mime.clone(),
                data: raw_b64.clone(),
            };
            match self.client.ask::<ops::AttachmentCreate>(&req).await {
                Ok(att) => Some(att),
                Err(failure) => return McpToolResult::error(format_failure(&failure)).redact(&secrets),
            }
        } else {
            None
        };

        let mut summary = format!("Captured {}x{} screenshot ({mime}, {} bytes)", shot.width, shot.height, bytes.len());
        if let Some(ref path) = out_path {
            summary.push_str(&format!(" saved to {}", path.display()));
        }
        if let Some(ref att) = uploaded {
            summary.push_str(&format!(" attachmentId={}", att.id));
        }

        McpToolResult {
            content: vec![
                McpContent::Image {
                    data: raw_b64,
                    mime_type: mime,
                },
                McpContent::Text { text: summary },
            ],
            is_error: false,
        }
        .redact(&secrets)
    }

    async fn tool_vdp_input(&self, raw_args: Value) -> McpToolResult {
        let args: VdpInputArgs = match Self::decode_args("vv_vdp_input", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let cmd = match args.kind {
            InputKind::Key => {
                let Some(keys) = non_empty_trimmed(args.keys) else {
                    return McpToolResult::error("vv_vdp_input with kind='key' requires non-empty 'keys'");
                };
                VdpCommand::InputDispatchKey(VdpDispatchKeyParams { keys })
            }
            InputKind::Type => {
                let Some(text) = args.text else {
                    return McpToolResult::error("vv_vdp_input with kind='type' requires 'text'");
                };
                VdpCommand::InputTypeText(VdpTypeTextParams { text })
            }
            InputKind::Click => {
                let (Some(x), Some(y)) = (args.x, args.y) else {
                    return McpToolResult::error("vv_vdp_input with kind='click' requires numeric 'x' and 'y'");
                };
                if !x.is_finite() || !y.is_finite() {
                    return McpToolResult::error("vv_vdp_input click coordinates must be finite numbers");
                }
                VdpCommand::InputDispatchMouse(VdpDispatchMouseParams {
                    kind: VdpMouseEventKind::Click,
                    x,
                    y,
                    button: Some(if args.right { VdpMouseButton::Right } else { VdpMouseButton::Left }),
                    end_x: None,
                    end_y: None,
                })
            }
        };

        self.with_vdp_ws(&args.target, |mut ws| async move {
            match ws.call_typed::<VdpInputResult>(&cmd, DEFAULT_RPC_TIMEOUT).await {
                Ok(res) => Ok((McpToolResult::json(&res), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }

    async fn tool_vdp_call(&self, raw_args: Value) -> McpToolResult {
        let args: VdpCallArgs = match Self::decode_args("vv_vdp_call", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let method = args.method.trim().to_string();
        if method.is_empty() {
            return McpToolResult::error("vv_vdp_call requires a non-empty method");
        }
        let params = args.params.filter(|v| !v.is_null()).unwrap_or_else(|| json!({}));
        let session_id = non_empty_trimmed(args.session_id);
        self.with_vdp_ws(&args.target, |mut ws| async move {
            match ws.call_raw(&method, params, session_id, DEFAULT_RPC_TIMEOUT).await {
                Ok(val) => Ok((McpToolResult::json(&val), ws)),
                Err(err) => Err((err, ws)),
            }
        })
        .await
    }
}

fn matches_agent(issue: &Issue, agent_filter: &str) -> bool {
    issue
        .assignments
        .iter()
        .rev()
        .find(|a| a.ended_at.is_none())
        .or_else(|| issue.assignments.last())
        .is_some_and(|a| a.agent.eq_ignore_ascii_case(agent_filter))
}

fn build_client_for_home(base: &Client, target_home: &Path, channel: Option<ReleaseChannel>) -> Client {
    let flag_server = (base.server_source == ServerSource::Flag).then(|| base.server.clone());
    let env_server = (base.server_source == ServerSource::Env)
        .then(|| base.server.clone())
        .or_else(|| std::env::var("VIBEVALLEY_SERVER").ok());
    let stored_auth = auth::load(target_home).ok().flatten();
    let announced = home::announced(target_home).or_else(|| channel.map(|ch| format!("http://127.0.0.1:{}", ch.default_port())));
    Client::from_parts(
        target_home.to_path_buf(),
        flag_server,
        env_server,
        base.flag_token().cloned(),
        base.env_token().cloned(),
        stored_auth,
        announced,
        false,
        false,
    )
}

#[cfg(test)]
async fn serve_io<R, W>(server: &mut McpServer, reader: R, mut writer: W) -> Done
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = reader;
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|err| Failure::new(exit::OTHER, "Io", format!("failed to read MCP stdin: {err}")))?;
        if bytes == 0 {
            return Ok(());
        }
        if let Some(response) = server.handle_line(&line).await {
            let encoded =
                serde_json::to_string(&response).map_err(|err| Failure::new(exit::OTHER, "Encode", format!("failed to encode MCP response: {err}")))?;
            let write_res: std::io::Result<()> = async {
                writer.write_all(encoded.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await
            }
            .await;
            if let Err(err) = write_res {
                if err.kind() == std::io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(Failure::new(exit::OTHER, "Io", format!("failed to write MCP stdout: {err}")));
            }
        }
    }
}

pub async fn run(client: &Client, cmd: McpCmd) -> Done {
    let mut server = McpServer::new(client, cmd);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<std::io::Result<String>>(32);

    // Read blocking stdin lines on a dedicated OS thread so the Tokio runtime stays responsive.
    std::thread::Builder::new()
        .name("vibevalley-mcp-stdin".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = std::io::BufReader::new(stdin.lock());
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if tx.blocking_send(Ok(std::mem::take(&mut line))).is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = tx.blocking_send(Err(err));
                        break;
                    }
                }
            }
        })
        .map_err(|err| Failure::new(exit::OTHER, "Io", format!("failed to spawn MCP stdin reader: {err}")))?;

    while let Some(next_line) = rx.recv().await {
        let line = next_line.map_err(|err| Failure::new(exit::OTHER, "Io", format!("failed to read MCP stdin: {err}")))?;
        if let Some(response) = server.handle_line(&line).await {
            let encoded =
                serde_json::to_string(&response).map_err(|err| Failure::new(exit::OTHER, "Encode", format!("failed to encode MCP response: {err}")))?;
            let mut stdout = std::io::stdout().lock();
            if let Err(err) = writeln!(stdout, "{encoded}").and_then(|()| stdout.flush()) {
                if err.kind() == std::io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(Failure::new(exit::OTHER, "Io", format!("failed to write MCP stdout: {err}")));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client(home_dir: &Path) -> Client {
        Client::from_parts(
            home_dir.to_path_buf(),
            Some("http://127.0.0.1:9".into()),
            None,
            Some(Secret::new("vv_secret_bearer_token_123")),
            None,
            None,
            None,
            false,
            false,
        )
    }

    #[test]
    fn channel_alpha_resolves_canonical_home_and_port() {
        let base = Client::from_parts(PathBuf::from("/tmp/dev-home"), None, None, None, None, None, None, false, false);
        let server = McpServer::new(
            &base,
            McpCmd {
                channel: Some(ChannelArg::Alpha),
                home: None,
                vdp_port: None,
                vdp_url: None,
            },
        );
        let expected_home = home::home_for(ReleaseChannel::Alpha);
        assert_eq!(server.client.home, expected_home);
        assert_eq!(server.defaults.home, Some(expected_home));
        assert!(server.client.home.ends_with(".vibevalley-alpha"));
        assert_eq!(server.channel, Some(ReleaseChannel::Alpha));
        // Unless ~/.vibevalley-alpha has a live server.json or auth.json pointing elsewhere, fallback port is 8789.
        if auth::load(&server.client.home).ok().flatten().is_none() && home::announced(&server.client.home).is_none() {
            assert_eq!(server.client.server, "http://127.0.0.1:8789");
        }
    }

    #[test]
    fn vdp_target_override_precedence_respects_per_tool_home_and_port() {
        let client = test_client(Path::new("/tmp/default-home"));
        let server = McpServer::new(
            &client,
            McpCmd {
                channel: None,
                home: Some(PathBuf::from("/tmp/cli-home")),
                vdp_port: Some(9222),
                vdp_url: Some("ws://127.0.0.1:9222/devtools".into()),
            },
        );

        let default = server.resolve_vdp_target(&VdpOverrideArgs::default());
        assert_eq!(default.home, Some(PathBuf::from("/tmp/cli-home")));
        assert_eq!(default.port, Some(9222));
        assert_eq!(default.url.as_deref(), Some("ws://127.0.0.1:9222/devtools"));

        // Per-tool port overrides CLI --vdp-url while retaining default home for token lookup.
        let by_port = server.resolve_vdp_target(&VdpOverrideArgs { home: None, port: Some(9333) });
        assert_eq!(by_port.home, Some(PathBuf::from("/tmp/cli-home")));
        assert_eq!(by_port.port, Some(9333));
        assert_eq!(by_port.url, None);

        // Per-tool home overrides CLI --vdp-port and --vdp-url.
        let by_home = server.resolve_vdp_target(&VdpOverrideArgs {
            home: Some("/tmp/override-home".into()),
            port: None,
        });
        assert_eq!(by_home.home, Some(PathBuf::from("/tmp/override-home")));
        assert_eq!(by_home.port, None);
        assert_eq!(by_home.url, None);
    }

    #[test]
    fn redact_secrets_scrubs_tokens_from_tool_results() {
        let tok = Secret::new("vdp-super-secret-xyz");
        let res = McpToolResult::error("failed connecting with token vdp-super-secret-xyz").redact(&[&tok]);
        let McpContent::Text { text } = &res.content[0] else {
            panic!("expected text block");
        };
        assert!(!text.contains("vdp-super-secret-xyz"));
        assert!(text.contains("[redacted]"));
    }

    #[tokio::test]
    async fn stdio_loop_handles_initialize_notifications_ping_and_errors_without_crashing() {
        let client = test_client(Path::new("/tmp/mcp-unit-test"));
        let mut server = McpServer::new(&client, McpCmd::default());

        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "not valid json\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"vv_unknown\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"unknown/method\"}\n",
        );

        let mut output = Vec::new();
        serve_io(&mut server, tokio::io::BufReader::new(input.as_bytes()), &mut output).await.unwrap();

        let lines: Vec<Value> = String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        // 5 responses (notifications/initialized produces none).
        assert_eq!(lines.len(), 5, "{lines:?}");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(lines[0]["result"]["serverInfo"]["name"], "vibevalley");

        assert_eq!(lines[1]["error"]["code"], JSONRPC_PARSE_ERROR);

        assert_eq!(lines[2]["id"], 2);
        assert_eq!(lines[2]["result"], json!({}));

        assert_eq!(lines[3]["id"], 3);
        assert_eq!(lines[3]["result"]["isError"], true);

        assert_eq!(lines[4]["id"], 4);
        assert_eq!(lines[4]["error"]["code"], JSONRPC_METHOD_NOT_FOUND);
    }
}
