//! Ring 0 domain-agnostic system engineering primitives for VibeValley.
//!
//! Zero workspace dependencies, zero ORM entities, zero mutable process globals:
//! - [`rt`]: process-wide shared Tokio runtime (`vibevalley-io-*`).
//! - [`core`]: virtual clock, redacted `Secret`, retry policies, UTF-16 text, orthogonal fault types.
//! - [`sync`]: `loom` shim, leak-free `KeyLock`, `FlightGroup`, `WakeGate`, `AsyncTeardownGate`.
//! - [`cache`]: explicit-capacity `LruCache`, `ShardedLruCache`, `TtlCache`, `ReadThrough`.
//! - [`trace`]: tracing subscriber setup, span-propagating spawns, lock-free `ObserverSlot`, sinks.
//! - [`task`]: `TaskGroup`, `Ticker`, pure 5-field `CronExpr`/`CronScheduler`, `QuotaPool`, `DirLease`.
//! - [`queue`]: `KeyedLane`, `BatchCoalescer`, `ThrottleGate`, `BoundedSink` + `LagGuard`, and transactional `outbox`.
//! - `storage` (opt-in `storage-fs` / `storage-s3`): pluggable `StorageBackend`, path/CAS guards, `StagingArea`, `OrphanSweeper`.
//! - `db` (opt-in `db-sql` / `postgres`): unified SQLite/PostgreSQL pool engine, `PostCommitHooks`, `SeqAllocator`, schema helpers, and query telemetry.
//! - `net` (opt-in `net-client` / `net-gateway`): outbound HTTP client with SSRF guards and gateway feed/RPC/range/bridge/remote primitives.

pub mod cache;
pub mod core;
#[cfg(feature = "db-sql")]
pub mod db;
#[cfg(any(feature = "net-client", feature = "net-gateway"))]
pub mod net;
pub mod queue;
pub mod rt;
#[cfg(any(feature = "storage-fs", feature = "storage-s3"))]
pub mod storage;
pub mod sync;
pub mod task;
pub mod trace;

use std::time::Duration;

use crate::core::time::{SharedClock, system_clock};
use crate::task::TaskGroup;

/// Explicit composite handle carrying the Ring 0 clock and structured task tree.
#[derive(Clone)]
pub struct Kit {
    pub clock: SharedClock,
    pub task: TaskGroup,
}

impl Default for Kit {
    fn default() -> Self {
        Self::new()
    }
}

impl Kit {
    pub fn new() -> Self {
        Self {
            clock: system_clock(),
            task: TaskGroup::new(),
        }
    }

    pub fn with_clock(clock: SharedClock) -> Self {
        Self { clock, task: TaskGroup::new() }
    }

    pub fn from_parts(clock: SharedClock, task: TaskGroup) -> Self {
        Self { clock, task }
    }

    pub async fn close_async(&self, grace: Duration) -> bool {
        self.task.shutdown(grace).await
    }
}
