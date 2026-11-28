//! Cross-process single-writer directory lease backed by OS advisory file locks.

mod dir_lock;

pub use dir_lock::{DirLease, DirLeaseError};
