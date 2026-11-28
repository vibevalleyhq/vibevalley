use std::borrow::Borrow;
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::fmt;
use std::hash::{BuildHasher as _, Hash};
use std::num::NonZeroUsize;

use parking_lot::Mutex;

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

/// Bounded O(1) LRU cache with explicit `NonZeroUsize` capacity and exact-key verification.
///
/// Uses an intrusive index-linked list backed by a dense `Vec` plus a free list and
/// hash buckets so `get_by` looks up entries from borrowed slices without allocating
/// owned keys on cache hits.
pub struct LruCache<K, V> {
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

impl<K, V> fmt::Debug for LruCache<K, V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LruCache")
            .field("entries", &self.entries)
            .field("capacity", &self.capacity)
            .field("hits", &self.hits)
            .field("misses", &self.misses)
            .field("evictions", &self.evictions)
            .finish()
    }
}

impl<K, V> LruCache<K, V> {
    pub fn new(capacity: NonZeroUsize) -> Self {
        let cap = capacity.get();
        Self {
            capacity: cap,
            hasher: RandomState::new(),
            buckets: HashMap::with_capacity(cap.min(256)),
            nodes: Vec::with_capacity(cap.min(256)),
            free: Vec::new(),
            head: None,
            tail: None,
            entries: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries == 0
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn clear(&mut self) {
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

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries,
            capacity: self.capacity,
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
        }
    }

    fn find_slot(&self, hash: u64, mut matches: impl FnMut(&K) -> bool) -> Option<usize> {
        self.buckets.get(&hash).and_then(|slots| {
            slots
                .iter()
                .copied()
                .find(|&slot| self.nodes[slot].as_ref().is_some_and(|node| matches(&node.key)))
        })
    }

    pub fn get_by_ref(&mut self, hash: u64, matches: impl FnMut(&K) -> bool) -> Option<&V> {
        if let Some(slot) = self.find_slot(hash, matches) {
            self.hits += 1;
            self.move_to_front(slot);
            self.nodes[slot].as_ref().map(|node| &node.value)
        } else {
            self.misses += 1;
            None
        }
    }

    pub fn get_by_mut(&mut self, hash: u64, matches: impl FnMut(&K) -> bool) -> Option<&mut V> {
        if let Some(slot) = self.find_slot(hash, matches) {
            self.hits += 1;
            self.move_to_front(slot);
            self.nodes[slot].as_mut().map(|node| &mut node.value)
        } else {
            self.misses += 1;
            None
        }
    }

    pub fn insert_by(&mut self, hash: u64, key: K, value: V, matches: impl FnMut(&K) -> bool) -> Option<V> {
        if let Some(slot) = self.find_slot(hash, matches) {
            let old = self.nodes[slot].as_mut().map(|node| std::mem::replace(&mut node.value, value));
            self.move_to_front(slot);
            return old;
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
        None
    }

    pub fn remove_by(&mut self, hash: u64, matches: impl FnMut(&K) -> bool) -> Option<V> {
        let slot = self.find_slot(hash, matches)?;
        self.remove_slot(slot, false)
    }

    /// Retains only entries matching `predicate`.
    pub fn retain(&mut self, mut predicate: impl FnMut(&K, &V) -> bool) {
        let mut doomed = Vec::new();
        for (slot, node) in self.nodes.iter().enumerate() {
            if let Some(node) = node
                && !predicate(&node.key, &node.value)
            {
                doomed.push(slot);
            }
        }
        for slot in doomed {
            let _ = self.remove_slot(slot, false);
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

    fn remove_slot(&mut self, slot: usize, count_eviction: bool) -> Option<V> {
        self.unlink(slot);
        let node = self.nodes[slot].take()?;
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
        if count_eviction {
            self.evictions += 1;
        }
        Some(node.value)
    }

    fn evict_lru(&mut self) {
        if let Some(slot) = self.tail {
            let _ = self.remove_slot(slot, true);
        }
    }
}

impl<K, V: Clone> LruCache<K, V> {
    pub fn get_by(&mut self, hash: u64, matches: impl FnMut(&K) -> bool) -> Option<V> {
        self.get_by_ref(hash, matches).cloned()
    }
}

impl<K: Eq + Hash, V> LruCache<K, V> {
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let hash = self.hasher.hash_one(key);
        self.get_by_ref(hash, |candidate| candidate.borrow() == key)
    }

    pub fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let hash = self.hasher.hash_one(key);
        self.get_by_mut(hash, |candidate| candidate.borrow() == key)
    }

    pub fn peek<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let hash = self.hasher.hash_one(key);
        let slot = self.find_slot(hash, |candidate| candidate.borrow() == key)?;
        self.nodes[slot].as_ref().map(|node| &node.value)
    }

    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        let hash = self.hasher.hash_one(&key);
        if let Some(slot) = self.find_slot(hash, |candidate| candidate == &key) {
            let old = self.nodes[slot].as_mut().map(|node| std::mem::replace(&mut node.value, value));
            self.move_to_front(slot);
            return old;
        }
        self.insert_by(hash, key, value, |_| false)
    }

    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let hash = self.hasher.hash_one(key);
        self.remove_by(hash, |candidate| candidate.borrow() == key)
    }
}

