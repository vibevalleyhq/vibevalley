//! Synchronization primitive shim switching between `std::sync` and `loom::sync`.
//!
//! Keep `#[cfg(feature = "loom")]` confined to this module and `loom_models` test modules
//! so production concurrency kernels stay free of conditional compilation branches.

#[allow(unused_imports, reason = "shared sync shim for production kernels and loom models")]
#[cfg(feature = "loom")]
pub(crate) use loom::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, AtomicU8, AtomicU64, Ordering},
};

#[allow(unused_imports, reason = "shared sync shim for production kernels and loom models")]
#[cfg(not(feature = "loom"))]
pub(crate) use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, AtomicU8, AtomicU64, Ordering},
};
