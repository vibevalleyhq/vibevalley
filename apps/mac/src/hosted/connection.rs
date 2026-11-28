//! Desktop Control Plane connection mode persistence (`$VIBEVALLEY_HOME/desktop-connection.json`),
//! redacted token handling, environment variable overrides, and pair-code exchange.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;
pub use vibevalley_protocol::{ConnectionSaveRequest, DesktopConnectionMode, DesktopConnectionSnapshot, DesktopConnectionSource, Secret};
use vibevalley_protocol::{Envelope, RemotePairExchangeRequest, RemotePairExchangeResult, RemotePlatform, SCOPE_REMOTE_CLIENT};

pub const CONNECTION_FILE: &str = "desktop-connection.json";
pub const ENV_CONTROL_PLANE_URL: &str = "VIBEVALLEY_CONTROL_PLANE_URL";
pub const ENV_CONTROL_PLANE_TOKEN: &str = "VIBEVALLEY_CONTROL_PLANE_TOKEN";
pub const ENV_CONTROL_PLANE_LABEL: &str = "VIBEVALLEY_CONTROL_PLANE_LABEL";

const REMOTE_CLIENT_HEADER: &str = "remote";

/// Persisted or active Control Plane transport mode for the macOS desktop app.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Embedded,
    Remote {
        url: String,
        token: Secret,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

impl Mode {
    pub const fn desktop_mode(&self) -> DesktopConnectionMode {
        match self {
            Mode::Embedded => DesktopConnectionMode::Embedded,
            Mode::Remote { .. } => DesktopConnectionMode::Remote,
        }
    }

    pub fn as_str(&self) -> &'static str {
        self.desktop_mode().as_str()
    }

    pub fn url(&self) -> Option<&str> {
        match self {
            Mode::Embedded => None,
            Mode::Remote { url, .. } => Some(url.as_str()),
        }
    }

    pub fn label(&self) -> Option<&str> {
        match self {
            Mode::Embedded => None,
            Mode::Remote { label, .. } => label.as_deref(),
        }
    }

    pub fn token_hint(&self) -> Option<String> {
        match self {
            Mode::Embedded => None,
            Mode::Remote { token, .. } => (!token.is_empty()).then(|| token.hint()),
        }
    }

    /// Compares connection targets without leaking or exposing raw tokens in logs.
    pub fn same_target(&self, other: &Self) -> bool {
        match (self, other) {
            (Mode::Embedded, Mode::Embedded) => true,
            (Mode::Remote { url: a_url, token: a_tok, .. }, Mode::Remote { url: b_url, token: b_tok, .. }) => a_url == b_url && a_tok == b_tok,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionSource {
    Env,
    File,
    Default,
}

impl ConnectionSource {
    pub const fn desktop_source(self) -> DesktopConnectionSource {
        match self {
            ConnectionSource::Env => DesktopConnectionSource::Env,
            ConnectionSource::File => DesktopConnectionSource::File,
            ConnectionSource::Default => DesktopConnectionSource::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnection {
    pub mode: Mode,
    pub source: ConnectionSource,
}

pub fn connection_path(home: &Path) -> PathBuf {
    home.join(CONNECTION_FILE)
}

fn has_scheme(raw: &str) -> bool {
    let Some((scheme, _)) = raw.split_once("://") else {
        return false;
    };
    let mut bytes = scheme.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z')) && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

/// Normalizes a Control Plane base URL: trims whitespace, adds `http://` when no scheme is given,
/// validates `http`/`https` with a non-empty host, forbids embedded credentials/query/fragment,
/// and strips trailing slashes.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("control plane URL must not be empty".into());
    }
    let with_scheme = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&with_scheme).map_err(|e| format!("invalid control plane URL {raw:?}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported control plane URL scheme {:?} (expected http or https)", parsed.scheme()));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(format!("control plane URL {raw:?} is missing a host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("control plane URL must not include embedded credentials".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!("control plane URL {raw:?} must not include query parameters or fragments"));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

pub fn is_loopback_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    unbracketed.eq_ignore_ascii_case("localhost") || unbracketed.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn non_empty_trimmed(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Loads `$VIBEVALLEY_HOME/desktop-connection.json`, defaulting to [`Mode::Embedded`] when absent.
pub fn load(home: &Path) -> Result<Mode, String> {
    let path = connection_path(home);
    let raw = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Mode::Embedded),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };
    let mode: Mode = serde_json::from_str(&raw).map_err(|err| format!("invalid {} (line {}, column {}): {err}", path.display(), err.line(), err.column()))?;
    match mode {
        Mode::Embedded => Ok(Mode::Embedded),
        Mode::Remote { url, token, label } => {
            let normalized = normalize_url(&url)?;
            let label = non_empty_trimmed(label.as_deref());
            Ok(Mode::Remote { url: normalized, token, label })
        }
    }
}

/// Persists `mode` atomically to `$VIBEVALLEY_HOME/desktop-connection.json` with `0o600` permissions on Unix.
pub fn save(home: &Path, mode: &Mode) -> Result<PathBuf, String> {
    let stored = match mode {
        Mode::Embedded => Mode::Embedded,
        Mode::Remote { url, token, label } => {
            let normalized = normalize_url(url)?;
            let trimmed_token = token.trimmed().ok_or_else(|| "remote control plane token must not be empty".to_string())?;
            Mode::Remote {
                url: normalized,
                token: trimmed_token,
                label: non_empty_trimmed(label.as_deref()),
            }
        }
    };
    fs::create_dir_all(home).map_err(|err| format!("failed to create {}: {err}", home.display()))?;
    let body = serde_json::to_string_pretty(&stored).map_err(|err| format!("failed to encode desktop connection config: {err}"))?;
    let path = connection_path(home);
    let tmp_name = format!(
        ".desktop-connection.json.tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = home.join(tmp_name);

    let write_res = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp_path)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp_path, &path)?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to write {}: {err}", path.display()));
    }
    Ok(path)
}

/// Resets persisted connection mode to Local Embedded by removing `desktop-connection.json`.
pub fn reset(home: &Path) -> Result<bool, String> {
    let path = connection_path(home);
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("failed to remove {}: {err}", path.display())),
    }
}

/// Resolves the startup connection mode with explicit precedence:
/// `VIBEVALLEY_CONTROL_PLANE_URL` (+ `VIBEVALLEY_CONTROL_PLANE_TOKEN`) > `$VIBEVALLEY_HOME/desktop-connection.json` > `Mode::Embedded`.
pub fn resolve_from(home: &Path, env_url: Option<&str>, env_token: Option<&str>, env_label: Option<&str>) -> Result<ResolvedConnection, String> {
    if let Some(raw_url) = non_empty_trimmed(env_url) {
        let url = normalize_url(&raw_url)?;
        let token = match non_empty_trimmed(env_token) {
            Some(tok) => Secret::new(tok),
            None if is_loopback_url(&url) => Secret::default(),
            None => {
                return Err(format!(
                    "{ENV_CONTROL_PLANE_TOKEN} is required when {ENV_CONTROL_PLANE_URL} targets a non-loopback host"
                ));
            }
        };
        let label = non_empty_trimmed(env_label);
        return Ok(ResolvedConnection {
            mode: Mode::Remote { url, token, label },
            source: ConnectionSource::Env,
        });
    }

    let persisted = load(home)?;
    let source = match &persisted {
        Mode::Embedded => ConnectionSource::Default,
        Mode::Remote { .. } => ConnectionSource::File,
    };
    Ok(ResolvedConnection { mode: persisted, source })
}

/// Resolves the startup connection mode using live process environment variables and `home`.
pub fn resolve(home: &Path) -> Result<ResolvedConnection, String> {
    let env_url = std::env::var(ENV_CONTROL_PLANE_URL).ok();
    let env_token = std::env::var(ENV_CONTROL_PLANE_TOKEN).ok();
    let env_label = std::env::var(ENV_CONTROL_PLANE_LABEL).ok();
    resolve_from(home, env_url.as_deref(), env_token.as_deref(), env_label.as_deref())
}

pub fn snapshot_from(active: &Mode, configured: &ResolvedConnection) -> DesktopConnectionSnapshot {
    DesktopConnectionSnapshot {
        active_mode: active.desktop_mode(),
        active_url: active.url().map(str::to_string),
        active_label: active.label().map(str::to_string),
        configured_mode: configured.mode.desktop_mode(),
        configured_url: configured.mode.url().map(str::to_string),
        configured_label: configured.mode.label().map(str::to_string),
        token_hint: configured.mode.token_hint().or_else(|| active.token_hint()),
        source: configured.source.desktop_source(),
        restart_required: !active.same_target(&configured.mode),
    }
}

pub fn snapshot(home: &Path, active: &Mode) -> Result<DesktopConnectionSnapshot, String> {
    let configured = resolve(home)?;
    Ok(snapshot_from(active, &configured))
}

/// Resolves a default display name for this Mac when pairing with a remote Control Plane.
pub fn default_device_name() -> String {
    vibevalley_protocol::home::computer_name()
}

/// Exchanges a one-time pairing code against `POST <base_url>/api/v1/remote/pair/exchange`
/// for a persistent Bearer device token.
pub fn exchange_pair_code(base_url: &str, code: &str, device_name: &str) -> Result<RemotePairExchangeResult, String> {
    let normalized = normalize_url(base_url)?;
    let trimmed_code = code.trim();
    if trimmed_code.is_empty() {
        return Err("pairing code must not be empty".into());
    }
    let name = non_empty_trimmed(Some(device_name)).unwrap_or_else(default_device_name);
    let endpoint = format!("{normalized}/api/v1/remote/pair/exchange");
    let body = RemotePairExchangeRequest {
        code: trimmed_code.to_string(),
        device_name: name,
        platform: RemotePlatform::Other,
        scope: Some(SCOPE_REMOTE_CLIENT.to_string()),
    };

    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if is_loopback_url(&normalized) {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|e| format!("failed to build HTTP client: {e}"))?;

    vibevalley_kit::rt::block_on(async move {
        let response = client
            .post(&endpoint)
            .header("x-vibevalley-client", REMOTE_CLIENT_HEADER)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("failed to reach {normalized}: {e}"))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| format!("failed to read pairing response: {e}"))?;
        let envelope: Envelope = serde_json::from_str(&text).map_err(|_| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                format!("pairing failed with HTTP {}", status.as_u16())
            } else {
                format!("pairing failed with HTTP {}: {trimmed}", status.as_u16())
            }
        })?;
        if envelope.biz_code != 0 {
            return Err(envelope.message);
        }
        let data = envelope.data.ok_or_else(|| "pairing response missing data".to_string())?;
        serde_json::from_value(data).map_err(|e| format!("invalid pairing response shape: {e}"))
    })
}

