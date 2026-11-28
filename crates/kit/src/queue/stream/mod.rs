//! Bounded async event stream with explicit overflow policy and sequence lag guard.

mod lag;
mod sink;

pub use lag::LagGuard;
pub use sink::{BoundedSink, BoundedStream, OverflowPolicy, SinkStats, bounded_stream};
