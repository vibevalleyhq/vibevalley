//! `runtime.mcp.*` & `runtime.mcpServer.*` endpoints delegating host probing and
//! configuration management strictly to OAR (`vibevalley_runtime::oar::mcp_install`).

use std::collections::BTreeMap;

use vibevalley_mcp::{McpServerConfig, McpTransportSpec};
use vibevalley_protocol::home::{ReleaseChannel, current_channel, default_port};
use vibevalley_protocol::{
    ApiError, BizCode, McpHostId, McpHostInfo, McpInstallInput, McpInstallStatus, McpListInput, McpListResult, McpServerEntry, McpServerListInput,
    McpServerListResult, McpServerRemoveInput, McpServerSaveInput, McpServerToggleInput, McpTransportKind, McpUninstallInput,
};
use vibevalley_runtime::oar::{
    HostMcpServer, McpHostId as OarMcpHostId, McpHostReport, McpInstallError, McpInstallState, host_mcp_config_path, install_mcp_host, list_host_mcp_servers,
    list_mcp_hosts, remove_host_mcp_server, render_mcp_snippet, set_host_mcp_server_enabled, uninstall_mcp_host, upsert_host_mcp_server,
};

use super::Runtime;

const MCP_SERVER_NAME: &str = "vibevalley";
const MCP_STDIO_COMMAND: &str = "vibevalley";

fn stdio_args() -> Vec<String> {
    let channel = current_channel();
    if channel == ReleaseChannel::Release {
        vec!["mcp".to_owned()]
    } else {
        vec!["mcp".to_owned(), "--channel".to_owned(), channel.as_str().to_owned()]
    }
}

fn to_oar_host(host: McpHostId) -> OarMcpHostId {
    match host {
        McpHostId::Antigravity => OarMcpHostId::Antigravity,
        McpHostId::Claude => OarMcpHostId::Claude,
        McpHostId::Codex => OarMcpHostId::Codex,
        McpHostId::Cursor => OarMcpHostId::Cursor,
    }
}

fn from_oar_host(host: OarMcpHostId) -> McpHostId {
    match host {
        OarMcpHostId::Antigravity => McpHostId::Antigravity,
        OarMcpHostId::Claude => McpHostId::Claude,
        OarMcpHostId::Codex => McpHostId::Codex,
        OarMcpHostId::Cursor => McpHostId::Cursor,
    }
}

fn transport_kind(spec: &McpTransportSpec) -> McpTransportKind {
    match spec {
        McpTransportSpec::Stdio { .. } => McpTransportKind::Stdio,
        McpTransportSpec::StreamableHttp { .. } => McpTransportKind::StreamableHttp,
    }
}

fn map_status(state: McpInstallState) -> McpInstallStatus {
    match state {
        McpInstallState::NotInstalled => McpInstallStatus::NotInstalled,
        McpInstallState::Installed { transport } => McpInstallStatus::Installed {
            transport: transport_kind(&transport),
        },
        McpInstallState::Outdated { current, reason } => McpInstallStatus::Outdated {
            current: transport_kind(&current),
            reason,
        },
        McpInstallState::Unsupported { reason } => McpInstallStatus::Unsupported { reason },
    }
}

fn map_error(err: McpInstallError) -> ApiError {
    let code = match err {
        McpInstallError::InvalidServerName(_) | McpInstallError::UnsupportedTransport { .. } => BizCode::InvalidInput,
        McpInstallError::ServerNotFound { .. } => BizCode::NotFound,
        McpInstallError::NoHomeDir(_) | McpInstallError::InvalidConfig { .. } | McpInstallError::Io { .. } => BizCode::RuntimeRefused,
    };
    ApiError::new(code, err.to_string())
}

fn map_host_server(server: HostMcpServer) -> McpServerEntry {
    let (transport, command, args, env, url, headers) = match server.transport {
        McpTransportSpec::Stdio { command, args, env } => (McpTransportKind::Stdio, Some(command), args, env, None, BTreeMap::new()),
        McpTransportSpec::StreamableHttp { url, headers, .. } => (McpTransportKind::StreamableHttp, None, Vec::new(), BTreeMap::new(), Some(url), headers),
    };
    McpServerEntry {
        host: from_oar_host(server.host),
        name: server.name,
        transport,
        command,
        args,
        env,
        url,
        headers,
        enabled: server.enabled,
        config_path: server.config_path.to_string_lossy().into_owned(),
    }
}

fn build_server_config(input: &McpServerSaveInput) -> Result<McpServerConfig, ApiError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(ApiError::new(BizCode::InvalidInput, "MCP server name must not be empty"));
    }
    let transport = match input.transport {
        McpTransportKind::Stdio => {
            let command = input.command.as_deref().map(str::trim).unwrap_or_default();
            if command.is_empty() {
                return Err(ApiError::new(BizCode::InvalidInput, "stdio command must not be empty"));
            }
            McpTransportSpec::Stdio {
                command: command.to_owned(),
                args: input.args.clone(),
                env: input.env.clone(),
            }
        }
        McpTransportKind::StreamableHttp => {
            let url = input.url.as_deref().map(str::trim).unwrap_or_default();
            if url.is_empty() {
                return Err(ApiError::new(BizCode::InvalidInput, "streamableHttp url must not be empty"));
            }
            McpTransportSpec::StreamableHttp {
                url: url.to_owned(),
                headers: input.headers.clone(),
                stateless: false,
            }
        }
    };
    Ok(McpServerConfig {
        name: name.to_owned(),
        transport,
    })
}

