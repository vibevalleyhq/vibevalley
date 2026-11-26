//! Strongly-typed JSON-RPC 2.0 and MCP protocol models and constants.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const JSONRPC_VERSION: &str = "2.0";

/// SEP-2575 stateless Streamable HTTP MCP protocol version.
pub const PROTOCOL_STATELESS: &str = "2026-07-28";

/// Legacy stateful MCP protocol version supported for existing coding-agent clients.
pub const PROTOCOL_LEGACY: &str = "2025-06-18";

/// All MCP protocol versions accepted by this crate, ordered newest first.
pub const SUPPORTED_PROTOCOLS: &[&str] = &["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"];

/// SEP-2575 `_meta` key declaring the caller's protocol version on stateless requests.
pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";

/// SEP-2575 `_meta` key declaring client capabilities on stateless requests.
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";

/// SEP-2640 capability extension key for Skills over MCP (`skill://`).
pub const EXT_SKILLS: &str = "io.modelcontextprotocol/skills";

/// SEP-2243 HTTP header carrying the MCP protocol version.
pub const HEADER_PROTOCOL_VERSION: &str = "MCP-Protocol-Version";

/// SEP-2243 HTTP header mirroring JSON-RPC `method` for L7 routing.
pub const HEADER_METHOD: &str = "Mcp-Method";

/// SEP-2243 HTTP header mirroring `params.name` (or target URI) for L7 routing.
pub const HEADER_NAME: &str = "Mcp-Name";

/// Standard JSON-RPC 2.0 and MCP protocol error codes.
pub mod error_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const UNAUTHORIZED: i64 = -32001;
    pub const RESOURCE_NOT_FOUND: i64 = -32002;
    /// SEP-2243: HTTP routing header disagrees with the JSON-RPC request body.
    pub const HEADER_MISMATCH: i64 = -32020;
}

/// JSON-RPC 2.0 request/response identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Int(i64),
    Uint(u64),
    Str(String),
    Null,
}

impl RpcId {
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
}

impl From<i64> for RpcId {
    fn from(value: i64) -> Self {
        Self::Int(value)
    }
}

impl From<u64> for RpcId {
    fn from(value: u64) -> Self {
        Self::Uint(value)
    }
}

impl From<String> for RpcId {
    fn from(value: String) -> Self {
        Self::Str(value)
    }
}

impl From<&str> for RpcId {
    fn from(value: &str) -> Self {
        Self::Str(value.to_owned())
    }
}

/// Self-describing `_meta` envelope carried inside `params._meta` (SEP-2575).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestMeta {
    #[serde(rename = "io.modelcontextprotocol/protocolVersion", default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(rename = "io.modelcontextprotocol/clientCapabilities", default, skip_serializing_if = "Option::is_none")]
    pub client_capabilities: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Incoming JSON-RPC 2.0 request or notification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    #[serde(default)]
    pub id: Option<RpcId>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl RpcRequest {
    /// True when the message omits `id` or passes `id: null` (JSON-RPC notification).
    pub fn is_notification(&self) -> bool {
        self.id.as_ref().is_none_or(RpcId::is_null)
    }

    /// Decodes `params._meta` when present and well-formed.
    pub fn meta(&self) -> RequestMeta {
        self.params
            .as_object()
            .and_then(|obj| obj.get("_meta"))
            .cloned()
            .and_then(|raw| serde_json::from_value(raw).ok())
            .unwrap_or_default()
    }

    /// Extracts the routable target name (`params.name`, falling back to `params.uri` for read/get methods).
    pub fn target_name(&self) -> Option<&str> {
        let obj = self.params.as_object()?;
        if let Some(name) = obj.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            return Some(name);
        }
        obj.get("uri").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
    }

    /// Extracts `params.protocolVersion` for `initialize` requests.
    pub fn initialize_protocol_version(&self) -> Option<&str> {
        if self.method.trim() != "initialize" {
            return None;
        }
        self.params
            .as_object()?
            .get("protocolVersion")?
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// Structured JSON-RPC 2.0 error payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(error_code::PARSE_ERROR, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(error_code::INVALID_REQUEST, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(error_code::METHOD_NOT_FOUND, format!("method not found: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(error_code::INVALID_PARAMS, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(error_code::INTERNAL_ERROR, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(error_code::UNAUTHORIZED, message)
    }

    pub fn resource_not_found(message: impl Into<String>) -> Self {
        Self::new(error_code::RESOURCE_NOT_FOUND, message)
    }

    pub fn header_mismatch(header: &str, expected: Option<&str>, actual: &str, message: impl Into<String>) -> Self {
        Self::with_data(
            error_code::HEADER_MISMATCH,
            message,
            json!({
                "header": header,
                "expected": expected,
                "actual": actual,
            }),
        )
    }
}

