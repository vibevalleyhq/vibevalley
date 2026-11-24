//! Bounded O(1) LRU cache used by diagram, canvas, and code-block renderers.

use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher as _, Hash};

/// Runtime hit/miss/eviction counters for cache diagnostics and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub entries: usize,
    pub capacity: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

struct Node<K, V> {
    hash: u64,
    key: K,
    value: V,
    prev: Option<usize>,
    next: Option<usize>,
}

/// Bounded O(1) LRU cache with exact-key verification (zero hash-collision risk).
///
/// Uses an intrusive index-linked list backed by a dense `Vec` plus a free list and
/// hash buckets so `get_by` looks up entries from borrowed slices without allocating
/// owned keys on cache hits.
pub(crate) struct LruCache<K, V> {
    capacity: usize,
    hasher: RandomState,
    buckets: HashMap<u64, Vec<usize>>,
    nodes: Vec<Option<Node<K, V>>>,
    free: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
    entries: usize,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K, V: Clone> LruCache<K, V> {
    pub(crate) fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            capacity: cap,
            hasher: RandomState::new(),
            buckets: HashMap::with_capacity(cap),
            nodes: Vec::with_capacity(cap),
            free: Vec::new(),
            head: None,
            tail: None,
            entries: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub(crate) fn get_by(&mut self, hash: u64, mut matches: impl FnMut(&K) -> bool) -> Option<V> {
        let found = self.buckets.get(&hash).and_then(|slots| {
            slots
                .iter()
                .copied()
                .find(|&slot| self.nodes[slot].as_ref().is_some_and(|node| matches(&node.key)))
        });
        if let Some(slot) = found {
            self.hits += 1;
            let value = self.nodes[slot].as_ref().map(|node| node.value.clone());
            self.move_to_front(slot);
            value
        } else {
            self.misses += 1;
            None
        }
    }

    pub(crate) fn insert_by(&mut self, hash: u64, key: K, value: V, mut matches: impl FnMut(&K) -> bool) {
        let existing = self.buckets.get(&hash).and_then(|slots| {
            slots
                .iter()
                .copied()
                .find(|&slot| self.nodes[slot].as_ref().is_some_and(|node| matches(&node.key)))
        });
        if let Some(slot) = existing {
            if let Some(node) = self.nodes[slot].as_mut() {
                node.value = value;
            }
            self.move_to_front(slot);
            return;
        }
        if self.entries >= self.capacity {
            self.evict_lru();
        }
        let slot = match self.free.pop() {
            Some(idx) => idx,
            None => {
                let idx = self.nodes.len();
                self.nodes.push(None);
                idx
            }
        };
        self.nodes[slot] = Some(Node {
            hash,
            key,
            value,
            prev: None,
            next: None,
        });
        self.buckets.entry(hash).or_default().push(slot);
        self.entries += 1;
        self.push_front(slot);
    }

    pub(crate) fn clear(&mut self) {
        self.buckets.clear();
        self.nodes.clear();
        self.free.clear();
        self.head = None;
        self.tail = None;
        self.entries = 0;
        self.hits = 0;
        self.misses = 0;
        self.evictions = 0;
    }

    pub(crate) fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries,
            capacity: self.capacity,
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
        }
    }

    fn unlink(&mut self, slot: usize) {
        let Some((prev, next)) = self.nodes[slot].as_mut().map(|node| {
            let links = (node.prev, node.next);
            node.prev = None;
            node.next = None;
            links
        }) else {
            return;
        };
        match prev {
            Some(p) => {
                if let Some(prev_node) = self.nodes[p].as_mut() {
                    prev_node.next = next;
                }
            }
            None => self.head = next,
        }
        match next {
            Some(n) => {
                if let Some(next_node) = self.nodes[n].as_mut() {
                    next_node.prev = prev;
                }
            }
            None => self.tail = prev,
        }
    }

    fn push_front(&mut self, slot: usize) {
        let old_head = self.head;
        if let Some(node) = self.nodes[slot].as_mut() {
            node.prev = None;
            node.next = old_head;
        }
        match old_head {
            Some(h) => {
                if let Some(head_node) = self.nodes[h].as_mut() {
                    head_node.prev = Some(slot);
                }
            }
            None => self.tail = Some(slot),
        }
        self.head = Some(slot);
    }

    fn move_to_front(&mut self, slot: usize) {
        if self.head == Some(slot) {
            return;
        }
        self.unlink(slot);
        self.push_front(slot);
    }

    fn evict_lru(&mut self) {
        let Some(slot) = self.tail else {
            return;
        };
        self.unlink(slot);
        if let Some(node) = self.nodes[slot].take() {
            if let Some(slots) = self.buckets.get_mut(&node.hash) {
                if let Some(pos) = slots.iter().position(|&s| s == slot) {
                    slots.swap_remove(pos);
                }
                if slots.is_empty() {
                    self.buckets.remove(&node.hash);
                }
            }
            self.free.push(slot);
            self.entries = self.entries.saturating_sub(1);
            self.evictions += 1;
        }
    }
}

