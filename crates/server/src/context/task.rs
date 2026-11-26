//! Cooperative background task group (`TaskGroup`), periodic [`Ticker`], host wake
//! watch channel, and bounded graceful shutdown.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;

struct TaskGroupInner {
    token: CancellationToken,
    tasks: TaskTracker,
    wake: watch::Sender<u64>,
}

impl Drop for TaskGroupInner {
    fn drop(&mut self) {
        self.token.cancel();
    }
}

/// Shared handle managing cooperative cancellation, tracked async/blocking tasks,
/// periodic tickers, and host wake signals.
#[derive(Clone)]
pub struct TaskGroup {
    inner: Arc<TaskGroupInner>,
}

impl TaskGroup {
    /// Creates a fresh [`TaskGroup`] with a root [`CancellationToken`], empty [`TaskTracker`],
    /// and wake sequence initialized to `0`.
    pub fn new() -> Self {
        let (wake, _) = watch::channel(0u64);
        Self {
            inner: Arc::new(TaskGroupInner {
                token: CancellationToken::new(),
                tasks: TaskTracker::new(),
                wake,
            }),
        }
    }

    /// Root cancellation token for this group.
    pub(super) fn token(&self) -> CancellationToken {
        self.inner.token.clone()
    }

    /// Child cancellation token linked to the root token.
    pub fn child_token(&self) -> CancellationToken {
        self.inner.token.child_token()
    }

    /// Whether shutdown cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.inner.token.is_cancelled()
    }

    /// Subscribes to host system wake notifications carrying the monotonic wake sequence.
    pub fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.inner.wake.subscribe()
    }

    /// Advances the monotonic system wake counter and notifies all subscribers.
    pub fn notify_wake(&self) -> u64 {
        let mut next = 0u64;
        self.inner.wake.send_modify(|count| {
            *count += 1;
            next = *count;
        });
        tracing::info!(wake_seq = next, "task.system_wake");
        next
    }

    /// Current monotonic count of host system wake events observed by this group.
    pub fn wake_count(&self) -> u64 {
        *self.inner.wake.borrow()
    }

    /// Number of currently tracked active tasks.
    #[cfg(test)]
    fn task_count(&self) -> usize {
        self.inner.tasks.len()
    }

    /// Spawns a tracked async task on the current Tokio runtime (or global fallback),
    /// preserving the active tracing span and subscriber.
    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        self.inner.tasks.spawn_on(future.in_current_span().with_current_subscriber(), &handle)
    }

    /// Spawns a tracked async task annotated with a `task` tracing span named `name`.
    pub fn spawn_named<F>(&self, name: &'static str, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        let span = tracing::debug_span!("task", name);
        self.inner.tasks.spawn_on(future.instrument(span).with_current_subscriber(), &handle)
    }

    /// Spawns a tracked blocking closure on the current Tokio runtime (or global fallback),
    /// preserving the active tracing span and subscriber.
    pub fn spawn_blocking<F, R>(&self, func: F) -> JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        let dispatch = tracing::dispatcher::get_default(|d| d.clone());
        let span = tracing::Span::current();
        self.inner
            .tasks
            .spawn_blocking_on(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(func)), &handle)
    }

    /// Spawns a cancelable periodic ticker waiting `interval` before the first tick.
    /// The ticker stops when the group cancels, `Ticker::stop` is called, or `tick` returns `false`.
    pub(super) fn every<F, Fut>(&self, name: &'static str, interval: Duration, tick: F) -> Ticker
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        self.spawn_ticker(name, interval, false, tick)
    }

    /// Spawns a cancelable periodic ticker that fires immediately on startup and then every `interval`.
    pub fn every_immediate<F, Fut>(&self, name: &'static str, interval: Duration, tick: F) -> Ticker
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        self.spawn_ticker(name, interval, true, tick)
    }

    fn spawn_ticker<F, Fut>(&self, name: &'static str, interval: Duration, immediate: bool, tick: F) -> Ticker
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        let cancel = self.child_token();
        let handle = self.spawn_named(name, run_async_ticker(cancel.clone(), interval, immediate, tick));
        Ticker { cancel, handle }
    }

    /// Cancels the root token, closes the task tracker, and awaits up to `grace` for all tracked
    /// tasks to finish. Returns `true` if all tasks drained within `grace`.
    pub(super) async fn shutdown(&self, grace: Duration) -> bool {
        self.inner.token.cancel();
        self.inner.tasks.close();
        if tokio::time::timeout(grace, self.inner.tasks.wait()).await.is_ok() {
            true
        } else {
            tracing::warn!(
                remaining = self.inner.tasks.len(),
                timeout_ms = grace.as_millis() as u64,
                "task.shutdown timed out waiting for tracked tasks"
            );
            false
        }
    }
}

