//! How the app starts the in-process server: the same conventions as the
//! standalone `vibevalley-server` binary (crates/vibevalley-server/src/main.rs).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The process-wide TLS provider (ring). The server's `reqwest` is built
/// without one and panics on its first HTTPS client unless this ran.
pub fn install_tls() {
    // Err means one is already installed, which is what is wanted.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The space: `VIBEVALLEY_WORK_ROOT`, else `~/vibevalley-dev`.
pub fn work_root_from(said: Option<OsString>, user_home: Option<OsString>) -> PathBuf {
    if let Some(root) = said.filter(|v| !v.is_empty()) {
        return PathBuf::from(root);
    }
    user_home.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/")).join("vibevalley-dev")
}

pub fn work_root() -> PathBuf {
    work_root_from(std::env::var_os("VIBEVALLEY_WORK_ROOT"), std::env::var_os("HOME"))
}

/// The server's config for the farm at `home`, with the space's folders made.
pub fn config(home: &Path, work_root: PathBuf) -> vibevalley_server::ServerConfig {
    for dir in ["repos", "worktrees", "pkm"] {
        if let Err(e) = std::fs::create_dir_all(work_root.join(dir)) {
            eprintln!("vibevalley server: {}: {e}", work_root.join(dir).display());
        }
    }
    vibevalley_server::ServerConfig {
        work_root,
        ..vibevalley_server::ServerConfig::under(home)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_work_root_is_the_named_one_else_the_users_vibevalley_dev() {
        assert_eq!(work_root_from(Some("/tmp/space".into()), Some("/Users/u".into())), PathBuf::from("/tmp/space"));
        assert_eq!(
            work_root_from(Some("".into()), Some("/Users/u".into())),
            PathBuf::from("/Users/u/vibevalley-dev")
        );
        assert_eq!(work_root_from(None, Some("/Users/u".into())), PathBuf::from("/Users/u/vibevalley-dev"));
        assert_eq!(work_root_from(None, None), PathBuf::from("/vibevalley-dev"));
    }

    #[test]
    fn the_config_keeps_the_home_and_makes_the_spaces_folders() {
        let dir = tempfile::tempdir().unwrap();
        let (home, work) = (dir.path().join("home"), dir.path().join("work"));
        let config = config(&home, work.clone());
        assert_eq!(config.home, home);
        assert_eq!(config.work_root, work);
        for sub in ["repos", "worktrees", "pkm"] {
            assert!(work.join(sub).is_dir(), "{sub}");
        }
    }

    #[test]
    fn an_https_client_is_built_once_the_provider_is_installed() {
        install_tls();
        install_tls();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        // Without a provider this is where the server's reqwest panics.
        assert!(reqwest::Client::builder().build().is_ok());
    }

    /// Needs the network: `cargo test -p vibevalley-mac -- --ignored https_request`.
    #[test]
    #[ignore]
    fn an_https_request_is_answered() {
        install_tls();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let status = runtime.block_on(async {
            reqwest::Client::builder()
                .build()
                .unwrap()
                .get("https://api.mosi.cn/")
                .send()
                .await
                .map(|r| r.status())
        });
        assert!(status.is_ok(), "{status:?}");
    }
}

#[derive(serde::Deserialize)]
pub struct Opening {
    pub phase: OpeningPhase,
    pub progress: f32,
}

#[derive(serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum OpeningPhase {
    Connecting,
    Reading,
    Loading,
    Ready,
    Waiting,
    Failed,
}

impl OpeningPhase {
    pub fn pixel(&self) -> crate::pixel::opening::Phase {
        use crate::pixel::opening::Phase;
        match self {
            Self::Connecting | Self::Waiting => Phase::Connecting,
            Self::Reading => Phase::Reading,
            Self::Loading => Phase::Loading,
            Self::Ready => Phase::Ready,
            Self::Failed => Phase::Failed,
        }
    }
}

pub struct Running {
    started: vibevalley_server::Started,
    _listener: Option<vibevalley_http::Listener>,
    _announced: Option<vibevalley_server::home::Announced>,
}

static RUNNING: std::sync::OnceLock<Running> = std::sync::OnceLock::new();

pub fn set_running(started: vibevalley_server::Started, listener: Option<vibevalley_http::Listener>, announced: Option<vibevalley_server::home::Announced>) {
    let _ = RUNNING.set(Running {
        started,
        _listener: listener,
        _announced: announced,
    });
}

pub fn voice() -> Result<std::sync::Arc<vibevalley_server::modules::voice::Voice>, String> {
    RUNNING
        .get()
        .map(|r| r.started.voice.clone())
        .ok_or_else(|| "the voice service is not ready".into())
}

pub fn speech() -> Result<vibevalley_server_api::media::SharedSpeechStreams, String> {
    RUNNING
        .get()
        .map(|r| -> vibevalley_server_api::media::SharedSpeechStreams { r.started.media.clone() })
        .ok_or_else(|| "the speech service is not ready".into())
}
