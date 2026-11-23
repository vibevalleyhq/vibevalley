//! Synchronization primitive shim switching between `std::sync` and `loom::sync`
//! under `feature = "loom"` so concurrent kernels need no conditional compilation
//! in their logic.

#![allow(unused_imports)]

#[cfg(feature = "loom")]
pub(crate) use loom::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
#[cfg(feature = "loom")]
pub(crate) use loom::sync::{Arc, Condvar, Mutex};

#[cfg(not(feature = "loom"))]
pub(crate) use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
#[cfg(not(feature = "loom"))]
pub(crate) use std::sync::{Arc, Condvar, Mutex};
