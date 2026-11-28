//! Bounded O(1) LRU cache and sharded concurrent LRU cache.

mod shard;

pub use shard::{CacheStats, LruCache, ShardedLruCache, hash_str};
