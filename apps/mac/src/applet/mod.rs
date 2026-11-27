//! Host bridge and `.app` bundle installer for local note applets.
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
#[cfg(test)]
pub(crate) use protocol::apps_dir_from;
pub use protocol::{AppletInfo, AppletInstallRequest, AppletOpenResult, AppletRemoveResult, HostToShim, ShimToHost, apps_dir, socket_path};
#[cfg(test)]
pub use protocol::{Modifiers, MouseButtonKind, ScrollPhaseKind};
