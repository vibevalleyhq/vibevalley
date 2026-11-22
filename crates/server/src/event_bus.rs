//! Bounded asynchronous transition bus for [`Hub`](crate::Hub).
//!
//! Each subscriber runs on its own worker thread (`vibevalley-bus-{name}`) fed
//! by a bounded channel (`CHANNEL_CAPACITY = 1024`), so [`Hub::apply`] never
//! runs subscriber logic synchronously and slow subscribers never block other
//! subscribers or state commits.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread::JoinHandle;

use vibevalley_core::Transition;

use crate::{Hub, lock};

/// Bounded per-subscriber transition queue depth.
pub const CHANNEL_CAPACITY: usize = 1024;

struct Subscriber {
    id: u64,
    name: &'static str,
    tx: Mutex<Option<flume::Sender<Arc<Transition>>>>,
    stop_flag: Arc<AtomicBool>,
    stop_tx: Mutex<Option<flume::Sender<()>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Subscriber {
    fn signal_stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
        let _ = lock(&self.tx).take();
        let _ = lock(&self.stop_tx).take();
    }

    fn join(&self) {
        if let Some(handle) = lock(&self.handle).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
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
    next_id: AtomicU64,
    state: Arc<Mutex<BusState>>,
}

/// Handle for an active [`EventBus`] subscription.
///
/// Calling [`Subscription::close`] or dropping the handle unsubscribes and
/// cooperatively stops and joins the subscriber's worker thread.
pub struct Subscription {
    state: Weak<Mutex<BusState>>,
    sub: Option<Arc<Subscriber>>,
}

impl Subscription {
    fn closed() -> Self {
        Self { state: Weak::new(), sub: None }
    }

    /// Unsubscribes and cooperatively stops and joins the worker thread.
    pub fn close(&self) {
        let Some(sub) = &self.sub else { return };
        if let Some(state) = self.state.upgrade() {
            lock(&state).subscribers.retain(|s| s.id != sub.id);
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
    pub(crate) fn new() -> Self {
        Self {
            hub: OnceLock::new(),
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
    /// channel (`CHANNEL_CAPACITY`) and worker thread `vibevalley-bus-{name}`.
    pub fn subscribe(&self, name: &'static str, handler: impl Fn(&Arc<Hub>, &Transition) + Send + Sync + 'static) -> Subscription {
        if lock(&self.state).closed {
            return Subscription::closed();
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = flume::bounded::<Arc<Transition>>(CHANNEL_CAPACITY);
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = stop_flag.clone();
        let hub_weak = self.hub.get().cloned().unwrap_or_default();

        let spawned = std::thread::Builder::new().name(format!("vibevalley-bus-{name}")).spawn(move || {
            loop {
                if worker_stop.load(Ordering::Acquire) {
                    return;
                }
                let next = flume::Selector::new().recv(&rx, |r| r.ok()).recv(&stop_rx, |_| None).wait();
                if worker_stop.load(Ordering::Acquire) {
                    return;
                }
                let Some(tr) = next else { return };
                let Some(hub) = hub_weak.upgrade() else { return };
                handler(&hub, &tr);
            }
        });
        let handle = match spawned {
            Ok(handle) => handle,
            Err(e) => {
                eprintln!("vibevalley-server: event_bus: failed to spawn subscriber '{name}': {e}");
                return Subscription::closed();
            }
        };

        let sub = Arc::new(Subscriber {
            id,
            name,
            tx: Mutex::new(Some(tx)),
            stop_flag,
            stop_tx: Mutex::new(Some(stop_tx)),
            handle: Mutex::new(Some(handle)),
        });

        let accepted = {
            let mut st = lock(&self.state);
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
        let targets: Vec<(&'static str, flume::Sender<Arc<Transition>>, u64)> = {
            let st = lock(&self.state);
            if st.closed || st.subscribers.is_empty() {
                return;
            }
            st.subscribers.iter().filter_map(|s| lock(&s.tx).clone().map(|tx| (s.name, tx, s.id))).collect()
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
                    Err(flume::TrySendError::Full(_)) => {
                        eprintln!("vibevalley-server: event_bus: subscriber '{name}' queue full ({CHANNEL_CAPACITY}); dropping transition");
                    }
                    Err(flume::TrySendError::Disconnected(_)) => {
                        disconnected.push(*id);
                    }
                }
            }
        }
        if !disconnected.is_empty() {
            lock(&self.state).subscribers.retain(|s| !disconnected.contains(&s.id));
        }
    }

    /// Cooperatively signals and joins every registered subscriber thread.
    pub fn close(&self) {
        let subs = {
            let mut st = lock(&self.state);
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
        assert_eq!(first.1.as_deref(), Some("vibevalley-bus-fast"));
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

        // Calling close_bus from inside a subscriber thread must not panic with self-join.
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
