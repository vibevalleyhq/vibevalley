//! Bounded LRU cache used by diagram, canvas, and code-block renderers.

use std::collections::VecDeque;
use std::hash::Hash;

/// Runtime hit/miss/eviction counters for cache diagnostics and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub entries: usize,
    pub capacity: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// Simple bounded LRU cache with exact-key verification (zero hash-collision risk).
pub(crate) struct LruCache<K, V> {
    capacity: usize,
    entries: VecDeque<(K, V)>,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K: Eq + Hash, V: Clone> LruCache<K, V> {
    pub(crate) fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            capacity: cap,
            entries: VecDeque::with_capacity(cap),
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub(crate) fn get(&mut self, key: &K) -> Option<V> {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == key) {
            self.hits += 1;
            let entry = self.entries.remove(pos)?;
            let value = entry.1.clone();
            self.entries.push_back(entry);
            Some(value)
        } else {
            self.misses += 1;
            None
        }
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == &key) {
            self.entries.remove(pos);
        } else if self.entries.len() >= self.capacity {
            self.entries.pop_front();
            self.evictions += 1;
        }
        self.entries.push_back((key, value));
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.hits = 0;
        self.misses = 0;
        self.evictions = 0;
    }

    pub(crate) fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            capacity: self.capacity,
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
        }
    }
}

/// Fast 64-bit FNV-1a hash for cache key pre-filtering alongside exact key equality.
pub(crate) fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_cache_refreshes_recency_and_evicts_least_recently_used() {
        let mut cache = LruCache::new(2);
        cache.insert("a", 1);
        cache.insert("b", 2);
        // Accessing "a" makes "b" the least recently used entry.
        assert_eq!(cache.get(&"a"), Some(1));
        cache.insert("c", 3);
        assert_eq!(cache.get(&"b"), None);
        assert_eq!(cache.get(&"a"), Some(1));
        assert_eq!(cache.get(&"c"), Some(3));
        let stats = cache.stats();
        assert_eq!(stats.entries, 2);
        assert_eq!(stats.hits, 3);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.evictions, 1);
    }
}
