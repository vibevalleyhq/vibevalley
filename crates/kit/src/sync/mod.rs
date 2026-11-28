//! Fine-grained concurrency primitives and `loom` verification shims.

pub mod gate;
pub mod key_lock;
pub mod loom;
pub mod singleflight;

#[cfg(feature = "loom")]
pub use gate::TeardownGate;
pub use gate::{AsyncTeardownGate, WakeGate};
pub use key_lock::{KeyLock, KeyLockGuard};
pub use singleflight::FlightGroup;
