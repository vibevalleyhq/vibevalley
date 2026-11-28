use std::future::Future;
use std::hash::Hash;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

use crate::cache::lru::CacheStats;
use crate::cache::ttl::TtlCache;
use crate::core::time::SharedClock;
use crate::sync::singleflight::FlightGroup;

/// Single-flight read-through cache backed by [`TtlCache`] with generation-guarded invalidation.
///
/// Prevents stampedes on cache misses via [`FlightGroup`] and prevents stale
/// in-flight loads from repopulating the cache after an invalidation occurs.
pub struct ReadThrough<K, V, E> {
    cache: Mutex<TtlCache<K, V>>,
    flights: FlightGroup<K, V, E>,
    generation: AtomicU64,
}

impl<K, V, E> ReadThrough<K, V, E>
where
    K: Eq + Hash + Clone,
    V: Clone,
    E: Clone,
{
    pub fn new(capacity: NonZeroUsize, ttl: Duration, clock: SharedClock) -> Self {
        Self {
            cache: Mutex::new(TtlCache::new(capacity, ttl, clock)),
            flights: FlightGroup::new(),
            generation: AtomicU64::new(0),
        }
    }

    pub fn invalidate(&self, key: &K) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.cache.lock().remove(key);
    }

    pub fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.cache.lock().clear();
    }

    pub fn stats(&self) -> CacheStats {
        self.cache.lock().stats()
    }

    pub async fn get_or_load<F, Fut>(&self, key: K, loader: F) -> Result<V, E>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        if let Some(hit) = self.cache.lock().get(&key).cloned() {
            return Ok(hit);
        }

        let start_gen = self.generation.load(Ordering::Acquire);
        let loaded = self.flights.run(key.clone(), loader).await?;

        if self.generation.load(Ordering::Acquire) == start_gen {
            self.cache.lock().insert(key, loaded.clone());
        }
        Ok(loaded)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::core::time::ManualClock;

    #[tokio::test]
    async fn read_through_coalesces_misses_and_respects_invalidation() {
        let clock = Arc::new(ManualClock::new(10_000));
        let rt = Arc::new(ReadThrough::<String, usize, &'static str>::new(
            NonZeroUsize::new(8).unwrap(),
            Duration::from_secs(60),
            clock.clone(),
        ));
        let loads = Arc::new(AtomicUsize::new(0));

        let v1 = rt
            .get_or_load("k".to_owned(), || {
                let loads = Arc::clone(&loads);
                async move { Ok(loads.fetch_add(1, Ordering::SeqCst) + 1) }
            })
            .await
            .unwrap();
        assert_eq!(v1, 1);

        // Cached hit skips loader.
        let v2 = rt
            .get_or_load("k".to_owned(), || {
                let loads = Arc::clone(&loads);
                async move { Ok(loads.fetch_add(1, Ordering::SeqCst) + 1) }
            })
            .await
            .unwrap();
        assert_eq!(v2, 1);
        assert_eq!(loads.load(Ordering::SeqCst), 1);

        // Invalidate forces reload.
        rt.invalidate(&"k".to_owned());
        let v3 = rt
            .get_or_load("k".to_owned(), || {
                let loads = Arc::clone(&loads);
                async move { Ok(loads.fetch_add(1, Ordering::SeqCst) + 1) }
            })
            .await
            .unwrap();
        assert_eq!(v3, 2);

        // TTL expiry forces reload deterministically.
        clock.advance(Duration::from_secs(61));
        let v4 = rt
            .get_or_load("k".to_owned(), || {
                let loads = Arc::clone(&loads);
                async move { Ok(loads.fetch_add(1, Ordering::SeqCst) + 1) }
            })
            .await
            .unwrap();
        assert_eq!(v4, 3);
    }
}
