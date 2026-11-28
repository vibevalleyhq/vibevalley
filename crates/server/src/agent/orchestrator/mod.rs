//! The orchestrator: one assistant per orchestrator profile, each a durable
//! conversation on `vibevalley-runtime::agent` holding the farm's tools.
//! Subscribes to orchestrator-targeted dispatches from `Chat`; crons for no
//! profile come to it too. Before each input it is shown the time and the farm
//! (`situation`), or what changed since; its words are said in the place it
//! answers.
//!
//! Inputs that come while it works wait and go in together as the next turn.

mod eval;
mod execution;
pub mod inbox;
mod mcp;
mod prompt;
mod run;
mod service;
mod state;
mod types;
pub mod words;

pub use execution::{Execution, PendingExecution};
pub use inbox::RuntimeInboxObserver;
pub use state::{Orchestrator, Parts, Reply};
pub use types::Input;
pub use words::Source;
