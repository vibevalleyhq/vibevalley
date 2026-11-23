use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};

use crate::agent::ai::stream::CancelToken;

const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: usize,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(4),
        }
    }
}

impl RetryPolicy {
    pub fn none() -> Self {
        Self {
            max_retries: 0,
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
        }
    }

    pub fn is_retryable_status(status: u16) -> bool {
        matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
    }

    pub fn is_retryable_error(err: &reqwest::Error) -> bool {
        err.is_timeout() || err.is_connect() || err.is_request() || err.is_body()
    }

    fn builder(&self) -> ExponentialBuilder {
        ExponentialBuilder::new()
            .with_factor(2.0)
            .with_min_delay(self.initial_backoff.min(self.max_backoff))
            .with_max_delay(self.max_backoff)
    }

    pub fn backoff(&self) -> ExponentialBackoff {
        self.builder().with_max_times(self.max_retries).build()
    }

    pub fn delay_for(&self, attempt: usize, retry_after: Option<Duration>) -> Duration {
        if let Some(after) = retry_after {
            return after.min(MAX_RETRY_AFTER);
        }
        let mut backoff = self.builder().without_max_times().build();
        // After 32 doublings any non-zero delay has already saturated to `max_backoff`.
        backoff.nth(attempt.min(32)).unwrap_or(self.max_backoff).min(self.max_backoff)
    }

    pub(crate) fn resolve_delay(backoff_delay: Duration, retry_after: Option<Duration>) -> Duration {
        retry_after.map(|after| after.min(MAX_RETRY_AFTER)).unwrap_or(backoff_delay)
    }
}

pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let secs: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(secs))
}

/// Sleeps for `duration`, waking immediately with `false` if `cancel` triggers.
pub fn sleep_interruptible(duration: Duration, cancel: &CancelToken) -> bool {
    crate::rt::block_on(sleep_interruptible_async(duration, cancel))
}

pub(crate) async fn sleep_interruptible_async(duration: Duration, cancel: &CancelToken) -> bool {
    if cancel.is_cancelled() {
        return false;
    }
    if duration.is_zero() {
        return true;
    }
    tokio::select! {
        biased;
        () = cancel.cancelled() => false,
        () = tokio::time::sleep(duration) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ai::CancelHandle;

    #[tokio::test(start_paused = true)]
    async fn sleep_interruptible_async_completes_and_cancels_on_virtual_clock() {
        let wall = std::time::Instant::now();
        let t0 = tokio::time::Instant::now();
        assert!(sleep_interruptible_async(Duration::from_secs(30), &CancelToken::never()).await);
        assert_eq!(t0.elapsed(), Duration::from_secs(30));
        assert!(wall.elapsed() < Duration::from_secs(1));

        let handle = CancelHandle::new();
        let token = handle.token();
        let sleeper = tokio::spawn(async move { sleep_interruptible_async(Duration::from_secs(60), &token).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        handle.cancel();
        assert!(!sleeper.await.unwrap());
        assert_eq!(t0.elapsed(), Duration::from_secs(35));
    }
}
