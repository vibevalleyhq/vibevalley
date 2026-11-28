//! MCP servers an agent profile attaches, their tools offered to the model
//! as `server__tool`: stdio and streamable HTTP servers, 120 s for connecting
//! and for each call, an unreachable server reported (not fatal), results
//! flattened to text.
mod client;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use self::client::Client;
use crate::ToolSpec;
use crate::ai::CancelToken;
use crate::tools::{Tool, ToolContext, ToolOutput};
use vibevalley_oar::BoxFuture;

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

/// Connected servers. Dropping it and its tools closes them.
pub struct McpHub {
    tools: Vec<McpTool>,
    /// Servers that could not offer their tools, with why.
    pub failures: Vec<(String, String)>,
}

impl McpHub {
    /// Each configured server connects and enumerates independently on the Tokio runtime.
    pub async fn connect(config: &McpConfig) -> McpHub {
        if config.servers.is_empty() {
            return McpHub {
                tools: vec![],
                failures: vec![],
            };
        }
        let entries: Vec<(usize, String, McpServerConfig)> = config
            .servers
            .iter()
            .enumerate()
            .map(|(idx, (name, cfg))| (idx, name.clone(), cfg.clone()))
            .collect();
        let mut set = tokio::task::JoinSet::new();
        for (idx, name, cfg) in entries {
            set.spawn(async move {
                let outcome = async {
                    let client = Arc::new(Client::connect_async(cfg).await?);
                    let mut tools = Vec::new();
                    for tool in client.tools_async().await? {
                        let remote = tool.name.into_owned();
                        if remote.is_empty() {
                            continue;
                        }
                        let description = tool.description.as_deref().unwrap_or_default();
                        tools.push(McpTool {
                            spec: ToolSpec {
                                name: tool_name(&name, &remote),
                                description: format!("（{name}）{description}"),
                                parameters: Value::Object((*tool.input_schema).clone()),
                            },
                            server: name.clone(),
                            remote,
                            read_only: tool.annotations.and_then(|a| a.read_only_hint).unwrap_or(false),
                            client: client.clone(),
                        });
                    }
                    Ok::<_, String>(tools)
                }
                .await;
                (idx, name, outcome)
            });
        }
        let mut results: Vec<(usize, String, Result<Vec<McpTool>, String>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(item) = joined {
                results.push(item);
            }
        }
        results.sort_by_key(|(idx, _, _)| *idx);
        let mut hub = McpHub {
            tools: vec![],
            failures: vec![],
        };
        for (_, name, outcome) in results {
            match outcome {
                Ok(tools) => hub.tools.extend(tools),
                Err(why) => hub.failures.push((name.clone(), format!("连不上 MCP 服务 {name}：{why}"))),
            }
        }
        hub
    }

    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        self.tools.iter().cloned().map(|tool| Box::new(tool) as Box<dyn Tool>).collect()
    }
}

#[derive(Clone)]
struct McpTool {
    spec: ToolSpec,
    server: String,
    remote: String,
    read_only: bool,
    client: Arc<Client>,
}

impl Tool for McpTool {
    fn is_mcp(&self) -> bool {
        true
    }

    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn replay_safe(&self) -> bool {
        self.read_only
    }

    fn execute<'a>(&'a self, args: &'a Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let never = CancelToken::never();
            self.call(args, &never).await
        })
    }

    fn execute_with_context<'a>(&'a self, args: &'a Value, ctx: &'a ToolContext) -> BoxFuture<'a, ToolOutput> {
        Box::pin(self.call(args, &ctx.cancel))
    }
}

impl McpTool {
    async fn call(&self, args: &Value, cancel: &CancelToken) -> ToolOutput {
        let arguments = args.as_object().cloned().unwrap_or_default();
        match self.client.call(self.remote.clone(), arguments, cancel).await {
            Err(e) => ToolOutput::error(format!("{} 的 {} 出错：{e}", self.server, self.remote)),
            Ok(result) => {
                let content: Vec<_> = match result.content.iter().map(serde_json::to_value).collect::<Result<_, _>>() {
                    Ok(blocks) => blocks,
                    Err(e) => return ToolOutput::error(e.to_string()),
                };
                let mut text = content_text(&content);
                if text.is_empty() {
                    text = result
                        .structured_content
                        .as_ref()
                        .map(Value::to_string)
                        .unwrap_or_else(|| "（没有内容）".into());
                }
                if result.is_error == Some(true) {
                    ToolOutput::error(text)
                } else {
                    ToolOutput::ok(text)
                }
            }
        }
    }
}