impl Default for TaskGroup {
    fn default() -> Self {
        Self::new()
    }
}

/// Handle to a periodic ticker task spawned via [`TaskGroup::every`] or [`TaskGroup::every_immediate`].
pub struct Ticker {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}

impl Ticker {
    /// Signals the ticker to stop without waiting for its in-flight tick.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Cancels the ticker and awaits its completion.
    pub async fn stop(self) {
        self.cancel.cancel();
        let _ = self.handle.await;
    }
}

async fn run_async_ticker<F, Fut>(cancel: CancellationToken, interval: Duration, immediate: bool, mut tick: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = bool> + Send + 'static,
{
    let period = if interval.is_zero() { Duration::from_millis(1) } else { interval };
    let mut timer = if immediate {
        tokio::time::interval(period)
    } else {
        tokio::time::interval_at(tokio::time::Instant::now() + period, period)
    };
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = timer.tick() => {}
        }
        if cancel.is_cancelled() || !tick().await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::TaskGroup;

    #[tokio::test]
    async fn spawn_and_spawn_blocking_track_tasks_and_drain_cleanly_on_shutdown() {
        let group = TaskGroup::new();
        let token = group.token();
        let child = group.child_token();
        let blocking_ran = Arc::new(AtomicBool::new(false));
        let async_stopped = Arc::new(AtomicBool::new(false));

        let b_flag = blocking_ran.clone();
        let blocking_handle = group.spawn_blocking(move || {
            b_flag.store(true, Ordering::Release);
            42usize
        });
        assert_eq!(blocking_handle.await.unwrap(), 42);
        assert!(blocking_ran.load(Ordering::Acquire));

        let started = Arc::new(Notify::new());
        let started_tx = started.clone();
        let stopped_flag = async_stopped.clone();
        group.spawn_named("waiter", async move {
            started_tx.notify_one();
            token.cancelled().await;
            stopped_flag.store(true, Ordering::Release);
        });

        started.notified().await;
        assert_eq!(group.task_count(), 1);
        assert!(!group.is_cancelled());
        assert!(!child.is_cancelled());

        let drained = group.shutdown(Duration::from_secs(1)).await;
        assert!(drained);
        assert!(group.is_cancelled());
        assert!(child.is_cancelled());
        assert!(async_stopped.load(Ordering::Acquire));
        assert_eq!(group.task_count(), 0);
    }

    #[tokio::test]
    async fn wake_watch_notifies_subscribers_monotonically() {
        let group = TaskGroup::new();
        assert_eq!(group.wake_count(), 0);

        let mut sub = group.subscribe_wake();
        assert_eq!(*sub.borrow_and_update(), 0);

        assert_eq!(group.notify_wake(), 1);
        sub.changed().await.unwrap();
        assert_eq!(*sub.borrow_and_update(), 1);

        assert_eq!(group.notify_wake(), 2);
        assert_eq!(group.notify_wake(), 3);
        sub.changed().await.unwrap();
        assert_eq!(*sub.borrow_and_update(), 3);
        assert_eq!(group.wake_count(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_returns_false_when_task_exceeds_grace_period() {
        let group = TaskGroup::new();
        let gate = Arc::new(Notify::new());
        let gate_rx = gate.clone();

        group.spawn(async move {
            gate_rx.notified().await;
        });
        tokio::task::yield_now().await;

        let shutdown_fut = group.shutdown(Duration::from_millis(100));
        tokio::pin!(shutdown_fut);
        tokio::select! {
            _ = &mut shutdown_fut => panic!("shutdown must not finish before grace period"),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        tokio::time::advance(Duration::from_millis(60)).await;
        assert!(!shutdown_fut.await);
        gate.notify_one();
    }

    #[tokio::test]
    async fn every_runs_on_interval_and_stops_cleanly() {
        let group = TaskGroup::new();
        let count = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let done_tx = Arc::new(parking_lot::Mutex::new(Some(done_tx)));
        let count_c = count.clone();
        let ticker = group.every_immediate("test.tick", Duration::from_millis(10), move || {
            let count = count_c.clone();
            let done_tx = done_tx.clone();
            async move {
                if count.fetch_add(1, Ordering::Relaxed) + 1 >= 3
                    && let Some(tx) = done_tx.lock().take()
                {
                    let _ = tx.send(());
                }
                true
            }
        });
        let _ = tokio::time::timeout(Duration::from_secs(2), done_rx).await.expect("ticker fired");
        ticker.stop().await;
        assert!(count.load(Ordering::Relaxed) >= 3);
    }

    #[tokio::test]
    async fn dropping_a_clone_does_not_cancel_the_group() {
        let group = TaskGroup::new();
        let clone = group.clone();
        drop(clone);
        assert!(!group.is_cancelled());
    }
}
