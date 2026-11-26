//! Host bridge and `.app` bundle installer for local artifact applets.
//!
//! Frozen NDJSON wire protocol shared byte-for-byte with `apps/shim` over
//! `$VIBEVALLEY_HOME/applet.sock`.

pub mod host;
pub mod installer;
pub mod protocol;
pub mod prototype;
pub mod remote_layer;
#[cfg(test)]
mod tests;

pub use host::AppletHost;
pub(crate) use protocol::apps_dir_from;
pub use protocol::{
    AppletInfo, AppletInstallRequest, AppletOpenResult, AppletRemoveResult, HostToShim, Modifiers, MouseButtonKind, ScrollPhaseKind, ShimToHost, apps_dir,
    socket_path,
};
