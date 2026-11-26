//! `cron.*` and the scheduler ticker: each cron, when due, keeps one issue
//! going or nudges the channel's orchestrator. Schedule rules live in
//! `vibevalley-core::cron`; persistence is delegated to `ctx.service.cron`.

pub mod digest;
mod service;
#[cfg(test)]
mod tests;

pub use crate::context::port::DigestDeliveryPort;
pub use service::{DEFAULT_CHANNEL, DigestCronRequest, Scheduler};
