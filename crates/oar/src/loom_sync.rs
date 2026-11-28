//! Synchronization primitive shim delegating to [`vibevalley_kit::sync::loom`].

#![allow(unused_imports)]
#![allow(clippy::disallowed_types, reason = "loom concurrency model shim")]

pub(crate) use vibevalley_kit::sync::loom::{Arc, AtomicBool, AtomicU8, AtomicU64, Condvar, Mutex, Ordering};