impl<K: Eq + Hash, V: Clone> LruCache<K, V> {
    pub(crate) fn get(&mut self, key: &K) -> Option<V> {
        let hash = self.hasher.hash_one(key);
        self.get_by(hash, |candidate| candidate == key)
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        let hash = self.hasher.hash_one(&key);
        if let Some(slot) = self
            .buckets
            .get(&hash)
            .and_then(|slots| slots.iter().copied().find(|&slot| self.nodes[slot].as_ref().is_some_and(|n| n.key == key)))
        {
            if let Some(node) = self.nodes[slot].as_mut() {
                node.value = value;
            }
            self.move_to_front(slot);
            return;
        }
        self.insert_by(hash, key, value, |_| false);
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

    #[test]
    fn lru_cache_update_existing_key_refreshes_recency_without_evicting() {
        let mut cache = LruCache::new(3);
        cache.insert("a", 1);
        cache.insert("b", 2);
        cache.insert("c", 3);
        // Updating "a" moves it to MRU so "b" becomes LRU.
        cache.insert("a", 10);
        assert_eq!(cache.stats().evictions, 0);
        assert_eq!(cache.stats().entries, 3);

        cache.insert("d", 4);
        assert_eq!(cache.get(&"b"), None);
        assert_eq!(cache.get(&"a"), Some(10));
        assert_eq!(cache.get(&"c"), Some(3));
        assert_eq!(cache.get(&"d"), Some(4));
        assert_eq!(cache.stats().evictions, 1);
    }

    #[test]
    fn lru_cache_handles_capacity_one_and_clear() {
        let mut cache = LruCache::new(0); // Clamped to 1.
        assert_eq!(cache.stats().capacity, 1);
        cache.insert("x", 1);
        assert_eq!(cache.get(&"x"), Some(1));
        cache.insert("x", 2);
        assert_eq!(cache.get(&"x"), Some(2));
        assert_eq!(cache.stats().evictions, 0);

        cache.insert("y", 3);
        assert_eq!(cache.get(&"x"), None);
        assert_eq!(cache.get(&"y"), Some(3));
        assert_eq!(cache.stats().evictions, 1);

        cache.clear();
        assert_eq!(
            cache.stats(),
            CacheStats {
                entries: 0,
                capacity: 1,
                hits: 0,
                misses: 0,
                evictions: 0
            }
        );
        cache.insert("z", 9);
        assert_eq!(cache.get(&"z"), Some(9));
    }

    #[test]
    fn lru_cache_reuses_slots_and_preserves_order_at_scale() {
        const CAP: usize = 256;
        let mut cache = LruCache::new(CAP);
        for i in 0..CAP {
            cache.insert(i, i * 10);
        }
        // Touch even keys so odd keys become the least recently used half.
        for i in (0..CAP).step_by(2) {
            assert_eq!(cache.get(&i), Some(i * 10));
        }
        // Insert CAP/2 new keys: every odd key must be evicted and every even key retained.
        for i in CAP..(CAP + CAP / 2) {
            cache.insert(i, i * 10);
        }
        assert!(cache.nodes.len() <= CAP, "backing vec must stay bounded by capacity");
        for i in 0..CAP {
            if i % 2 == 0 {
                assert_eq!(cache.get(&i), Some(i * 10), "even key {i} should stay cached");
            } else {
                assert_eq!(cache.get(&i), None, "odd key {i} should have been evicted");
            }
        }
        assert_eq!(cache.stats().entries, CAP);
        assert_eq!(cache.stats().evictions, (CAP / 2) as u64);
    }

    #[test]
    fn lru_cache_get_by_handles_borrowed_lookup_and_hash_collisions() {
        let mut cache: LruCache<String, usize> = LruCache::new(2);
        let same_hash = 0xdead_beef_u64;
        cache.insert_by(same_hash, "alpha".to_owned(), 1, |k| k == "alpha");
        cache.insert_by(same_hash, "beta".to_owned(), 2, |k| k == "beta");

        assert_eq!(cache.get_by(same_hash, |k| k == "alpha"), Some(1));
        assert_eq!(cache.get_by(same_hash, |k| k == "beta"), Some(2));
        assert_eq!(cache.get_by(same_hash, |k| k == "gamma"), None);

        // Inserting a third key evicts the LRU entry ("alpha") cleanly from its bucket.
        cache.insert_by(0x1234_u64, "gamma".to_owned(), 3, |k| k == "gamma");
        assert_eq!(cache.get_by(same_hash, |k| k == "alpha"), None);
        assert_eq!(cache.get_by(same_hash, |k| k == "beta"), Some(2));
        assert_eq!(cache.get_by(0x1234_u64, |k| k == "gamma"), Some(3));
        assert_eq!(cache.stats().evictions, 1);
    }
}
