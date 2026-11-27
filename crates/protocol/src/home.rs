//! The farm's home on disk, for the server, the command line and the app:
//! where it is, `server.json` (where the server using it listens; the
//! command line finds the server through it) and the saved language.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vdp::VdpEndpointInfo;

pub const SERVER_FILE: &str = "server.json";
pub const DEBUG_FILE: &str = "debug.json";
pub const SETTINGS_FILE: &str = "settings.json";

/// Canonical non-standard environment variables recognized across VibeValley crates and scripts.
pub const CANONICAL_ENV_VARS: &[&str] = &[
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "GITHUB_TOKEN",
    "GIT_CONFIG_GLOBAL",
    "MAC_TESTS_CONCURRENCY",
    "OAR_SUBAGENT_DEPTH",
    "VIBEVALLEY_AGENTS_TRACE",
    "VIBEVALLEY_APPS_DIR",
    "VIBEVALLEY_ASSETS",
    "VIBEVALLEY_ASSETS_REPO",
    "VIBEVALLEY_CHANNEL",
    "VIBEVALLEY_CONTROL_PLANE_LABEL",
    "VIBEVALLEY_CONTROL_PLANE_TOKEN",
    "VIBEVALLEY_CONTROL_PLANE_URL",
    "VIBEVALLEY_DEBUG",
    "VIBEVALLEY_DEBUG_PORT",
    "VIBEVALLEY_DIORAMA_DIST",
    "VIBEVALLEY_EMBED_UI",
    "VIBEVALLEY_FAKE_SERVER",
    "VIBEVALLEY_HOME",
    "VIBEVALLEY_IO_WORKERS",
    "VIBEVALLEY_ISLAND",
    "VIBEVALLEY_LOG",
    "VIBEVALLEY_NO_ANIMATION",
    "VIBEVALLEY_NO_ISLAND",
    "VIBEVALLEY_NO_OPENING",
    "VIBEVALLEY_NOTARY_PROFILE",
    "VIBEVALLEY_OAR_DEPTH",
    "VIBEVALLEY_PORT",
    "VIBEVALLEY_REMOTE_ALLOW_ALL",
    "VIBEVALLEY_REMOTE_BIND",
    "VIBEVALLEY_REMOTE_TOKEN",
    "VIBEVALLEY_SANDBOX",
    "VIBEVALLEY_SERVER",
    "VIBEVALLEY_SERVER_BIN",
    "VIBEVALLEY_SERVER_NAME",
    "VIBEVALLEY_SHIM_BIN",
    "VIBEVALLEY_SIGN_IDENTITY",
    "VIBEVALLEY_SKIP_LOGIN_PATH",
    "VIBEVALLEY_STORE",
    "VIBEVALLEY_TOKEN",
    "VIBEVALLEY_UI_BUNDLE",
    "VIBEVALLEY_UI_DEV",
    "VIBEVALLEY_UPDATE_FEED",
    "VIBEVALLEY_WORK_ROOT",
];

/// Release channel of the running binary: separates default ports and on-disk homes across concurrent channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReleaseChannel {
    Release,
    Beta,
    Alpha,
    Dev,
}

impl ReleaseChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Release => "release",
            Self::Beta => "beta",
            Self::Alpha => "alpha",
            Self::Dev => "dev",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "release" | "final" | "stable" => Some(Self::Release),
            "beta" => Some(Self::Beta),
            "alpha" => Some(Self::Alpha),
            "dev" => Some(Self::Dev),
            _ => None,
        }
    }

    pub const fn default_port(self) -> u16 {
        match self {
            Self::Release => 8787,
            Self::Beta => 8788,
            Self::Alpha => 8789,
            Self::Dev => 8790,
        }
    }

    pub const fn home_dir_name(self) -> &'static str {
        match self {
            Self::Release => ".vibevalley",
            Self::Beta => ".vibevalley-beta",
            Self::Alpha => ".vibevalley-alpha",
            Self::Dev => ".vibevalley-dev",
        }
    }

    pub const fn app_support_dir_name(self) -> &'static str {
        match self {
            Self::Release => "VibeValley",
            Self::Beta => "VibeValley-beta",
            Self::Alpha => "VibeValley-alpha",
            Self::Dev => "VibeValley-dev",
        }
    }
}

