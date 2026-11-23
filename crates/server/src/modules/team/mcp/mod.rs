//! The helpers' MCP door (`gateway/mcp`): JSON-RPC over `POST /mcp`. Each
//! helper's token, minted by the board when it starts the helper, names it;
//! its tools are served via `crate::ports::ToolDispatchPort` (zero concrete
//! dependency on `team/tool`).

pub mod resource;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::ports::{ToolDispatchPort, ToolSpecWire};
use crate::transport::api::Mcp;

pub use resource::{ResourceReadArgs, Resources};

const UNKNOWN_CALLER: &str = "没认出你是谁：这些工具只给执行会话用";
const PROTOCOL: &str = "2025-06-18";

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

pub struct Door {
    dispatch: Arc<dyn ToolDispatchPort>,
    tools: Vec<ToolSpecWire>,
    version: String,
}

impl Door {
    pub fn new(dispatch: Arc<dyn ToolDispatchPort>, version: String) -> Arc<Door> {
        let tools = dispatch.helper_tools();
        Arc::new(Door { dispatch, tools, version })
    }

    fn result(&self, token: &str, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let init: InitializeParams = serde_json::from_value(params).unwrap_or_default();
                let version = init.protocol_version.as_deref().unwrap_or(PROTOCOL);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "vibevalley", "version": self.version },
                }))
            }
            "ping" => Ok(json!({})),
            // The list is anyone's; a call names its caller (mcp.ts: the tools refuse an unknown one themselves).
            "tools/list" => {
                let tools: Vec<Value> = self
                    .tools
                    .iter()
                    .map(|t| {
                        let mut schema = t.parameters.clone();
                        schema["type"] = json!("object");
                        json!({ "name": t.name, "description": t.description, "inputSchema": schema })
                    })
                    .collect();
                Ok(json!({ "tools": tools }))
            }
            "tools/call" => {
                let Some(me) = self.dispatch.session_for_token(token) else {
                    return Ok(json!({ "content": [{ "type": "text", "text": UNKNOWN_CALLER }], "isError": true }));
                };
                let call: ToolCallParams = serde_json::from_value(params).unwrap_or_default();
                let args = match call.arguments {
                    Value::Object(map) => Value::Object(map),
                    _ => Value::Object(Map::new()),
                };
                let called = self.dispatch.call_helper(me, &call.name, &args);
                let (text, error) = match called {
                    Ok(text) => (text, false),
                    Err(why) if why.starts_with("没成：") => (why, true),
                    Err(why) => (format!("没成：{why}"), true),
                };
                let text = text.replace(token, "[redacted]");
                Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": error }))
            }
            other => Err((-32601, format!("method not found: {other}"))),
        }
    }
}

impl Mcp for Door {
    fn message(&self, token: &str, message: Value) -> Option<Value> {
        let req: RpcRequest = serde_json::from_value(message).ok()?;
        let id = req.id.filter(|id| !id.is_null())?;
        Some(match self.result(token, &req.method, req.params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, why)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": why } }),
        })
    }
}
