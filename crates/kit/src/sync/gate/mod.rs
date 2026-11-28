//! Lock-free wake coalescing gate and idempotent 3-state teardown gate.

mod teardown;
mod wake;

pub use teardown::AsyncTeardownGate;
#[cfg(feature = "loom")]
pub use teardown::TeardownGate;
pub use wake::WakeGate;
