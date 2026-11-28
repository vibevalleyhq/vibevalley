//! OAR-owned MCP host probing and atomic configuration management.
//!
//! All coding-agent interactions (probing installations, reading/writing user-level
//! MCP config files, drift detection, and uninstall) live inside OAR so upper layers
//! (`vibevalley-server`, `vibevalley-cli`, UI settings) stay thin and agent-agnostic.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use vibevalley_mcp::{McpServerConfig, McpTransportSpec};

use super::process::find_binary;
use super::specs::runtime_spec;

/// Coding agents that OAR knows how to probe and configure for user-level MCP servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpHostId {
    Antigravity,
    Claude,
    Codex,
    Cursor,
}

impl McpHostId {
    pub const ALL: &'static [Self] = &[Self::Antigravity, Self::Claude, Self::Codex, Self::Cursor];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Antigravity => "antigravity",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }

    /// Matching built-in OAR runtime id when this host is also driven as a runtime.
    pub fn runtime_id(self) -> Option<&'static str> {
        match self {
            Self::Antigravity => Some("antigravity"),
            Self::Claude => Some("claude"),
            Self::Codex => Some("codex"),
            Self::Cursor => None,
        }
    }

    pub fn supports_stdio(self) -> bool {
        match self {
            Self::Antigravity | Self::Claude | Self::Codex | Self::Cursor => true,
        }
    }

    pub fn supports_http(self) -> bool {
        match self {
            Self::Antigravity | Self::Claude | Self::Codex | Self::Cursor => true,
        }
    }

    pub fn config_path(self, home_dir: &Path) -> PathBuf {
        match self {
            Self::Antigravity => home_dir.join(".gemini").join("config").join("mcp_config.json"),
            Self::Claude => home_dir.join(".claude.json"),
            Self::Codex => home_dir.join(".codex").join("config.toml"),
            Self::Cursor => home_dir.join(".cursor").join("mcp.json"),
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "antigravity" | "agy" | "acp:antigravity" => Some(Self::Antigravity),
            "claude" | "claude-code" | "claudecode" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }
}

impl fmt::Display for McpHostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for McpHostId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s).ok_or_else(|| format!("unknown MCP host `{s}`"))
    }
}

/// Installation state of a desired MCP server entry in one coding agent's user config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpInstallState {
    NotInstalled,
    Installed { transport: McpTransportSpec },
    Outdated { current: McpTransportSpec, reason: String },
    Unsupported { reason: String },
}

/// Complete OAR status report for a coding agent's MCP configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHostReport {
    pub id: McpHostId,
    pub label: String,
    pub installed: bool,
    pub config_path: Option<PathBuf>,
    pub state: McpInstallState,
    pub supports_stdio: bool,
    pub supports_http: bool,
}

/// One user-level MCP server entry read from a coding agent's host config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMcpServer {
    pub host: McpHostId,
    pub name: String,
    pub transport: McpTransportSpec,
    pub enabled: bool,
    pub config_path: PathBuf,
}

/// Failure while installing or uninstalling an MCP server entry on a coding agent.
#[derive(Debug, thiserror::Error)]
pub enum McpInstallError {
    #[error("cannot determine home directory for MCP host `{0}`")]
    NoHomeDir(McpHostId),
    #[error("MCP host `{host}` does not support the requested transport: {reason}")]
    UnsupportedTransport { host: McpHostId, reason: String },
    #[error("invalid MCP server name `{0}`")]
    InvalidServerName(String),
    #[error("MCP server `{name}` not found in host `{host}` config")]
    ServerNotFound { host: McpHostId, name: String },
    #[error("invalid config file at `{path}`: {message}")]
    InvalidConfig { path: PathBuf, message: String },
    #[error("io error at `{path}`: {message}")]
    Io { path: PathBuf, message: String },
}

fn current_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn validate_server_name(name: &str) -> Result<&str, McpInstallError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed != name || name.chars().any(|c| c.is_control()) {
        return Err(McpInstallError::InvalidServerName(name.to_owned()));
    }
    Ok(trimmed)
}

fn validate_transport_support(host: McpHostId, transport: &McpTransportSpec) -> Result<(), McpInstallError> {
    match transport {
        McpTransportSpec::Stdio { command, .. } => {
            if !host.supports_stdio() {
                return Err(McpInstallError::UnsupportedTransport {
                    host,
                    reason: "stdio transport is not supported".into(),
                });
            }
            if command.trim().is_empty() {
                return Err(McpInstallError::UnsupportedTransport {
                    host,
                    reason: "stdio command must not be empty".into(),
                });
            }
            Ok(())
        }
        McpTransportSpec::StreamableHttp { url, .. } => {
            if !host.supports_http() {
                return Err(McpInstallError::UnsupportedTransport {
                    host,
                    reason: "streamableHttp transport is not supported".into(),
                });
            }
            if url.trim().is_empty() {
                return Err(McpInstallError::UnsupportedTransport {
                    host,
                    reason: "streamableHttp url must not be empty".into(),
                });
            }
            Ok(())
        }
    }
}

fn detect_installed(host: McpHostId, home_dir: &Path, probe_system: bool) -> bool {
    let home_marker = match host {
        McpHostId::Antigravity => home_dir.join(".gemini/antigravity-cli").exists() || host.config_path(home_dir).exists(),
        McpHostId::Claude => home_dir.join(".claude").exists() || host.config_path(home_dir).exists(),
        McpHostId::Codex => home_dir.join(".codex").exists(),
        McpHostId::Cursor => home_dir.join(".cursor").exists() || home_dir.join("Applications/Cursor.app").exists(),
    };
    if home_marker || !probe_system {
        return home_marker;
    }
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Codex => host
            .runtime_id()
            .and_then(runtime_spec)
            .and_then(|spec| spec.binary)
            .and_then(find_binary)
            .is_some(),
        McpHostId::Cursor => Path::new("/Applications/Cursor.app").exists() || find_binary("cursor").is_some(),
    }
}

fn normalize_headers(map: &BTreeMap<String, String>) -> BTreeMap<String, &str> {
    map.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.as_str())).collect()
}

