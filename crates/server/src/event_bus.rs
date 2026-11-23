//! Bounded asynchronous transition bus for [`Hub`](crate::Hub).
//!
//! Each subscriber runs as a lightweight Tokio task fed by a bounded
//! `tokio::sync::mpsc` channel (`CHANNEL_CAPACITY = 1024`) and executes its
//! synchronous handler via `tokio::task::spawn_blocking`, so [`Hub::apply`]
//! never runs subscriber logic synchronously and slow subscribers never block
//! other subscribers, async I/O workers, or state commits.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::thread::ThreadId;

use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::Transition;

use crate::Hub;

/// Bounded per-subscriber transition queue depth.
pub const CHANNEL_CAPACITY: usize = 1024;

struct Subscriber {
    id: u64,
    name: &'static str,
    tx: Mutex<Option<mpsc::Sender<Arc<Transition>>>>,
    cancel: CancellationToken,
    running_thread: Arc<Mutex<Option<ThreadId>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Subscriber {
    fn signal_stop(&self) {
        self.cancel.cancel();
        let _ = self.tx.lock().take();
    }

    fn join(&self) {
        if *self.running_thread.lock() == Some(std::thread::current().id()) {
            return;
        }
        if let Some(handle) = self.handle.lock().take() {
            let _ = vibevalley_runtime::rt::block_on(handle);
        }
    }

    fn close(&self) {
        self.signal_stop();
        self.join();
    }
}

struct BusState {
    closed: bool,
    subscribers: Vec<Arc<Subscriber>>,
}

/// Asynchronous fan-out bus publishing folded [`Transition`]s to subscribers.
pub struct EventBus {
    hub: OnceLock<Weak<Hub>>,
    cancel: CancellationToken,
    next_id: AtomicU64,
    state: Arc<Mutex<BusState>>,
}

/// Handle for an active [`EventBus`] subscription.
///
/// Calling [`Subscription::close`] or dropping the handle unsubscribes and
/// cooperatively stops and awaits the subscriber task.
pub struct Subscription {
    state: Weak<Mutex<BusState>>,
    sub: Option<Arc<Subscriber>>,
}

impl Subscription {
    fn closed() -> Self {
        Self { state: Weak::new(), sub: None }
    }

    /// Unsubscribes and cooperatively stops and awaits the subscriber task.
    pub fn close(&self) {
        let Some(sub) = &self.sub else { return };
        if let Some(state) = self.state.upgrade() {
            state.lock().subscribers.retain(|s| s.id != sub.id);
        }
        sub.close();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.close();
    }
}

impl EventBus {
    pub(crate) fn new(cancel: CancellationToken) -> Self {
        Self {
            hub: OnceLock::new(),
            cancel,
            next_id: AtomicU64::new(1),
            state: Arc::new(Mutex::new(BusState {
                closed: false,
                subscribers: Vec::new(),
            })),
        }
    }

    pub(crate) fn attach_hub(&self, hub: Weak<Hub>) {
        let _ = self.hub.set(hub);
    }

    /// Registers an asynchronous transition subscriber backed by a bounded
    /// `tokio::sync::mpsc` channel (`CHANNEL_CAPACITY`) and cooperative
    /// `CancellationToken`.
    pub fn subscribe(&self, name: &'static str, handler: impl Fn(&Arc<Hub>, &Transition) + Send + Sync + 'static) -> Subscription {
        if self.state.lock().closed {
            return Subscription::closed();
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = mpsc::channel::<Arc<Transition>>(CHANNEL_CAPACITY);
        let cancel = self.cancel.child_token();
        let worker_cancel = cancel.clone();
        let hub_weak = self.hub.get().cloned().unwrap_or_default();
        let running_thread: Arc<Mutex<Option<ThreadId>>> = Arc::new(Mutex::new(None));
        let worker_thread = running_thread.clone();
        let handler = Arc::new(handler);

        let handle = vibevalley_runtime::rt::handle().spawn(async move {
            loop {
                let tr = tokio::select! {
                    biased;
                    _ = worker_cancel.cancelled() => return,
                    item = rx.recv() => match item {
                        Some(tr) => tr,
                        None => return,
                    },
                };
                if worker_cancel.is_cancelled() {
                    return;
                }
                let Some(hub) = hub_weak.upgrade() else { return };
                let handler = handler.clone();
                let worker_thread = worker_thread.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    struct ThreadGuard(Arc<Mutex<Option<ThreadId>>>);
                    impl Drop for ThreadGuard {
                        fn drop(&mut self) {
                            *self.0.lock() = None;
                        }
                    }
                    *worker_thread.lock() = Some(std::thread::current().id());
                    let _guard = ThreadGuard(worker_thread);
                    handler(&hub, &tr);
                })
                .await;
            }
        });

        let sub = Arc::new(Subscriber {
            id,
            name,
            tx: Mutex::new(Some(tx)),
            cancel,
            running_thread,
            handle: Mutex::new(Some(handle)),
        });

        let accepted = {
            let mut st = self.state.lock();
            if st.closed {
                false
            } else {
                st.subscribers.push(sub.clone());
                true
            }
        };
        if !accepted {
            sub.close();
            return Subscription::closed();
        }

        Subscription {
            state: Arc::downgrade(&self.state),
            sub: Some(sub),
        }
    }

