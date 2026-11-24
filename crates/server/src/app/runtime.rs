//! Single-owner async runtime spine: root cancellation token, tracked tasks,
//! host wake watch channel, and bounded async shutdown.

// Staged spine module wired into `App` during direct cutover.
#![allow(dead_code)]

use std::future::Future;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;

/// Server runtime spine managing cooperative cancellation, tracked tasks, and system wake signals.
pub(crate) struct Runtime {
    token: CancellationToken,
    tasks: TaskTracker,
    wake: watch::Sender<u64>,
}

impl Runtime {
    /// Creates a new [`Runtime`] with a fresh root [`CancellationToken`], empty [`TaskTracker`],
    /// and wake sequence initialized to `0`.
    pub(crate) fn new() -> Self {
        let (wake, _) = watch::channel(0u64);
        Self {
            token: CancellationToken::new(),
            tasks: TaskTracker::new(),
            wake,
        }
    }

    /// Root cancellation token for this runtime.
    pub(crate) fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Child cancellation token linked to the root token.
    pub(crate) fn child_token(&self) -> CancellationToken {
        self.token.child_token()
    }

    /// Whether shutdown cancellation has been requested.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Subscribes to host system wake notifications carrying the monotonic wake sequence.
    pub(crate) fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.wake.subscribe()
    }

    /// Advances the monotonic system wake counter and notifies all subscribers.
    pub(crate) fn notify_wake(&self) -> u64 {
        let mut next = 0u64;
        self.wake.send_modify(|count| {
            *count += 1;
            next = *count;
        });
        tracing::info!(wake_seq = next, "runtime.system_wake");
        next
    }

    /// Current monotonic count of host system wake events observed by this runtime.
    pub(crate) fn wake_count(&self) -> u64 {
        *self.wake.borrow()
    }

    /// Number of currently tracked active tasks.
    pub(crate) fn task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Spawns a tracked async task on the current Tokio runtime (or global runtime fallback),
    /// preserving the active tracing span and subscriber.
    pub(crate) fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        self.tasks.spawn_on(future.in_current_span().with_current_subscriber(), &handle)
    }

    /// Spawns a tracked blocking closure on the current Tokio runtime (or global runtime fallback),
    /// preserving the active tracing span and subscriber.
    pub(crate) fn spawn_blocking<F, R>(&self, func: F) -> JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        let dispatch = tracing::dispatcher::get_default(|d| d.clone());
        let span = tracing::Span::current();
        self.tasks
            .spawn_blocking_on(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(func)), &handle)
    }

    /// Cancels the root token, closes the task tracker, and awaits up to `grace` for all tracked
    /// tasks to finish. Returns `true` if all tasks drained within `grace`.
    pub(crate) async fn shutdown(&self, grace: Duration) -> bool {
        self.token.cancel();
        self.tasks.close();
        if tokio::time::timeout(grace, self.tasks.wait()).await.is_ok() {
            true
        } else {
            tracing::warn!(
                remaining = self.tasks.len(),
                timeout_ms = grace.as_millis() as u64,
                "runtime.shutdown timed out waiting for tracked tasks"
            );
            false
        }
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.token.cancel();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::Runtime;

    #[tokio::test]
    async fn spawn_and_spawn_blocking_track_tasks_and_drain_cleanly_on_shutdown() {
        let runtime = Runtime::new();
        let token = runtime.token();
        let child = runtime.child_token();
        let blocking_ran = Arc::new(AtomicBool::new(false));
        let async_stopped = Arc::new(AtomicBool::new(false));

        let b_flag = blocking_ran.clone();
        let blocking_handle = runtime.spawn_blocking(move || {
            b_flag.store(true, Ordering::Release);
            42usize
        });
        assert_eq!(blocking_handle.await.unwrap(), 42);
        assert!(blocking_ran.load(Ordering::Acquire));

        let started = Arc::new(Notify::new());
        let started_tx = started.clone();
        let stopped_flag = async_stopped.clone();
        runtime.spawn(async move {
            started_tx.notify_one();
            token.cancelled().await;
            stopped_flag.store(true, Ordering::Release);
        });

        started.notified().await;
        assert_eq!(runtime.task_count(), 1);
        assert!(!runtime.is_cancelled());
        assert!(!child.is_cancelled());

        let drained = runtime.shutdown(Duration::from_secs(1)).await;
        assert!(drained);
        assert!(runtime.is_cancelled());
        assert!(child.is_cancelled());
        assert!(async_stopped.load(Ordering::Acquire));
        assert_eq!(runtime.task_count(), 0);
    }

    #[tokio::test]
    async fn wake_watch_notifies_subscribers_monotonically() {
        let runtime = Runtime::new();
        assert_eq!(runtime.wake_count(), 0);

        let mut sub = runtime.subscribe_wake();
        assert_eq!(*sub.borrow_and_update(), 0);

        assert_eq!(runtime.notify_wake(), 1);
        sub.changed().await.unwrap();
        assert_eq!(*sub.borrow_and_update(), 1);

        assert_eq!(runtime.notify_wake(), 2);
        assert_eq!(runtime.notify_wake(), 3);
        sub.changed().await.unwrap();
        assert_eq!(*sub.borrow_and_update(), 3);
        assert_eq!(runtime.wake_count(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_returns_false_when_task_exceeds_grace_period() {
        let runtime = Runtime::new();
        let gate = Arc::new(Notify::new());
        let gate_rx = gate.clone();

        runtime.spawn(async move {
            gate_rx.notified().await;
        });
        tokio::task::yield_now().await;

        let shutdown_fut = runtime.shutdown(Duration::from_millis(100));
        tokio::pin!(shutdown_fut);
        tokio::select! {
            _ = &mut shutdown_fut => panic!("shutdown must not finish before grace period"),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        tokio::time::advance(Duration::from_millis(60)).await;
        assert!(!shutdown_fut.await);
        gate.notify_one();
    }
}
