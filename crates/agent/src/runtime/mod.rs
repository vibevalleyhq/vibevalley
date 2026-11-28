//! The built-in `vibevalley` runtime: VibeValley's own agent (`vibevalley_runtime::agent`) on
//! DeepSeek, driven by the durable execution harness and extension system.

mod driver;
mod engine;

pub use engine::{ID, KeySource, VibeValleyRuntime, default_registry};
