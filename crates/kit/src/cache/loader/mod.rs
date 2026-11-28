//! Read-through cache combining `TtlCache`, `FlightGroup`, and generation invalidation.

mod read_through;

pub use read_through::ReadThrough;