    /// Publishes folded transitions to all active subscribers without blocking.
    pub fn publish(&self, transitions: &[Transition]) {
        if transitions.is_empty() {
            return;
        }
        let targets: Vec<(&'static str, mpsc::Sender<Arc<Transition>>, u64)> = {
            let st = self.state.lock();
            if st.closed || st.subscribers.is_empty() {
                return;
            }
            st.subscribers.iter().filter_map(|s| s.tx.lock().clone().map(|tx| (s.name, tx, s.id))).collect()
        };
        if targets.is_empty() {
            return;
        }
        let items: Vec<Arc<Transition>> = transitions.iter().cloned().map(Arc::new).collect();
        let mut disconnected = Vec::new();
        for tr in &items {
            for (name, tx, id) in &targets {
                match tx.try_send(tr.clone()) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        eprintln!("vibevalley-server: event_bus: subscriber '{name}' queue full ({CHANNEL_CAPACITY}); dropping transition");
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        disconnected.push(*id);
                    }
                }
            }
        }
        if !disconnected.is_empty() {
            self.state.lock().subscribers.retain(|s| !disconnected.contains(&s.id));
        }
    }

    /// Cooperatively signals and awaits every registered subscriber task.
    pub fn close(&self) {
        self.cancel.cancel();
        let subs = {
            let mut st = self.state.lock();
            st.closed = true;
            std::mem::take(&mut st.subscribers)
        };
        for sub in &subs {
            sub.signal_stop();
        }
        for sub in &subs {
            sub.join();
        }
    }
}

impl Drop for EventBus {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use vibevalley_core::empty_space_state;
    use vibevalley_protocol::{CommitCount, Fact, FactProgressChanged};

    use super::*;

    fn commit_fact(total: i64) -> Fact {
        Fact::ProgressChanged(FactProgressChanged {
            at: total,
            progress: None,
            news: None,
            commits: Some(CommitCount { total, repos: vec![] }),
            station: None,
        })
    }

    #[test]
    fn subscribers_run_off_thread_never_block_apply_and_can_reapply() {
        let hub = Hub::new(empty_space_state());
        let caller_tid = std::thread::current().id();
        let (block_tx, block_rx) = flume::bounded::<()>(1);
        let (entered_tx, entered_rx) = flume::bounded::<()>(1);
        let (fast_tx, fast_rx) = flume::bounded::<(std::thread::ThreadId, Option<String>, i64)>(8);

        let _slow = hub.subscribe_transitions("slow", move |_, _| {
            let _ = entered_tx.try_send(());
            let _ = block_rx.recv_timeout(Duration::from_secs(5));
        });
        let _fast = hub.subscribe_transitions("fast", move |hub, tr| {
            if let Fact::ProgressChanged(f) = &tr.fact
                && let Some(c) = &f.commits
            {
                let tid = std::thread::current().id();
                let name = std::thread::current().name().map(str::to_string);
                // Re-applying from the bus worker must never deadlock.
                if c.total == 1 {
                    hub.apply(vec![commit_fact(2)]);
                }
                if c.total <= 2 {
                    let _ = fast_tx.try_send((tid, name, c.total));
                }
            }
        });

        hub.apply(vec![commit_fact(1)]);
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("slow subscriber entered");

        // While slow is blocked, fast still receives both the initial and re-applied facts.
        let first = fast_rx.recv_timeout(Duration::from_secs(2)).expect("first fast event");
        let second = fast_rx.recv_timeout(Duration::from_secs(2)).expect("re-applied fast event");
        assert_ne!(first.0, caller_tid);
        assert!(
            first.1.as_deref().is_some_and(|n| n.starts_with("vibevalley-io-")),
            "expected shared vibevalley-io worker, got {:?}",
            first.1
        );
        assert_eq!((first.2, second.2), (1, 2));

        // Even exceeding CHANNEL_CAPACITY against a blocked subscriber never stalls Hub::apply.
        for i in 3..=(CHANNEL_CAPACITY as i64 + 16) {
            hub.apply(vec![commit_fact(i)]);
        }

        drop(block_tx);
        hub.close_bus();
    }

    #[test]
    fn drop_and_close_bus_stop_workers_and_guard_self_join() {
        let hub = Hub::new(empty_space_state());
        let seen = Arc::new(AtomicUsize::new(0));
        let (hit_tx, hit_rx) = flume::bounded::<()>(4);

        let sub = {
            let seen = seen.clone();
            let hit_tx = hit_tx.clone();
            hub.subscribe_transitions("droppable", move |_, _| {
                seen.fetch_add(1, Ordering::SeqCst);
                let _ = hit_tx.send(());
            })
        };

        hub.apply(vec![commit_fact(1)]);
        hit_rx.recv_timeout(Duration::from_secs(2)).expect("received before drop");
        drop(sub);

        let before = seen.load(Ordering::SeqCst);
        hub.apply(vec![commit_fact(2)]);
        assert!(hit_rx.recv_timeout(Duration::from_millis(80)).is_err());
        assert_eq!(seen.load(Ordering::SeqCst), before);

        // Calling close_bus from inside a subscriber thread must not deadlock or panic.
        let (done_tx, done_rx) = flume::bounded::<()>(1);
        let _self_closer = hub.subscribe_transitions("self-closer", move |hub, _| {
            hub.close_bus();
            let _ = done_tx.send(());
        });
        hub.apply(vec![commit_fact(3)]);
        done_rx.recv_timeout(Duration::from_secs(2)).expect("self-closer completed");
        hub.close_bus();
    }
}
