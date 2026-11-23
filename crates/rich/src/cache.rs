//! Bounded O(1) LRU cache used by diagram, canvas, and code-block renderers.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;

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
    key: Arc<K>,
    value: V,
    prev: Option<usize>,
    next: Option<usize>,
}

/// Bounded O(1) LRU cache with exact-key verification (zero hash-collision risk).
///
/// Uses an intrusive index-linked list backed by a dense `Vec` plus a free list so
/// `get`, `insert`, recency touch, and LRU eviction all run in O(1) without extra
/// crate dependencies or requiring `K: Clone`.
pub(crate) struct LruCache<K, V> {
    capacity: usize,
    index: HashMap<Arc<K>, usize>,
    nodes: Vec<Option<Node<K, V>>>,
    free: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K: Eq + Hash, V: Clone> LruCache<K, V> {
    pub(crate) fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            capacity: cap,
            index: HashMap::with_capacity(cap),
            nodes: Vec::with_capacity(cap),
            free: Vec::new(),
            head: None,
            tail: None,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub(crate) fn get(&mut self, key: &K) -> Option<V> {
        if let Some(&slot) = self.index.get(key) {
            self.hits += 1;
            self.move_to_front(slot);
            self.nodes[slot].as_ref().map(|node| node.value.clone())
        } else {
            self.misses += 1;
            None
        }
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        if let Some(&slot) = self.index.get(&key) {
            if let Some(node) = self.nodes[slot].as_mut() {
                node.value = value;
            }
            self.move_to_front(slot);
            return;
        }
        if self.index.len() >= self.capacity {
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
        let key = Arc::new(key);
        self.nodes[slot] = Some(Node {
            key: Arc::clone(&key),
            value,
            prev: None,
            next: None,
        });
        self.index.insert(key, slot);
        self.push_front(slot);
    }

    pub(crate) fn clear(&mut self) {
        self.index.clear();
        self.nodes.clear();
        self.free.clear();
        self.head = None;
        self.tail = None;
        self.hits = 0;
        self.misses = 0;
        self.evictions = 0;
    }

    pub(crate) fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.index.len(),
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
            self.index.remove(&node.key);
            self.free.push(slot);
            self.evictions += 1;
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
}
