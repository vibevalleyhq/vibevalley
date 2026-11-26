//! Hosted views: nsh `AppView`s running the TSX bundle from `ui/`, one
//! engine per view. Rust pushes frames, the view posts actions back.

pub mod bridge;
pub mod connection;
pub mod frames;
pub mod remote;

mod bundle;
mod debug;
mod hub;
mod late;
mod view;

#[cfg(test)]
mod tests;

#[cfg(test)]
pub use bridge::Outbox;
pub use bridge::{Action, Panel};
#[cfg(test)]
pub use debug::MAX_DEBUG_FRAMES;
pub use debug::{DebugCacheEntry, SLOW_FRAME_US, ShellDebugHandle};
#[cfg(test)]
pub use hub::ClientsProvider;
pub use hub::{BridgeHub, Replier, ServerStartup, StartupFailure, StartupFailureKind, next_client_identity, server_home};
pub use view::{HostedEvent, HostedView, ensure_ui_sets};
