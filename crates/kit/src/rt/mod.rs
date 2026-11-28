//! Process-wide shared Tokio runtime (`vibevalley-io-*`).

mod runtime;

pub use runtime::{block_on, current_or_global_handle, handle, spawn};
