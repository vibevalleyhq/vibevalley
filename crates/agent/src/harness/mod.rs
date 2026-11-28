//! Layer 4 runtime harness: extension registration, crash stand-in recovery,
//! and worker pools.

mod engine;
pub mod registry;
pub mod standin;
mod workers;

#[cfg(test)]
mod tests;

pub use engine::{Harness, SharedExecution, generation_kind};
pub use registry::ExtensionRegistry;
pub use standin::{StandIn, StandInRecovery, StandInTool};
pub use workers::{ATTACHED, Observer, Workers, WorkersOnly, worker_conversation};
