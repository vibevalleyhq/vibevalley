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

/// Failure while installing or uninstalling an MCP server entry on a coding agent.
#[derive(Debug, thiserror::Error)]
pub enum McpInstallError {
    #[error("cannot determine home directory for MCP host `{0}`")]
    NoHomeDir(McpHostId),
    #[error("MCP host `{host}` does not support the requested transport: {reason}")]
    UnsupportedTransport { host: McpHostId, reason: String },
    #[error("invalid MCP server name `{0}`")]
    InvalidServerName(String),
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
    let name = validate_server_name(&config.name)?;
    validate_transport_support(host, &config.transport)?;
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => {
            upsert_json_server(host, &config_path, name, &config.transport)?;
        }
        McpHostId::Codex => {
            codex_toml::upsert_toml_server(&config_path, name, &config.transport)?;
        }
    }
    Ok(probe_host_report(host, home_dir, config, probe_system))
}

fn uninstall_host_inner(home_dir: &Path, host: McpHostId, server_name: &str, probe_system: bool) -> Result<McpHostReport, McpInstallError> {
    let name = validate_server_name(server_name)?;
    let config_path = host.config_path(home_dir);
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => {
            remove_json_server(&config_path, name)?;
        }
        McpHostId::Codex => {
            codex_toml::remove_toml_server(&config_path, name)?;
        }
    }
    let probe = McpServerConfig::stdio(name, "placeholder", Vec::new());
    Ok(probe_host_report(host, home_dir, &probe, probe_system))
}

fn read_host_server(host: McpHostId, path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
    match host {
        McpHostId::Antigravity | McpHostId::Claude | McpHostId::Cursor => read_json_server(path, server_name),
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

fn decode_json_entry(path: &Path, entry: &Value) -> Result<McpTransportSpec, McpInstallError> {
    let Some(obj) = entry.as_object() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "MCP server entry must be a JSON object".into(),
        });
    };
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
        return Ok(McpTransportSpec::Stdio {
            command: command.to_owned(),
            args,
            env,
        });
    }
    if let Some(url) = ["url", "serverUrl", "httpUrl"].into_iter().find_map(|k| obj.get(k).and_then(Value::as_str)) {
        let headers = parse_string_map(path, "headers", obj.get("headers"))?;
        return Ok(McpTransportSpec::StreamableHttp {
            url: url.to_owned(),
            headers,
            stateless: false,
        });
    }
    Err(McpInstallError::InvalidConfig {
        path: path.to_path_buf(),
        message: "MCP server entry defines neither `command` nor `url`".into(),
    })
}

fn encode_json_entry(host: McpHostId, transport: &McpTransportSpec) -> Value {
    match transport {
        McpTransportSpec::Stdio { command, args, env } => {
            let mut obj = Map::new();
            obj.insert("command".into(), json!(command));
            obj.insert("args".into(), json!(args));
            if !env.is_empty() {
                obj.insert("env".into(), json!(env));
            }
            Value::Object(obj)
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
            Value::Object(obj)
        }
    }
}

fn read_json_server(path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
    let raw = read_optional_file(path)?;
    if raw.is_none() {
        return Ok(None);
    }
    let root = parse_json_root(path, raw)?;
    let Some(servers_val) = root.get("mcpServers") else {
        return Ok(None);
    };
    if servers_val.is_null() {
        return Ok(None);
    }
    let Some(servers) = servers_val.as_object() else {
        return Err(McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: "`mcpServers` must be a JSON object".into(),
        });
    };
    match servers.get(server_name) {
        Some(entry) => decode_json_entry(path, entry).map(Some),
        None => Ok(None),
    }
}

fn upsert_json_server(host: McpHostId, path: &Path, server_name: &str, transport: &McpTransportSpec) -> Result<(), McpInstallError> {
    let raw = read_optional_file(path)?;
    let mut root = parse_json_root(path, raw)?;
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
    servers_obj.insert(server_name.to_owned(), encode_json_entry(host, transport));
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| io_err(path, e))?;
    encoded.push('\n');
    write_file_atomic(path, encoded.as_bytes())
}

