//! The farm's home on disk as `packages/home` lays it out: where it is, and
//! `server.json`, which says where the server using it listens (the CLI
//! finds the server through it).

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_announcement_is_taken_back_only_while_it_is_ours() {
        let dir = tempfile::tempdir().unwrap();
        let a = announce(dir.path(), "http://127.0.0.1:1").unwrap();
        let said: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("server.json")).unwrap()).unwrap();
        assert_eq!(said["url"], "http://127.0.0.1:1");
        drop(a);
        assert!(!dir.path().join("server.json").exists());
        let b = announce(dir.path(), "http://127.0.0.1:2").unwrap();
        std::fs::write(dir.path().join("server.json"), r#"{"url":"x","pid":1}"#).unwrap();
        drop(b);
        assert!(dir.path().join("server.json").exists());
    }
}
