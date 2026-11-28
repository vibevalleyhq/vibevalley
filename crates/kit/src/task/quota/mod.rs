//! Dual-level concurrency quota pool (global + per-key bounded permits).

mod pool;

pub use pool::{QuotaPermit, QuotaPool};
