//! Wall-clock abstraction and deterministic virtual clock.

mod clock;
mod manual;

pub use clock::{Clock, SharedClock, SystemClock, system_clock};
pub use manual::ManualClock;
