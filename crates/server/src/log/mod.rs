//! Process-wide tracing initialization, span propagation helpers, and RPC invocation observer.

pub mod observer;
pub mod span;

pub use observer::*;
pub use span::*;

/// Initializes the global `tracing_subscriber` formatter writing to stderr, honoring
/// `VIBEVALLEY_LOG`, then `RUST_LOG`, and falling back to `default_level`.
pub fn init(default_level: &str) {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let spec = env("VIBEVALLEY_LOG").or_else(|| env("RUST_LOG")).unwrap_or_else(|| default_level.to_string());
    let filter = tracing_subscriber::EnvFilter::try_new(&spec).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_level));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}
