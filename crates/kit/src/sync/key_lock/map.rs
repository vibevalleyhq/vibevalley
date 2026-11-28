use std::collections::HashMap;
use std::fmt;
use std::hash::Hash;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Leak-free per-key async mutual exclusion table.
///
/// Stores `Weak<tokio::sync::Mutex<()>>` per active key and atomically removes
/// the map entry under the table lock when the final strong holder or waiter
/// drops — preventing unbounded lock-table growth and eliminating check-then-remove
/// races even when awaiting callers are cancelled.
pub struct KeyLock<K> {
    slots: Mutex<HashMap<K, Weak<AsyncMutex<()>>>>,
}

impl<K> Default for KeyLock<K> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K> fmt::Debug for KeyLock<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyLock").field("active_keys", &self.slots.lock().len()).finish()
    }
}

impl<K> KeyLock<K> {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Number of keys currently tracked in the lock table (active holders or waiters).
    pub fn len(&self) -> usize {
        self.slots.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<K> KeyLock<K>
where
    K: Eq + Hash + Clone,
{
    /// Acquires exclusive async ownership for `key`, automatically reclaiming
    /// the map slot once all holders and waiters for `key` have dropped.
    pub async fn lock(&self, key: K) -> KeyLockGuard<'_, K> {
        let mutex = {
            let mut slots = self.slots.lock();
            if let Some(existing) = slots.get(&key).and_then(Weak::upgrade) {
                existing
            } else {
                let fresh = Arc::new(AsyncMutex::new(()));
                slots.insert(key.clone(), Arc::downgrade(&fresh));
                fresh
            }
        };

        // Ensures cancelled `lock()` futures still reclaim idle slots if they hold the final `Arc`.
        let mut cancel_guard = PendingReclaim {
            table: self,
            key: Some(key),
            mutex: Some(Arc::clone(&mutex)),
        };

        let owned = mutex.lock_owned().await;
        let key = cancel_guard.key.take().expect("key present before disarm");
        let mutex = cancel_guard.mutex.take().expect("mutex present before disarm");

        KeyLockGuard {
            table: self,
            key,
            mutex,
            _guard: Some(owned),
        }
    }

    /// Reclaims `key` atomically if `mutex` is the sole remaining strong reference
    /// and the bucket still points to the same allocation.
    fn reclaim_if_idle(&self, key: &K, mutex: &Arc<AsyncMutex<()>>) {
        let mut slots = self.slots.lock();
        if Arc::strong_count(mutex) == 1 && slots.get(key).is_some_and(|weak| std::ptr::eq(weak.as_ptr(), Arc::as_ptr(mutex))) {
            slots.remove(key);
        }
    }
}

struct PendingReclaim<'a, K: Eq + Hash + Clone> {
    table: &'a KeyLock<K>,
    key: Option<K>,
    mutex: Option<Arc<AsyncMutex<()>>>,
}

impl<K: Eq + Hash + Clone> Drop for PendingReclaim<'_, K> {
    fn drop(&mut self) {
        if let (Some(key), Some(mutex)) = (self.key.take(), self.mutex.take()) {
            self.table.reclaim_if_idle(&key, &mutex);
        }
    }
}

/// RAII guard for a [`KeyLock`] entry; dropping releases the lock and atomically
/// removes the key from the table when no other waiters remain.
pub struct KeyLockGuard<'a, K: Eq + Hash + Clone> {
    table: &'a KeyLock<K>,
    key: K,
    mutex: Arc<AsyncMutex<()>>,
    _guard: Option<OwnedMutexGuard<()>>,
}

impl<K: Eq + Hash + Clone> Drop for KeyLockGuard<'_, K> {
    fn drop(&mut self) {
        // Release the async mutex before reclaiming the table slot so any woken waiter
        // holding a strong `Arc` sees `strong_count >= 2` and keeps the slot alive.
        self._guard.take();
        self.table.reclaim_if_idle(&self.key, &self.mutex);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Notify;

    use super::KeyLock;

    #[tokio::test]
    async fn serializes_same_key_and_reclaims_idle_entries() {
        let lock = Arc::new(KeyLock::<String>::new());
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let lock = Arc::clone(&lock);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            handles.push(tokio::spawn(async move {
                let _guard = lock.lock("doc-1".to_owned()).await;
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now, Ordering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        assert!(lock.is_empty(), "idle key must be reclaimed after final guard drops");
    }

    #[tokio::test]
    async fn different_keys_proceed_concurrently_and_cancelled_waiter_reclaims() {
        let lock = Arc::new(KeyLock::<String>::new());
        let g1 = lock.lock("a".to_owned()).await;
        let g2 = lock.lock("b".to_owned()).await;
        assert_eq!(lock.len(), 2);

        let started = Arc::new(Notify::new());
        let waiter = {
            let lock = Arc::clone(&lock);
            let started = Arc::clone(&started);
            tokio::spawn(async move {
                started.notify_one();
                let _g = lock.lock("a".to_owned()).await;
            })
        };
        started.notified().await;
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;

        drop(g1);
        drop(g2);
        assert_eq!(lock.len(), 0);
    }
}
