//! `runtime.mcp.*` endpoints delegating host probing and configuration
//! management strictly to OAR (`vibevalley_runtime::oar::mcp_install`).

use vibevalley_mcp::{McpServerConfig, McpTransportSpec};
use vibevalley_protocol::home::{ReleaseChannel, current_channel, default_port};
use vibevalley_protocol::{
    ApiError, BizCode, McpHostId, McpHostInfo, McpInstallInput, McpInstallStatus, McpListInput, McpListResult, McpTransportKind, McpUninstallInput,
};
use vibevalley_runtime::oar::{
    McpHostId as OarMcpHostId, McpHostReport, McpInstallError, McpInstallState, install_mcp_host, list_mcp_hosts, render_mcp_snippet, uninstall_mcp_host,
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
    ApiError::new(BizCode::RuntimeRefused, err.to_string())
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
}
