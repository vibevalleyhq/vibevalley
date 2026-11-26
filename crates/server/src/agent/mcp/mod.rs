//! The helpers' MCP door (`gateway/mcp`): JSON-RPC over `POST /mcp` backed by
//! `vibevalley-mcp` (SEP-2575 stateless core, SEP-2640 Skills over MCP, and
//! legacy `initialize` compatibility).

mod door;
pub mod resource;
mod skills;

use vibevalley_protocol::Session;

use crate::BoxFuture;

pub use door::Mcp;
pub use resource::{McpResourceContentWire, McpResourceTemplateWire, McpResourceWire, Resource, ResourceReadArgs, ResourceReader};

/// Tool schema description exposed to the MCP door without importing `agent/tool`.
#[derive(Debug, Clone)]
pub struct ToolSpecWire {
    pub name: String,
    pub description: String,
    pub parameters_json: String,
}

/// Breaks the `agent/mcp <-> agent/tool` cycle so the MCP door dispatches helper tool calls while `agent/tool` reads `vv://` resources.
pub trait ToolDispatchPort: Send + Sync {
    fn helper_tools(&self) -> Vec<ToolSpecWire>;
    fn helper_tools_for(&self, _session: Option<&Session>) -> Vec<ToolSpecWire> {
        self.helper_tools()
    }
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn call_readonly_issue_tool_async<'a>(&'a self, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn list_resources_async<'a>(&'a self) -> BoxFuture<'a, Vec<McpResourceWire>>;
    fn list_resource_templates(&self) -> Vec<McpResourceTemplateWire>;
    fn read_resource_async<'a>(&'a self, session: Option<Session>, uri: &'a str) -> BoxFuture<'a, Result<McpResourceContentWire, String>>;
}
