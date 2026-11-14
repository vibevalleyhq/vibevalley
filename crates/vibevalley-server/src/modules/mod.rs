//! VibeValley's server modules (`apps/server/src/modules/*`), each
//! registering its endpoints on the hub.

use crate::Hub;

pub mod agent;
pub mod artifact;
pub mod attachment;
pub mod channel;
pub mod connector;
pub mod core;
pub mod cron;
pub mod game;
pub mod issue;
pub mod ledger;
pub mod library;
pub mod mcp;
pub mod media;
pub mod memory;
pub mod orchestrator;
pub mod pkm;
pub mod provider;
pub mod publish;
pub mod repo;
pub mod session;
pub mod setting;
pub mod tool;
pub mod voice;
pub mod watch;
pub mod workplace;

/// Every module this build serves.
pub fn install(hub: &Hub) {
    core::install(hub);
}