fn bundle_root(exe: &Path) -> Option<PathBuf> {
    let text = exe.to_str()?;
    let at = text.rfind(".app/Contents/MacOS/")?;
    Some(PathBuf::from(&text[..at + ".app".len()]))
}

fn plist_version(xml: &str) -> Option<&str> {
    let key = if xml.contains("<key>VibeValleyVersion</key>") {
        "<key>VibeValleyVersion</key>"
    } else {
        "<key>CFBundleShortVersionString</key>"
    };
    let rest = &xml[xml.find(key)? + key.len()..];
    let rest = rest.trim_start().strip_prefix("<string>")?;
    Some(rest[..rest.find('<')?].trim())
}

/// Resolves the release channel from an explicit env override, executable path, and optional `Info.plist` XML.
pub fn channel_from(env_channel: Option<&str>, exe_path: Option<&Path>, plist_xml: Option<&str>) -> ReleaseChannel {
    if let Some(channel) = env_channel.and_then(ReleaseChannel::parse) {
        return channel;
    }
    let Some(exe) = exe_path else {
        return ReleaseChannel::Dev;
    };
    if bundle_root(exe).is_none() {
        return ReleaseChannel::Dev;
    }
    let Some(version) = plist_xml.and_then(plist_version).filter(|v| !v.is_empty()) else {
        return ReleaseChannel::Dev;
    };
    if version == "0.0.0" {
        ReleaseChannel::Dev
    } else if version.contains("-alpha.") {
        ReleaseChannel::Alpha
    } else if version.contains("-beta.") {
        ReleaseChannel::Beta
    } else {
        ReleaseChannel::Release
    }
}

/// The active release channel for the current process (`VIBEVALLEY_CHANNEL`, else packaged `.app` `Info.plist`, else `Dev`).
pub fn current_channel() -> ReleaseChannel {
    if let Some(channel) = std::env::var("VIBEVALLEY_CHANNEL").ok().as_deref().and_then(ReleaseChannel::parse) {
        return channel;
    }
    let exe = std::env::current_exe().ok();
    let plist = exe
        .as_deref()
        .and_then(bundle_root)
        .and_then(|bundle| std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok());
    channel_from(None, exe.as_deref(), plist.as_deref())
}

/// Default HTTP port for the current release channel (`8787`..`8790`).
pub fn default_port() -> u16 {
    current_channel().default_port()
}

/// Default farm home directory for `channel` under `$HOME`.
pub fn home_for(channel: ReleaseChannel) -> PathBuf {
    let user = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    user.join(channel.home_dir_name())
}

fn home_from(env_home: Option<&OsStr>, user_home: Option<&Path>, channel: ReleaseChannel) -> PathBuf {
    if let Some(h) = env_home.filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    user_home.unwrap_or_else(|| Path::new("/")).join(channel.home_dir_name())
}