fn headers_match(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> bool {
    a.len() == b.len() && normalize_headers(a) == normalize_headers(b)
}

fn compare_transport(current: McpTransportSpec, desired: &McpTransportSpec) -> McpInstallState {
    match (&current, desired) {
        (
            McpTransportSpec::Stdio {
                command: cur_cmd,
                args: cur_args,
                env: cur_env,
            },
            McpTransportSpec::Stdio {
                command: des_cmd,
                args: des_args,
                env: des_env,
            },
        ) => {
            if cur_cmd != des_cmd {
                McpInstallState::Outdated {
                    reason: format!("command differs: configured `{cur_cmd}`, expected `{des_cmd}`"),
                    current,
                }
            } else if cur_args != des_args {
                McpInstallState::Outdated {
                    reason: format!("args differ: configured `{cur_args:?}`, expected `{des_args:?}`"),
                    current,
                }
            } else if cur_env != des_env {
                McpInstallState::Outdated {
                    reason: "environment variables differ from desired configuration".into(),
                    current,
                }
            } else {
                McpInstallState::Installed { transport: current }
            }
        }
        (
            McpTransportSpec::StreamableHttp {
                url: cur_url,
                headers: cur_headers,
                ..
            },
            McpTransportSpec::StreamableHttp {
                url: des_url,
                headers: des_headers,
                stateless: des_stateless,
            },
        ) => {
            if cur_url.trim() != des_url.trim() {
                McpInstallState::Outdated {
                    reason: format!("url differs: configured `{cur_url}`, expected `{des_url}`"),
                    current,
                }
            } else if !headers_match(cur_headers, des_headers) {
                McpInstallState::Outdated {
                    reason: "HTTP headers differ from desired configuration".into(),
                    current,
                }
            } else {
                McpInstallState::Installed {
                    transport: McpTransportSpec::StreamableHttp {
                        url: cur_url.clone(),
                        headers: cur_headers.clone(),
                        stateless: *des_stateless,
                    },
                }
            }
        }
        (McpTransportSpec::Stdio { .. }, McpTransportSpec::StreamableHttp { .. }) => McpInstallState::Outdated {
            reason: "transport differs: configured stdio, expected streamableHttp".into(),
            current,
        },
        (McpTransportSpec::StreamableHttp { .. }, McpTransportSpec::Stdio { .. }) => McpInstallState::Outdated {
            reason: "transport differs: configured streamableHttp, expected stdio".into(),
            current,
        },
    }
}

/// Lists all OAR-known coding-agent MCP hosts and their status against `desired`,
/// probing the current user's `$HOME` and system binaries via OAR.
pub fn list_mcp_hosts(desired: &McpServerConfig) -> Vec<McpHostReport> {
    McpHostId::ALL.iter().map(|&host| mcp_status(host, desired)).collect()
}

/// Probes one coding agent's MCP status against `desired` in the current user's `$HOME`.
pub fn mcp_status(host: McpHostId, desired: &McpServerConfig) -> McpHostReport {
    let Some(home_dir) = current_home_dir() else {
        return McpHostReport {
            id: host,
            label: host.label().to_owned(),
            installed: false,
            config_path: None,
            state: McpInstallState::Unsupported {
                reason: "HOME directory is not set".into(),
            },
            supports_stdio: host.supports_stdio(),
            supports_http: host.supports_http(),
        };
    };
    probe_host_report(host, &home_dir, desired, true)
}

/// Hermetic variant of [`list_mcp_hosts`] scoped strictly to `home_dir` (no system PATH probe).
pub fn list_mcp_hosts_in(home_dir: &Path, desired: &McpServerConfig) -> Vec<McpHostReport> {
    McpHostId::ALL.iter().map(|&host| mcp_status_in(home_dir, host, desired)).collect()
}

/// Hermetic variant of [`mcp_status`] scoped strictly to `home_dir` (no system PATH probe).
pub fn mcp_status_in(home_dir: &Path, host: McpHostId, desired: &McpServerConfig) -> McpHostReport {
    probe_host_report(host, home_dir, desired, false)
}

/// Atomically installs or updates `config` in `host`'s user-level MCP configuration under `$HOME`.
pub fn install_mcp_host(host: McpHostId, config: &McpServerConfig) -> Result<McpHostReport, McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    install_host_inner(&home_dir, host, config, true)
}

/// Hermetic variant of [`install_mcp_host`] scoped strictly to `home_dir`.
pub fn install_mcp_host_in(home_dir: &Path, host: McpHostId, config: &McpServerConfig) -> Result<McpHostReport, McpInstallError> {
    install_host_inner(home_dir, host, config, false)
}

/// Atomically removes ONLY `server_name` from `host`'s user-level MCP configuration under `$HOME`.
pub fn uninstall_mcp_host(host: McpHostId, server_name: &str) -> Result<McpHostReport, McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    uninstall_host_inner(&home_dir, host, server_name, true)
}

/// Hermetic variant of [`uninstall_mcp_host`] scoped strictly to `home_dir`.
pub fn uninstall_mcp_host_in(home_dir: &Path, host: McpHostId, server_name: &str) -> Result<McpHostReport, McpInstallError> {
    uninstall_host_inner(home_dir, host, server_name, false)
}

/// Lists all user-level MCP servers configured on `host` under `$HOME`.
pub fn list_host_mcp_servers(host: McpHostId) -> Result<Vec<HostMcpServer>, McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    list_host_mcp_servers_in(&home_dir, host)
}

/// Returns the user-level MCP configuration file path for `host` under `$HOME`, if `$HOME` is set.
pub fn host_mcp_config_path(host: McpHostId) -> Option<PathBuf> {
    current_home_dir().map(|home_dir| host.config_path(&home_dir))
}

/// Hermetic variant of [`list_host_mcp_servers`] scoped strictly to `home_dir`.
pub fn list_host_mcp_servers_in(home_dir: &Path, host: McpHostId) -> Result<Vec<HostMcpServer>, McpInstallError> {
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => read_json_servers(host, &config_path),
        McpHostId::Codex => codex_toml::read_toml_servers(&config_path),
    }
}

/// Atomically adds or updates an MCP server entry on `host` under `$HOME`, optionally renaming from `previous_name`.
pub fn upsert_host_mcp_server(host: McpHostId, previous_name: Option<&str>, config: &McpServerConfig, enabled: bool) -> Result<HostMcpServer, McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    upsert_host_mcp_server_in(&home_dir, host, previous_name, config, enabled)
}

/// Hermetic variant of [`upsert_host_mcp_server`] scoped strictly to `home_dir`.
pub fn upsert_host_mcp_server_in(
    home_dir: &Path,
    host: McpHostId,
    previous_name: Option<&str>,
    config: &McpServerConfig,
    enabled: bool,
) -> Result<HostMcpServer, McpInstallError> {
    let name = validate_server_name(&config.name)?;
    let prev = previous_name.map(validate_server_name).transpose()?.filter(|&p| p != name);
    validate_transport_support(host, &config.transport)?;
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => {
            upsert_json_server(host, &config_path, prev, name, &config.transport, enabled)?;
        }
        McpHostId::Codex => {
            codex_toml::upsert_toml_server(&config_path, prev, name, &config.transport, enabled)?;
        }
    }
    Ok(HostMcpServer {
        host,
        name: name.to_owned(),
        transport: config.transport.clone(),
        enabled,
        config_path,
    })
}

/// Atomically toggles the `enabled` status of an existing MCP server on `host` under `$HOME`.
pub fn set_host_mcp_server_enabled(host: McpHostId, server_name: &str, enabled: bool) -> Result<HostMcpServer, McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    set_host_mcp_server_enabled_in(&home_dir, host, server_name, enabled)
}

/// Hermetic variant of [`set_host_mcp_server_enabled`] scoped strictly to `home_dir`.
pub fn set_host_mcp_server_enabled_in(home_dir: &Path, host: McpHostId, server_name: &str, enabled: bool) -> Result<HostMcpServer, McpInstallError> {
    let name = validate_server_name(server_name)?;
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => set_json_server_enabled(host, &config_path, name, enabled),
        McpHostId::Codex => codex_toml::set_toml_server_enabled(&config_path, name, enabled),
    }
}

/// Atomically removes `server_name` from `host`'s user-level MCP configuration under `$HOME`.
pub fn remove_host_mcp_server(host: McpHostId, server_name: &str) -> Result<(), McpInstallError> {
    let home_dir = current_home_dir().ok_or(McpInstallError::NoHomeDir(host))?;
    remove_host_mcp_server_in(&home_dir, host, server_name)
}

/// Hermetic variant of [`remove_host_mcp_server`] scoped strictly to `home_dir`.
pub fn remove_host_mcp_server_in(home_dir: &Path, host: McpHostId, server_name: &str) -> Result<(), McpInstallError> {
    let name = validate_server_name(server_name)?;
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => remove_json_server(host, &config_path, name),
        McpHostId::Codex => codex_toml::remove_toml_server(&config_path, name),
    }
}

/// Renders a copyable configuration snippet for `config` in `host`'s native config format.
pub fn render_mcp_snippet(host: McpHostId, config: &McpServerConfig) -> String {
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => serde_json::to_string_pretty(&json!({
            "mcpServers": {
                &config.name: encode_json_entry(host, &config.transport, true),
            }
        }))
        .unwrap_or_default(),
        McpHostId::Codex => codex_toml::format_server_section(&config.name, &config.transport).trim_end().to_owned(),
    }
}

