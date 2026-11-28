use std::collections::HashMap;
use std::hash::Hash;
use std::num::NonZeroUsize;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Dual-level concurrency limiter enforcing both a global permit cap and a per-key cap,
/// with automatic race-free idle reclaim of per-key semaphores.
pub struct QuotaPool<K> {
    global: Arc<Semaphore>,
    per_key_limit: usize,
    per_key: Mutex<HashMap<K, Weak<Semaphore>>>,
}

impl<K> QuotaPool<K> {
    pub fn new(global_limit: NonZeroUsize, per_key_limit: NonZeroUsize) -> Self {
        Self {
            global: Arc::new(Semaphore::new(global_limit.get())),
            per_key_limit: per_key_limit.get(),
            per_key: Mutex::new(HashMap::new()),
        }
    }

    pub fn active_keys(&self) -> usize {
        self.per_key.lock().len()
    }

    pub fn available_global(&self) -> usize {
        self.global.available_permits()
    }
}

impl<K> QuotaPool<K>
where
    K: Eq + Hash + Clone,
{
    fn reclaim_if_idle(&self, key: &K, sem: &Arc<Semaphore>) {
        let mut slots = self.per_key.lock();
        if Arc::strong_count(sem) == 1 && slots.get(key).is_some_and(|weak| std::ptr::eq(weak.as_ptr(), Arc::as_ptr(sem))) {
            slots.remove(key);
        }
    }

    fn get_or_create_key_sem(&self, key: &K) -> Arc<Semaphore> {
        let mut slots = self.per_key.lock();
        if let Some(existing) = slots.get(key).and_then(Weak::upgrade) {
            existing
        } else {
            let fresh = Arc::new(Semaphore::new(self.per_key_limit));
            slots.insert(key.clone(), Arc::downgrade(&fresh));
            fresh
        }
    }

    /// Acquires both the per-key permit and a global permit (always acquiring per-key
    /// first to avoid holding a global slot while blocked on a saturated key).
    pub async fn acquire(&self, key: K) -> QuotaPermit<'_, K> {
        let key_sem = self.get_or_create_key_sem(&key);
        let mut cancel_guard = PendingKeyReclaim {
            pool: self,
            key: Some(key),
            sem: Some(Arc::clone(&key_sem)),
        };

        let key_permit = Arc::clone(&key_sem).acquire_owned().await.expect("per-key semaphore is never closed");
        let global_permit = Arc::clone(&self.global).acquire_owned().await.expect("global semaphore is never closed");

        let key = cancel_guard.key.take().expect("key present");
        let key_sem = cancel_guard.sem.take().expect("sem present");
        QuotaPermit {
            pool: self,
            key,
            key_sem,
            _global: Some(global_permit),
            _per_key: Some(key_permit),
        }
    }

    /// Attempts to acquire both permits without waiting; returns `None` if either quota is full.
    pub fn try_acquire(&self, key: K) -> Option<QuotaPermit<'_, K>> {
        let key_sem = self.get_or_create_key_sem(&key);
        let Ok(key_permit) = Arc::clone(&key_sem).try_acquire_owned() else {
            self.reclaim_if_idle(&key, &key_sem);
            return None;
        };
        let Ok(global_permit) = Arc::clone(&self.global).try_acquire_owned() else {
            drop(key_permit);
            self.reclaim_if_idle(&key, &key_sem);
            return None;
        };
        Some(QuotaPermit {
            pool: self,
            key,
            key_sem,
            _global: Some(global_permit),
            _per_key: Some(key_permit),
        })
    }
}

struct PendingKeyReclaim<'a, K: Eq + Hash + Clone> {
    pool: &'a QuotaPool<K>,
    key: Option<K>,
    sem: Option<Arc<Semaphore>>,
}

impl<K: Eq + Hash + Clone> Drop for PendingKeyReclaim<'_, K> {
    fn drop(&mut self) {
        if let (Some(key), Some(sem)) = (self.key.take(), self.sem.take()) {
            self.pool.reclaim_if_idle(&key, &sem);
        }
    }
}

/// RAII dual-quota lease releasing both global and per-key permits on drop.
pub struct QuotaPermit<'a, K: Eq + Hash + Clone> {
    pool: &'a QuotaPool<K>,
    key: K,
    key_sem: Arc<Semaphore>,
    _global: Option<OwnedSemaphorePermit>,
    _per_key: Option<OwnedSemaphorePermit>,
}

impl<K: Eq + Hash + Clone> Drop for QuotaPermit<'_, K> {
    fn drop(&mut self) {
        self._global.take();
        self._per_key.take();
        self.pool.reclaim_if_idle(&self.key, &self.key_sem);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn quota_pool_enforces_global_and_per_key_limits_and_reclaims() {
        let pool = QuotaPool::<String>::new(NonZeroUsize::new(3).unwrap(), NonZeroUsize::new(2).unwrap());
        let p1 = pool.try_acquire("k1".to_owned()).unwrap();
        let p2 = pool.try_acquire("k1".to_owned()).unwrap();
        assert!(pool.try_acquire("k1".to_owned()).is_none(), "per-key limit=2 enforced");

        let p3 = pool.try_acquire("k2".to_owned()).unwrap();
        assert!(pool.try_acquire("k3".to_owned()).is_none(), "global limit=3 enforced");
        assert_eq!(pool.active_keys(), 2);

        drop(p1);
        drop(p2);
        drop(p3);
        assert_eq!(pool.active_keys(), 0);
        assert_eq!(pool.available_global(), 3);
    }
}
