//! Persistent remote CLI credentials (`$VIBEVALLEY_HOME/auth.json`), redacted token wrapper,
//! server URL normalization, and `vibevalley://pair?...` deep-link parsing.

use std::convert::Infallible;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use url::Url;
use vibevalley_cli::{load_secret_json, save_secret_json};

use crate::client::{Failure, exit};

pub const AUTH_FILE: &str = "auth.json";

/// Redacted credential token: serializes as a plain JSON string, never reveals its full value in `Debug` or `Display`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }

    pub fn trimmed(&self) -> Option<Self> {
        let trimmed = self.0.trim();
        (!trimmed.is_empty()).then(|| Self(trimmed.to_string()))
    }

    /// Safe redacted hint (last four characters only for long tokens; never reveals short secrets).
    pub fn hint(&self) -> String {
        let trimmed = self.0.trim();
        if trimmed.is_empty() {
            return "none".into();
        }
        if trimmed.chars().count() <= 8 {
            return "[redacted]".into();
        }
        let tail: String = trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            f.write_str("Secret(none)")
        } else {
            write!(f, "Secret({})", self.hint())
        }
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hint())
    }
}

impl FromStr for Secret {
    type Err = Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(s.to_string()))
    }
}

/// Persisted remote authentication record stored at `$VIBEVALLEY_HOME/auth.json` (`0o600` on Unix).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthConfig {
    pub server: String,
    pub token: Secret,
    pub device_id: String,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Parsed fields from a `vibevalley://pair?url=<server>&code=<code>[&scope=<scope>]` deep link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPairUrl {
    pub server: String,
    pub code: String,
    pub scope: Option<String>,
}

/// Path to `auth.json` inside `home`.
pub fn auth_path(home: &Path) -> PathBuf {
    home.join(AUTH_FILE)
}

