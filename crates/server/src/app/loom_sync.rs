//! Conditional synchronization primitives switching to `loom::sync` under
//! `--features loom` so lock-free spine protocols can be exhaustively explored.

#[cfg(feature = "loom")]
pub(crate) use loom::sync::atomic::{AtomicI64, AtomicU8, Ordering};
#[cfg(not(feature = "loom"))]
pub(crate) use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
