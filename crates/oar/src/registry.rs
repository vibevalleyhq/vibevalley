use std::sync::Arc;

use vibevalley_mcp::McpServerConfig;

use super::mcp_install::{HostMcpServer, McpHostId, McpHostReport, McpInstallError};
use super::traits::{Runtime, find_runtime};
use super::types::{AgentError, Event, Result};
use super::{acp, claude, codex, mcp_install, process, record, scripted, sdk};

pub struct Registry {
    runtimes: Vec<Arc<dyn Runtime>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { runtimes: Vec::new() }
    }

    pub fn register(&mut self, runtime: Arc<dyn Runtime>) {
        if let Some(slot) = self.runtimes.iter_mut().find(|r| r.id() == runtime.id()) {
            *slot = runtime;
        } else {
            self.runtimes.push(runtime);
        }
    }

    pub fn list(&self) -> &[Arc<dyn Runtime>] {
        &self.runtimes
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Runtime>> {
        find_runtime(&self.runtimes, id)
    }

    pub fn require(&self, id: &str) -> Result<Arc<dyn Runtime>> {
        self.get(id).ok_or_else(|| AgentError::UnknownRuntime(id.to_string()))
    }

    pub fn list_mcp_hosts(&self, desired: &McpServerConfig) -> Vec<McpHostReport> {
        mcp_install::list_mcp_hosts(desired)
    }

    pub fn mcp_status(&self, host: McpHostId, desired: &McpServerConfig) -> McpHostReport {
        mcp_install::mcp_status(host, desired)
    }

    pub fn install_mcp_host(&self, host: McpHostId, config: &McpServerConfig) -> std::result::Result<McpHostReport, McpInstallError> {
        mcp_install::install_mcp_host(host, config)
    }

    pub fn uninstall_mcp_host(&self, host: McpHostId, server_name: &str) -> std::result::Result<McpHostReport, McpInstallError> {
        mcp_install::uninstall_mcp_host(host, server_name)
    }

    pub fn list_host_mcp_servers(&self, host: McpHostId) -> std::result::Result<Vec<HostMcpServer>, McpInstallError> {
        mcp_install::list_host_mcp_servers(host)
    }

    pub fn upsert_host_mcp_server(
        &self,
        host: McpHostId,
        previous_name: Option<&str>,
        config: &McpServerConfig,
        enabled: bool,
    ) -> std::result::Result<HostMcpServer, McpInstallError> {
        mcp_install::upsert_host_mcp_server(host, previous_name, config, enabled)
    }

    pub fn set_host_mcp_server_enabled(&self, host: McpHostId, server_name: &str, enabled: bool) -> std::result::Result<HostMcpServer, McpInstallError> {
        mcp_install::set_host_mcp_server_enabled(host, server_name, enabled)
    }

    pub fn remove_host_mcp_server(&self, host: McpHostId, server_name: &str) -> std::result::Result<(), McpInstallError> {
        mcp_install::remove_host_mcp_server(host, server_name)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// Registry with every built-in runtime: `claude`, `codex`, and `acp:*`,
/// plus `scripted` (no binary, no login; replays a demo script).
pub fn default_runtimes() -> Registry {
    let mut registry = Registry::new();
    registry.register(Arc::new(claude::ClaudeRuntime::new()));
    registry.register(Arc::new(codex::CodexRuntime::new()));
    for spec in acp::builtin_agents() {
        registry.register(Arc::new(acp::AcpRuntime::new(spec)));
    }
    registry.register(Arc::new(sdk::SdkRuntime::Qwen));
    registry.register(Arc::new(sdk::SdkRuntime::Qoder));
    registry.register(Arc::new(scripted::ScriptedRuntime::demo()));
    registry
}

/// Runs `command` (`claude`, `codex`, `opencode`, ...) from `path` instead of
/// the one found on PATH; `None` goes back to PATH. VibeValley's
/// `OAR_<COMMAND>_BIN` environment variable is honoured too, below this.
pub fn set_binary(command: &str, path: Option<std::path::PathBuf>) {
    process::set_binary(command, path);
}

/// Reads a JSONL record file written through `SessionOptions::record_to`.
pub fn read_record(path: &std::path::Path) -> Result<Vec<Event>> {
    record::read_record_with_header(path).map(|(_, events)| events)
}
