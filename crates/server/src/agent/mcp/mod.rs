//! The helpers' MCP door (`gateway/mcp`): JSON-RPC over `POST /mcp`. Each
//! helper's token, minted by the runtime when it starts the helper, names it;
//! its tools are dispatched asynchronously through [`ToolDispatchPort`].

pub mod resource;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use vibevalley_protocol::Session;

use crate::BoxFuture;
use crate::context::api::Mcp as McpGateway;

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
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn call_readonly_issue_tool_async<'a>(&'a self, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn list_resources_async<'a>(&'a self) -> BoxFuture<'a, Vec<McpResourceWire>>;
    fn list_resource_templates(&self) -> Vec<McpResourceTemplateWire>;
    fn read_resource_async<'a>(&'a self, session: Option<Session>, uri: &'a str) -> BoxFuture<'a, Result<McpResourceContentWire, String>>;
}

const UNKNOWN_CALLER: &str = "没认出你是谁：这些工具只给执行会话用";
const PROTOCOL: &str = "2025-06-18";

fn is_readonly_issue_tool(name: &str) -> bool {
    matches!(name, "issue_list" | "issue_get")
}

#[derive(Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    #[serde(default)]
    protocol_version: Option<String>,
}

#[derive(Deserialize, Default)]
struct ToolCallParams {
    #[serde(default)]
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize, Default)]
struct ResourceReadParams {
    #[serde(default)]
    uri: String,
}

/// JSON-RPC MCP endpoint serving helper tools and `vv://` resources over `POST /mcp`.
pub struct Mcp {
    dispatch: Arc<dyn ToolDispatchPort>,
    tools: Vec<ToolSpecWire>,
    version: String,
}

impl Mcp {
    pub fn new(dispatch: Arc<dyn ToolDispatchPort>, version: String) -> Arc<Mcp> {
        let tools = dispatch.helper_tools();
        Arc::new(Mcp { dispatch, tools, version })
    }

    async fn result_async(&self, token: &str, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let init: InitializeParams = serde_json::from_value(params).unwrap_or_default();
                let version = init.protocol_version.as_deref().unwrap_or(PROTOCOL);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {}, "resources": {} },
                    "serverInfo": { "name": "vibevalley", "version": self.version },
                }))
            }
            "ping" => Ok(json!({})),
            // The list is anyone's; a call names its caller (the tools refuse an unknown one themselves).
            "tools/list" => {
                let tools: Vec<Value> = self
                    .tools
                    .iter()
                    .map(|t| {
                        let mut schema: Value = serde_json::from_str(&t.parameters_json).unwrap_or_else(|_| json!({}));
                        schema["type"] = json!("object");
                        json!({ "name": t.name, "description": t.description, "inputSchema": schema })
                    })
                    .collect();
                Ok(json!({ "tools": tools }))
            }
            "tools/call" => {
                let call: ToolCallParams = serde_json::from_value(params).unwrap_or_default();
                let args = match call.arguments {
                    Value::Object(map) => Value::Object(map),
                    _ => Value::Object(Map::new()),
                };
                let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                let called = if token.is_empty() {
                    if !is_readonly_issue_tool(&call.name) {
                        return Ok(json!({ "content": [{ "type": "text", "text": UNKNOWN_CALLER }], "isError": true }));
                    }
                    self.dispatch.call_readonly_issue_tool_async(&call.name, &args_json).await
                } else {
                    let Some(me) = self.dispatch.session_for_token(token).await else {
                        return Ok(json!({ "content": [{ "type": "text", "text": UNKNOWN_CALLER }], "isError": true }));
                    };
                    self.dispatch.call_helper_async(me, &call.name, &args_json).await
                };
                let (text, error) = match called {
                    Ok(text) => (text, false),
                    Err(why) if why.starts_with("没成：") => (why, true),
                    Err(why) => (format!("没成：{why}"), true),
                };
                let text = if token.is_empty() { text } else { text.replace(token, "[redacted]") };
                Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": error }))
            }
            "resources/list" => {
                if !token.is_empty() && self.dispatch.session_for_token(token).await.is_none() {
                    return Err((-32001, UNKNOWN_CALLER.to_string()));
                }
                let resources = self.dispatch.list_resources_async().await;
                Ok(json!({ "resources": resources }))
            }
            "resources/templates/list" => {
                if !token.is_empty() && self.dispatch.session_for_token(token).await.is_none() {
                    return Err((-32001, UNKNOWN_CALLER.to_string()));
                }
                let templates = self.dispatch.list_resource_templates();
                Ok(json!({ "resourceTemplates": templates }))
            }
            "resources/read" => {
                let read: ResourceReadParams = serde_json::from_value(params).unwrap_or_default();
                let uri = read.uri.trim();
                if uri.is_empty() {
                    return Err((-32602, "missing resource uri".to_string()));
                }
                let session = if token.is_empty() {
                    None
                } else {
                    let Some(me) = self.dispatch.session_for_token(token).await else {
                        return Err((-32001, UNKNOWN_CALLER.to_string()));
                    };
                    Some(me)
                };
                let mut content = self.dispatch.read_resource_async(session, uri).await.map_err(|why| (-32002, why))?;
                if !token.is_empty() {
                    content.text = content.text.replace(token, "[redacted]");
                }
                Ok(json!({ "contents": [content] }))
            }
            other => Err((-32601, format!("method not found: {other}"))),
        }
    }
}

impl McpGateway for Mcp {
    fn message_json(&self, _token: &str, message_json: &str) -> Option<String> {
        let req: RpcRequest = serde_json::from_str(message_json).ok()?;
        let id = req.id.filter(|id| !id.is_null())?;
        serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": "sync Mcp::message_json is unsupported; use Mcp::message_json_async" },
        }))
        .ok()
    }

    fn message_json_async(self: Arc<Self>, token: String, message_json: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async move {
            let req: RpcRequest = serde_json::from_str(&message_json).ok()?;
            let id = req.id.filter(|id| !id.is_null())?;
            let response = match self.result_async(&token, &req.method, req.params).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, why)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": why } }),
            };
            serde_json::to_string(&response).ok()
        })
    }
}
