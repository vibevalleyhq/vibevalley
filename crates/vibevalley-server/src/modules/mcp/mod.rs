//! The helpers' MCP door (`gateway/mcp`): JSON-RPC over `POST /mcp`. Each
//! helper's token, minted by the board when it starts the helper, names it;
//! its tools are `helper.rs`'s.

pub mod helper;
pub mod resource;

use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_server_api::Mcp;

pub use helper::Helpers;
pub use resource::Resources;

const UNKNOWN_CALLER: &str = "没认出你是谁：这些工具只给帮工用";
const PROTOCOL: &str = "2025-06-18";

pub struct Door {
    pub helpers: Helpers,
    pub version: String,
}

impl Door {
    pub fn new(helpers: Helpers, version: String) -> Arc<Door> {
        Arc::new(Door { helpers, version })
    }

    fn result(&self, token: &str, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or(PROTOCOL),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "vibevalley", "version": self.version },
            })),
            "ping" => Ok(json!({})),
            // The list is anyone's; a call names its caller (mcp.ts: the tools refuse an unknown one themselves).
            "tools/list" => {
                let tools: Vec<Value> = helper::TOOLS
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
                let Some(me) = self.caller(token) else {
                    return Ok(json!({ "content": [{ "type": "text", "text": UNKNOWN_CALLER }], "isError": true }));
                };
                let name = params["name"].as_str().unwrap_or("");
                let args = params.get("arguments").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
                let (text, error) = match self.helpers.call(&me, name, &args) {
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

    fn caller(&self, token: &str) -> Option<vibevalley_protocol::Session> {
        self.helpers.board.session(&self.helpers.board.who(token)?)
    }
}

impl Mcp for Door {
    fn message(&self, token: &str, message: Value) -> Option<Value> {
        let id = message.get("id").cloned().filter(|id| !id.is_null())?;
        let method = message["method"].as_str().unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Some(match self.result(token, method, &params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, why)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": why } }),
        })
    }
}
