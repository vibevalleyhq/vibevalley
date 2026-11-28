use std::time::Duration;

use backon::ExponentialBackoff;
use vibevalley_kit::core::resilience::RetryPolicy as KitRetryPolicy;
pub use vibevalley_kit::core::resilience::parse_retry_after;

use crate::ai::stream::CancelToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: usize,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        let base = KitRetryPolicy::default();
        Self {
            max_retries: base.max_retries,
            initial_backoff: base.initial_backoff,
            max_backoff: base.max_backoff,
        }
    }
}

impl RetryPolicy {
    fn as_kit(self) -> KitRetryPolicy {
        KitRetryPolicy::new(self.max_retries, self.initial_backoff, self.max_backoff)
    }

    pub fn none() -> Self {
        Self {
            max_retries: 0,
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
        }
    }

    pub fn is_retryable_status(status: u16) -> bool {
        KitRetryPolicy::is_retryable_status(status)
    }

    pub fn is_retryable_error(err: &reqwest::Error) -> bool {
        err.is_timeout() || err.is_connect() || err.is_request() || err.is_body()
    }

    pub fn backoff(&self) -> ExponentialBackoff {
        self.as_kit().backoff()
    }

    pub fn delay_for(&self, attempt: usize, retry_after: Option<Duration>) -> Duration {
        self.as_kit().delay_for(attempt, retry_after)
    }

    pub(crate) fn resolve_delay(backoff_delay: Duration, retry_after: Option<Duration>) -> Duration {
        KitRetryPolicy::resolve_delay(backoff_delay, retry_after)
    }
}

/// Sleeps for `duration`, waking immediately with `false` if `cancel` triggers.
pub async fn sleep_interruptible(duration: Duration, cancel: &CancelToken) -> bool {
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
    use crate::ai::CancelHandle;

    #[tokio::test(start_paused = true)]
    async fn sleep_interruptible_completes_and_cancels_on_virtual_clock() {
        let wall = std::time::Instant::now();
        let t0 = tokio::time::Instant::now();
        assert!(sleep_interruptible(Duration::from_secs(30), &CancelToken::never()).await);
        assert_eq!(t0.elapsed(), Duration::from_secs(30));
        assert!(wall.elapsed() < Duration::from_secs(1));

        let handle = CancelHandle::new();
        let token = handle.token();
        let sleeper = tokio::spawn(async move { sleep_interruptible(Duration::from_secs(60), &token).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        handle.cancel();
        assert!(!sleeper.await.unwrap());
        assert_eq!(t0.elapsed(), Duration::from_secs(35));
    }
}