fn probe_host_report(host: McpHostId, home_dir: &Path, desired: &McpServerConfig, probe_system: bool) -> McpHostReport {
    let config_path = host.config_path(home_dir);
    let installed = detect_installed(host, home_dir, probe_system);
    let state = match validate_server_name(&desired.name) {
        Err(err) => McpInstallState::Unsupported { reason: err.to_string() },
        Ok(name) => match read_host_server(host, &config_path, name) {
            Ok(Some(current)) => compare_transport(current, &desired.transport),
            Ok(None) => McpInstallState::NotInstalled,
            Err(err) => McpInstallState::Unsupported { reason: err.to_string() },
        },
    };
    McpHostReport {
        id: host,
        label: host.label().to_owned(),
        installed,
        config_path: Some(config_path),
        state,
        supports_stdio: host.supports_stdio(),
        supports_http: host.supports_http(),
    }
}

fn install_host_inner(home_dir: &Path, host: McpHostId, config: &McpServerConfig, probe_system: bool) -> Result<McpHostReport, McpInstallError> {
    upsert_host_mcp_server_in(home_dir, host, None, config, true)?;
    Ok(probe_host_report(host, home_dir, config, probe_system))
}

fn uninstall_host_inner(home_dir: &Path, host: McpHostId, server_name: &str, probe_system: bool) -> Result<McpHostReport, McpInstallError> {
    let name = validate_server_name(server_name)?;
    remove_host_mcp_server_in(home_dir, host, name)?;
    let probe = McpServerConfig::stdio(name, "placeholder", Vec::new());
    Ok(probe_host_report(host, home_dir, &probe, probe_system))
}

fn read_host_server(host: McpHostId, path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => read_json_server(host, path, server_name),
        McpHostId::Codex => codex_toml::read_toml_server(path, server_name),
    }
}

// ---- Atomic filesystem I/O --------------------------------------------------

fn io_err(path: &Path, err: impl fmt::Display) -> McpInstallError {
    McpInstallError::Io {
        path: path.to_path_buf(),
        message: err.to_string(),
    }
}

fn read_optional_file(path: &Path) -> Result<Option<String>, McpInstallError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_err(path, err)),
    }
}

/// Atomically writes `bytes` to `path` via a same-directory temporary file with `0600` permissions on Unix.
fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), McpInstallError> {
    let parent = path.parent().ok_or_else(|| io_err(path, "config path has no parent directory"))?;
    std::fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;

    let mut builder = tempfile::Builder::new();
    builder.prefix(".vv-mcp-").suffix(".tmp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut tmp = builder.tempfile_in(parent).map_err(|e| io_err(path, e))?;
    tmp.write_all(bytes).map_err(|e| io_err(path, e))?;
    tmp.flush().map_err(|e| io_err(path, e))?;
    tmp.as_file().sync_all().map_err(|e| io_err(path, e))?;
    tmp.persist(path).map_err(|e| io_err(path, e.error))?;
    Ok(())
}

// ---- JSON host configs (Antigravity, Claude Code, Cursor) -------------------

fn parse_json_root(path: &Path, raw: Option<String>) -> Result<Map<String, Value>, McpInstallError> {
    let Some(text) = raw else {
        return Ok(Map::new());
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| McpInstallError::InvalidConfig {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "root JSON value must be an object".into(),
        }),
    }
}

fn parse_string_map(path: &Path, field: &str, value: Option<&Value>) -> Result<BTreeMap<String, String>, McpInstallError> {
    let Some(val) = value else {
        return Ok(BTreeMap::new());
    };
    if val.is_null() {
        return Ok(BTreeMap::new());
    }
    let Some(obj) = val.as_object() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: format!("`{field}` must be a JSON object"),
        });
    };
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        let Some(s) = v.as_str() else {
            return Err(McpInstallError::InvalidConfig {
                path: path.to_path_buf(),
                message: format!("`{field}.{k}` must be a string"),
            });
        };
        out.insert(k.clone(), s.to_owned());
    }
    Ok(out)
}

fn claude_disabled_servers(host: McpHostId, root: &Map<String, Value>) -> std::collections::HashSet<String> {
    if !matches!(host, McpHostId::Claude) {
        return std::collections::HashSet::new();
    }
    root.get("disabledMcpServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn remove_claude_disabled_server(host: McpHostId, root: &mut Map<String, Value>, server_name: &str) -> bool {
    if !matches!(host, McpHostId::Claude) {
        return false;
    }
    let Some(Value::Array(arr)) = root.get_mut("disabledMcpServers") else {
        return false;
    };
    let before = arr.len();
    arr.retain(|v| v.as_str() != Some(server_name));
    arr.len() != before
}

fn decode_json_entry(path: &Path, entry: &Value, root_disabled: bool) -> Result<(McpTransportSpec, bool), McpInstallError> {
    let Some(obj) = entry.as_object() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "MCP server entry must be a JSON object".into(),
        });
    };
    let entry_disabled = match (obj.get("disabled"), obj.get("enabled")) {
        (Some(val), _) => val.as_bool().ok_or_else(|| McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "`disabled` must be a JSON boolean".into(),
        })?,
        (None, Some(val)) => !val.as_bool().ok_or_else(|| McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "`enabled` must be a JSON boolean".into(),
        })?,
        (None, None) => false,
    };
    let enabled = !entry_disabled && !root_disabled;
    if let Some(command) = obj.get("command").and_then(Value::as_str) {
        let args = match obj.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let Some(s) = item.as_str() else {
                        return Err(McpInstallError::InvalidConfig {
                            path: path.to_path_buf(),
                            message: "`args` entries must be strings".into(),
                        });
                    };
                    out.push(s.to_owned());
                }
                out
            }
            Some(_) => {
                return Err(McpInstallError::InvalidConfig {
                    path: path.to_path_buf(),
                    message: "`args` must be a JSON array".into(),
                });
            }
        };
        let env = parse_string_map(path, "env", obj.get("env"))?;
        return Ok((
            McpTransportSpec::Stdio {
                command: command.to_owned(),
                args,
                env,
            },
            enabled,
        ));
    }
    if let Some(url) = ["url", "serverUrl", "httpUrl"].into_iter().find_map(|k| obj.get(k).and_then(Value::as_str)) {
        let headers = parse_string_map(path, "headers", obj.get("headers"))?;
        return Ok((
            McpTransportSpec::StreamableHttp {
                url: url.to_owned(),
                headers,
                stateless: false,
            },
            enabled,
        ));
    }
    Err(McpInstallError::InvalidConfig {
        path: path.to_path_buf(),
        message: "MCP server entry defines neither `command` nor `url`".into(),
    })
}

fn encode_json_entry(host: McpHostId, transport: &McpTransportSpec, enabled: bool) -> Value {
    let mut obj = match transport {
        McpTransportSpec::Stdio { command, args, env } => {
            let mut obj = Map::new();
            obj.insert("command".into(), json!(command));
            obj.insert("args".into(), json!(args));
            if !env.is_empty() {
                obj.insert("env".into(), json!(env));
            }
            obj
        }
        McpTransportSpec::StreamableHttp { url, headers, .. } => {
            let mut obj = Map::new();
            if matches!(host, McpHostId::Claude) {
                obj.insert("type".into(), json!("http"));
            }
            obj.insert("url".into(), json!(url));
            if !headers.is_empty() {
                obj.insert("headers".into(), json!(headers));
            }
            obj
        }
    };
    if !enabled {
        obj.insert("disabled".into(), Value::Bool(true));
    }
    Value::Object(obj)
}

fn read_json_servers_map<'a>(path: &Path, root: &'a Map<String, Value>) -> Result<Option<&'a Map<String, Value>>, McpInstallError> {
    let Some(servers_val) = root.get("mcpServers") else {
        return Ok(None);
    };
    if servers_val.is_null() {
        return Ok(None);
    }
    servers_val.as_object().map(Some).ok_or_else(|| McpInstallError::InvalidConfig {
        path: path.to_path_buf(),
        message: "`mcpServers` must be a JSON object".into(),
    })
}

