//! Pure Model Context Protocol (MCP) crate shared by `vibevalley-server`,
//! `vibevalley-cli`, and future OAR/runtime adapters.
//!
//! Covers:
//! - Typed JSON-RPC 2.0 & MCP protocol models ([`protocol`])
//! - SEP-2575 Stateless Core (`server/discover`, self-describing `_meta`) &
//!   SEP-2243 Routable Streamable HTTP header validation ([`stateless`])
//! - SEP-2640 Skills over MCP (`skill://`, `skills/list`, `skills/get`) ([`skills`])
//! - Async newline-delimited JSON-RPC 2.0 stdio server runner ([`stdio`])
//! - Pure transport-agnostic [`config::McpServerConfig`] specs ([`config`])
//! - Secret redaction helpers ([`redact`])

pub mod config;
pub mod protocol;
pub mod redact;
pub mod skills;
pub mod stateless;
pub mod stdio;

pub use config::{McpServerConfig, McpTransportSpec};
pub use protocol::{
    ContentBlock, EXT_SKILLS, HEADER_METHOD, HEADER_NAME, HEADER_PROTOCOL_VERSION, InitializeParams, InitializeResult, JSONRPC_VERSION,
    META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, PROTOCOL_LEGACY, PROTOCOL_STATELESS, RequestMeta, ResourceContent, ResourceDef, ResourceReadParams,
    ResourceTemplateDef, RpcError, RpcId, RpcRequest, RpcResponse, SUPPORTED_PROTOCOLS, ServerCapabilities, ServerDiscoverResult, ServerInfo, ToolCallParams,
    ToolCallResult, ToolDef, ToolsCapability, error_code,
};
pub use redact::{REDACTED_MARKER, scrub_resource_content, scrub_secrets, scrub_tool_result};
pub use skills::{SKILL_URI_SCHEME, SkillCatalog, SkillDef, SkillDocument, SkillGetParams, SkillListParams, builtin_note_skill_catalog, builtin_note_skills};
pub use stateless::{
    BoxFuture, HttpHeaders, HttpReply, HttpValidationError, McpHandler, RequestContext, ResponseHeaders, ValidatedHttpBody, build_response_headers,
    dispatch_http, dispatch_json, dispatch_line, dispatch_request,
};
pub use stdio::{serve_io, serve_stdio};
