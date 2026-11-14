//! The farm's home on disk, for the server, the command line and the app:
//! where it is, `server.json` (where the server using it listens; the
//! command line finds the server through it) and the saved language.

use std::path::{Path, PathBuf};

/// `VIBEVALLEY_HOME`, else `~/.vibevalley`.
pub fn home() -> PathBuf {
    if let Some(h) = std::env::var_os("VIBEVALLEY_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    let user = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    user.join(".vibevalley")
}

/// Says where this server listens until the returned guard is dropped.
pub fn announce(home: &Path, url: &str) -> std::io::Result<Announced> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = home.join("server.json");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
    writeln!(f, "{}", serde_json::json!({ "url": url, "pid": std::process::id() }))?;
    Ok(Announced { path })
}

pub struct Announced {
    path: PathBuf,
}

impl Drop for Announced {
    fn drop(&mut self) {
        let ours = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .is_some_and(|v| v["pid"].as_u64() == Some(u64::from(std::process::id())));
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Where the server using `home` listens, while that server is running.
pub fn announced(home: &Path) -> Option<String> {
    let said: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("server.json")).ok()?).ok()?;
    let pid = said["pid"].as_u64()?;
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !alive {
        return None;
    }
    said["url"].as_str().map(String::from)
}

/// The language `settings.json` keeps: `en`, else `zh`.
pub fn saved_locale(home: &Path) -> &'static str {
    let said = std::fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if said.is_some_and(|v| v["locale"] == "en") { "en" } else { "zh" }
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
}