fn read_json_servers(host: McpHostId, path: &Path) -> Result<Vec<HostMcpServer>, McpInstallError> {
    let Some(raw) = read_optional_file(path)? else {
        return Ok(Vec::new());
    };
    let root = parse_json_root(path, Some(raw))?;
    let Some(servers) = read_json_servers_map(path, &root)? else {
        return Ok(Vec::new());
    };
    let disabled_list = claude_disabled_servers(host, &root);
    let mut out = Vec::with_capacity(servers.len());
    for (name, entry) in servers {
        let (transport, enabled) = decode_json_entry(path, entry, disabled_list.contains(name))?;
        out.push(HostMcpServer {
            host,
            name: name.clone(),
            transport,
            enabled,
            config_path: path.to_path_buf(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_json_server(host: McpHostId, path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
    let Some(raw) = read_optional_file(path)? else {
        return Ok(None);
    };
    let root = parse_json_root(path, Some(raw))?;
    let Some(servers) = read_json_servers_map(path, &root)? else {
        return Ok(None);
    };
    let disabled_list = claude_disabled_servers(host, &root);
    match servers.get(server_name) {
        Some(entry) => decode_json_entry(path, entry, disabled_list.contains(server_name)).map(|(t, _)| Some(t)),
        None => Ok(None),
    }
}

fn upsert_json_server(
    host: McpHostId,
    path: &Path,
    previous_name: Option<&str>,
    server_name: &str,
    transport: &McpTransportSpec,
    enabled: bool,
) -> Result<(), McpInstallError> {
    let raw = read_optional_file(path)?;
    let mut root = parse_json_root(path, raw)?;
    if let Some(prev) = previous_name {
        remove_claude_disabled_server(host, &mut root, prev);
    }
    if enabled {
        remove_claude_disabled_server(host, &mut root, server_name);
    }
    let servers = match root.entry("mcpServers".to_owned()) {
        serde_json::map::Entry::Vacant(slot) => slot.insert(Value::Object(Map::new())),
        serde_json::map::Entry::Occupied(mut slot) => {
            if slot.get().is_null() {
                slot.insert(Value::Object(Map::new()));
            }
            slot.into_mut()
        }
    };
    let Some(servers_obj) = servers.as_object_mut() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "`mcpServers` must be a JSON object".into(),
        });
    };
    if let Some(prev) = previous_name {
        servers_obj.remove(prev);
    }
    servers_obj.insert(server_name.to_owned(), encode_json_entry(host, transport, enabled));
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| io_err(path, e))?;
    encoded.push('\n');
    write_file_atomic(path, encoded.as_bytes())
}

fn set_json_server_enabled(host: McpHostId, path: &Path, server_name: &str, enabled: bool) -> Result<HostMcpServer, McpInstallError> {
    let Some(raw) = read_optional_file(path)? else {
        return Err(McpInstallError::ServerNotFound {
            host,
            name: server_name.to_owned(),
        });
    };
    let mut root = parse_json_root(path, Some(raw))?;
    if enabled {
        remove_claude_disabled_server(host, &mut root, server_name);
    }
    let servers_val = root.get_mut("mcpServers").ok_or_else(|| McpInstallError::ServerNotFound {
        host,
        name: server_name.to_owned(),
    })?;
    if servers_val.is_null() {
        return Err(McpInstallError::ServerNotFound {
            host,
            name: server_name.to_owned(),
        });
    }
    let Some(servers_obj) = servers_val.as_object_mut() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "`mcpServers` must be a JSON object".into(),
        });
    };
    let Some(entry) = servers_obj.get_mut(server_name) else {
        return Err(McpInstallError::ServerNotFound {
            host,
            name: server_name.to_owned(),
        });
    };
    let Some(entry_obj) = entry.as_object_mut() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "MCP server entry must be a JSON object".into(),
        });
    };
    entry_obj.remove("enabled");
    if enabled {
        entry_obj.remove("disabled");
    } else {
        entry_obj.insert("disabled".into(), Value::Bool(true));
    }
    let (transport, final_enabled) = decode_json_entry(path, entry, false)?;
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| io_err(path, e))?;
    encoded.push('\n');
    write_file_atomic(path, encoded.as_bytes())?;
    Ok(HostMcpServer {
        host,
        name: server_name.to_owned(),
        transport,
        enabled: final_enabled,
        config_path: path.to_path_buf(),
    })
}

fn remove_json_server(host: McpHostId, path: &Path, server_name: &str) -> Result<(), McpInstallError> {
    let Some(raw) = read_optional_file(path)? else {
        return Ok(());
    };
    let mut root = parse_json_root(path, Some(raw))?;
    let removed_disabled = remove_claude_disabled_server(host, &mut root, server_name);
    let removed = match root.get_mut("mcpServers") {
        None | Some(Value::Null) => false,
        Some(Value::Object(servers)) => servers.remove(server_name).is_some(),
        Some(_) => {
            return Err(McpInstallError::InvalidConfig {
                path: path.to_path_buf(),
                message: "`mcpServers` must be a JSON object".into(),
            });
        }
    };
    if !removed && !removed_disabled {
        return Ok(());
    }
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| io_err(path, e))?;
    encoded.push('\n');
    write_file_atomic(path, encoded.as_bytes())
}

// ---- Comment-preserving TOML editor for Codex (~/.codex/config.toml) --------

mod codex_toml {
    use toml_edit::{Array, DocumentMut, Item, Table, TableLike, Value};

    use super::*;

