//! Micro-batch coalescer with shutdown auto-flush and clock-driven throttle gate.

mod coalescer;
mod throttle;

pub use coalescer::{BatchCoalescer, BatchConfig};
pub use throttle::ThrottleGate;
