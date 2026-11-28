//! Cooperative background task group (`TaskGroup`), periodic [`Ticker`], and host wake watch.

mod tracker;
mod wake;

pub use tracker::{PeriodicTick, TaskGroup, Ticker};
pub use wake::WakeSignal;
