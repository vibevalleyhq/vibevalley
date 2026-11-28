//! Single-flight async deduplication for concurrent same-key loads.

mod group;

pub use group::FlightGroup;