/// Normalizes a server base URL: trims whitespace, adds `http://` when no scheme is present,
/// validates `http`/`https` with a non-empty host, canonicalizes default ports and host casing,
/// and strips trailing slashes.
pub fn normalize_server_url(raw: &str) -> Result<String, Failure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Failure::usage("InvalidValue", "server URL must not be empty"));
    }
    let with_scheme = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&with_scheme).map_err(|e| Failure::usage("InvalidValue", format!("invalid server URL {raw:?}: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Failure::usage(
            "InvalidValue",
            format!("unsupported server URL scheme {:?} (expected http or https)", parsed.scheme()),
        ));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(Failure::usage("InvalidValue", format!("server URL {raw:?} is missing a host")));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Failure::usage(
            "InvalidValue",
            "server URL must not include embedded credentials; use --token instead",
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(Failure::usage(
            "InvalidValue",
            format!("server URL {raw:?} must not include query parameters or fragments"),
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

/// Best-effort normalization for target URLs already passed via flags or `server.json`.
pub fn normalize_server_url_lossy(raw: &str) -> String {
    normalize_server_url(raw).unwrap_or_else(|_| raw.trim().trim_end_matches('/').to_string())
}

/// Returns `true` only when both URLs parse as valid `http`/`https` server URLs with identical normalized forms.
pub fn same_server(a: &str, b: &str) -> bool {
    match (normalize_server_url(a), normalize_server_url(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn has_scheme(raw: &str) -> bool {
    let Some((scheme, _)) = raw.split_once("://") else {
        return false;
    };
    let mut bytes = scheme.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z')) && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

/// Parses `vibevalley://pair?url=<http|https>&code=<code>[&scope=<scope>]`.
pub fn parse_pair_url(raw: &str) -> Result<ParsedPairUrl, Failure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Failure::usage("InvalidValue", "pair URL must not be empty"));
    }
    let parsed = Url::parse(trimmed).map_err(|e| Failure::usage("InvalidValue", format!("invalid pair URL: {e}")))?;
    if !parsed.scheme().eq_ignore_ascii_case("vibevalley") {
        return Err(Failure::usage(
            "InvalidValue",
            format!("invalid pair URL scheme {:?} (expected vibevalley://pair?...)", parsed.scheme()),
        ));
    }
    if !parsed.host_str().is_some_and(|h| h.eq_ignore_ascii_case("pair")) {
        return Err(Failure::usage("InvalidValue", "pair URL must use vibevalley://pair?..."));
    }
    if !matches!(parsed.path(), "" | "/") {
        return Err(Failure::usage("InvalidValue", "pair URL must not contain an extra path"));
    }

    let mut url_param: Option<String> = None;
    let mut code_param: Option<String> = None;
    let mut scope_param: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "url" => url_param = Some(v.trim().to_string()),
            "code" => code_param = Some(v.trim().to_string()),
            "scope" => scope_param = Some(v.trim().to_string()),
            _ => {}
        }
    }

    let raw_server = url_param
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::usage("InvalidValue", "pair URL is missing required `url` query parameter"))?;
    let server = normalize_server_url(&raw_server)?;
    let code = code_param
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::usage("InvalidValue", "pair URL is missing required `code` query parameter"))?;
    let scope = scope_param.filter(|s| !s.is_empty());

    Ok(ParsedPairUrl { server, code, scope })
}

/// Loads `$VIBEVALLEY_HOME/auth.json`, returning `Ok(None)` when absent.
pub fn load(home: &Path) -> Result<Option<AuthConfig>, Failure> {
    let Some(mut cfg) = load_secret_json::<AuthConfig>(&auth_path(home), "credentials")? else {
        return Ok(None);
    };
    cfg.server = normalize_server_url_lossy(&cfg.server);
    Ok(Some(cfg))
}

/// Persists `config` atomically to `$VIBEVALLEY_HOME/auth.json` with `0o600` permissions on Unix.
pub fn save(home: &Path, config: &AuthConfig) -> Result<PathBuf, Failure> {
    let mut stored = config.clone();
    stored.server = normalize_server_url(&stored.server)?;
    save_secret_json(home, AUTH_FILE, &stored, "credentials")
}

/// Removes `$VIBEVALLEY_HOME/auth.json`, returning `Ok(false)` cleanly when already absent.
pub fn remove(home: &Path) -> Result<bool, Failure> {
    let path = auth_path(home);
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(Failure::new(exit::OTHER, "Auth", format!("failed to remove {}: {err}", path.display()))),
    }
}

