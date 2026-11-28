//! Layer 0 model communication: protocol types, cancellable SSE streaming,
//! retry policies, model catalog, and DeepSeek provider client.

pub mod models;
pub mod providers;
pub mod retry;
pub mod stream;
pub mod types;

#[cfg(test)]
mod tests;

pub use providers::deepseek::{AccountBalance, BalanceEntry, OpenAiClient};
pub use stream::{CancelHandle, CancelToken};
pub use types::ModelClient;
