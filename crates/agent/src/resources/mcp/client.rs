use std::future::Future;
use std::process::Stdio;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ClientConfig, Implementation, JsonObject, PaginatedRequestParams, ProtocolVersion, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};

use super::McpServerConfig;
use crate::ai::CancelToken;

const CALL_TIMEOUT: Duration = Duration::from_secs(120);

async fn run_with_timeout<T>(future: impl Future<Output = Result<T, String>>, cancel: &CancelToken) -> Result<T, String> {
    if cancel.is_cancelled() {
        return Err("aborted by the user".into());
    }
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err("aborted by the user".into()),
        res = tokio::time::timeout(CALL_TIMEOUT, future) => res.unwrap_or_else(|_| Err("timed out".into())),
    }
}

pub(super) struct Client(RunningService<RoleClient, ClientConfig>);

impl Client {
    pub(super) async fn connect_async(config: McpServerConfig) -> Result<Self, String> {
        run_with_timeout(
            async move {
                let info = ClientConfig::new(Default::default(), Implementation::new("vibevalley", env!("CARGO_PKG_VERSION")))
                    .with_protocol_version(ProtocolVersion::V_2025_06_18);
                let service = match config {
                    McpServerConfig::Stdio { command, args, env, cwd } => {
                        let mut cmd = tokio::process::Command::new(command);
                        cmd.args(args).envs(env);
                        if let Some(cwd) = cwd {
                            cmd.current_dir(cwd);
                        }
                        let (transport, _) = TokioChildProcess::builder(cmd).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
                        info.serve(transport).await
                    }
                    McpServerConfig::Http { url, headers } => {
                        let mut cfg = StreamableHttpClientTransportConfig::with_uri(url).reinit_on_expired_session(false);
                        for (name, value) in headers {
                            let key = name.parse().map_err(|_| format!("invalid MCP header name: {name}"))?;
                            let value = value.parse().map_err(|_| format!("invalid MCP header value for {name}"))?;
                            cfg.custom_headers.insert(key, value);
                        }
                        let _ = rustls::crypto::ring::default_provider().install_default();
                        info.serve(StreamableHttpClientTransport::from_config(cfg)).await
                    }
                }
                .map_err(|e| e.to_string())?;
                Ok(Self(service))
            },
            &CancelToken::never(),
        )
        .await
    }

    pub(super) async fn tools_async(&self) -> Result<Vec<Tool>, String> {
        let peer = self.0.peer().clone();
        run_with_timeout(
            async move {
                let mut tools = Vec::new();
                let mut cursor = None;
                for _ in 0..64 {
                    let page = peer
                        .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor)))
                        .await
                        .map_err(|e| e.to_string())?;
                    tools.extend(page.tools);
                    cursor = page.next_cursor.filter(|c| !c.is_empty());
                    if cursor.is_none() {
                        break;
                    }
                }
                Ok(tools)
            },
            &CancelToken::never(),
        )
        .await
    }

    pub(super) async fn call(&self, name: String, arguments: JsonObject, cancel: &CancelToken) -> Result<CallToolResult, String> {
        let peer = self.0.peer().clone();
        run_with_timeout(
            async move {
                peer.call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
                    .await
                    .map_err(|e| e.to_string())
            },
            cancel,
        )
        .await
    }
}
