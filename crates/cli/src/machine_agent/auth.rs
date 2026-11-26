use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;
use vibevalley_protocol::MachinePlatform;
use vibevalley_runtime::sandbox::Secret;

use crate::{Failure, load_secret_json, save_secret_json};

pub const MACHINE_AUTH_FILE: &str = "machine-auth.json";
const RECONNECT_MIN_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(16);

/// Persisted credentials for a non-ephemeral execution machine (`$VIBEVALLEY_HOME/machine-auth.json`, `0o600`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAuthConfig {
    pub server: String,
    pub token: Secret,
    pub machine_id: String,
    pub machine_name: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

pub fn machine_auth_path(home: &Path) -> PathBuf {
    home.join(MACHINE_AUTH_FILE)
}

/// Loads `$VIBEVALLEY_HOME/machine-auth.json`, returning `Ok(None)` when absent.
pub fn load_machine_auth(home: &Path) -> Result<Option<MachineAuthConfig>, Failure> {
    load_secret_json(&machine_auth_path(home), "machine credentials")
}

/// Persists `config` atomically to `$VIBEVALLEY_HOME/machine-auth.json` with `0o600` permissions on Unix.
pub fn save_machine_auth(home: &Path, config: &MachineAuthConfig) -> Result<PathBuf, Failure> {
    save_secret_json(home, MACHINE_AUTH_FILE, config, "machine credentials")
}

/// Converts a normalized `http://` or `https://` server base URL into `<ws(s)://server>/api/v1/machine/ws`.
pub fn machine_ws_url(server_url: &str) -> Result<String, Failure> {
    let parsed = Url::parse(server_url.trim()).map_err(|e| Failure::usage("InvalidValue", format!("invalid server URL {server_url:?}: {e}")))?;
    let ws_scheme = match parsed.scheme() {
        "http" => "ws",
        "https" => "wss",
        "ws" => "ws",
        "wss" => "wss",
        other => {
            return Err(Failure::usage(
                "InvalidValue",
                format!("unsupported server URL scheme {other:?} (expected http or https)"),
            ));
        }
    };
    let mut base = parsed;
    base.set_scheme(ws_scheme)
        .map_err(|()| Failure::usage("InvalidValue", format!("failed to construct WebSocket URL for {server_url:?}")))?;
    let trimmed = base.as_str().trim_end_matches('/');
    Ok(format!("{trimmed}/api/v1/machine/ws"))
}

/// Detects the wire `MachinePlatform` for this daemon process.
pub fn detect_platform(ephemeral: bool) -> MachinePlatform {
    let in_container = std::env::var("VIBEVALLEY_SANDBOX").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        || Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists();
    if ephemeral || in_container {
        MachinePlatform::Container
    } else if cfg!(target_os = "macos") {
        MachinePlatform::Macos
    } else if cfg!(target_os = "linux") {
        MachinePlatform::Linux
    } else {
        MachinePlatform::Other
    }
}

#[derive(Debug, Clone)]
pub struct MachineAgentConfig {
    pub server_url: String,
    pub token: Secret,
    pub machine_id: String,
    pub name: String,
    pub ephemeral: bool,
    pub workdir: PathBuf,
    pub once: bool,
    pub reconnect_base_delay: Duration,
    pub reconnect_max_delay: Duration,
}

impl MachineAgentConfig {
    pub fn new(server_url: String, token: Secret, machine_id: String, name: String, workdir: PathBuf) -> Self {
        Self {
            server_url,
            token,
            machine_id,
            name,
            ephemeral: false,
            workdir,
            once: false,
            reconnect_base_delay: RECONNECT_MIN_DELAY,
            reconnect_max_delay: RECONNECT_MAX_DELAY,
        }
    }
}
