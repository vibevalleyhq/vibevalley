//! Span- and subscriber-preserving Tokio spawn helpers.

mod propagate;

pub use propagate::{spawn_blocking_traced, spawn_traced};
