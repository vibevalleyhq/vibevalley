//! VibeValley's in-process server: shallow composition root (`App`),
//! thin compile-time exhaustive [`Router`] implementing [`Server`], unified
//! `Context` (`Service`, `TaskGroup`, `LiveState`, `Outbox`, `StateFeed`),
//! and flat domain modules.

pub mod agent;
pub mod app;
pub mod artifact;
mod boot;
pub mod channel;
pub mod config;
pub mod connector;
pub mod context;
pub mod cron;
pub mod db;
pub mod debug;
mod debug_sources;
pub mod fake;
pub mod game;
pub mod gateway;
pub mod issue;
pub mod log;
pub mod machine;
mod projection;
pub mod provider;
pub mod repo;
pub mod router;
pub mod runtime;
pub mod service;
pub mod setting;
pub mod storage;
pub mod voice;

pub use vibevalley_protocol::home;

pub use crate::app::{App, Config, StartError, TestInternals, create_app, create_app_blocking};
pub use crate::context::{Sink, SliceFeed, SliceFrame, SliceSubscription, install_tls, now};
pub use crate::gateway::api::*;
pub use crate::log::spawn_blocking_traced;
pub use crate::router::Router;
