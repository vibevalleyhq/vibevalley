//! The contract: every shape on the wire, the endpoint table and the type
//! registry the golden tests read. TypeScript is written from it
//! (`crate::typescript`).

pub mod agent;
pub mod artifact;
pub mod attachment;
pub mod channel;
pub mod common;
pub mod connector;
pub mod core;
pub mod cron;
pub mod debug;
pub mod endpoints;
pub mod game;
pub mod host;
pub mod inbox;
pub mod issue;
pub mod media;
pub mod memory;
pub mod orchestrator;
pub mod provider;
pub mod remote;
pub mod repo;
pub mod runtime;
pub mod session;
pub mod setting;
pub mod voice;

pub use agent::*;
pub use artifact::*;
pub use attachment::*;
pub use channel::*;
pub use common::*;
pub use connector::*;
pub use core::*;
pub use cron::*;
pub use debug::*;
pub use endpoints::*;
pub use game::*;
pub use host::*;
pub use inbox::*;
pub use issue::*;
pub use media::*;
pub use memory::*;
pub use orchestrator::*;
pub use provider::*;
pub use remote::*;
pub use repo::*;
pub use runtime::*;
pub use session::*;
pub use setting::*;
pub use voice::*;

/// Every module's TypeScript, in the order of the files.
#[cfg(feature = "ts-gen")]
pub(crate) fn ts_modules(cfg: &ts_rs::Config) -> Vec<crate::typescript::Module> {
    vec![
        agent::ts_module(cfg),
        artifact::ts_module(cfg),
        attachment::ts_module(cfg),
        channel::ts_module(cfg),
        common::ts_module(cfg),
        connector::ts_module(cfg),
        core::ts_module(cfg),
        cron::ts_module(cfg),
        debug::ts_module(cfg),
        game::ts_module(cfg),
        host::ts_module(cfg),
        inbox::ts_module(cfg),
        issue::ts_module(cfg),
        media::ts_module(cfg),
        memory::ts_module(cfg),
        orchestrator::ts_module(cfg),
        provider::ts_module(cfg),
        remote::ts_module(cfg),
        repo::ts_module(cfg),
        runtime::ts_module(cfg),
        session::ts_module(cfg),
        setting::ts_module(cfg),
        voice::ts_module(cfg),
    ]
}
