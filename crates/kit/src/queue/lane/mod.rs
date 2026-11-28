//! Per-key FIFO async lanes with bounded backpressure and race-free idle worker reclaim.

mod keyed;

pub use keyed::{KeyedLane, LaneConfig, LaneError};