fn remove_json_server(path: &Path, server_name: &str) -> Result<(), McpInstallError> {
    let Some(raw) = read_optional_file(path)? else {
        return Ok(());
    };
    let mut root = parse_json_root(path, Some(raw))?;
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
    if !removed {
        return Ok(());
    }
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| io_err(path, e))?;
    encoded.push('\n');
    write_file_atomic(path, encoded.as_bytes())
}

// ---- Comment-preserving TOML editor for Codex (~/.codex/config.toml) --------

mod codex_toml {
    use super::*;

    #[derive(Debug, Default)]
    struct ParsedServer {
        command: Option<String>,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        url: Option<String>,
        headers: BTreeMap<String, String>,
        saw_section: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MultiLineQuote {
        None,
        Basic,
        Literal,
    }

    fn invalid(path: &Path, message: impl Into<String>) -> McpInstallError {
        McpInstallError::InvalidConfig {
            path: path.to_path_buf(),
            message: message.into(),
        }
    }

    /// Scans a line outside multiline strings, updating multiline quote state.
    fn advance_multiline_state(line: &str, mut state: MultiLineQuote) -> MultiLineQuote {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match state {
                MultiLineQuote::Basic => {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes.get(i..i + 3) == Some(b"\"\"\"") {
                        state = MultiLineQuote::None;
                        i += 3;
                        continue;
                    }
                    i += 1;
                }
                MultiLineQuote::Literal => {
                    if bytes.get(i..i + 3) == Some(b"'''") {
                        state = MultiLineQuote::None;
                        i += 3;
                        continue;
                    }
                    i += 1;
                }
                MultiLineQuote::None => {
                    if bytes[i] == b'#' {
                        break;
                    }
                    if bytes.get(i..i + 3) == Some(b"\"\"\"") {
                        state = MultiLineQuote::Basic;
                        i += 3;
                        continue;
                    }
                    if bytes.get(i..i + 3) == Some(b"'''") {
                        state = MultiLineQuote::Literal;
                        i += 3;
                        continue;
                    }
                    if bytes[i] == b'"' {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == b'\\' {
                                i += 2;
                                continue;
                            }
                            if bytes[i] == b'"' {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    if bytes[i] == b'\'' {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == b'\'' {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    i += 1;
                }
            }
        }
        state
    }

    fn strip_comment(line: &str) -> &str {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'#' => return &line[..i],
                b'"' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == b'\\' {
                            i += 2;
                            continue;
                        }
                        if bytes[i] == b'"' {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                }
                b'\'' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == b'\'' {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 1,
            }
        }
        line
    }

    fn parse_basic_string(src: &str) -> Result<(String, &str), String> {
        let Some(rest) = src.strip_prefix('"') else {
            return Err("expected '\"'".into());
        };
        let mut out = String::new();
        let mut chars = rest.char_indices();
        while let Some((idx, ch)) = chars.next() {
            match ch {
                '"' => return Ok((out, &rest[idx + 1..])),
                '\\' => {
                    let Some((_, esc)) = chars.next() else {
                        return Err("unterminated escape sequence".into());
                    };
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'b' => out.push('\u{0008}'),
                        'f' => out.push('\u{000C}'),
                        'u' | 'U' => {
                            let digits = if esc == 'u' { 4 } else { 8 };
                            let mut hex = String::with_capacity(digits);
                            for _ in 0..digits {
                                let Some((_, d)) = chars.next() else {
                                    return Err("incomplete unicode escape".into());
                                };
                                hex.push(d);
                            }
                            let code = u32::from_str_radix(&hex, 16).map_err(|_| format!("invalid unicode escape `\\{esc}{hex}`"))?;
                            let decoded = char::from_u32(code).ok_or_else(|| format!("invalid unicode scalar `\\{esc}{hex}`"))?;
                            out.push(decoded);
                        }
                        other => return Err(format!("unsupported TOML escape `\\{other}`")),
                    }
                }
                other => out.push(other),
            }
        }
        Err("unterminated double-quoted string".into())
    }

    fn parse_literal_string(src: &str) -> Result<(String, &str), String> {
        let Some(rest) = src.strip_prefix('\'') else {
            return Err("expected `'`".into());
        };
        let Some(end) = rest.find('\'') else {
            return Err("unterminated single-quoted string".into());
        };
        Ok((rest[..end].to_owned(), &rest[end + 1..]))
    }

    fn parse_key_segment(src: &str) -> Result<(String, &str), String> {
        let trimmed = src.trim_start();
        if trimmed.starts_with('"') {
            parse_basic_string(trimmed)
        } else if trimmed.starts_with('\'') {
            parse_literal_string(trimmed)
        } else {
            let end = trimmed
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(trimmed.len());
            if end == 0 {
                return Err(format!("expected TOML key near `{trimmed}`"));
            }
            Ok((trimmed[..end].to_owned(), &trimmed[end..]))
        }
    }

    fn parse_dotted_key(src: &str) -> Result<(Vec<String>, &str), String> {
        let mut parts = Vec::new();
        let mut rest = src.trim_start();
        loop {
            let (seg, after) = parse_key_segment(rest)?;
            parts.push(seg);
            let after = after.trim_start();
            if let Some(next) = after.strip_prefix('.') {
                rest = next;
            } else {
                return Ok((parts, after));
            }
        }
    }

    /// Parses `[a.b."c"]` or `[[a.b]]`. Returns `Ok(Some(path))` if this line is a header.
    fn parse_table_header(line: &str) -> Result<Option<Vec<String>>, String> {
        let code = strip_comment(line).trim();
        if !code.starts_with('[') {
            return Ok(None);
        }
        let (inner, double) = if let Some(rest) = code.strip_prefix("[[") {
            let Some(body) = rest.strip_suffix("]]") else {
                return Err(format!("malformed array-of-tables header `{code}`"));
            };
            (body, true)
        } else {
            let Some(body) = code.strip_prefix('[').and_then(|r| r.strip_suffix(']')) else {
                return Err(format!("malformed table header `{code}`"));
            };
            (body, false)
        };
        let (path, rem) = parse_dotted_key(inner)?;
        if !rem.trim().is_empty() {
            return Err(format!(
                "unexpected trailing tokens `{}` in {} header",
                rem.trim(),
                if double { "array-of-tables" } else { "table" }
            ));
        }
        Ok(Some(path))
    }

    fn parse_string_value(src: &str) -> Result<(String, &str), String> {
        let trimmed = src.trim_start();
        if trimmed.starts_with('"') {
            parse_basic_string(trimmed)
        } else if trimmed.starts_with('\'') {
            parse_literal_string(trimmed)
        } else {
            Err(format!("expected TOML string near `{trimmed}`"))
        }
    }

    fn parse_string_array(src: &str) -> Result<(Vec<String>, &str), String> {
        let mut rest = src.trim_start().strip_prefix('[').ok_or_else(|| format!("expected `[` near `{src}`"))?;
        let mut out = Vec::new();
        loop {
            rest = skip_ws_and_comments(rest);
            if let Some(after) = rest.strip_prefix(']') {
                return Ok((out, after));
            }
            let (item, after) = parse_string_value(rest)?;
            out.push(item);
            rest = skip_ws_and_comments(after);
            if let Some(after_comma) = rest.strip_prefix(',') {
                rest = after_comma;
            } else if let Some(after_close) = rest.strip_prefix(']') {
                return Ok((out, after_close));
            } else {
                return Err(format!("expected `,` or `]` in array near `{rest}`"));
            }
        }
    }

    fn parse_inline_string_table(src: &str) -> Result<(BTreeMap<String, String>, &str), String> {
        let mut rest = src.trim_start().strip_prefix('{').ok_or_else(|| format!("expected `{{` near `{src}`"))?;
        let mut out = BTreeMap::new();
        loop {
            rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix('}') {
                return Ok((out, after));
            }
            let (key_parts, after_key) = parse_dotted_key(rest)?;
            let after_eq = after_key
                .trim_start()
                .strip_prefix('=')
                .ok_or_else(|| format!("expected `=` in inline table near `{after_key}`"))?;
            let (val, after_val) = parse_string_value(after_eq)?;
            out.insert(key_parts.join("."), val);
            rest = after_val.trim_start();
            if let Some(after_comma) = rest.strip_prefix(',') {
                rest = after_comma;
            } else if let Some(after_close) = rest.strip_prefix('}') {
                return Ok((out, after_close));
            } else {
                return Err(format!("expected `,` or `}}` in inline table near `{rest}`"));
            }
        }
    }

    fn skip_ws_and_comments(mut src: &str) -> &str {
        loop {
            src = src.trim_start();
            if let Some(comment) = src.strip_prefix('#') {
                match comment.find('\n') {
                    Some(nl) => src = &comment[nl + 1..],
                    None => return "",
                }
            } else {
                return src;
            }
        }
    }

    /// Parses an inline server table like `vibevalley = { command = "...", args = [...] }`.
    fn parse_inline_server_entry(src: &str, out: &mut ParsedServer) -> Result<(), String> {
        let mut rest = src
            .trim_start()
            .strip_prefix('{')
            .ok_or_else(|| format!("expected inline table near `{src}`"))?;
        out.saw_section = true;
        loop {
            rest = rest.trim_start();
            if rest.starts_with('}') {
                return Ok(());
            }
            let (keys, after_key) = parse_dotted_key(rest)?;
            let after_eq = after_key
                .trim_start()
                .strip_prefix('=')
                .ok_or_else(|| format!("expected `=` near `{after_key}`"))?
                .trim_start();
            let after_val = match keys.as_slice() {
                [k] if k == "command" => {
                    let (v, r) = parse_string_value(after_eq)?;
                    out.command = Some(v);
                    r
                }
                [k] if k == "args" => {
                    let (v, r) = parse_string_array(after_eq)?;
                    out.args = v;
                    r
                }
                [k] if k == "env" => {
                    let (v, r) = parse_inline_string_table(after_eq)?;
                    out.env.extend(v);
                    r
                }
                [k] if k == "url" => {
                    let (v, r) = parse_string_value(after_eq)?;
                    out.url = Some(v);
                    r
                }
                [k] if k == "http_headers" || k == "headers" => {
                    let (v, r) = parse_inline_string_table(after_eq)?;
                    out.headers.extend(v);
                    r
                }
                _ => skip_inline_value(after_eq)?,
            };
            rest = after_val.trim_start();
            if let Some(next) = rest.strip_prefix(',') {
                rest = next;
            } else if rest.starts_with('}') {
                return Ok(());
            } else {
                return Err(format!("expected `,` or `}}` near `{rest}`"));
            }
        }
    }

    fn skip_inline_value(src: &str) -> Result<&str, String> {
        let trimmed = src.trim_start();
        if trimmed.starts_with('"') {
            parse_basic_string(trimmed).map(|(_, r)| r)
        } else if trimmed.starts_with('\'') {
            parse_literal_string(trimmed).map(|(_, r)| r)
        } else if trimmed.starts_with('[') || trimmed.starts_with('{') {
            let open = trimmed.as_bytes()[0];
            let close = if open == b'[' { b']' } else { b'}' };
            let bytes = trimmed.as_bytes();
            let mut depth = 0usize;
            let mut i = 0usize;
            while i < bytes.len() {
                match bytes[i] {
                    b'"' => {
                        let (_, r) = parse_basic_string(&trimmed[i..])?;
                        i = trimmed.len() - r.len();
                        continue;
                    }
                    b'\'' => {
                        let (_, r) = parse_literal_string(&trimmed[i..])?;
                        i = trimmed.len() - r.len();
                        continue;
                    }
                    b if b == open => depth += 1,
                    b if b == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(&trimmed[i + 1..]);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            Err("unterminated composite value in inline table".into())
        } else {
            let end = trimmed.find([',', '}']).unwrap_or(trimmed.len());
            Ok(&trimmed[end..])
        }
    }

    /// Computes bracket balance (`[`/`]` and `{`/`}`) outside string literals and `#` comments.
    fn delimiter_delta(line: &str) -> i32 {
        let code = strip_comment(line);
        let bytes = code.as_bytes();
        let mut i = 0;
        let mut delta = 0i32;
        while i < bytes.len() {
            match bytes[i] {
                b'"' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == b'\\' {
                            i += 2;
                            continue;
                        }
                        if bytes[i] == b'"' {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                }
                b'\'' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == b'\'' {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                }
                b'[' | b'{' => {
                    delta += 1;
                    i += 1;
                }
                b']' | b'}' => {
                    delta -= 1;
                    i += 1;
                }
                _ => i += 1,
            }
        }
        delta
    }

    fn is_target_section(section: &[String], server_name: &str) -> bool {
        section.len() >= 2 && section[0] == "mcp_servers" && section[1] == server_name
    }

    fn is_inline_target_entry(section: &[String], line: &str, server_name: &str) -> bool {
        if section.len() != 1 || section[0] != "mcp_servers" {
            return false;
        }
        let code = strip_comment(line).trim();
        if code.is_empty() {
            return false;
        }
        matches!(parse_dotted_key(code), Ok((keys, rem)) if keys.first().map(String::as_str) == Some(server_name) && rem.trim_start().starts_with('='))
    }

    fn parse_assignment_lines(lines: &[&str], idx: &mut usize) -> Result<Option<(Vec<String>, String)>, String> {
        let code = strip_comment(lines[*idx]).trim();
        if code.is_empty() {
            return Ok(None);
        }
        let (keys, after_key) = parse_dotted_key(code)?;
        let Some(rhs_first) = after_key.trim_start().strip_prefix('=') else {
            return Err(format!("expected `=` in TOML assignment `{code}`"));
        };
        let mut rhs = rhs_first.trim().to_owned();
        let mut depth = delimiter_delta(rhs_first);
        while depth > 0 {
            if *idx + 1 >= lines.len() {
                return Err("unterminated multiline TOML value".into());
            }
            *idx += 1;
            let next_line = lines[*idx];
            rhs.push('\n');
            rhs.push_str(next_line);
            depth += delimiter_delta(next_line);
        }
        Ok(Some((keys, rhs)))
    }

    pub(super) fn read_toml_server(path: &Path, server_name: &str) -> Result<Option<McpTransportSpec>, McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Ok(None);
        };
        let lines: Vec<&str> = raw.lines().collect();
        let mut section: Vec<String> = Vec::new();
        let mut quote_state = MultiLineQuote::None;
        let mut parsed = ParsedServer::default();
        let mut i = 0;

        while i < lines.len() {
            let line = lines[i];
            if quote_state != MultiLineQuote::None {
                quote_state = advance_multiline_state(line, quote_state);
                i += 1;
                continue;
            }
            if let Some(header) = parse_table_header(line).map_err(|e| invalid(path, e))? {
                section = header;
                if is_target_section(&section, server_name) {
                    parsed.saw_section = true;
                }
                i += 1;
                continue;
            }
            if is_target_section(&section, server_name) {
                let Some((keys, rhs)) = parse_assignment_lines(&lines, &mut i).map_err(|e| invalid(path, e))? else {
                    i += 1;
                    continue;
                };
                match section.as_slice() {
                    [_, _] => match keys.as_slice() {
                        [k] if k == "command" => {
                            let (v, rem) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                            if !rem.trim().is_empty() {
                                return Err(invalid(path, format!("unexpected tokens after `command`: `{}`", rem.trim())));
                            }
                            parsed.command = Some(v);
                        }
                        [k] if k == "args" => {
                            let (v, rem) = parse_string_array(&rhs).map_err(|e| invalid(path, e))?;
                            if !rem.trim().is_empty() {
                                return Err(invalid(path, format!("unexpected tokens after `args`: `{}`", rem.trim())));
                            }
                            parsed.args = v;
                        }
                        [k] if k == "env" => {
                            let (v, rem) = parse_inline_string_table(&rhs).map_err(|e| invalid(path, e))?;
                            if !rem.trim().is_empty() {
                                return Err(invalid(path, format!("unexpected tokens after `env`: `{}`", rem.trim())));
                            }
                            parsed.env.extend(v);
                        }
                        [prefix, sub] if prefix == "env" => {
                            let (v, _) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                            parsed.env.insert(sub.clone(), v);
                        }
                        [k] if k == "url" => {
                            let (v, rem) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                            if !rem.trim().is_empty() {
                                return Err(invalid(path, format!("unexpected tokens after `url`: `{}`", rem.trim())));
                            }
                            parsed.url = Some(v);
                        }
                        [k] if k == "http_headers" || k == "headers" => {
                            let (v, rem) = parse_inline_string_table(&rhs).map_err(|e| invalid(path, e))?;
                            if !rem.trim().is_empty() {
                                return Err(invalid(path, format!("unexpected tokens after `http_headers`: `{}`", rem.trim())));
                            }
                            parsed.headers.extend(v);
                        }
                        [prefix, sub] if prefix == "http_headers" || prefix == "headers" => {
                            let (v, _) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                            parsed.headers.insert(sub.clone(), v);
                        }
                        _ => {}
                    },
                    [_, _, sub] if sub == "env" => {
                        let (v, _) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                        parsed.env.insert(keys.join("."), v);
                    }
                    [_, _, sub] if sub == "http_headers" || sub == "headers" => {
                        let (v, _) = parse_string_value(&rhs).map_err(|e| invalid(path, e))?;
                        parsed.headers.insert(keys.join("."), v);
                    }
                    _ => {}
                }
            } else if is_inline_target_entry(&section, line, server_name) {
                let Some((keys, rhs)) = parse_assignment_lines(&lines, &mut i).map_err(|e| invalid(path, e))? else {
                    i += 1;
                    continue;
                };
                if keys.len() == 1 {
                    parse_inline_server_entry(&rhs, &mut parsed).map_err(|e| invalid(path, e))?;
                }
            } else {
                quote_state = advance_multiline_state(line, quote_state);
            }
            i += 1;
        }

        if quote_state != MultiLineQuote::None {
            return Err(invalid(path, "unterminated multiline TOML string"));
        }
        if !parsed.saw_section {
            return Ok(None);
        }
        if let Some(command) = parsed.command {
            return Ok(Some(McpTransportSpec::Stdio {
                command,
                args: parsed.args,
                env: parsed.env,
            }));
        }
        if let Some(url) = parsed.url {
            return Ok(Some(McpTransportSpec::StreamableHttp {
                url,
                headers: parsed.headers,
                stateless: false,
            }));
        }
        Err(invalid(
            path,
            format!("TOML section `[mcp_servers.{server_name}]` defines neither `command` nor `url`"),
        ))
    }

    fn format_toml_key(key: &str) -> String {
        if !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            key.to_owned()
        } else {
            format_toml_string(key)
        }
    }

