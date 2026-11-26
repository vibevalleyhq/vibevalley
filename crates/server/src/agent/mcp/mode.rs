//! Mode-scoped MCP tool exposure and dispatch port (`执行 / 起草 / 只读问答`).

use serde_json::{Value, json};
use vibevalley_mcp::ToolDef;
use vibevalley_protocol::Session;

use super::resource::{McpResourceContentWire, McpResourceTemplateWire, McpResourceWire};
use crate::BoxFuture;

/// Tool schema description exposed to the MCP door without importing `agent/tool`.
#[derive(Debug, Clone)]
pub struct ToolSpecWire {
    pub name: String,
    pub description: String,
    pub parameters_json: String,
}

/// Converts wire tool specs from `ToolDispatchPort` into MCP `ToolDef` entries.
pub fn to_tool_defs(specs: Vec<ToolSpecWire>) -> Vec<ToolDef> {
    specs
        .into_iter()
        .map(|t| {
            let mut schema: Value = serde_json::from_str(&t.parameters_json).unwrap_or_else(|_| json!({}));
            schema["type"] = json!("object");
            ToolDef {
                name: t.name,
                description: t.description,
                input_schema: schema,
            }
        })
        .collect()
}

/// Mode-scoped tool access levels for `/mcp` helper sessions (`执行 / 起草 / 只读问答`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperRunMode {
    Execution,
    Drafting,
    ReadOnlyAnswer,
}

impl HelperRunMode {
    pub fn label_zh(self) -> &'static str {
        match self {
            Self::Execution => "执行",
            Self::Drafting => "起草",
            Self::ReadOnlyAnswer => "只读问答",
        }
    }
}

/// Returns whether MCP tool `name` is exposed and callable in `mode`.
pub fn tool_allowed_in_mode(name: &str, mode: HelperRunMode) -> bool {
    let readonly = matches!(
        name,
        "resource_read"
            | "channel_message_list"
            | "channel_unread_list"
            | "session_list"
            | "memory_search"
            | "issue_list"
            | "issue_get"
            | "artifact_list"
            | "artifact_get"
            | "artifact_content_get"
            | "artifact_type_list"
            | "artifact_type_read"
            | "artifact_file_list"
            | "artifact_file_get"
            | "artifact_suggestion_list"
            | "library_item_list"
    );
    match mode {
        HelperRunMode::Execution => true,
        HelperRunMode::Drafting => readonly,
        HelperRunMode::ReadOnlyAnswer => readonly || name == "issue_report",
    }
}

/// Breaks the `agent/mcp <-> agent/tool` cycle so the MCP door dispatches helper tool calls while `agent/tool` reads `vv://` resources.
pub trait ToolDispatchPort: Send + Sync {
    fn helper_tools(&self) -> Vec<ToolSpecWire>;
    fn helper_tools_for(&self, _session: Option<&Session>) -> Vec<ToolSpecWire> {
        self.helper_tools()
    }
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn session_mode_async<'a>(&'a self, session: &'a Session) -> BoxFuture<'a, HelperRunMode>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn call_readonly_issue_tool_async<'a>(&'a self, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn list_resources_async<'a>(&'a self) -> BoxFuture<'a, Vec<McpResourceWire>>;
    fn list_resource_templates(&self) -> Vec<McpResourceTemplateWire>;
    fn read_resource_async<'a>(&'a self, session: Option<Session>, uri: &'a str) -> BoxFuture<'a, Result<McpResourceContentWire, String>>;
}

/// Filters `tools` for `bearer_token`'s agent toolsets and session mode, or returns `None` if the token is unknown.
pub async fn tools_for_token_async(dispatch: &dyn ToolDispatchPort, tools: &[ToolDef], bearer_token: Option<&str>) -> Option<Vec<ToolDef>> {
    let token = bearer_token.unwrap_or("");
    if token.is_empty() {
        return Some(tools.to_vec());
    }
    let me = dispatch.session_for_token(token).await?;
    let mode = dispatch.session_mode_async(&me).await;
    Some(
        to_tool_defs(dispatch.helper_tools_for(Some(&me)))
            .into_iter()
            .filter(|t| tool_allowed_in_mode(&t.name, mode))
            .collect(),
    )
}

/// Executes a tool call for `bearer_token`, enforcing mode-scoped write-tool narrowing.
pub async fn dispatch_tool_for_token_async(
    dispatch: &dyn ToolDispatchPort,
    bearer_token: Option<&str>,
    name: &str,
    args_json: &str,
    unknown_caller: &str,
) -> Result<String, String> {
    let token = bearer_token.unwrap_or("");
    if token.is_empty() {
        if !matches!(name, "issue_list" | "issue_get") {
            return Err(unknown_caller.to_string());
        }
        return dispatch.call_readonly_issue_tool_async(name, args_json).await;
    }
    let Some(me) = dispatch.session_for_token(token).await else {
        return Err(unknown_caller.to_string());
    };
    let mode = dispatch.session_mode_async(&me).await;
    if !tool_allowed_in_mode(name, mode) {
        return Err(format!("没成：当前{}模式只读，不能调用 {name}", mode.label_zh()));
    }
    dispatch.call_helper_async(me, name, args_json).await
}