/// Validates and persists a remote Control Plane target, exchanging a pairing code when no direct token is provided.
pub fn configure_remote(home: &Path, req: ConnectionSaveRequest) -> Result<Mode, String> {
    let url = normalize_url(&req.url)?;
    let custom_label = non_empty_trimmed(req.label.as_deref());
    let mode = if let Some(raw_token) = non_empty_trimmed(req.token.as_deref()) {
        Mode::Remote {
            url,
            token: Secret::new(raw_token),
            label: custom_label,
        }
    } else if let Some(pair_code) = non_empty_trimmed(req.pair_code.as_deref()) {
        let device_name = non_empty_trimmed(req.device_name.as_deref()).unwrap_or_else(default_device_name);
        let exchanged = exchange_pair_code(&url, &pair_code, &device_name)?;
        let label = custom_label.or_else(|| non_empty_trimmed(Some(&exchanged.server_name)));
        Mode::Remote {
            url,
            token: Secret::new(exchanged.token),
            label,
        }
    } else {
        return Err("provide either a pairing code or a bearer token".into());
    };
    save(home, &mode)?;
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_redacts_in_debug_and_display() {
        let raw = "vv_dev_0123456789abcdef0123456789abcdef";
        let secret = Secret::new(raw);
        let debug = format!("{secret:?}");
        let display = format!("{secret}");
        assert!(!debug.contains(raw), "Debug leaked token: {debug}");
        assert!(!display.contains(raw), "Display leaked token: {display}");
        assert!(debug.contains("cdef"), "Debug should retain 4-char hint: {debug}");

        let short = Secret::new("tiny12");
        assert!(!format!("{short:?}").contains("tiny12"));
        assert_eq!(short.hint(), "[redacted]");

        let mode = Mode::Remote {
            url: "https://hub.tailnet.ts.net:8791".into(),
            token: secret,
            label: Some("Mac Studio".into()),
        };
        let mode_debug = format!("{mode:?}");
        assert!(!mode_debug.contains(raw), "Mode Debug leaked token: {mode_debug}");
        assert!(mode_debug.contains("cdef"));
    }

    #[test]
    fn persist_remote_mode_0600_round_trip_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), Mode::Embedded);
        assert!(!reset(dir.path()).unwrap());

        let mode = Mode::Remote {
            url: "HTTPS://Hub.Tailnet.TS.Net:8791/".into(),
            token: Secret::new("vv_dev_secret_token_9876543210"),
            label: Some("Studio Hub".into()),
        };
        let saved_path = save(dir.path(), &mode).unwrap();
        assert_eq!(saved_path, dir.path().join(CONNECTION_FILE));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perm = fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(perm, 0o600, "desktop-connection.json must be 0600, got {perm:o}");

            // Overwriting a looser file must still produce 0o600.
            fs::set_permissions(&saved_path, fs::Permissions::from_mode(0o644)).unwrap();
            save(dir.path(), &mode).unwrap();
            let perm_after = fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(perm_after, 0o600, "overwritten desktop-connection.json must stay 0600, got {perm_after:o}");
        }

        let loaded = load(dir.path()).unwrap();
        assert_eq!(
            loaded,
            Mode::Remote {
                url: "https://hub.tailnet.ts.net:8791".into(),
                token: Secret::new("vv_dev_secret_token_9876543210"),
                label: Some("Studio Hub".into()),
            }
        );

        assert!(reset(dir.path()).unwrap());
        assert_eq!(load(dir.path()).unwrap(), Mode::Embedded);
        assert!(!reset(dir.path()).unwrap());
    }

    #[test]
    fn env_override_precedence_over_persisted_file() {
        let dir = tempfile::tempdir().unwrap();

        // Default when neither env nor file is set.
        let default_conn = resolve_from(dir.path(), None, None, None).unwrap();
        assert_eq!(default_conn.mode, Mode::Embedded);
        assert_eq!(default_conn.source, ConnectionSource::Default);

        // Persisted remote config wins when env vars are absent.
        save(
            dir.path(),
            &Mode::Remote {
                url: "http://100.64.1.2:8791".into(),
                token: Secret::new("vv_dev_file_token_1111"),
                label: Some("File Hub".into()),
            },
        )
        .unwrap();
        let file_conn = resolve_from(dir.path(), None, None, None).unwrap();
        assert_eq!(file_conn.source, ConnectionSource::File);
        assert_eq!(file_conn.mode.url(), Some("http://100.64.1.2:8791"));

        // Env vars take highest precedence over persisted file.
        let env_conn = resolve_from(
            dir.path(),
            Some("https://ci-control.ts.net:8791/"),
            Some("vv_dev_env_token_9999"),
            Some("CI Hub"),
        )
        .unwrap();
        assert_eq!(env_conn.source, ConnectionSource::Env);
        assert_eq!(
            env_conn.mode,
            Mode::Remote {
                url: "https://ci-control.ts.net:8791".into(),
                token: Secret::new("vv_dev_env_token_9999"),
                label: Some("CI Hub".into()),
            }
        );

        // Non-loopback env URL without token fails loudly.
        assert!(resolve_from(dir.path(), Some("http://100.64.1.9:8791"), None, None).is_err());

        // Loopback env URL without token is allowed for local/CI mock testing.
        let loopback = resolve_from(dir.path(), Some("http://127.0.0.1:8790"), None, None).unwrap();
        assert_eq!(loopback.source, ConnectionSource::Env);
        assert_eq!(loopback.mode.url(), Some("http://127.0.0.1:8790"));
    }

    #[test]
    fn url_normalization_and_validation() {
        assert_eq!(normalize_url("100.64.1.5:8791").unwrap(), "http://100.64.1.5:8791");
        assert_eq!(normalize_url("https://hub.example.com:443///").unwrap(), "https://hub.example.com");
        assert!(is_loopback_url("http://127.0.0.1:8790"));
        assert!(is_loopback_url("http://localhost:8790"));
        assert!(!is_loopback_url("http://100.64.1.5:8791"));
        assert!(normalize_url("").is_err());
        assert!(normalize_url("ftp://hub.example.com").is_err());
        assert!(normalize_url("http://user:pass@hub.example.com:8791").is_err());
        assert!(normalize_url("http://hub.example.com:8791?token=1").is_err());
    }

    #[test]
    fn snapshot_detects_restart_required_without_leaking_token() {
        let active = Mode::Embedded;
        let raw_token = "vv_dev_super_secret_token_abcd";
        let configured = ResolvedConnection {
            mode: Mode::Remote {
                url: "https://hub.ts.net:8791".into(),
                token: Secret::new(raw_token),
                label: Some("Studio".into()),
            },
            source: ConnectionSource::File,
        };
        let snap = snapshot_from(&active, &configured);
        assert_eq!(snap.active_mode, DesktopConnectionMode::Embedded);
        assert_eq!(snap.configured_mode, DesktopConnectionMode::Remote);
        assert_eq!(snap.configured_url.as_deref(), Some("https://hub.ts.net:8791"));
        assert_eq!(snap.configured_label.as_deref(), Some("Studio"));
        assert_eq!(snap.token_hint.as_deref(), Some("…abcd"));
        assert_eq!(snap.source, DesktopConnectionSource::File);
        assert!(snap.restart_required);

        let serialized = serde_json::to_string(&snap).unwrap();
        assert!(!serialized.contains(raw_token), "snapshot serialized raw token: {serialized}");
    }
}
