use std::borrow::Borrow;
use std::hash::Hash;
use std::num::NonZeroUsize;
use std::time::Duration;

use crate::cache::lru::{CacheStats, LruCache};
use crate::core::time::SharedClock;

#[derive(Debug, Clone)]
struct Entry<V> {
    value: V,
    expires_at_ms: i64,
}

/// Bounded LRU cache whose entries expire against an injected [`SharedClock`].
pub struct TtlCache<K, V> {
    inner: LruCache<K, Entry<V>>,
    clock: SharedClock,
    default_ttl: Duration,
}

impl<K: Eq + Hash, V> TtlCache<K, V> {
    pub fn new(capacity: NonZeroUsize, default_ttl: Duration, clock: SharedClock) -> Self {
        Self {
            inner: LruCache::new(capacity),
            clock,
            default_ttl,
        }
    }

    fn deadline(&self, ttl: Duration) -> i64 {
        let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
        self.clock.now_ms().saturating_add(ttl_ms)
    }

    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        self.insert_with_ttl(key, value, self.default_ttl)
    }

    pub fn insert_with_ttl(&mut self, key: K, value: V, ttl: Duration) -> Option<V> {
        let entry = Entry {
            value,
            expires_at_ms: self.deadline(ttl),
        };
        self.inner.insert(key, entry).map(|old| old.value)
    }

    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = self.clock.now_ms();
        let expired = self.inner.peek(key).is_some_and(|e| e.expires_at_ms <= now);
        if expired {
            let _ = self.inner.remove(key);
            return None;
        }
        self.inner.get(key).map(|e| &e.value)
    }

    pub fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = self.clock.now_ms();
        let expired = self.inner.peek(key).is_some_and(|e| e.expires_at_ms <= now);
        if expired {
            let _ = self.inner.remove(key);
            return None;
        }
        self.inner.get_mut(key).map(|e| &mut e.value)
    }

    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.inner.remove(key).map(|e| e.value)
    }

    /// Removes all entries whose deadline has passed on [`SharedClock`].
    pub fn purge_expired(&mut self) {
        let now = self.clock.now_ms();
        self.inner.retain(|_, entry| entry.expires_at_ms > now);
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn stats(&self) -> CacheStats {
        self.inner.stats()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::core::time::ManualClock;

    #[test]
    fn ttl_cache_expires_deterministically_with_manual_clock() {
        let clock = Arc::new(ManualClock::new(1_000));
        let mut cache = TtlCache::new(NonZeroUsize::new(4).unwrap(), Duration::from_secs(30), clock.clone());
        cache.insert("k1".to_owned(), "v1");
        assert_eq!(cache.get("k1"), Some(&"v1"));

        clock.advance(Duration::from_secs(29));
        assert_eq!(cache.get("k1"), Some(&"v1"));

        clock.advance(Duration::from_secs(1));
        assert_eq!(cache.get("k1"), None);
        assert!(cache.is_empty());
    }
}
