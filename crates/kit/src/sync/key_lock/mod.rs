//! Leak-free per-key async mutex table with atomic in-bucket idle reclaim.

mod map;

pub use map::{KeyLock, KeyLockGuard};