    fn format_toml_string(val: &str) -> String {
        let mut out = String::with_capacity(val.len() + 2);
        out.push('"');
        for ch in val.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn format_server_section(server_name: &str, transport: &McpTransportSpec) -> String {
        let key = format_toml_key(server_name);
        let mut out = String::new();
        out.push_str(&format!("[mcp_servers.{key}]\n"));
        match transport {
            McpTransportSpec::Stdio { command, args, env } => {
                out.push_str(&format!("command = {}\n", format_toml_string(command)));
                let encoded_args: Vec<String> = args.iter().map(|a| format_toml_string(a)).collect();
                out.push_str(&format!("args = [{}]\n", encoded_args.join(", ")));
                if !env.is_empty() {
                    out.push_str(&format!("\n[mcp_servers.{key}.env]\n"));
                    for (k, v) in env {
                        out.push_str(&format!("{} = {}\n", format_toml_key(k), format_toml_string(v)));
                    }
                }
            }
            McpTransportSpec::StreamableHttp { url, headers, .. } => {
                out.push_str(&format!("url = {}\n", format_toml_string(url)));
                if !headers.is_empty() {
                    out.push_str(&format!("\n[mcp_servers.{key}.http_headers]\n"));
                    for (k, v) in headers {
                        out.push_str(&format!("{} = {}\n", format_toml_key(k), format_toml_string(v)));
                    }
                }
            }
        }
        out
    }

    /// Removes all lines belonging to `[mcp_servers.<name>]`, `[mcp_servers.<name>.*]`,
    /// or inline `<name> = ...` under `[mcp_servers]`, preserving all other content verbatim.
    fn strip_server_sections(path: &Path, raw: &str, server_name: &str) -> Result<(String, bool), McpInstallError> {
        let lines: Vec<&str> = raw.lines().collect();
        let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
        let mut section: Vec<String> = Vec::new();
        let mut quote_state = MultiLineQuote::None;
        let mut removed_any = false;
        let mut i = 0;

        while i < lines.len() {
            let line = lines[i];
            if quote_state != MultiLineQuote::None {
                quote_state = advance_multiline_state(line, quote_state);
                if !is_target_section(&section, server_name) {
                    kept.push(line);
                }
                i += 1;
                continue;
            }
            if let Some(header) = parse_table_header(line).map_err(|e| invalid(path, e))? {
                section = header;
                if is_target_section(&section, server_name) {
                    removed_any = true;
                    // Trim a single separating blank line directly preceding the removed section.
                    if kept.last().is_some_and(|l| l.trim().is_empty()) {
                        kept.pop();
                    }
                } else {
                    kept.push(line);
                }
                i += 1;
                continue;
            }
            if is_target_section(&section, server_name) {
                removed_any = true;
                quote_state = advance_multiline_state(line, quote_state);
                i += 1;
                continue;
            }
            if is_inline_target_entry(&section, line, server_name) {
                removed_any = true;
                let mut depth = delimiter_delta(line);
                while depth > 0 && i + 1 < lines.len() {
                    i += 1;
                    depth += delimiter_delta(lines[i]);
                }
                i += 1;
                continue;
            }
            quote_state = advance_multiline_state(line, quote_state);
            kept.push(line);
            i += 1;
        }

        if quote_state != MultiLineQuote::None {
            return Err(invalid(path, "unterminated multiline TOML string"));
        }

        while kept.last().is_some_and(|l| l.trim().is_empty()) {
            kept.pop();
        }
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        Ok((out, removed_any))
    }

    pub(super) fn upsert_toml_server(path: &Path, server_name: &str, transport: &McpTransportSpec) -> Result<(), McpInstallError> {
        let raw = read_optional_file(path)?.unwrap_or_default();
        let (mut base, _) = strip_server_sections(path, &raw, server_name)?;
        let section = format_server_section(server_name, transport);
        if !base.is_empty() {
            if !base.ends_with('\n') {
                base.push('\n');
            }
            base.push('\n');
        }
        base.push_str(&section);
        write_file_atomic(path, base.as_bytes())
    }

    pub(super) fn remove_toml_server(path: &Path, server_name: &str) -> Result<(), McpInstallError> {
        let Some(raw) = read_optional_file(path)? else {
            return Ok(());
        };
        let (updated, removed) = strip_server_sections(path, &raw, server_name)?;
        if !removed {
            return Ok(());
        }
        write_file_atomic(path, updated.as_bytes())
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
}
