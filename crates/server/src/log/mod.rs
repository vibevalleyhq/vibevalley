//! Process-wide tracing initialization, span propagation helpers, and RPC invocation observer.

pub mod observer;
pub mod span;

pub use observer::*;
pub use span::*;

/// Initializes the global `tracing_subscriber` formatter writing to stderr, honoring
/// `VIBEVALLEY_LOG`, then `RUST_LOG`, and falling back to `default_level`.
pub fn init(default_level: &str) {
    vibevalley_kit::trace::init_subscriber(&["VIBEVALLEY_LOG", "RUST_LOG"], default_level);
}
