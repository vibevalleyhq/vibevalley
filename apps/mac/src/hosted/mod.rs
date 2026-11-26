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

pub use bridge::{Action, Outbox, Panel};
pub use debug::{DebugCacheEntry, MAX_DEBUG_FRAMES, SLOW_FRAME_US, ShellDebugHandle};
pub use hub::{BridgeHub, ClientsProvider, Replier, ServerStartup, StartupFailure, StartupFailureKind, next_client_identity, server_home};
pub use view::{HostedEvent, HostedView, ensure_ui_sets};
