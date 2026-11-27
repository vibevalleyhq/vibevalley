//! What agents remember: rows persisted through `ctx.service.memory`, recall
//! and search rules, the `memory.*` endpoints, an orchestrator's carried notes,
//! and learnings captured from finished issue rounds.
//!
//! Only the local source is served, so `sources` lists `local` alone.

mod gse;
mod prompt;
mod rules;
mod store;
#[cfg(test)]
mod tests;

pub use prompt::found_text;
pub use store::{By, FinishedRun, LOCAL, Memory, Note, WriteMemory};
