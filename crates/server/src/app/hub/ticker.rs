use std::time::Duration;

/// A cancelable background periodic ticker running blocking work on the Tokio pool.
pub(crate) struct Ticker {
    cancel: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

async fn run_ticker(cancel: tokio_util::sync::CancellationToken, interval: Duration, immediate: bool, mut tick: impl FnMut() -> bool + Send + 'static) {
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
        if cancel.is_cancelled() {
            return;
        }
        let result = tokio::task::spawn_blocking(move || {
            let keep_going = tick();
            (tick, keep_going)
        })
        .await;
        let Ok((returned, true)) = result else { return };
        tick = returned;
    }
}

impl Ticker {
    pub(crate) fn spawn_on(hub: &crate::Hub, interval: Duration, immediate: bool, tick: impl FnMut() -> bool + Send + 'static) -> Self {
        let cancel = hub.child_token();
        let handle = hub.spawn_task(run_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) fn spawn_detached(interval: Duration, immediate: bool, tick: impl FnMut() -> bool + Send + 'static) -> Self {
        let cancel = tokio_util::sync::CancellationToken::new();
        let handle = vibevalley_runtime::rt::current_or_global_handle().spawn(run_ticker(cancel.clone(), interval, immediate, tick));
        Self { cancel, handle }
    }

    pub(crate) async fn stop_async(self) {
        self.cancel.cancel();
        let _ = self.handle.await;
    }

    pub(crate) fn stop(self) {
        vibevalley_runtime::rt::block_on(self.stop_async());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn ticker_runs_on_interval_and_cancels_cleanly() {
        let count = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = flume::bounded(1);
        let c = count.clone();
        let ticker = Ticker::spawn_detached(Duration::from_millis(15), true, move || {
            let n = c.fetch_add(1, Ordering::SeqCst) + 1;
            if n >= 3 {
                let _ = done_tx.try_send(());
                return false;
            }
            true
        });
        done_rx.recv_timeout(Duration::from_secs(2)).expect("ticker fired 3 times");
        ticker.stop();
        assert!(count.load(Ordering::SeqCst) >= 3);
    }

    #[tokio::test(start_paused = true)]
    async fn ticker_advances_deterministically_over_virtual_minutes_and_stops_async() {
        let wall_start = Instant::now();
        let (tick_tx, mut tick_rx) = tokio::sync::mpsc::unbounded_channel();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let ticker = Ticker::spawn_detached(Duration::from_secs(60), false, move || {
            let n = c.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = tick_tx.send(n);
            true
        });

        tokio::task::yield_now().await;
        assert!(tick_rx.try_recv().is_err(), "non-immediate ticker must not fire at t=0");

        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert!(tick_rx.try_recv().is_err(), "ticker must not fire before 60s");

        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(tick_rx.recv().await, Some(1));

        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(tick_rx.recv().await, Some(2));

        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(tick_rx.recv().await, Some(3));

        ticker.stop_async().await;
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(
            wall_start.elapsed() < Duration::from_secs(1),
            "3 virtual minutes of Ticker ticks must finish instantaneously, took {:?}",
            wall_start.elapsed()
        );
    }
}
