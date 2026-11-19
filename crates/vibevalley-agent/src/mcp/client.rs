use std::future::Future;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ClientConfig, Implementation, JsonObject, PaginatedRequestParams, ProtocolVersion, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use tokio::runtime::Runtime;

use super::McpServerConfig;

const CALL_TIMEOUT: Duration = Duration::from_secs(120);

fn runtime() -> Result<&'static Runtime, String> {
    static MCP: OnceLock<Result<Runtime, String>> = OnceLock::new();
    MCP.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("vibevalley-mcp")
            .enable_all()
            .build()
            .map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn request<T: Send + 'static>(future: impl Future<Output = Result<T, String>> + Send + 'static, cancelled: Option<&flume::Receiver<()>>) -> Result<T, String> {
    if cancelled.is_some_and(flume::Receiver::is_disconnected) {
        return Err("aborted by the user".into());
    }
    let (tx, rx) = flume::bounded(1);
    let task = runtime()?.spawn(async move {
        let result = tokio::time::timeout(CALL_TIMEOUT, future).await.unwrap_or_else(|_| Err("timed out".into()));
        let _ = tx.send(result);
    });
    let receive = |result: Result<Result<T, String>, flume::RecvError>| result.map_err(|_| "MCP task stopped".to_string())?;
    match cancelled {
        None => receive(rx.recv()),
        Some(stop) => flume::Selector::new()
            .recv(&rx, receive)
            .recv(stop, |_| {
                task.abort();
                Err("aborted by the user".into())
            })
            .wait(),
    }
}

pub(super) struct Client(RunningService<RoleClient, ClientConfig>);

impl Client {
    pub(super) fn connect(config: &McpServerConfig) -> Result<Self, String> {
        let config = config.clone();
        request(
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
            None,
        )
    }

    pub(super) fn tools(&self) -> Result<Vec<Tool>, String> {
        let peer = self.0.peer().clone();
        request(
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
            None,
        )
    }

    pub(super) fn call(&self, name: String, arguments: JsonObject, cancelled: Option<&flume::Receiver<()>>) -> Result<CallToolResult, String> {
        let peer = self.0.peer().clone();
        request(
            async move {
                peer.call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
                    .await
                    .map_err(|e| e.to_string())
            },
            cancelled,
        )
    }
}
