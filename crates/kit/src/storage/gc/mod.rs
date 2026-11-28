//! Domain-agnostic orphan object sweeping with active-key reconciliation, grace periods, and dry-run previews.

pub mod sweep;

pub use sweep::{OrphanCandidate, OrphanSweepReport, OrphanSweeper};