/// Resolves a default device display name from the system hostname, falling back to `"vibevalley-cli"`.
pub fn default_device_name() -> String {
    let read_cmd = |bin: &str, args: &[&str]| -> Option<String> {
        let out = Command::new(bin).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8(out.stdout).ok()?;
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    read_cmd("hostname", &["-s"])
        .or_else(|| read_cmd("hostname", &[]))
        .or_else(|| std::env::var("HOSTNAME").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("COMPUTERNAME").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "vibevalley-cli".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_never_leaks_in_debug_or_display() {
        let raw = "vv_dev_0123456789abcdef0123456789abcdef";
        let secret = Secret::new(raw);
        let debug = format!("{secret:?}");
        let display = format!("{secret}");
        assert!(!debug.contains(raw), "debug leaked token: {debug}");
        assert!(!display.contains(raw), "display leaked token: {display}");
        assert!(debug.contains("cdef"), "debug missing tail hint: {debug}");

        let short = Secret::new("abc123");
        assert!(!format!("{short:?}").contains("abc123"));
        assert!(!format!("{short}").contains("abc123"));

        let cfg = AuthConfig {
            server: "http://100.64.0.5:8890".into(),
            token: secret,
            device_id: "dev_1".into(),
            device_name: "laptop".into(),
            server_name: Some("Mac Studio".into()),
            scope: Some("remote:default".into()),
        };
        let cfg_debug = format!("{cfg:?}");
        assert!(!cfg_debug.contains(raw), "AuthConfig debug leaked token: {cfg_debug}");
    }

    #[test]
    fn auth_config_save_load_remove_and_unix_0600_mode() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        assert!(!remove(dir.path()).unwrap());

        let cfg = AuthConfig {
            server: "HTTP://100.64.0.5:8890/".into(),
            token: Secret::new("vv_dev_secret_token_9876543210"),
            device_id: "dev_abc".into(),
            device_name: "workstation".into(),
            server_name: Some("Studio".into()),
            scope: Some("remote:default".into()),
        };
        let saved_path = save(dir.path(), &cfg).unwrap();
        assert_eq!(saved_path, dir.path().join(AUTH_FILE));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "auth.json permissions must be 0600, got {mode:o}");
        }

        // Overwriting a file with looser permissions must still produce 0o600.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&saved_path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        save(dir.path(), &cfg).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "overwritten auth.json must keep 0600, got {mode:o}");
        }

        let loaded = load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.server, "http://100.64.0.5:8890");
        assert_eq!(loaded.token.expose(), "vv_dev_secret_token_9876543210");
        assert_eq!(loaded.device_id, "dev_abc");
        assert_eq!(loaded.device_name, "workstation");
        assert_eq!(loaded.server_name.as_deref(), Some("Studio"));
        assert_eq!(loaded.scope.as_deref(), Some("remote:default"));

        assert!(remove(dir.path()).unwrap());
        assert_eq!(load(dir.path()).unwrap(), None);
        assert!(!remove(dir.path()).unwrap());
    }

    #[test]
    fn normalizes_and_compares_server_urls() {
        assert_eq!(normalize_server_url("100.64.0.5:8890").unwrap(), "http://100.64.0.5:8890");
        assert_eq!(normalize_server_url("HTTP://Example.COM:80/").unwrap(), "http://example.com");
        assert_eq!(normalize_server_url("https://mac.ts.net:443///").unwrap(), "https://mac.ts.net");
        assert!(same_server("http://100.64.0.5:8890", "HTTP://100.64.0.5:8890/"));
        assert!(same_server("http://example.com:80", "http://EXAMPLE.COM"));
        assert!(!same_server("http://100.64.0.5:8890", "https://100.64.0.5:8890"));
        assert!(!same_server("http://100.64.0.5:8890", "http://100.64.0.5:8790"));
        assert!(!same_server("http://100.64.0.5:8890", "http://127.0.0.1:8890"));
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("http://user:pass@100.64.0.5:8890").is_err());
        assert!(normalize_server_url("").is_err());
    }

    #[test]
    fn parses_valid_and_rejects_invalid_pair_urls() {
        let ok = parse_pair_url("vibevalley://pair?url=http%3A%2F%2F100.64.0.5%3A8890%2F&code=ABC234").unwrap();
        assert_eq!(ok.server, "http://100.64.0.5:8890");
        assert_eq!(ok.code, "ABC234");
        assert_eq!(ok.scope, None);

        let with_scope = parse_pair_url("vibevalley://pair/?url=https://mac.ts.net:8890&code=XYZ789&scope=remote:runtime").unwrap();
        assert_eq!(with_scope.server, "https://mac.ts.net:8890");
        assert_eq!(with_scope.code, "XYZ789");
        assert_eq!(with_scope.scope.as_deref(), Some("remote:runtime"));

        assert!(parse_pair_url("").is_err());
        assert!(parse_pair_url("https://pair?url=http://127.0.0.1:8890&code=ABC234").is_err());
        assert!(parse_pair_url("vibevalley://other?url=http://127.0.0.1:8890&code=ABC234").is_err());
        assert!(parse_pair_url("vibevalley://pair/extra?url=http://127.0.0.1:8890&code=ABC234").is_err());
        assert!(parse_pair_url("vibevalley://pair?url=http://127.0.0.1:8890").is_err());
        assert!(parse_pair_url("vibevalley://pair?code=ABC234").is_err());
        assert!(parse_pair_url("vibevalley://pair?url=ftp://127.0.0.1&code=ABC234").is_err());
    }
}