    fn invalid(path: &Path, message: impl fmt::Display) -> McpInstallError {
        McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: message.to_string(),
        }
    }

    fn collect_string_map(path: &Path, field: &str, item: &Item, out: &mut BTreeMap<String, String>) -> Result<(), McpInstallError> {
        let Some(table) = item.as_table_like() else {
            return Err(invalid(path, format!("`{field}` must be a TOML table")));
        };
        collect_table_strings(path, field, "", table, out)
    }

    fn collect_table_strings(path: &Path, field: &str, prefix: &str, table: &dyn TableLike, out: &mut BTreeMap<String, String>) -> Result<(), McpInstallError> {
        for (k, v) in table.iter() {
            let full_key = if prefix.is_empty() { k.to_owned() } else { format!("{prefix}.{k}") };
            if let Some(s) = v.as_str() {
                out.insert(full_key, s.to_owned());
            } else if let Some(sub) = v.as_table_like()
                && v.as_table().is_some_and(Table::is_dotted)
            {
                collect_table_strings(path, field, &full_key, sub, out)?;
            } else {
                return Err(invalid(path, format!("`{field}.{full_key}` must be a string")));
            }
        }
        Ok(())
    }

    fn decode_toml_entry(path: &Path, server_name: &str, entry: &dyn TableLike) -> Result<(McpTransportSpec, bool), McpInstallError> {
        let enabled = match entry.get("enabled") {
            None => true,
            Some(item) => item.as_bool().ok_or_else(|| invalid(path, "`enabled` must be a boolean"))?,
        };
        let command = match entry.get("command") {
            None => None,
            Some(item) => {
                let s = item.as_str().ok_or_else(|| invalid(path, "`command` must be a string"))?;
                Some(s.to_owned())
            }
        };
        let args = match entry.get("args") {
            None => Vec::new(),
            Some(item) => {
                let arr = item.as_array().ok_or_else(|| invalid(path, "`args` must be a TOML array"))?;
                let mut out = Vec::with_capacity(arr.len());
                for val in arr.iter() {
                    let s = val.as_str().ok_or_else(|| invalid(path, "`args` entries must be strings"))?;
                    out.push(s.to_owned());
                }
                out
            }
        };
        let mut env = BTreeMap::new();
        if let Some(env_item) = entry.get("env") {
            collect_string_map(path, "env", env_item, &mut env)?;
        }
        let url = match entry.get("url") {
            None => None,
            Some(item) => {
                let s = item.as_str().ok_or_else(|| invalid(path, "`url` must be a string"))?;
                Some(s.to_owned())
            }
        };
        let mut headers = BTreeMap::new();
        if let Some(hdr_item) = entry.get("headers") {
            collect_string_map(path, "headers", hdr_item, &mut headers)?;
        }
        if let Some(hdr_item) = entry.get("http_headers") {
            collect_string_map(path, "http_headers", hdr_item, &mut headers)?;
        }

        if let Some(command) = command {
            return Ok((McpTransportSpec::Stdio { command, args, env }, enabled));
        }
        if let Some(url) = url {
            return Ok((
                McpTransportSpec::StreamableHttp {
                    url,
                    headers,
                    stateless: false,
                },
                enabled,
            ));
        }
        Err(invalid(
            path,
            format!("TOML section `[mcp_servers.{server_name}]` defines neither `command` nor `url`"),
        ))
    }

    pub(super) fn read_toml_servers(path: &Path) -> Result<Vec<HostMcpServer>, McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Ok(Vec::new());
        };
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let doc: DocumentMut = raw.parse().map_err(|e| invalid(path, e))?;
        let Some(servers_item) = doc.get("mcp_servers") else {
            return Ok(Vec::new());
        };
        let Some(servers) = servers_item.as_table_like() else {
            return Err(invalid(path, "`mcp_servers` must be a TOML table"));
        };
        let mut out = Vec::with_capacity(servers.len());
        for (name, entry_item) in servers.iter() {
            let Some(entry) = entry_item.as_table_like() else {
                return Err(invalid(path, format!("`mcp_servers.{name}` must be a TOML table")));
            };
            let (transport, enabled) = decode_toml_entry(path, name, entry)?;
            out.push(HostMcpServer {
                host: McpHostId::Codex,
                name: name.to_owned(),
                transport,
                enabled,
                config_path: path.to_path_buf(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub(super) fn read_toml_server(path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Ok(None);
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let doc: DocumentMut = raw.parse().map_err(|e| invalid(path, e))?;
        let Some(servers_item) = doc.get("mcp_servers") else {
            return Ok(None);
        };
        let Some(servers) = servers_item.as_table_like() else {
            return Err(invalid(path, "`mcp_servers` must be a TOML table"));
        };
        let Some(entry_item) = servers.get(server_name) else {
            return Ok(None);
        };
        let Some(entry) = entry_item.as_table_like() else {
            return Err(invalid(path, format!("`mcp_servers.{server_name}` must be a TOML table")));
        };
        decode_toml_entry(path, server_name, entry).map(|(t, _)| Some(t))
    }

    fn build_server_table(transport: &McpTransportSpec, enabled: bool) -> Table {
        let mut table = Table::new();
        match transport {
            McpTransportSpec::Stdio { command, args, env } => {
                table.insert("command", Item::Value(Value::from(command.as_str())));
                let mut arr = Array::new();
                for arg in args {
                    arr.push(arg.as_str());
                }
                table.insert("args", Item::Value(Value::Array(arr)));
                if !env.is_empty() {
                    let mut env_table = Table::new();
                    for (k, v) in env {
                        env_table.insert(k, Item::Value(Value::from(v.as_str())));
                    }
                    table.insert("env", Item::Table(env_table));
                }
            }
            McpTransportSpec::StreamableHttp { url, headers, .. } => {
                table.insert("url", Item::Value(Value::from(url.as_str())));
                if !headers.is_empty() {
                    let mut hdr_table = Table::new();
                    for (k, v) in headers {
                        hdr_table.insert(k, Item::Value(Value::from(v.as_str())));
                    }
                    table.insert("http_headers", Item::Table(hdr_table));
                }
            }
        }
        if !enabled {
            table.insert("enabled", Item::Value(Value::from(false)));
        }
        table
    }

    pub(super) fn format_server_section(server_name: &str, transport: &McpTransportSpec) -> String {
        let mut doc = DocumentMut::new();
        let mut mcp_servers = Table::new();
        mcp_servers.set_implicit(true);
        mcp_servers.insert(server_name, Item::Table(build_server_table(transport, true)));
        doc.insert("mcp_servers", Item::Table(mcp_servers));
        doc.to_string()
    }

    pub(super) fn upsert_toml_server(
        path: &Path,
        previous_name: Option<&str>,
        server_name: &str,
        transport: &McpTransportSpec,
        enabled: bool,
    ) -> Result<(), McpInstallError> {
        let raw = read_optional_file(path)?.unwrap_or_default();
        let mut doc: DocumentMut = raw.parse().map_err(|e| invalid(path, e))?;
        let entry = Item::Table(build_server_table(transport, enabled));
        match doc.get_mut("mcp_servers") {
            None => {
                let mut mcp_servers = Table::new();
                mcp_servers.set_implicit(true);
                mcp_servers.insert(server_name, entry);
                doc.insert("mcp_servers", Item::Table(mcp_servers));
            }
            Some(Item::Table(table)) => {
                if let Some(prev) = previous_name {
                    table.remove(prev);
                }
                table.insert(server_name, entry);
            }
            Some(Item::Value(Value::InlineTable(inline))) => {
                let mut table = inline.clone().into_table();
                if let Some(prev) = previous_name {
                    table.remove(prev);
                }
                table.insert(server_name, entry);
                doc.insert("mcp_servers", Item::Table(table));
            }
            Some(_) => return Err(invalid(path, "`mcp_servers` must be a TOML table")),
        }
        let mut encoded = doc.to_string();
        if !encoded.is_empty() && !encoded.ends_with('\n') {
            encoded.push('\n');
        }
        write_file_atomic(path, encoded.as_bytes())
    }

    pub(super) fn set_toml_server_enabled(path: &Path, server_name: &str, enabled: bool) -> Result<HostMcpServer, McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Err(McpInstallError::ServerNotFound {
                host: McpHostId::Codex,
                name: server_name.to_owned(),
            });
        };
        if raw.trim().is_empty() {
            return Err(McpInstallError::ServerNotFound {
                host: McpHostId::Codex,
                name: server_name.to_owned(),
            });
        }
        let mut doc: DocumentMut = raw.parse().map_err(|e| invalid(path, e))?;
        let Some(servers_item) = doc.get_mut("mcp_servers") else {
            return Err(McpInstallError::ServerNotFound {
                host: McpHostId::Codex,
                name: server_name.to_owned(),
            });
        };
        let Some(servers) = servers_item.as_table_like_mut() else {
            return Err(invalid(path, "`mcp_servers` must be a TOML table"));
        };
        let Some(entry_item) = servers.get_mut(server_name) else {
            return Err(McpInstallError::ServerNotFound {
                host: McpHostId::Codex,
                name: server_name.to_owned(),
            });
        };
        let Some(entry) = entry_item.as_table_like_mut() else {
            return Err(invalid(path, format!("`mcp_servers.{server_name}` must be a TOML table")));
        };
        if enabled {
            entry.remove("enabled");
        } else {
            entry.insert("enabled", Item::Value(Value::from(false)));
        }
        let (transport, final_enabled) = decode_toml_entry(path, server_name, entry)?;
        let mut encoded = doc.to_string();
        if !encoded.is_empty() && !encoded.ends_with('\n') {
            encoded.push('\n');
        }
        write_file_atomic(path, encoded.as_bytes())?;
        Ok(HostMcpServer {
            host: McpHostId::Codex,
            name: server_name.to_owned(),
            transport,
            enabled: final_enabled,
            config_path: path.to_path_buf(),
        })
    }

    pub(super) fn remove_toml_server(path: &Path, server_name: &str) -> Result<(), McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Ok(());
        };
        let mut doc: DocumentMut = raw.parse().map_err(|e| invalid(path, e))?;
        match doc.get_mut("mcp_servers") {
            None => return Ok(()),
            Some(Item::Table(table)) => {
                if table.remove(server_name).is_none() {
                    return Ok(());
                }
                if table.is_empty() {
                    doc.remove("mcp_servers");
                }
            }
            Some(Item::Value(Value::InlineTable(inline))) => {
                if inline.remove(server_name).is_none() {
                    return Ok(());
                }
                if inline.is_empty() {
                    doc.remove("mcp_servers");
                }
            }
            Some(_) => return Err(invalid(path, "`mcp_servers` must be a TOML table")),
        }
        let mut encoded = doc.to_string();
        if !encoded.is_empty() && !encoded.ends_with('\n') {
            encoded.push('\n');
        }
        write_file_atomic(path, encoded.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_cfg(name: &str, cmd: &str, args: &[&str]) -> McpServerConfig {
        McpServerConfig::stdio(name, cmd, args.iter().map(|s| (*s).to_owned()).collect())
    }

    fn http_cfg(name: &str, url: &str) -> McpServerConfig {
        McpServerConfig::streamable_http(name, url, true)
    }

    #[test]
    fn host_id_parse_and_display_round_trip() {
        for &host in McpHostId::ALL {
            assert_eq!(McpHostId::parse(host.as_str()), Some(host));
            assert_eq!(host.to_string().parse::<McpHostId>().unwrap(), host);
        }
        assert_eq!(McpHostId::parse("agy"), Some(McpHostId::Antigravity));
        assert_eq!(McpHostId::parse("acp:antigravity"), Some(McpHostId::Antigravity));
        assert_eq!(McpHostId::parse("claude-code"), Some(McpHostId::Claude));
        assert_eq!(McpHostId::parse("unknown"), None);
    }

    #[test]
    fn full_lifecycle_across_all_hosts_stdio_and_http() {
        let home = tempfile::tempdir().unwrap();
        let desired_stdio = stdio_cfg("vibevalley", "/usr/local/bin/vibevalley", &["mcp", "--channel", "alpha"]).with_env("VIBEVALLEY_CHANNEL", "alpha");
        let drifted_stdio = stdio_cfg("vibevalley", "/opt/new/vibevalley", &["mcp", "--channel", "beta"]).with_env("VIBEVALLEY_CHANNEL", "beta");
        let desired_http = http_cfg("vibevalley", "http://127.0.0.1:8789/mcp")
            .with_header("Authorization", "Bearer tok-123")
            .with_header("MCP-Protocol-Version", vibevalley_mcp::PROTOCOL_STATELESS);
        let drifted_http = http_cfg("vibevalley", "http://127.0.0.1:8790/mcp")
            .with_header("Authorization", "Bearer tok-123")
            .with_header("MCP-Protocol-Version", vibevalley_mcp::PROTOCOL_STATELESS);

        // 1. Missing config files -> NotInstalled across all hosts.
        let initial = list_mcp_hosts_in(home.path(), &desired_stdio);
        assert_eq!(initial.len(), McpHostId::ALL.len());
        for report in &initial {
            assert_eq!(report.state, McpInstallState::NotInstalled, "host={}", report.id);
            assert!(!report.installed, "host={}", report.id);
            assert!(report.supports_stdio);
            assert!(report.supports_http);
        }

        // 2. Stdio install -> Installed -> drift -> Outdated -> update -> Installed.
        for &host in McpHostId::ALL {
            let installed = install_mcp_host_in(home.path(), host, &desired_stdio).unwrap();
            assert!(installed.installed, "host={host}");
            assert_eq!(
                installed.state,
                McpInstallState::Installed {
                    transport: desired_stdio.transport.clone(),
                },
                "host={host}"
            );

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(host.config_path(home.path())).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "host={host} must write 0600 permissions");
            }

            let drift = mcp_status_in(home.path(), host, &drifted_stdio);
            assert!(
                matches!(drift.state, McpInstallState::Outdated { ref reason, .. } if reason.contains("command differs")),
                "host={host} got {:?}",
                drift.state
            );

            // Switch transport mode from Stdio to StreamableHttp -> Outdated before install, Installed after.
            let mode_drift = mcp_status_in(home.path(), host, &desired_http);
            assert!(
                matches!(mode_drift.state, McpInstallState::Outdated { ref reason, .. } if reason.contains("transport differs")),
                "host={host} got {:?}",
                mode_drift.state
            );

            let http_installed = install_mcp_host_in(home.path(), host, &desired_http).unwrap();
            assert_eq!(
                http_installed.state,
                McpInstallState::Installed {
                    transport: desired_http.transport.clone(),
                },
                "host={host}"
            );

            // URL drift detection in HTTP mode.
            let url_drift = mcp_status_in(home.path(), host, &drifted_http);
            assert!(
                matches!(url_drift.state, McpInstallState::Outdated { ref reason, .. } if reason.contains("url differs")),
                "host={host} got {:?}",
                url_drift.state
            );

            // Uninstall -> NotInstalled.
            let removed = uninstall_mcp_host_in(home.path(), host, "vibevalley").unwrap();
            assert_eq!(removed.state, McpInstallState::NotInstalled, "host={host}");
            assert_eq!(mcp_status_in(home.path(), host, &desired_http).state, McpInstallState::NotInstalled);
        }
    }

    #[test]
    fn preserves_sibling_servers_and_user_settings_in_json_hosts() {
        let home = tempfile::tempdir().unwrap();

        // Antigravity: existing sibling server + extra top-level setting.
        let agy_path = McpHostId::Antigravity.config_path(home.path());
        std::fs::create_dir_all(agy_path.parent().unwrap()).unwrap();
        std::fs::write(
            &agy_path,
            r#"{
  "customFlag": true,
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "keep-me" }
    }
  }
}
"#,
        )
        .unwrap();

        // Claude: rich ~/.claude.json with unrelated user state & sibling server.
        let claude_path = McpHostId::Claude.config_path(home.path());
        std::fs::write(
            &claude_path,
            r#"{
  "numStartups": 42,
  "projects": { "/work/demo": { "allowedTools": ["Read"] } },
  "mcpServers": {
    "postgres": {
      "type": "http",
      "url": "http://127.0.0.1:9999/mcp",
      "headers": { "X-Custom": "yes" }
    }
  }
}
"#,
        )
        .unwrap();

        // Cursor: existing sibling server.
        let cursor_path = McpHostId::Cursor.config_path(home.path());
        std::fs::create_dir_all(cursor_path.parent().unwrap()).unwrap();
        std::fs::write(
            &cursor_path,
            r#"{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp" }
  }
}
"#,
        )
        .unwrap();

        let vv = http_cfg("vibevalley", "http://127.0.0.1:8789/mcp").with_header("Authorization", "Bearer vv-token");

        for host in [McpHostId::Antigravity, McpHostId::Claude, McpHostId::Cursor] {
            let report = install_mcp_host_in(home.path(), host, &vv).unwrap();
            assert!(matches!(report.state, McpInstallState::Installed { .. }), "host={host}");
        }

        // Verify Claude uses `{ type: "http", url, headers }` and keeps numStartups/projects/postgres.
        let claude_json: Value = serde_json::from_str(&std::fs::read_to_string(&claude_path).unwrap()).unwrap();
        assert_eq!(claude_json["numStartups"], 42);
        assert_eq!(claude_json["projects"]["/work/demo"]["allowedTools"][0], "Read");
        assert_eq!(claude_json["mcpServers"]["postgres"]["url"], "http://127.0.0.1:9999/mcp");
        assert_eq!(claude_json["mcpServers"]["vibevalley"]["type"], "http");
        assert_eq!(claude_json["mcpServers"]["vibevalley"]["url"], "http://127.0.0.1:8789/mcp");
        assert_eq!(claude_json["mcpServers"]["vibevalley"]["headers"]["Authorization"], "Bearer vv-token");

        // Uninstall vibevalley from all three and verify siblings survive intact.
        for host in [McpHostId::Antigravity, McpHostId::Claude, McpHostId::Cursor] {
            uninstall_mcp_host_in(home.path(), host, "vibevalley").unwrap();
        }

        let agy_after: Value = serde_json::from_str(&std::fs::read_to_string(&agy_path).unwrap()).unwrap();
        assert_eq!(agy_after["customFlag"], true);
        assert_eq!(agy_after["mcpServers"]["github"]["env"]["GITHUB_TOKEN"], "keep-me");
        assert!(agy_after["mcpServers"].get("vibevalley").is_none());

        let claude_after: Value = serde_json::from_str(&std::fs::read_to_string(&claude_path).unwrap()).unwrap();
        assert_eq!(claude_after["numStartups"], 42);
        assert_eq!(claude_after["mcpServers"]["postgres"]["headers"]["X-Custom"], "yes");
        assert!(claude_after["mcpServers"].get("vibevalley").is_none());

        let cursor_after: Value = serde_json::from_str(&std::fs::read_to_string(&cursor_path).unwrap()).unwrap();
        assert_eq!(cursor_after["mcpServers"]["linear"]["url"], "https://mcp.linear.app/mcp");
        assert!(cursor_after["mcpServers"].get("vibevalley").is_none());
    }

    #[test]
    fn preserves_comments_keys_and_sibling_servers_in_codex_toml() {
        let home = tempfile::tempdir().unwrap();
        let codex_path = McpHostId::Codex.config_path(home.path());
        std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
        let original = r#"# Top-level Codex preferences
model = "o3"
approval_policy = "on-request"

# Sibling server must stay untouched
[mcp_servers.context7]
command = "npx"
args = [
  "-y",
  "@upstash/context7-mcp",
]

[mcp_servers.context7.env]
API_KEY = "keep-secret"

[profiles.fast]
model = "o4-mini"
"#;
        std::fs::write(&codex_path, original).unwrap();

        let stdio = stdio_cfg("vibevalley", "/usr/local/bin/vibevalley", &["mcp", "--channel", "alpha"]).with_env("VIBEVALLEY_CHANNEL", "alpha");
        let installed = install_mcp_host_in(home.path(), McpHostId::Codex, &stdio).unwrap();
        assert_eq!(
            installed.state,
            McpInstallState::Installed {
                transport: stdio.transport.clone(),
            }
        );

        let after_install = std::fs::read_to_string(&codex_path).unwrap();
        assert!(after_install.contains("# Top-level Codex preferences"));
        assert!(after_install.contains("model = \"o3\""));
        assert!(after_install.contains("# Sibling server must stay untouched"));
        assert!(after_install.contains("[mcp_servers.context7]"));
        assert!(after_install.contains("API_KEY = \"keep-secret\""));
        assert!(after_install.contains("[profiles.fast]"));
        assert!(after_install.contains("[mcp_servers.vibevalley]"));
        assert!(after_install.contains("[mcp_servers.vibevalley.env]"));

        // Sibling server is still readable as Installed.
        let sibling_probe = stdio_cfg("context7", "npx", &["-y", "@upstash/context7-mcp"]).with_env("API_KEY", "keep-secret");
        assert_eq!(
            mcp_status_in(home.path(), McpHostId::Codex, &sibling_probe).state,
            McpInstallState::Installed {
                transport: sibling_probe.transport.clone(),
            }
        );

        // Update vibevalley in-place to StreamableHttp with headers.
        let http = http_cfg("vibevalley", "http://127.0.0.1:8789/mcp").with_header("Authorization", "Bearer abc");
        let updated = install_mcp_host_in(home.path(), McpHostId::Codex, &http).unwrap();
        assert_eq!(
            updated.state,
            McpInstallState::Installed {
                transport: http.transport.clone(),
            }
        );
        let after_update = std::fs::read_to_string(&codex_path).unwrap();
        assert!(!after_update.contains("[mcp_servers.vibevalley.env]"));
        assert!(after_update.contains("[mcp_servers.vibevalley.http_headers]"));
        assert!(after_update.contains("Authorization = \"Bearer abc\""));

        // Uninstall vibevalley: original comments, top-level keys, sibling, and profiles remain intact.
        let removed = uninstall_mcp_host_in(home.path(), McpHostId::Codex, "vibevalley").unwrap();
        assert_eq!(removed.state, McpInstallState::NotInstalled);
        let after_remove = std::fs::read_to_string(&codex_path).unwrap();
        assert!(!after_remove.contains("vibevalley"));
        assert!(after_remove.contains("# Top-level Codex preferences"));
        assert!(after_remove.contains("[mcp_servers.context7]"));
        assert!(after_remove.contains("API_KEY = \"keep-secret\""));
        assert!(after_remove.contains("[profiles.fast]"));
    }

    #[test]
    fn refuses_to_overwrite_corrupt_config_files() {
        let home = tempfile::tempdir().unwrap();
        let claude_path = McpHostId::Claude.config_path(home.path());
        std::fs::write(&claude_path, "{ not valid json").unwrap();

        let cfg = stdio_cfg("vibevalley", "/usr/local/bin/vibevalley", &["mcp"]);
        let err = install_mcp_host_in(home.path(), McpHostId::Claude, &cfg).unwrap_err();
        assert!(matches!(err, McpInstallError::InvalidConfig { .. }), "{err}");
        assert_eq!(std::fs::read_to_string(&claude_path).unwrap(), "{ not valid json");

        let status = mcp_status_in(home.path(), McpHostId::Claude, &cfg);
        assert!(matches!(status.state, McpInstallState::Unsupported { .. }), "{status:?}");
    }

    #[test]
    fn antigravity_accepts_legacy_server_url_and_flags_drift() {
        let home = tempfile::tempdir().unwrap();
        let agy_path = McpHostId::Antigravity.config_path(home.path());
        std::fs::create_dir_all(agy_path.parent().unwrap()).unwrap();
        std::fs::write(&agy_path, r#"{ "mcpServers": { "vibevalley": { "serverUrl": "http://127.0.0.1:8790/mcp" } } }"#).unwrap();

        let desired = http_cfg("vibevalley", "http://127.0.0.1:8789/mcp");
        let report = mcp_status_in(home.path(), McpHostId::Antigravity, &desired);
        assert!(report.installed);
        assert!(matches!(report.state, McpInstallState::Outdated { ref reason, .. } if reason.contains("url differs")));

        let matching = http_cfg("vibevalley", "http://127.0.0.1:8790/mcp");
        let matched = mcp_status_in(home.path(), McpHostId::Antigravity, &matching);
        assert!(matches!(matched.state, McpInstallState::Installed { .. }));
    }

    #[test]
    fn render_mcp_snippet_formats_json_and_toml_for_each_host() {
        let stdio = stdio_cfg("vibevalley", "vibevalley", &["mcp", "--channel", "alpha"]);
        let http = http_cfg("vibevalley", "http://127.0.0.1:8789/mcp");

        let claude_http: Value = serde_json::from_str(&render_mcp_snippet(McpHostId::Claude, &http)).unwrap();
        assert_eq!(claude_http["mcpServers"]["vibevalley"]["type"], "http");
        assert_eq!(claude_http["mcpServers"]["vibevalley"]["url"], "http://127.0.0.1:8789/mcp");

        let cursor_stdio: Value = serde_json::from_str(&render_mcp_snippet(McpHostId::Cursor, &stdio)).unwrap();
        assert_eq!(cursor_stdio["mcpServers"]["vibevalley"]["command"], "vibevalley");
        assert_eq!(cursor_stdio["mcpServers"]["vibevalley"]["args"], json!(["mcp", "--channel", "alpha"]));

        let codex_stdio = render_mcp_snippet(McpHostId::Codex, &stdio);
        assert!(codex_stdio.contains("[mcp_servers.vibevalley]"));
        assert!(codex_stdio.contains("command = \"vibevalley\""));
        assert!(codex_stdio.contains("args = [\"mcp\", \"--channel\", \"alpha\"]"));
    }

    #[test]
    fn codex_toml_handles_multiline_strings_and_preserves_formatting() {
        let home = tempfile::tempdir().unwrap();
        let codex_path = McpHostId::Codex.config_path(home.path());
        std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();

        let original = r#"# Top comment stays intact
developer_instructions = """
# Not a comment
[mcp_servers.vibevalley]
command = "decoy"
"""

[mcp_servers.other]
command = "python3"
args = ["-c", "print('ok')"]
note = '''
[mcp_servers.vibevalley]
url = "http://127.0.0.1:9999/fake"
'''

[mcp_servers.other.env]
MULTILINE = """
line one
[not.a.table]
line two
"""
"#;
        std::fs::write(&codex_path, original).unwrap();

        let desired = stdio_cfg("vibevalley", "/usr/local/bin/vibevalley", &["mcp"]).with_env("PROMPT", "line1\nline2\n# keep");
        assert_eq!(mcp_status_in(home.path(), McpHostId::Codex, &desired).state, McpInstallState::NotInstalled);

        let installed = install_mcp_host_in(home.path(), McpHostId::Codex, &desired).unwrap();
        assert_eq!(
            installed.state,
            McpInstallState::Installed {
                transport: desired.transport.clone(),
            }
        );

        let after_install = std::fs::read_to_string(&codex_path).unwrap();
        assert!(after_install.contains("# Top comment stays intact"));
        assert!(after_install.contains("command = \"decoy\""));
        assert!(after_install.contains("url = \"http://127.0.0.1:9999/fake\""));
        assert!(after_install.contains("[not.a.table]"));

        // Re-reading round-trips multiline env value accurately.
        assert_eq!(
            mcp_status_in(home.path(), McpHostId::Codex, &desired).state,
            McpInstallState::Installed {
                transport: desired.transport.clone(),
            }
        );

        // Sibling server with multiline string env remains Installed.
        let other = stdio_cfg("other", "python3", &["-c", "print('ok')"]).with_env("MULTILINE", "line one\n[not.a.table]\nline two\n");
        assert_eq!(
            mcp_status_in(home.path(), McpHostId::Codex, &other).state,
            McpInstallState::Installed {
                transport: other.transport.clone(),
            }
        );

        // Uninstall removes only real [mcp_servers.vibevalley] and leaves multiline decoy strings intact.
        let removed = uninstall_mcp_host_in(home.path(), McpHostId::Codex, "vibevalley").unwrap();
        assert_eq!(removed.state, McpInstallState::NotInstalled);
        let after_remove = std::fs::read_to_string(&codex_path).unwrap();
        assert!(after_remove.contains("command = \"decoy\""));
        assert!(after_remove.contains("url = \"http://127.0.0.1:9999/fake\""));
        assert_eq!(
            mcp_status_in(home.path(), McpHostId::Codex, &other).state,
            McpInstallState::Installed { transport: other.transport }
        );
    }

    #[test]
    fn host_mcp_inventory_crud_and_enable_toggle_across_all_four_hosts() {
        let home = tempfile::tempdir().unwrap();

        // Missing config files yield empty inventory across all four hosts.
        for &host in McpHostId::ALL {
            assert!(list_host_mcp_servers_in(home.path(), host).unwrap().is_empty(), "host={host}");
        }

        // Antigravity: pre-seeded with disabled legacy serverUrl + enabled stdio server.
        let agy_path = McpHostId::Antigravity.config_path(home.path());
        std::fs::create_dir_all(agy_path.parent().unwrap()).unwrap();
        std::fs::write(
            &agy_path,
            r#"{
  "mcpServers": {
    "linear": { "serverUrl": "https://mcp.linear.app/mcp", "disabled": true },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}"#,
        )
        .unwrap();

        let agy_list = list_host_mcp_servers_in(home.path(), McpHostId::Antigravity).unwrap();
        assert_eq!(agy_list.len(), 2);
        assert_eq!(agy_list[0].name, "fs");
        assert!(agy_list[0].enabled);
        assert_eq!(agy_list[0].config_path, agy_path);
        assert_eq!(agy_list[1].name, "linear");
        assert!(!agy_list[1].enabled);
        assert_eq!(
            agy_list[1].transport,
            McpTransportSpec::StreamableHttp {
                url: "https://mcp.linear.app/mcp".into(),
                headers: BTreeMap::new(),
                stateless: false,
            }
        );

        // Claude: pre-seeded with disabledMcpServers list and unrelated state.
        let claude_path = McpHostId::Claude.config_path(home.path());
        std::fs::write(
            &claude_path,
            r#"{
  "numStartups": 7,
  "disabledMcpServers": ["sentry"],
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}"#,
        )
        .unwrap();
        let claude_list = list_host_mcp_servers_in(home.path(), McpHostId::Claude).unwrap();
        assert_eq!(claude_list.len(), 1);
        assert_eq!(claude_list[0].name, "sentry");
        assert!(!claude_list[0].enabled);

        // Toggle sentry back on in Claude -> clears disabledMcpServers entry and preserves numStartups.
        let enabled_claude = set_host_mcp_server_enabled_in(home.path(), McpHostId::Claude, "sentry", true).unwrap();
        assert!(enabled_claude.enabled);
        let claude_after: Value = serde_json::from_str(&std::fs::read_to_string(&claude_path).unwrap()).unwrap();
        assert_eq!(claude_after["numStartups"], 7);
        assert_eq!(claude_after["disabledMcpServers"], json!([]));

        // Full CRUD + rename + toggle across all four hosts.
        for &host in McpHostId::ALL {
            let created = upsert_host_mcp_server_in(
                home.path(),
                host,
                None,
                &stdio_cfg("context7", "npx", &["-y", "@upstash/context7-mcp"]).with_env("API_KEY", "k1"),
                true,
            )
            .unwrap();
            assert_eq!(created.host, host);
            assert!(created.enabled);

            let disabled = set_host_mcp_server_enabled_in(home.path(), host, "context7", false).unwrap();
            assert!(!disabled.enabled);
            assert!(
                list_host_mcp_servers_in(home.path(), host)
                    .unwrap()
                    .iter()
                    .any(|s| s.name == "context7" && !s.enabled),
                "host={host}"
            );

            let reenabled = set_host_mcp_server_enabled_in(home.path(), host, "context7", true).unwrap();
            assert!(reenabled.enabled);

            // Rename + switch transport atomically.
            let renamed = upsert_host_mcp_server_in(
                home.path(),
                host,
                Some("context7"),
                &http_cfg("context7-http", "https://mcp.context7.com/mcp").with_header("Authorization", "Bearer tok"),
                false,
            )
            .unwrap();
            assert_eq!(renamed.name, "context7-http");
            assert!(!renamed.enabled);

            let listed = list_host_mcp_servers_in(home.path(), host).unwrap();
            assert!(!listed.iter().any(|s| s.name == "context7"), "old name should be gone on {host}");
            let found = listed.iter().find(|s| s.name == "context7-http").expect("renamed server present");
            assert!(!found.enabled);
            assert!(matches!(
                found.transport,
                McpTransportSpec::StreamableHttp { ref url, .. } if url == "https://mcp.context7.com/mcp"
            ));

            remove_host_mcp_server_in(home.path(), host, "context7-http").unwrap();
            assert!(
                !list_host_mcp_servers_in(home.path(), host).unwrap().iter().any(|s| s.name == "context7-http"),
                "removed server must stay absent on {host}"
            );

            let missing_err = set_host_mcp_server_enabled_in(home.path(), host, "does-not-exist", true).unwrap_err();
            assert!(matches!(missing_err, McpInstallError::ServerNotFound { .. }), "{missing_err}");
        }
    }
}