/// Concurrent sharded LRU cache with explicit `NonZeroUsize` capacity and shard count.
pub struct ShardedLruCache<K, V> {
    hasher: RandomState,
    shards: Vec<Mutex<LruCache<K, V>>>,
}

impl<K: Eq + Hash, V> ShardedLruCache<K, V> {
    pub fn new(capacity: NonZeroUsize, shard_count: NonZeroUsize) -> Self {
        let count = shard_count.get().min(capacity.get()).max(1);
        let base = capacity.get() / count;
        let rem = capacity.get() % count;
        let shards = (0..count)
            .map(|i| {
                let cap = NonZeroUsize::new(base + usize::from(i < rem)).expect("shard capacity >= 1");
                Mutex::new(LruCache::new(cap))
            })
            .collect();
        Self {
            hasher: RandomState::new(),
            shards,
        }
    }

    fn shard_for<Q: Hash + ?Sized>(&self, key: &Q) -> &Mutex<LruCache<K, V>> {
        let hash = self.hasher.hash_one(key);
        let idx = (hash as usize) % self.shards.len();
        &self.shards[idx]
    }

    pub fn get_cloned<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
        V: Clone,
    {
        self.shard_for(key).lock().get(key).cloned()
    }

    pub fn insert(&self, key: K, value: V) -> Option<V> {
        self.shard_for(&key).lock().insert(key, value)
    }

    pub fn remove<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.shard_for(key).lock().remove(key)
    }

    pub fn clear(&self) {
        for shard in &self.shards {
            shard.lock().clear();
        }
    }

    pub fn stats(&self) -> CacheStats {
        let mut total = CacheStats::default();
        for shard in &self.shards {
            let s = shard.lock().stats();
            total.entries += s.entries;
            total.capacity += s.capacity;
            total.hits += s.hits;
            total.misses += s.misses;
            total.evictions += s.evictions;
        }
        total
    }
}

/// Fast 64-bit FNV-1a hash for cache key pre-filtering alongside exact key equality.
pub fn hash_str(s: &str) -> u64 {
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

    fn nz(n: usize) -> NonZeroUsize {
        NonZeroUsize::new(n).unwrap()
    }

    #[test]
    fn lru_evicts_least_recently_used_and_supports_borrowed_lookups() {
        let mut cache: LruCache<String, usize> = LruCache::new(nz(2));
        cache.insert("alpha".to_owned(), 1);
        cache.insert("beta".to_owned(), 2);
        assert_eq!(cache.get("alpha"), Some(&1));
        cache.insert("gamma".to_owned(), 3);
        assert_eq!(cache.get("beta"), None);
        assert_eq!(cache.get("alpha"), Some(&1));
        assert_eq!(cache.get("gamma"), Some(&3));
        assert_eq!(cache.remove("alpha"), Some(1));
        assert_eq!(cache.len(), 1);
        let stats = cache.stats();
        assert_eq!(stats.evictions, 1);
        assert_eq!(stats.hits, 3);
        assert_eq!(stats.misses, 1);
    }

    #[test]
    fn sharded_lru_distributes_and_aggregates_stats() {
        let cache = ShardedLruCache::<String, usize>::new(nz(8), nz(4));
        for i in 0..16 {
            cache.insert(format!("key-{i}"), i);
        }
        let stats = cache.stats();
        assert_eq!(stats.capacity, 8);
        assert!(stats.entries <= 8);
        assert!(stats.evictions >= 8);
    }
}
