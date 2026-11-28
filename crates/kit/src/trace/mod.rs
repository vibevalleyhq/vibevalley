//! Structured tracing subscriber initialization, span propagation, and lock-free observer slots.

pub mod hook;
pub mod span;
pub mod subscriber;

pub use hook::{JsonlSink, MemorySink, Observer, ObserverSlot};
pub use span::{spawn_blocking_traced, spawn_traced};
pub use subscriber::init_subscriber;
