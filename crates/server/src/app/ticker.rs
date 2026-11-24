//! Cancelable background periodic ticker bound to [`crate::app::runtime::Runtime`].

use std::pin::Pin;
use std::time::Duration;

use crate::app::runtime::Runtime;

/// A cancelable background periodic ticker driven by [`Runtime`].
pub(crate) struct Ticker {
    cancel: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

async fn run_async_ticker(
    cancel: tokio_util::sync::CancellationToken,
    interval: Duration,
    immediate: bool,
    mut tick: impl FnMut() -> Pin<Box<dyn std::future::Future<Output = bool> + Send>> + Send + 'static,
) {
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

impl Ticker {
    pub(crate) fn spawn_async_on(
        runtime: &Runtime,
        interval: Duration,
        immediate: bool,
        tick: impl FnMut() -> Pin<Box<dyn std::future::Future<Output = bool> + Send>> + Send + 'static,
    ) -> Self {
        let cancel = runtime.child_token();
        let handle = runtime.spawn(run_async_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) async fn stop_async(self) {
        self.cancel.cancel();
        let _ = self.handle.await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn ticker_runs_on_interval_and_cancels_cleanly() {
        let runtime = Runtime::new();
        let count = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let done_tx = Arc::new(parking_lot::Mutex::new(Some(done_tx)));
        let count_c = count.clone();
        let ticker = Ticker::spawn_async_on(&runtime, Duration::from_millis(10), true, move || {
            let count = count_c.clone();
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if count.fetch_add(1, Ordering::Relaxed) + 1 >= 3
                    && let Some(tx) = done_tx.lock().take()
                {
                    let _ = tx.send(());
                }
                true
            })
        });
        let _ = tokio::time::timeout(Duration::from_secs(2), done_rx).await.expect("ticker fired");
        ticker.stop_async().await;
        assert!(count.load(Ordering::Relaxed) >= 3);
    }
}