#[derive(Serialize, Deserialize)]
struct ServerAnnouncement {
    url: String,
    pid: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProviderConnection {
    #[serde(default)]
    adapter: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProviders {
    #[serde(default)]
    connections: Vec<SavedProviderConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSettings {
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    deepseek_api_key: Option<String>,
    #[serde(default)]
    providers: Option<SavedProviders>,
}

/// `VIBEVALLEY_HOME`, else `$HOME/<current_channel().home_dir_name()>`.
pub fn home() -> PathBuf {
    let env_home = std::env::var_os("VIBEVALLEY_HOME");
    let user_home = std::env::var_os("HOME").map(PathBuf::from);
    home_from(env_home.as_deref(), user_home.as_deref(), current_channel())
}

/// Says where this server listens until the returned guard is dropped.
pub fn announce(home: &Path, url: &str) -> std::io::Result<Announced> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = home.join(SERVER_FILE);
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
    let body = serde_json::to_string(&ServerAnnouncement {
        url: url.to_string(),
        pid: u64::from(std::process::id()),
    })
    .map_err(std::io::Error::other)?;
    writeln!(f, "{body}")?;
    Ok(Announced { path })
}

pub struct Announced {
    path: PathBuf,
}

impl Drop for Announced {
    fn drop(&mut self) {
        let ours = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<ServerAnnouncement>(&t).ok())
            .is_some_and(|v| v.pid == u64::from(std::process::id()));
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Returns whether `pid` refers to a live process owned by this user on Unix (`kill -0`).
pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Where the server using `home` listens, while that server is running.
pub fn announced(home: &Path) -> Option<String> {
    let said: ServerAnnouncement = serde_json::from_str(&std::fs::read_to_string(home.join(SERVER_FILE)).ok()?).ok()?;
    let pid = u32::try_from(said.pid).ok()?;
    if !is_pid_alive(pid) {
        return None;
    }
    Some(said.url)
}

/// Path to `$VIBEVALLEY_HOME/debug.json` for `home`.
pub fn debug_json_path(home: &Path) -> PathBuf {
    home.join(DEBUG_FILE)
}

/// Guard returned by [`write_debug_endpoint`]; removes `debug.json` on drop only if its `pid` still matches ours.
pub struct DebugEndpointGuard {
    path: PathBuf,
    pid: u32,
}

impl DebugEndpointGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DebugEndpointGuard {
    fn drop(&mut self) {
        let ours = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<VdpEndpointInfo>(&t).ok())
            .is_some_and(|v| v.pid == self.pid);
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Atomically writes `info` to `<home>/debug.json` with `0600` permissions on Unix and removes it on drop.
pub fn write_debug_endpoint(home: &Path, info: &VdpEndpointInfo) -> std::io::Result<DebugEndpointGuard> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::create_dir_all(home)?;
    let path = debug_json_path(home);
    let tmp = home.join(format!(".{DEBUG_FILE}.{}.tmp", info.pid));
    let body = serde_json::to_string_pretty(info).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        writeln!(f, "{body}")?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(DebugEndpointGuard { path, pid: info.pid })
}

/// Reads `<home>/debug.json` and returns it only while its recorded PID is still alive.
pub fn read_debug_endpoint(home: &Path) -> Option<VdpEndpointInfo> {
    let text = std::fs::read_to_string(debug_json_path(home)).ok()?;
    let info: VdpEndpointInfo = serde_json::from_str(&text).ok()?;
    if !is_pid_alive(info.pid) {
        return None;
    }
    Some(info)
}

/// Scans an explicit list of candidate homes for live `debug.json` endpoints, deduplicated by canonical path.
pub fn discover_debug_endpoints_in(homes: &[PathBuf]) -> Vec<VdpEndpointInfo> {
    let mut seen = BTreeSet::new();
    let mut found = Vec::new();
    for home in homes {
        let key = std::fs::canonicalize(home).unwrap_or_else(|_| home.clone());
        if !seen.insert(key) {
            continue;
        }
        if let Some(info) = read_debug_endpoint(home) {
            found.push(info);
        }
    }
    found
}

/// Discovers live local VDP endpoints across `extra_homes`, `VIBEVALLEY_HOME`, and the 4 default channel homes.
pub fn discover_local_debug_endpoints(extra_homes: &[PathBuf]) -> Vec<VdpEndpointInfo> {
    let mut candidates = Vec::with_capacity(extra_homes.len() + 5);
    candidates.extend(extra_homes.iter().cloned());
    if let Some(env_home) = std::env::var_os("VIBEVALLEY_HOME").filter(|h| !h.is_empty()) {
        candidates.push(PathBuf::from(env_home));
    }
    for channel in [ReleaseChannel::Dev, ReleaseChannel::Alpha, ReleaseChannel::Beta, ReleaseChannel::Release] {
        candidates.push(home_for(channel));
    }
    discover_debug_endpoints_in(&candidates)
}

/// The language `settings.json` keeps: `en`, else `zh`.
pub fn saved_locale(home: &Path) -> &'static str {
    let said = std::fs::read_to_string(home.join(SETTINGS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<SavedSettings>(&t).ok());
    if said.is_some_and(|v| v.locale.as_deref() == Some("en")) {
        "en"
    } else {
        "zh"
    }
}

/// The DeepSeek API key `settings.json` keeps, when non-empty.
pub fn saved_deepseek_key(home: &Path) -> Option<String> {
    let said: SavedSettings = serde_json::from_str(&std::fs::read_to_string(home.join(SETTINGS_FILE)).ok()?).ok()?;
    let from_providers = said.providers.as_ref().and_then(|p| {
        p.connections
            .iter()
            .find(|c| c.adapter.as_deref() == Some("deepseek") && c.enabled.unwrap_or(true))
            .and_then(|c| c.key.as_deref())
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(String::from)
    });
    from_providers.or_else(|| said.deepseek_api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()).map(String::from))
}

/// Resolves this machine's display name (`VIBEVALLEY_SERVER_NAME`, macOS `scutil --get ComputerName`,
/// `hostname -s`, `hostname`, `HOSTNAME`, `COMPUTERNAME`, else `"VibeValley"`), cached per process.
pub fn computer_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        let non_empty_env = |key: &str| std::env::var(key).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(name) = non_empty_env("VIBEVALLEY_SERVER_NAME") {
            return name;
        }
        let read_cmd = |bin: &str, args: &[&str]| -> Option<String> {
            let out = std::process::Command::new(bin)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let text = String::from_utf8(out.stdout).ok()?;
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        };
        #[cfg(target_os = "macos")]
        if let Some(name) = read_cmd("scutil", &["--get", "ComputerName"]) {
            return name;
        }
        read_cmd("hostname", &["-s"])
            .or_else(|| read_cmd("hostname", &[]))
            .or_else(|| non_empty_env("HOSTNAME"))
            .or_else(|| non_empty_env("COMPUTERNAME"))
            .unwrap_or_else(|| "VibeValley".into())
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_announcement_is_taken_back_only_while_it_is_ours() {
        let dir = tempfile::tempdir().unwrap();
        let a = announce(dir.path(), "http://127.0.0.1:1").unwrap();
        let said: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("server.json")).unwrap()).unwrap();
        assert_eq!(said["url"], "http://127.0.0.1:1");
        assert_eq!(announced(dir.path()).as_deref(), Some("http://127.0.0.1:1"));
        drop(a);
        assert_eq!(announced(dir.path()), None);
        assert!(!dir.path().join("server.json").exists());
        let b = announce(dir.path(), "http://127.0.0.1:2").unwrap();
        std::fs::write(dir.path().join("server.json"), r#"{"url":"x","pid":1}"#).unwrap();
        drop(b);
        assert!(dir.path().join("server.json").exists());
        std::fs::write(dir.path().join("server.json"), format!(r#"{{"url":"x","pid":{}}}"#, 1u64 << 22)).unwrap();
        assert_eq!(announced(dir.path()), None);
    }

    #[test]
    fn the_saved_language_is_english_only_when_it_says_so() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(saved_locale(dir.path()), "zh");
        std::fs::write(dir.path().join("settings.json"), r#"{"locale":"en"}"#).unwrap();
        assert_eq!(saved_locale(dir.path()), "en");
        std::fs::write(dir.path().join("settings.json"), "{").unwrap();
        assert_eq!(saved_locale(dir.path()), "zh");
    }

    #[test]
    fn the_saved_deepseek_key_trims_and_skips_blanks() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(saved_deepseek_key(dir.path()), None);
        std::fs::write(dir.path().join("settings.json"), r#"{"deepseekApiKey":"   "}"#).unwrap();
        assert_eq!(saved_deepseek_key(dir.path()), None);
        std::fs::write(dir.path().join("settings.json"), r#"{"deepseekApiKey":" sk-test-1234 "}"#).unwrap();
        assert_eq!(saved_deepseek_key(dir.path()).as_deref(), Some("sk-test-1234"));
    }

    #[test]
    fn channel_table_maps_ports_and_directories() {
        let cases = [
            (ReleaseChannel::Release, "release", 8787, ".vibevalley", "VibeValley"),
            (ReleaseChannel::Beta, "beta", 8788, ".vibevalley-beta", "VibeValley-beta"),
            (ReleaseChannel::Alpha, "alpha", 8789, ".vibevalley-alpha", "VibeValley-alpha"),
            (ReleaseChannel::Dev, "dev", 8790, ".vibevalley-dev", "VibeValley-dev"),
        ];
        for (channel, name, port, home_dir, support_dir) in cases {
            assert_eq!(channel.as_str(), name);
            assert_eq!(ReleaseChannel::parse(name), Some(channel));
            assert_eq!(channel.default_port(), port);
            assert_eq!(channel.home_dir_name(), home_dir);
            assert_eq!(channel.app_support_dir_name(), support_dir);
        }
        assert_eq!(ReleaseChannel::parse("FINAL"), Some(ReleaseChannel::Release));
        assert_eq!(ReleaseChannel::parse(" Stable "), Some(ReleaseChannel::Release));
        assert_eq!(ReleaseChannel::parse("ALPHA"), Some(ReleaseChannel::Alpha));
        assert_eq!(ReleaseChannel::parse("BeTa"), Some(ReleaseChannel::Beta));
        assert_eq!(ReleaseChannel::parse("DEV"), Some(ReleaseChannel::Dev));
        assert_eq!(ReleaseChannel::parse(""), None);
        assert_eq!(ReleaseChannel::parse("nightly"), None);
    }

    #[test]
    fn channel_detection_follows_env_plist_and_unpackaged_precedence() {
        let app_exe = Path::new("/Applications/VibeValley.app/Contents/MacOS/vibevalley-mac");
        let cli_exe = Path::new("/Applications/VibeValley.app/Contents/MacOS/vibevalley");
        let cargo_debug = Path::new("/Users/dev/vibevalley/target/debug/vibevalley-server");
        let cargo_release = Path::new("/Users/dev/vibevalley/target/release/vibevalley-server");

        let plist_release = r#"<plist><dict><key>VibeValleyVersion</key><string>1.2.3</string></dict></plist>"#;
        let plist_beta = r#"<plist><dict><key>VibeValleyVersion</key><string>1.2.3-beta.4</string></dict></plist>"#;
        let plist_alpha = r#"<plist><dict><key>VibeValleyVersion</key><string>1.2.3-alpha.1</string></dict></plist>"#;
        let plist_dev = r#"<plist><dict><key>VibeValleyVersion</key><string>0.0.0</string></dict></plist>"#;
        let plist_empty = r#"<plist><dict><key>VibeValleyVersion</key><string></string></dict></plist>"#;
        let plist_short_fallback = r#"<plist><dict><key>CFBundleShortVersionString</key>
            <string>0.4.0-alpha.2</string></dict></plist>"#;
        let plist_unpackaged_010 = r#"<plist><dict><key>VibeValleyVersion</key><string>0.1.0</string></dict></plist>"#;

        // Packaged .app reads Info.plist version
        assert_eq!(channel_from(None, Some(app_exe), Some(plist_release)), ReleaseChannel::Release);
        assert_eq!(channel_from(None, Some(cli_exe), Some(plist_beta)), ReleaseChannel::Beta);
        assert_eq!(channel_from(None, Some(app_exe), Some(plist_alpha)), ReleaseChannel::Alpha);
        assert_eq!(channel_from(None, Some(app_exe), Some(plist_dev)), ReleaseChannel::Dev);
        assert_eq!(channel_from(None, Some(app_exe), Some(plist_empty)), ReleaseChannel::Dev);
        assert_eq!(channel_from(None, Some(app_exe), Some(plist_short_fallback)), ReleaseChannel::Alpha);
        assert_eq!(channel_from(None, Some(app_exe), None), ReleaseChannel::Dev);

        // Unpackaged cargo builds always resolve to Dev even when version looks like 0.1.0
        assert_eq!(channel_from(None, Some(cargo_debug), Some(plist_unpackaged_010)), ReleaseChannel::Dev);
        assert_eq!(channel_from(None, Some(cargo_release), None), ReleaseChannel::Dev);
        assert_eq!(channel_from(None, None, Some(plist_release)), ReleaseChannel::Dev);

        // VIBEVALLEY_CHANNEL overrides packaged plist and unpackaged binaries; invalid values fall through
        assert_eq!(channel_from(Some("alpha"), Some(cargo_debug), None), ReleaseChannel::Alpha);
        assert_eq!(channel_from(Some("final"), Some(cargo_debug), None), ReleaseChannel::Release);
        assert_eq!(channel_from(Some("beta"), Some(app_exe), Some(plist_release)), ReleaseChannel::Beta);
        assert_eq!(channel_from(Some("dev"), Some(app_exe), Some(plist_release)), ReleaseChannel::Dev);
        assert_eq!(channel_from(Some("unknown"), Some(app_exe), Some(plist_alpha)), ReleaseChannel::Alpha);
    }

    #[test]
    fn home_respects_override_and_channel_directory() {
        let user = Path::new("/Users/tester");
        assert_eq!(home_from(None, Some(user), ReleaseChannel::Release), PathBuf::from("/Users/tester/.vibevalley"));
        assert_eq!(
            home_from(None, Some(user), ReleaseChannel::Beta),
            PathBuf::from("/Users/tester/.vibevalley-beta")
        );
        assert_eq!(
            home_from(None, Some(user), ReleaseChannel::Alpha),
            PathBuf::from("/Users/tester/.vibevalley-alpha")
        );
        assert_eq!(home_from(None, Some(user), ReleaseChannel::Dev), PathBuf::from("/Users/tester/.vibevalley-dev"));
        assert_eq!(
            home_from(Some(OsStr::new("/tmp/custom-home")), Some(user), ReleaseChannel::Alpha),
            PathBuf::from("/tmp/custom-home")
        );
        assert_eq!(
            home_from(Some(OsStr::new("")), Some(user), ReleaseChannel::Beta),
            PathBuf::from("/Users/tester/.vibevalley-beta")
        );
        assert!(home_for(ReleaseChannel::Alpha).ends_with(".vibevalley-alpha"));
    }

    #[test]
    fn canonical_env_vars_are_unique_and_well_formed() {
        let mut seen = std::collections::BTreeSet::new();
        for &name in CANONICAL_ENV_VARS {
            assert!(!name.is_empty());
            assert!(name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'));
            assert!(name.contains('_'));
            assert!(seen.insert(name), "duplicate canonical env var: {name}");
        }
    }

    #[test]
    fn debug_endpoint_write_read_permissions_and_cleanup() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let info = VdpEndpointInfo {
            protocol_version: crate::vdp::VDP_PROTOCOL_VERSION.into(),
            pid,
            channel: "dev".into(),
            app_version: "0.1.0-alpha.4".into(),
            home: dir.path().display().to_string(),
            port: 9222,
            http_url: "http://127.0.0.1:9222".into(),
            ws_url: "ws://127.0.0.1:9222/devtools".into(),
            token: "tok-abc".into(),
            started_at: 1_700_000_000_000,
        };

        let guard = write_debug_endpoint(dir.path(), &info).unwrap();
        assert_eq!(guard.path(), debug_json_path(dir.path()));
        let mode = std::fs::metadata(guard.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(read_debug_endpoint(dir.path()).as_ref(), Some(&info));

        drop(guard);
        assert!(!debug_json_path(dir.path()).exists());
        assert_eq!(read_debug_endpoint(dir.path()), None);

        // Guard must not remove a debug.json overwritten by another process.
        let guard2 = write_debug_endpoint(dir.path(), &info).unwrap();
        let other = VdpEndpointInfo { pid: 1, ..info.clone() };
        std::fs::write(debug_json_path(dir.path()), serde_json::to_string(&other).unwrap()).unwrap();
        drop(guard2);
        assert!(debug_json_path(dir.path()).exists());

        // Stale PIDs are filtered out by read_debug_endpoint.
        let dead = VdpEndpointInfo { pid: 1 << 22, ..info };
        std::fs::write(debug_json_path(dir.path()), serde_json::to_string(&dead).unwrap()).unwrap();
        assert_eq!(read_debug_endpoint(dir.path()), None);
        assert!(!is_pid_alive(0));
    }

    #[test]
    fn discover_debug_endpoints_deduplicates_canonical_paths_and_skips_stale() {
        let live_dir = tempfile::tempdir().unwrap();
        let stale_dir = tempfile::tempdir().unwrap();
        let empty_dir = tempfile::tempdir().unwrap();
        let symlink_parent = tempfile::tempdir().unwrap();
        let symlink_dir = symlink_parent.path().join("alias");
        std::os::unix::fs::symlink(live_dir.path(), &symlink_dir).unwrap();

        let live_info = VdpEndpointInfo {
            protocol_version: crate::vdp::VDP_PROTOCOL_VERSION.into(),
            pid: std::process::id(),
            channel: "dev".into(),
            app_version: "0.1.0-alpha.4".into(),
            home: live_dir.path().display().to_string(),
            port: 9333,
            http_url: "http://127.0.0.1:9333".into(),
            ws_url: "ws://127.0.0.1:9333/devtools".into(),
            token: "tok-live".into(),
            started_at: 100,
        };
        let _guard = write_debug_endpoint(live_dir.path(), &live_info).unwrap();

        let stale_info = VdpEndpointInfo {
            pid: 1 << 22,
            home: stale_dir.path().display().to_string(),
            port: 9334,
            ..live_info.clone()
        };
        std::fs::write(debug_json_path(stale_dir.path()), serde_json::to_string(&stale_info).unwrap()).unwrap();

        let found = discover_debug_endpoints_in(&[
            live_dir.path().to_path_buf(),
            symlink_dir,
            stale_dir.path().to_path_buf(),
            empty_dir.path().to_path_buf(),
        ]);
        assert_eq!(found, vec![live_info]);
    }
}
