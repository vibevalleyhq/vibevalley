use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;

use parking_lot::Mutex;
use tokio::sync::watch;

type FlightSlot<V, E> = watch::Receiver<Option<Result<V, E>>>;

/// Coalesces concurrent async executions sharing the same key `K` so only one
/// leader runs at a time while followers await and clone the leader's result.
///
/// If the leader future is dropped/cancelled before finishing, the slot is
/// removed immediately and waiting followers automatically retry.
pub struct FlightGroup<K, V, E> {
    in_flight: Mutex<HashMap<K, FlightSlot<V, E>>>,
}

impl<K, V, E> Default for FlightGroup<K, V, E> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K, V, E> FlightGroup<K, V, E> {
    pub fn new() -> Self {
        Self {
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.lock().len()
    }
}

struct LeaderCleanup<'a, K: Eq + Hash, V, E> {
    group: &'a FlightGroup<K, V, E>,
    key: Option<K>,
}

impl<K: Eq + Hash, V, E> Drop for LeaderCleanup<'_, K, V, E> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.group.in_flight.lock().remove(&key);
        }
    }
}

impl<K, V, E> FlightGroup<K, V, E>
where
    K: Eq + Hash + Clone,
    V: Clone,
    E: Clone,
{
    /// Executes `work` as the leader for `key`, or waits for an already in-flight
    /// leader on `key` and returns its cloned outcome.
    pub async fn run<F, Fut>(&self, key: K, mut work: F) -> Result<V, E>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        loop {
            let maybe_rx = {
                let mut map = self.in_flight.lock();
                if let Some(rx) = map.get(&key) {
                    Err(rx.clone())
                } else {
                    let (tx, rx) = watch::channel(None);
                    map.insert(key.clone(), rx);
                    Ok(tx)
                }
            };

            match maybe_rx {
                Ok(tx) => {
                    let mut cleanup = LeaderCleanup {
                        group: self,
                        key: Some(key.clone()),
                    };
                    let outcome = work().await;
                    // Remove before broadcasting so subsequent callers start a fresh flight.
                    if let Some(k) = cleanup.key.take() {
                        self.in_flight.lock().remove(&k);
                    }
                    let _ = tx.send(Some(outcome.clone()));
                    return outcome;
                }
                Err(mut rx) => {
                    if let Some(outcome) = rx.borrow().clone() {
                        return outcome;
                    }
                    if rx.changed().await.is_ok()
                        && let Some(outcome) = rx.borrow().clone()
                    {
                        return outcome;
                    }
                    // Leader dropped/cancelled without publishing a result; retry to elect a new leader.
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Notify;

    use super::FlightGroup;

    #[tokio::test]
    async fn coalesces_concurrent_callers_for_same_key() {
        let group = Arc::new(FlightGroup::<String, usize, String>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let entered = Arc::new(Notify::new());

        let g1 = Arc::clone(&group);
        let c1 = Arc::clone(&calls);
        let r1 = Arc::clone(&release);
        let e1 = Arc::clone(&entered);
        let t1 = tokio::spawn(async move {
            g1.run("k".to_owned(), || {
                let c = Arc::clone(&c1);
                let r = Arc::clone(&r1);
                let e = Arc::clone(&e1);
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    e.notify_one();
                    r.notified().await;
                    Ok(42)
                }
            })
            .await
        });

        entered.notified().await;

        let g2 = Arc::clone(&group);
        let c2 = Arc::clone(&calls);
        let t2 = tokio::spawn(async move {
            g2.run("k".to_owned(), || {
                let c = Arc::clone(&c2);
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok(99)
                }
            })
            .await
        });

        tokio::task::yield_now().await;
        release.notify_waiters();

        assert_eq!(t1.await.unwrap(), Ok(42));
        assert_eq!(t2.await.unwrap(), Ok(42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(group.in_flight_count(), 0);
    }

    #[tokio::test]
    async fn cancelled_leader_allows_follower_to_take_over() {
        let group = Arc::new(FlightGroup::<String, usize, String>::new());
        let entered = Arc::new(Notify::new());

        let g1 = Arc::clone(&group);
        let e1 = Arc::clone(&entered);
        let leader = tokio::spawn(async move {
            g1.run("k".to_owned(), || {
                let e = Arc::clone(&e1);
                async move {
                    e.notify_one();
                    std::future::pending::<Result<usize, String>>().await
                }
            })
            .await
        });

        entered.notified().await;

        let g2 = Arc::clone(&group);
        let follower = tokio::spawn(async move { g2.run("k".to_owned(), || async { Ok(7) }).await });
        tokio::task::yield_now().await;

        leader.abort();
        let _ = leader.await;

        assert_eq!(follower.await.unwrap(), Ok(7));
        assert_eq!(group.in_flight_count(), 0);
    }
}
