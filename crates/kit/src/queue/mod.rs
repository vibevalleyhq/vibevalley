//! Bounded in-memory concurrency queues and durable transactional outbox primitives.

pub mod batch;
pub mod lane;
pub mod outbox;
pub mod stream;

pub use batch::{BatchCoalescer, BatchConfig, ThrottleGate};
pub use lane::{KeyedLane, LaneConfig, LaneError};
#[cfg(feature = "db-sql")]
pub use outbox::{DEFAULT_OUTBOX_TABLE, OutboxLeaseMode, SqlOutbox, enqueue_outbox_sql, ensure_outbox_table_sql};
pub use outbox::{
    DeadLetterSummary, MemoryOutbox, OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING, OutboxDeadLetter, OutboxError,
    OutboxItem, OutboxRetryPolicy, OutboxStatus, OutboxStore,
};
pub use stream::{BoundedSink, BoundedStream, LagGuard, OverflowPolicy, SinkStats, bounded_stream};
