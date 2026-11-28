//! Synchronization primitive shim switching between `std::sync` and `loom::sync`
//! under `feature = "loom"` so concurrent kernels need no conditional compilation
//! in their logic.

#![allow(unused_imports)]
#![allow(clippy::disallowed_types, reason = "loom concurrency model shim")]

#[cfg(feature = "loom")]
pub use loom::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, AtomicUsize, Ordering};
#[cfg(feature = "loom")]
pub use loom::sync::{Arc, Condvar, Mutex};

#[cfg(not(feature = "loom"))]
pub use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, AtomicUsize, Ordering};
#[cfg(not(feature = "loom"))]
pub use std::sync::{Arc, Condvar, Mutex};