/// Outgoing JSON-RPC 2.0 response envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: RpcId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: RpcId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn ok_typed<T: Serialize>(id: RpcId, value: &T) -> Self {
        match serde_json::to_value(value) {
            Ok(val) => Self::ok(id, val),
            Err(err) => Self::err(id, RpcError::internal(format!("failed to encode response: {err}"))),
        }
    }

    pub fn err(id: RpcId, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// Server identity returned by `initialize` and `server/discover`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl ServerInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
            title: None,
        }
    }
}

/// Tools capability declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_changed: Option<bool>,
}

/// Resources capability declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscribe: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_changed: Option<bool>,
}

/// Server capability set including protocol extensions (such as SEP-2640 Skills).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourcesCapability>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, Value>,
}

impl ServerCapabilities {
    pub fn with_tools(mut self) -> Self {
        self.tools = Some(ToolsCapability::default());
        self
    }

    pub fn with_resources(mut self) -> Self {
        self.resources = Some(ResourcesCapability::default());
        self
    }

    pub fn with_skills_extension(mut self, directory_read: bool) -> Self {
        self.extensions.insert(EXT_SKILLS.to_owned(), json!({ "directoryRead": directory_read }));
        self
    }
}

/// Legacy `initialize` request parameters.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Value>,
    #[serde(default)]
    pub client_info: Option<Value>,
}

/// Legacy `initialize` result payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
    pub server_info: ServerInfo,
}

/// SEP-2575 `server/discover` response payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDiscoverResult {
    pub supported_protocol_versions: Vec<String>,
    pub capabilities: ServerCapabilities,
    pub server_info: ServerInfo,
    pub stateless: bool,
}

/// MCP tool definition returned by `tools/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Parameters for `tools/call`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolCallParams {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// Standard MCP resource entry returned by `resources/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDef {
    pub uri: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// Standard MCP resource URI template returned by `resources/templates/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTemplateDef {
    pub uri_template: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// Parameters for `resources/read`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ResourceReadParams {
    #[serde(default)]
    pub uri: String,
}

/// Single content item returned by `resources/read` or embedded inside [`ContentBlock::Resource`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContent {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

impl ResourceContent {
    pub fn text(uri: impl Into<String>, mime_type: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            mime_type: Some(mime_type.into()),
            text: Some(text.into()),
            blob: None,
        }
    }
}

/// Typed MCP tool result content block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        data: String,
        mime_type: String,
    },
    Resource {
        resource: ResourceContent,
    },
}

/// Result payload returned by `tools/call`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub is_error: bool,
}

impl ToolCallResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: text.into() }],
            is_error: false,
        }
    }

    pub fn json<T: Serialize>(value: &T) -> Self {
        match serde_json::to_string_pretty(value) {
            Ok(text) => Self::text(text),
            Err(err) => Self::error(format!("failed to serialize tool result: {err}")),
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: message.into() }],
            is_error: true,
        }
    }
}

/// Returns true when `version` is in [`SUPPORTED_PROTOCOLS`].
pub fn is_supported_protocol(version: &str) -> bool {
    SUPPORTED_PROTOCOLS.contains(&version)
}
