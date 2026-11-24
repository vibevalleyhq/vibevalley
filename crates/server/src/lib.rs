//! VibeValley's server, in process: the one state (`vibevalley-core`'s `Core`),
//! the endpoint table by op name (`vibevalley-protocol`'s `ENDPOINTS`) with the
//! same payloads and envelopes, per-domain slice feeds (`board`, `sessions`,
//! `collab`, `inbox`, `ops`, `farm`), live events and subscriptions. It
//! implements [`crate::transport::api::Server`] for the bridge and HTTP
//! adapters.
//!
//! Domain modules register their handlers with [`Hub::on`] (typed by
//! `vibevalley_protocol::ops`) and their subscriptions with
//! [`Hub::on_subscription`]; they change the state only through
//! [`Hub::apply`].

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

pub use crate::app::bootstrap::{ServerConfig, StartError, Started, start};
pub use crate::app::hub::{AsyncCtx, Ctx, Hub, Sink, install_tls, now, slice_feed, spawn_blocking_traced};
pub use crate::transport::api::*;
