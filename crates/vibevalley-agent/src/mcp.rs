//! MCP servers an agent profile attaches, their tools offered to the model
//! as `server__tool`. Ported from VibeValley
//! `packages/agent/src/infra/mcp.ts`: stdio and streamable HTTP servers,
//! 120 s for connecting and for each call, a server that cannot be reached
//! reported (not fatal), results flattened to text.
//!
//! Uses the official Rust SDK (`rmcp`) on a private Tokio runtime; the
//! `Tool`s it returns are synchronous like every other tool.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::model::ToolSpec;
use crate::tool::{Tool, ToolOutput};

const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// `mcp.json` as VibeValley and Claude Code write it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum McpServerConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

impl McpConfig {
    pub fn read(path: &std::path::Path) -> Result<McpConfig, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{} 不是 JSON 或配置形状不对：{e}", path.display()))
    }
}

/// The server's name first, only characters function names allow.
pub fn tool_name(server: &str, tool: &str) -> String {
    format!("{server}__{tool}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect()
}

/// Text of an MCP result's content blocks.
pub fn content_text(content: &[Value]) -> String {
    let parts: Vec<String> = content
        .iter()
        .map(|block| match block["type"].as_str().unwrap_or_default() {
            "text" => block["text"].as_str().unwrap_or_default().to_string(),
            "image" => "[image]".into(),
            "audio" => "[audio]".into(),
            "resource_link" => "[resource_link]".into(),
            "resource" => match (block.pointer("/resource/text"), block.pointer("/resource/uri")) {
                (Some(Value::String(t)), _) if !t.is_empty() => t.clone(),
                (_, Some(Value::String(u))) => format!("[{u}]"),
                _ => "[资源]".into(),
            },
            _ => String::new(),
        })
        .collect();
    parts.join("\n").trim().to_string()
}

/// Connected servers. Dropping it closes them.
pub struct McpHub {
    runtime: Arc<tokio::runtime::Runtime>,
    servers: Vec<(String, Arc<RunningService<RoleClient, ()>>)>,
    /// Servers that could not be reached, with why.
    pub failures: Vec<(String, String)>,
}

impl McpHub {
    /// Connects every server of `config`, each within 120 s, in parallel.
    pub fn connect(config: &McpConfig) -> McpHub {
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("vibevalley-mcp")
                .build()
                .expect("a tokio runtime"),
        );
        let mut servers = Vec::new();
        let mut failures = Vec::new();
        let results = runtime.block_on(async {
            let tasks: Vec<_> = config
                .servers
                .iter()
                .map(|(name, cfg)| {
                    let name = name.clone();
                    let cfg = cfg.clone();
                    tokio::spawn(async move {
                        let started = tokio::time::timeout(CALL_TIMEOUT, start(&cfg)).await;
                        let result = match started {
                            Ok(r) => r,
                            Err(_) => Err("timed out".to_string()),
                        };
                        (name, result)
                    })
                })
                .collect();
            let mut out = Vec::new();
            for task in tasks {
                if let Ok(r) = task.await {
                    out.push(r);
                }
            }
            out
        });
        for (name, result) in results {
            match result {
                Ok(service) => servers.push((name, Arc::new(service))),
                Err(why) => failures.push((name.clone(), format!("连不上 MCP 服务 {name}：{why}"))),
            }
        }
        McpHub { runtime, servers, failures }
    }

    /// Every tool of every connected server.
    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        let mut out: Vec<Box<dyn Tool>> = Vec::new();
        for (server, service) in &self.servers {
            // The timer must be made inside the runtime.
            let listed = self
                .runtime
                .block_on(async { tokio::time::timeout(CALL_TIMEOUT, service.list_all_tools()).await });
            let Ok(Ok(tools)) = listed else { continue };
            for tool in tools {
                let value = serde_json::to_value(&tool).unwrap_or_default();
                let remote = value["name"].as_str().unwrap_or_default().to_string();
                let description = value["description"].as_str().unwrap_or_default();
                out.push(Box::new(McpTool {
                    spec: ToolSpec {
                        name: tool_name(server, &remote),
                        description: format!("（{server}）{description}"),
                        parameters: value.get("inputSchema").cloned().unwrap_or_else(|| serde_json::json!({"type": "object"})),
                    },
                    server: server.clone(),
                    remote,
                    read_only: value.pointer("/annotations/readOnlyHint").and_then(Value::as_bool).unwrap_or(false),
                    service: service.clone(),
                    runtime: self.runtime.clone(),
                }));
            }
        }
        out
    }
}

async fn start(cfg: &McpServerConfig) -> Result<RunningService<RoleClient, ()>, String> {
    match cfg {
        McpServerConfig::Stdio { command, args, env, cwd } => {
            let command = tokio::process::Command::new(command).configure(|c| {
                c.args(args).envs(env);
                if let Some(cwd) = cwd {
                    c.current_dir(cwd);
                }
            });
            let transport = TokioChildProcess::new(command).map_err(|e| e.to_string())?;
            ().serve(transport).await.map_err(|e| e.to_string())
        }
        McpServerConfig::Http { url, headers } => {
            let transport = match headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")) {
                Some((_, value)) => {
                    let token = value.strip_prefix("Bearer ").unwrap_or(value).to_string();
                    StreamableHttpClientTransport::from_config(
                        rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url.as_str()).auth_header(token),
                    )
                }
                None => StreamableHttpClientTransport::from_uri(url.as_str()),
            };
            ().serve(transport).await.map_err(|e| e.to_string())
        }
    }
}

struct McpTool {
    spec: ToolSpec,
    server: String,
    remote: String,
    read_only: bool,
    service: Arc<RunningService<RoleClient, ()>>,
    runtime: Arc<tokio::runtime::Runtime>,
}

impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn replay_safe(&self) -> bool {
        self.read_only
    }

    fn execute(&self, args: &Value) -> ToolOutput {
        let mut params = CallToolRequestParams::new(self.remote.clone());
        params.arguments = match args {
            Value::Object(map) => Some(map.clone()),
            _ => Some(Map::new()),
        };
        let called = self
            .runtime
            .block_on(async { tokio::time::timeout(CALL_TIMEOUT, self.service.call_tool(params)).await });
        match called {
            Err(_) => ToolOutput::error(format!("{} 的 {} 出错：timed out", self.server, self.remote)),
            Ok(Err(e)) => ToolOutput::error(format!("{} 的 {} 出错：{e}", self.server, self.remote)),
            Ok(Ok(result)) => {
                let value = serde_json::to_value(&result).unwrap_or_default();
                let blocks = value["content"].as_array().cloned().unwrap_or_default();
                let mut text = content_text(&blocks);
                if text.is_empty() {
                    text = value.get("structuredContent").map(Value::to_string).unwrap_or_else(|| "（没有内容）".into());
                }
                if value["isError"].as_bool().unwrap_or(false) {
                    ToolOutput::error(text)
                } else {
                    ToolOutput::ok(text)
                }
            }
        }
    }
}
