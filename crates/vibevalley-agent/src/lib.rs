//! VibeValley's own agent: layered model client, durable execution core,
//! typed tools, resources, extensions, harness, and built-in `vibevalley` runtime.

pub mod ai;
pub mod codemode;
pub mod compaction;
pub mod core;
pub mod durable;
pub mod eval;
pub mod experiments;
pub mod extensions;
pub mod harness;
pub mod resources;
pub mod runtime;
pub mod tools;

pub use ai::OpenAiClient;
pub use ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, ToolSpec, Usage};
pub use core::doc::DocSpec;
pub use core::events::{AgentEvent, Brain, TurnOutcome};
pub use core::extension::Extension;
pub use harness::Harness;
pub use tools::{
    ReplayPolicy, Tool, ToolContext, ToolOutput, ToolUpdate, TypedTool, TypedToolAdapter, TypedToolOutput, Workspace, coding_tools, read_only_tools,
};

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("no API key is set for the model")]
    NoKey,
    #[error("model context window overflow: {0}")]
    ContextOverflow(String),
    #[error("network: {0}")]
    Network(String),
    #[error("model: {0}")]
    Model(String),
    #[error("store: {0}")]
    Store(String),
    #[error("a turn is already unfinished; resume it first")]
    Busy,
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, BrainError>;

#[cfg(test)]
mod tests;
