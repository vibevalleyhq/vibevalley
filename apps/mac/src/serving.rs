//! How the app starts the in-process server: the same conventions as the
//! standalone `vibevalley-server` binary (crates/vibevalley-server/src/main.rs).

use std::path::{Path, PathBuf};

pub fn work_root() -> PathBuf {
    vibevalley_server::ServerConfig::default_work_root()
}

/// The server's config for the farm at `home`, sharing environment overrides
/// and bundle version with the standalone server.
pub fn config(home: &Path, work_root: PathBuf) -> vibevalley_server::ServerConfig {
    let mut config = vibevalley_server::ServerConfig::from_env(home, crate::update::bundle_version());
    config.work_root = work_root;
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_server::ServerConfig;

    #[test]
    fn the_work_root_is_the_named_one_else_the_users_vibevalley_dev() {
        assert_eq!(
            ServerConfig::work_root_from(Some("/tmp/space".into()), Some("/Users/u".into())),
            PathBuf::from("/tmp/space")
        );
        assert_eq!(
            ServerConfig::work_root_from(Some("".into()), Some("/Users/u".into())),
            PathBuf::from("/Users/u/vibevalley-dev")
        );
        assert_eq!(
            ServerConfig::work_root_from(None, Some("/Users/u".into())),
            PathBuf::from("/Users/u/vibevalley-dev")
        );
        assert_eq!(ServerConfig::work_root_from(None, None), PathBuf::from("/vibevalley-dev"));
    }

    #[test]
    fn the_config_keeps_the_home_and_work_root() {
        let dir = tempfile::tempdir().unwrap();
        let (home, work) = (dir.path().join("home"), dir.path().join("work"));
        let config = config(&home, work.clone());
        assert_eq!(config.home, home);
        assert_eq!(config.work_root, work);
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
    listener: Option<vibevalley_http::Listener>,
    announced: Option<vibevalley_server::home::Announced>,
}

static RUNNING: std::sync::Mutex<Option<Running>> = std::sync::Mutex::new(None);

fn lock_running() -> std::sync::MutexGuard<'static, Option<Running>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn set_running(started: vibevalley_server::Started, listener: Option<vibevalley_http::Listener>, announced: Option<vibevalley_server::home::Announced>) {
    *lock_running() = Some(Running { started, listener, announced });
}

/// Removes `server.json`, stops the loopback HTTP listener, and closes background workers.
pub fn shutdown() {
    let Some(running) = lock_running().take() else { return };
    drop(running.announced);
    drop(running.listener);
    running.started.close();
}

pub fn voice() -> Result<std::sync::Arc<vibevalley_server::modules::collab::voice::Voice>, String> {
    lock_running()
        .as_ref()
        .map(|r| r.started.voice.clone())
        .ok_or_else(|| "the voice service is not ready".into())
}

pub fn speech() -> Result<vibevalley_server_api::media::SharedSpeechStreams, String> {
    lock_running()
        .as_ref()
        .map(|r| -> vibevalley_server_api::media::SharedSpeechStreams { r.started.media.clone() })
        .ok_or_else(|| "the speech service is not ready".into())
}
