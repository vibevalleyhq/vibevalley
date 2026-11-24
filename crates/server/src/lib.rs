//! VibeValley's in-process server: typed endpoint door (`ServerDoor`),
//! single-source `ServerDb` + `Outbox` + `LiveOverlay` + `SliceProjector`
//! projections (`board`, `sessions`, `collab`, `inbox`, `ops`, `farm`), live
//! events and subscriptions implementing [`crate::transport::api::Server`].

pub mod app;
pub mod collab;
pub mod content;
pub mod db;
pub mod infra;
pub mod skin;
pub mod team;
pub mod transport;
pub mod work;

pub use vibevalley_protocol::home;

pub use crate::app::bootstrap::{ServerConfig, StartError, Started, start, start_async};
pub use crate::app::door::ServerDoor;
pub use crate::app::slice::{SliceFeed, SliceFrame, SliceSubscription};
pub use crate::app::{App, Sink, install_tls, now, spawn_blocking_traced};
pub use crate::transport::api::*;
