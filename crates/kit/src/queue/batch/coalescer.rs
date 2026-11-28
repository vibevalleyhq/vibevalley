use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::task::TaskGroup;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchConfig {
    /// Maximum distinct pending keys held concurrently before forcing an eager flush.
    pub max_keys: NonZeroUsize,
    /// Maximum accumulated items per key before triggering an immediate flush.
    pub max_batch_items: NonZeroUsize,
    /// Coalescing window before flushing accumulated items.
    pub flush_interval: Duration,
}

/// Micro-batch coalescer merging items per key and flushing automatically on size cap,
/// time window, explicit `flush()`, or `TaskGroup` shutdown cancellation.
pub struct BatchCoalescer<K, T> {
    config: BatchConfig,
    buckets: Arc<Mutex<HashMap<K, Vec<T>>>>,
    wake: Arc<Notify>,
}

impl<K, T> Clone for BatchCoalescer<K, T> {
    fn clone(&self) -> Self {
        Self {
            config: self.config,
            buckets: Arc::clone(&self.buckets),
            wake: Arc::clone(&self.wake),
        }
    }
}

impl<K, T> BatchCoalescer<K, T>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    T: Send + 'static,
{
    /// Starts a background flusher task owned by `tasks` that drains all remaining
    /// buckets automatically when `tasks` cancels.
    pub fn start<F, Fut>(tasks: &TaskGroup, config: BatchConfig, flush: F) -> Self
    where
        F: Fn(K, Vec<T>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let buckets = Arc::new(Mutex::new(HashMap::<K, Vec<T>>::new()));
        let wake = Arc::new(Notify::new());
        let coalescer = Self {
            config,
            buckets: Arc::clone(&buckets),
            wake: Arc::clone(&wake),
        };

        let cancel = tasks.token();
        let interval = config.flush_interval.max(Duration::from_millis(1));
        let max_items = config.max_batch_items.get();
        let max_keys = config.max_keys.get();
        tasks.spawn_named("kit.batch_coalescer", async move {
            loop {
                let has_pending = !buckets.lock().is_empty();
                let shutting_down = if !has_pending {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => true,
                        _ = wake.notified() => false,
                    }
                } else {
                    let eager = {
                        let guard = buckets.lock();
                        guard.len() >= max_keys || guard.values().any(|items| items.len() >= max_items)
                    };
                    if eager {
                        false
                    } else {
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => true,
                            _ = tokio::time::sleep(interval) => false,
                            _ = wake.notified() => false,
                        }
                    }
                };

                let drained: Vec<(K, Vec<T>)> = {
                    let mut guard = buckets.lock();
                    if shutting_down {
                        guard.drain().collect()
                    } else {
                        let ready_keys: Vec<K> = guard.keys().cloned().collect();
                        ready_keys.into_iter().filter_map(|k| guard.remove(&k).map(|v| (k, v))).collect()
                    }
                };

                for (key, items) in drained {
                    if !items.is_empty() {
                        flush(key, items).await;
                    }
                }
                if shutting_down {
                    return;
                }
            }
        });

        coalescer
    }

    /// Appends `item` into `key`'s pending batch and wakes the flusher when ready.
    pub fn push(&self, key: K, item: T) {
        let should_wake = {
            let mut guard = self.buckets.lock();
            let was_empty = guard.is_empty();
            let entry = guard.entry(key).or_default();
            entry.push(item);
            was_empty || entry.len() >= self.config.max_batch_items.get() || guard.len() >= self.config.max_keys.get()
        };
        if should_wake {
            self.wake.notify_one();
        }
    }

    pub fn pending_keys(&self) -> usize {
        self.buckets.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::*;

    #[tokio::test]
    async fn batch_coalescer_flushes_pending_items_on_shutdown() {
        let tasks = TaskGroup::new();
        type FlushedLog = Arc<Mutex<Vec<(String, Vec<usize>)>>>;
        let flushed: FlushedLog = Arc::new(Mutex::new(Vec::new()));
        let flushed_c = Arc::clone(&flushed);

        let coalescer = BatchCoalescer::start(
            &tasks,
            BatchConfig {
                max_keys: NonZeroUsize::new(16).unwrap(),
                max_batch_items: NonZeroUsize::new(100).unwrap(),
                flush_interval: Duration::from_secs(60),
            },
            move |k: String, items: Vec<usize>| {
                let flushed = Arc::clone(&flushed_c);
                async move {
                    flushed.lock().push((k, items));
                }
            },
        );

        coalescer.push("doc-1".to_owned(), 1);
        coalescer.push("doc-1".to_owned(), 2);
        coalescer.push("doc-1".to_owned(), 3);
        tokio::task::yield_now().await;

        assert!(tasks.shutdown(Duration::from_secs(2)).await);
        assert_eq!(coalescer.pending_keys(), 0);
        let merged: Vec<usize> = flushed.lock().iter().flat_map(|(_, v)| v.iter().copied()).collect();
        assert_eq!(merged, vec![1, 2, 3]);
    }
}
