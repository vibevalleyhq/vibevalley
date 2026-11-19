//! VibeValley's own agent: a model client, tools, and a durable conversation
//! loop. It replaces what VibeValley takes from pi-ai (the DeepSeek
//! provider) and pi-durable (the loop, write-before-display, resume,
//! compaction) for the assistant and for the built-in `vibevalley` runtime.

pub mod conversation;
pub mod generation;
pub mod kit;
pub mod mcp;
pub mod model;
pub mod price;
pub mod tool;

pub use conversation::{Brain, BrainEvent, Conversation, Entry, TurnAbort, TurnOutcome, read_entries};
pub use model::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, OpenAiClient, Role, ToolCall, ToolSpec, Usage};
pub use tool::{Tool, ToolOutput, Workspace, coding_tools};

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
}

pub type Result<T> = std::result::Result<T, BrainError>;

#[cfg(test)]
mod tests;
