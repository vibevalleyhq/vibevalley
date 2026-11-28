use std::time::Duration;

use backon::{BackoffBuilder as _, ExponentialBackoff, ExponentialBuilder};
use tokio_util::sync::CancellationToken;

/// Upper cap honored for server-supplied `Retry-After` hints.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Exponential backoff retry policy with optional jitter and `Retry-After` cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: usize,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(4),
            jitter: false,
        }
    }
}

impl RetryPolicy {
    pub const fn new(max_retries: usize, initial_backoff: Duration, max_backoff: Duration) -> Self {
        Self {
            max_retries,
            initial_backoff,
            max_backoff,
            jitter: false,
        }
    }

    pub const fn none() -> Self {
        Self {
            max_retries: 0,
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
            jitter: false,
        }
    }

    pub const fn with_jitter(mut self, jitter: bool) -> Self {
        self.jitter = jitter;
        self
    }

    pub const fn is_retryable_status(status: u16) -> bool {
        matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
    }

    fn builder(&self) -> ExponentialBuilder {
        let mut builder = ExponentialBuilder::new()
            .with_factor(2.0)
            .with_min_delay(self.initial_backoff.min(self.max_backoff))
            .with_max_delay(self.max_backoff);
        if self.jitter {
            builder = builder.with_jitter();
        }
        builder
    }

    /// Builds a bounded `backon::ExponentialBackoff` iterator yielding up to `max_retries` delays.
    pub fn backoff(&self) -> ExponentialBackoff {
        self.builder().with_max_times(self.max_retries).build()
    }

    /// Computes the backoff delay for zero-based `attempt`, honoring capped `retry_after` when present.
    pub fn delay_for(&self, attempt: usize, retry_after: Option<Duration>) -> Duration {
        if let Some(after) = retry_after {
            return after.min(MAX_RETRY_AFTER);
        }
        let mut backoff = self.builder().without_max_times().build();
        backoff.nth(attempt.min(32)).unwrap_or(self.max_backoff).min(self.max_backoff)
    }

    /// Selects a capped `retry_after` duration if provided, else falls back to `backoff_delay`.
    pub fn resolve_delay(backoff_delay: Duration, retry_after: Option<Duration>) -> Duration {
        retry_after.map(|after| after.min(MAX_RETRY_AFTER)).unwrap_or(backoff_delay)
    }
}

/// Parses an integer seconds `Retry-After` header value.
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let secs: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(secs))
}

/// Sleeps for `duration`, waking immediately with `false` if `cancel` is triggered.
pub async fn sleep_cancelable(duration: Duration, cancel: &CancellationToken) -> bool {
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

    #[test]
    fn retry_policy_backoff_and_retry_after_caps() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.delay_for(0, None), Duration::from_millis(250));
        assert_eq!(policy.delay_for(1, None), Duration::from_millis(500));
        assert_eq!(policy.delay_for(2, None), Duration::from_secs(1));
        assert_eq!(policy.delay_for(10, None), Duration::from_secs(4));
        assert_eq!(policy.delay_for(0, Some(Duration::from_secs(120))), MAX_RETRY_AFTER);
        assert_eq!(RetryPolicy::none().backoff().next(), None);
        assert_eq!(parse_retry_after(" 15 "), Some(Duration::from_secs(15)));
        assert_eq!(parse_retry_after("invalid"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn sleep_cancelable_completes_and_cancels_on_virtual_clock() {
        let token = CancellationToken::new();
        let t0 = tokio::time::Instant::now();
        assert!(sleep_cancelable(Duration::from_secs(10), &token).await);
        assert_eq!(t0.elapsed(), Duration::from_secs(10));

        let child = token.child_token();
        let waiter = tokio::spawn(async move { sleep_cancelable(Duration::from_secs(60), &child).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(3)).await;
        token.cancel();
        assert!(!waiter.await.unwrap());
        assert_eq!(t0.elapsed(), Duration::from_secs(13));
    }
}
