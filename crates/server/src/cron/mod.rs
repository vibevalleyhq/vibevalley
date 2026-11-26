//! `cron.*` and the scheduler ticker: each cron, when due, keeps one issue
//! going or nudges the channel's orchestrator. Schedule rules live in
//! `vibevalley-core::cron`; persistence is delegated to `ctx.service.cron`.

mod service;
#[cfg(test)]
mod tests;

pub use service::{DEFAULT_CHANNEL, Scheduler};
