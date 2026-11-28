use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::hash::Hash;
use std::num::NonZeroUsize;
use std::sync::Arc;

use parking_lot::Mutex;
use thiserror::Error;
use tokio::sync::Notify;

use crate::task::TaskGroup;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneConfig {
    /// Maximum queued items per key before backpressure applies.
    pub capacity: NonZeroUsize,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LaneError {
    #[error("keyed lane is closed")]
    Closed,
    #[error("keyed lane for key is full")]
    Full,
}

struct LaneBucket<M> {
    queue: VecDeque<M>,
    space_notify: Arc<Notify>,
    item_notify: Arc<Notify>,
}

struct LaneState<K, M> {
    closed: bool,
    buckets: HashMap<K, LaneBucket<M>>,
}

/// Per-key FIFO ordered async dispatcher with bounded per-key backpressure
/// and race-free atomic idle reclaim.
///
/// Each active key runs at most one worker task on the provided [`TaskGroup`].
/// When a worker drains its key's queue, it checks emptiness and removes the
/// bucket under the same table lock so concurrent `send`/`try_send` calls never
/// enqueue into an exiting lane.
pub struct KeyedLane<K, M, H> {
    config: LaneConfig,
    tasks: TaskGroup,
    handler: Arc<H>,
    state: Arc<Mutex<LaneState<K, M>>>,
}

impl<K, M, H> Clone for KeyedLane<K, M, H> {
    fn clone(&self) -> Self {
        Self {
            config: self.config,
            tasks: self.tasks.clone(),
            handler: Arc::clone(&self.handler),
            state: Arc::clone(&self.state),
        }
    }
}

impl<K, M, H, Fut> KeyedLane<K, M, H>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    M: Send + 'static,
    H: Fn(K, M) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    pub fn new(tasks: TaskGroup, config: LaneConfig, handler: H) -> Self {
        Self {
            config,
            tasks,
            handler: Arc::new(handler),
            state: Arc::new(Mutex::new(LaneState {
                closed: false,
                buckets: HashMap::new(),
            })),
        }
    }

    pub fn active_lanes(&self) -> usize {
        self.state.lock().buckets.len()
    }

    /// Attempts to enqueue `msg` onto `key`'s FIFO lane without waiting.
    pub fn try_send(&self, key: K, msg: M) -> Result<(), LaneError> {
        let spawn_worker = {
            let mut st = self.state.lock();
            if st.closed || self.tasks.is_cancelled() {
                return Err(LaneError::Closed);
            }
            if let Some(bucket) = st.buckets.get_mut(&key) {
                if bucket.queue.len() >= self.config.capacity.get() {
                    return Err(LaneError::Full);
                }
                bucket.queue.push_back(msg);
                bucket.item_notify.notify_one();
                false
            } else {
                let mut queue = VecDeque::with_capacity(self.config.capacity.get().min(32));
                queue.push_back(msg);
                st.buckets.insert(
                    key.clone(),
                    LaneBucket {
                        queue,
                        space_notify: Arc::new(Notify::new()),
                        item_notify: Arc::new(Notify::new()),
                    },
                );
                true
            }
        };

        if spawn_worker {
            self.spawn_key_worker(key);
        }
        Ok(())
    }

    /// Enqueues `msg` onto `key`'s FIFO lane, waiting for capacity if the key's queue is full.
    pub async fn send(&self, key: K, msg: M) -> Result<(), LaneError> {
        let mut pending = Some(msg);
        loop {
            let wait_space = {
                let mut st = self.state.lock();
                if st.closed || self.tasks.is_cancelled() {
                    return Err(LaneError::Closed);
                }
                if let Some(bucket) = st.buckets.get_mut(&key) {
                    if bucket.queue.len() < self.config.capacity.get() {
                        bucket.queue.push_back(pending.take().expect("pending message"));
                        bucket.item_notify.notify_one();
                        return Ok(());
                    }
                    Arc::clone(&bucket.space_notify)
                } else {
                    let mut queue = VecDeque::with_capacity(self.config.capacity.get().min(32));
                    queue.push_back(pending.take().expect("pending message"));
                    st.buckets.insert(
                        key.clone(),
                        LaneBucket {
                            queue,
                            space_notify: Arc::new(Notify::new()),
                            item_notify: Arc::new(Notify::new()),
                        },
                    );
                    drop(st);
                    self.spawn_key_worker(key);
                    return Ok(());
                }
            };

            let notified = wait_space.notified();
            let cancel = self.tasks.token();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(LaneError::Closed),
                _ = notified => {}
            }
        }
    }

    /// Marks the lane closed so no new items are accepted; existing queued items drain on active workers.
    pub fn close(&self) {
        let mut st = self.state.lock();
        st.closed = true;
        for bucket in st.buckets.values() {
            bucket.space_notify.notify_waiters();
            bucket.item_notify.notify_waiters();
        }
    }

    fn spawn_key_worker(&self, key: K) {
        let state = Arc::clone(&self.state);
        let handler = Arc::clone(&self.handler);
        self.tasks.spawn_named("kit.keyed_lane", async move {
            loop {
                let next_item = {
                    let mut st = state.lock();
                    match st.buckets.get_mut(&key) {
                        Some(bucket) => {
                            if let Some(item) = bucket.queue.pop_front() {
                                bucket.space_notify.notify_one();
                                Some(item)
                            } else {
                                // Atomic empty-check + removal under table lock: zero race with `send`/`try_send`.
                                st.buckets.remove(&key);
                                None
                            }
                        }
                        None => None,
                    }
                };
                match next_item {
                    Some(msg) => {
                        handler(key.clone(), msg).await;
                    }
                    None => return,
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;

    use super::*;

    #[tokio::test]
    async fn keyed_lane_preserves_fifo_order_and_reclaims_idle_buckets() {
        let tasks = TaskGroup::new();
        let seen: Arc<Mutex<Vec<(String, usize)>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_c = Arc::clone(&seen);
        let lane = KeyedLane::new(
            tasks.clone(),
            LaneConfig {
                capacity: NonZeroUsize::new(4).unwrap(),
            },
            move |k: String, v: usize| {
                let seen = Arc::clone(&seen_c);
                async move {
                    tokio::task::yield_now().await;
                    seen.lock().push((k, v));
                }
            },
        );

        for i in 0..8 {
            lane.send("a".to_owned(), i).await.unwrap();
        }
        lane.close();
        assert!(tasks.shutdown(Duration::from_secs(2)).await);
        assert_eq!(lane.active_lanes(), 0);
        let a_items: Vec<usize> = seen.lock().iter().filter(|(k, _)| k == "a").map(|(_, v)| *v).collect();
        assert_eq!(a_items, (0..8).collect::<Vec<_>>());
    }
}
