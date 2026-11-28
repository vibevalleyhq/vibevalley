//! Bounded LRU cache with deterministic `SharedClock`-driven TTL expiration.

mod table;

pub use table::TtlCache;
