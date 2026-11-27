//! How the app starts and shuts down the in-process server: the same
//! conventions as the standalone `vibevalley-server` binary
//! (`crates/server/src/main.rs`), with runtime ownership held in GPUI's
//! [`RunningServer`] global instead of a process-wide static mutex.

use std::path::{Path, PathBuf};

pub use crate::env::work_root;

/// The server's config for the farm at `home`, sharing environment overrides
/// and bundle version with the standalone server.
pub fn config(home: &Path, work_root: PathBuf) -> vibevalley_server::Config {
    let mut config = vibevalley_server::Config::from_env(home, crate::env::bundle_version());
    config.work_root = work_root;
    config
}

pub struct Running {
    app: vibevalley_server::App,
    listener: Option<vibevalley_server::gateway::http::Listener>,
    announced: Option<vibevalley_server::home::Announced>,
    wake_observer: Option<crate::host::SystemObserver>,
}

impl Running {
    pub fn new(
        app: vibevalley_server::App,
        listener: Option<vibevalley_server::gateway::http::Listener>,
        announced: Option<vibevalley_server::home::Announced>,
        wake_observer: Option<crate::host::SystemObserver>,
    ) -> Self {
        Self {
            app,
            listener,
            announced,
            wake_observer,
        }
    }

    /// Removes `server.json`, stops the loopback HTTP listener, and closes background workers.
    pub fn shutdown(self) {
        drop(self.wake_observer);
        drop(self.announced);
        drop(self.listener);
        self.app.close_blocking();
    }
}

/// GPUI global owning the started in-process server so shutdown runs cleanly
/// on app quit without a process-global static mutex.
#[derive(Default)]
pub struct RunningServer {
    running: Option<Running>,
    shut_down: bool,
}

impl gpui::Global for RunningServer {}

impl RunningServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores `running` unless shutdown already started, in which case it
    /// returns `running` so the caller can close it immediately off the UI thread.
    pub fn install(&mut self, running: Running) -> Option<Running> {
        if self.shut_down {
            return Some(running);
        }
        self.running.replace(running)
    }

    /// Marks the server as shutting down and takes ownership of the active instance once.
    pub fn take(&mut self) -> Option<Running> {
        self.shut_down = true;
        self.running.take()
    }

    pub fn take_for_shutdown(cx: &mut gpui::App) -> Option<Running> {
        if !cx.has_global::<Self>() {
            return None;
        }
        cx.global_mut::<Self>().take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_server::Config;

    #[test]
    fn the_work_root_is_the_named_one_else_the_users_vibevalley_dev() {
        assert_eq!(
            Config::work_root_from(Some("/tmp/space".into()), Some("/Users/u".into())),
            PathBuf::from("/tmp/space")
        );
        assert_eq!(
            Config::work_root_from(Some("".into()), Some("/Users/u".into())),
            PathBuf::from("/Users/u/vibevalley-dev")
        );
        assert_eq!(Config::work_root_from(None, Some("/Users/u".into())), PathBuf::from("/Users/u/vibevalley-dev"));
        assert_eq!(Config::work_root_from(None, None), PathBuf::from("/vibevalley-dev"));
    }

    #[test]
    fn the_config_keeps_the_home_and_work_root() {
        let dir = tempfile::tempdir().unwrap();
        let (home, work) = (dir.path().join("home"), dir.path().join("work"));
        let config = config(&home, work.clone());
        assert_eq!(config.home, home);
        assert_eq!(config.work_root, work);
    }

    #[test]
    fn running_server_slot_marks_shutdown_idempotently() {
        let mut slot = RunningServer::new();
        assert!(slot.take().is_none());
        assert!(slot.shut_down);
        assert!(slot.take().is_none());
    }
}
