//! The farm's home on disk, for the server, the command line and the app:
//! where it is, `server.json` (where the server using it listens; the
//! command line finds the server through it) and the saved language.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SERVER_FILE: &str = "server.json";
pub const SETTINGS_FILE: &str = "settings.json";

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
struct SavedSettings {
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    deepseek_api_key: Option<String>,
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

/// Where the server using `home` listens, while that server is running.
pub fn announced(home: &Path) -> Option<String> {
    let said: ServerAnnouncement = serde_json::from_str(&std::fs::read_to_string(home.join(SERVER_FILE)).ok()?).ok()?;
    let alive = std::process::Command::new("kill")
        .args(["-0", &said.pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !alive {
        return None;
    }
    Some(said.url)
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
    said.deepseek_api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()).map(String::from)
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
}
