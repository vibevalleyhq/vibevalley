//! Server RPC endpoints, typed [`Op`] markers, [`SUBSCRIPTIONS`], and exhaustive [`EndpointId`],
//! organized by domain submodule while preserving VibeValley's canonical table order.

mod agent;
mod channel;
mod connector;
mod cron;
mod id;
mod issue;
mod media;
mod memory;
mod note;
mod orchestrator;
mod provider;
mod repo;
mod runtime;
mod session;
mod setting;
mod subscription;
mod system;
mod voice;

use crate::wire::Endpoint;

pub use self::id::EndpointId;
pub use self::subscription::{SUBSCRIPTIONS, subscriptions};

const ENDPOINT_GROUPS: &[&[Endpoint]] = &[
    agent::ENDPOINTS,
    runtime::ENDPOINTS,
    memory::ENDPOINTS,
    repo::ENDPOINTS,
    session::ENDPOINTS,
    issue::ENDPOINTS,
    cron::ENDPOINTS,
    channel::ENDPOINTS,
    connector::ENDPOINTS,
    media::ENDPOINTS,
    voice::ENDPOINTS,
    note::ENDPOINTS,
    provider::ENDPOINTS,
    setting::ENDPOINTS,
    orchestrator::ENDPOINTS,
    system::ENDPOINTS,
];

const ENDPOINT_COUNT: usize = {
    let mut n = 0;
    let mut i = 0;
    while i < ENDPOINT_GROUPS.len() {
        n += ENDPOINT_GROUPS[i].len();
        i += 1;
    }
    n
};

#[allow(clippy::large_const_arrays)]
const ENDPOINTS_STORAGE: [Endpoint; ENDPOINT_COUNT] = {
    let mut out = [Endpoint {
        op: "",
        module: "",
        about: &[],
        can: &[],
        dry_run: None,
        input: None,
        result: None,
    }; ENDPOINT_COUNT];
    let mut dst = 0;
    let mut g = 0;
    while g < ENDPOINT_GROUPS.len() {
        let group = ENDPOINT_GROUPS[g];
        let mut i = 0;
        while i < group.len() {
            out[dst] = group[i];
            dst += 1;
            i += 1;
        }
        g += 1;
    }
    out
};

/// Every endpoint, in VibeValley's order (`packages/protocol/src/api.ts`).
pub const ENDPOINTS: &[Endpoint] = &ENDPOINTS_STORAGE;

/// Each endpoint as a type: its name, input and result.
pub mod ops {
    pub use super::agent::ops::*;
    pub use super::channel::ops::*;
    pub use super::connector::ops::*;
    pub use super::cron::ops::*;
    pub use super::issue::ops::*;
    pub use super::media::ops::*;
    pub use super::memory::ops::*;
    pub use super::note::ops::*;
    pub use super::orchestrator::ops::*;
    pub use super::provider::ops::*;
    pub use super::repo::ops::*;
    pub use super::runtime::ops::*;
    pub use super::session::ops::*;
    pub use super::setting::ops::*;
    pub use super::system::ops::*;
    pub use super::voice::ops::*;
}