fn build_host_server_list(host: McpHostId) -> Result<McpServerListResult, ApiError> {
    let oar_host = to_oar_host(host);
    let servers = list_host_mcp_servers(oar_host)
        .map_err(map_error)?
        .into_iter()
        .map(map_host_server)
        .collect::<Vec<_>>();
    let config_path = servers
        .first()
        .map(|s| s.config_path.clone())
        .or_else(|| host_mcp_config_path(oar_host).map(|p| p.to_string_lossy().into_owned()));
    Ok(McpServerListResult { host, config_path, servers })
}

fn stdio_config() -> McpServerConfig {
    McpServerConfig::stdio(MCP_SERVER_NAME, MCP_STDIO_COMMAND, stdio_args())
}

fn http_config(http_url: &str) -> McpServerConfig {
    McpServerConfig::streamable_http(MCP_SERVER_NAME, http_url, true)
}

fn map_report(report: McpHostReport, stdio_cfg: &McpServerConfig, http_cfg: Option<&McpServerConfig>) -> McpHostInfo {
    let oar_host = report.id;
    McpHostInfo {
        id: from_oar_host(oar_host),
        label: report.label,
        installed: report.installed,
        config_path: report.config_path.map(|p| p.to_string_lossy().into_owned()),
        status: map_status(report.state),
        supports_stdio: report.supports_stdio,
        supports_http: report.supports_http,
        stdio_snippet: render_mcp_snippet(oar_host, stdio_cfg),
        http_snippet: http_cfg.map(|cfg| render_mcp_snippet(oar_host, cfg)),
    }
}

impl Runtime {
    fn mcp_http_url(&self) -> String {
        self.mcp_url().unwrap_or_else(|| format!("http://127.0.0.1:{}/mcp", default_port()))
    }

    pub(crate) fn list_mcp_hosts_endpoint(&self, input: McpListInput) -> McpListResult {
        let stdio_cfg = stdio_config();
        let http_url = self.mcp_http_url();
        let http_cfg = http_config(&http_url);
        let desired = match input.transport.unwrap_or(McpTransportKind::Stdio) {
            McpTransportKind::Stdio => &stdio_cfg,
            McpTransportKind::StreamableHttp => &http_cfg,
        };
        let hosts = list_mcp_hosts(desired)
            .into_iter()
            .map(|report| map_report(report, &stdio_cfg, Some(&http_cfg)))
            .collect();
        McpListResult {
            server_name: MCP_SERVER_NAME.to_owned(),
            stdio_command: MCP_STDIO_COMMAND.to_owned(),
            stdio_args: stdio_args(),
            http_url: Some(http_url),
            hosts,
        }
    }

    pub(crate) fn install_mcp_host_endpoint(&self, input: McpInstallInput) -> std::result::Result<McpHostInfo, ApiError> {
        let stdio_cfg = stdio_config();
        let http_url = self.mcp_http_url();
        let http_cfg = http_config(&http_url);
        let desired = match input.transport.unwrap_or(McpTransportKind::Stdio) {
            McpTransportKind::Stdio => &stdio_cfg,
            McpTransportKind::StreamableHttp => &http_cfg,
        };
        let report = install_mcp_host(to_oar_host(input.host), desired).map_err(map_error)?;
        Ok(map_report(report, &stdio_cfg, Some(&http_cfg)))
    }

    pub(crate) fn uninstall_mcp_host_endpoint(&self, input: McpUninstallInput) -> std::result::Result<McpHostInfo, ApiError> {
        let stdio_cfg = stdio_config();
        let http_url = self.mcp_http_url();
        let http_cfg = http_config(&http_url);
        let report = uninstall_mcp_host(to_oar_host(input.host), MCP_SERVER_NAME).map_err(map_error)?;
        Ok(map_report(report, &stdio_cfg, Some(&http_cfg)))
    }

    pub(crate) async fn list_host_mcp_servers_endpoint_async(&self, input: McpServerListInput) -> std::result::Result<McpServerListResult, ApiError> {
        crate::spawn_blocking_traced(move || build_host_server_list(input.host))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    pub(crate) async fn save_host_mcp_server_endpoint_async(&self, input: McpServerSaveInput) -> std::result::Result<McpServerListResult, ApiError> {
        let config = build_server_config(&input)?;
        let host = input.host;
        let previous_name = input.previous_name.clone();
        let enabled = input.enabled;
        crate::spawn_blocking_traced(move || {
            upsert_host_mcp_server(to_oar_host(host), previous_name.as_deref(), &config, enabled).map_err(map_error)?;
            build_host_server_list(host)
        })
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    pub(crate) async fn toggle_host_mcp_server_endpoint_async(&self, input: McpServerToggleInput) -> std::result::Result<McpServerListResult, ApiError> {
        let host = input.host;
        let name = input.name;
        let enabled = input.enabled;
        crate::spawn_blocking_traced(move || {
            set_host_mcp_server_enabled(to_oar_host(host), &name, enabled).map_err(map_error)?;
            build_host_server_list(host)
        })
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    pub(crate) async fn remove_host_mcp_server_endpoint_async(&self, input: McpServerRemoveInput) -> std::result::Result<McpServerListResult, ApiError> {
        let host = input.host;
        let name = input.name;
        crate::spawn_blocking_traced(move || {
            remove_host_mcp_server(to_oar_host(host), &name).map_err(map_error)?;
            build_host_server_list(host)
        })
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }
}
