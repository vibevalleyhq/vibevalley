use std::time::Duration;

use crate::ai::stream::CancelToken;

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

    pub fn is_retryable_error(err: &ureq::Error) -> bool {
        matches!(err, ureq::Error::Timeout(_) | ureq::Error::Io(_) | ureq::Error::Protocol(_))
    }

    pub fn delay_for(&self, attempt: usize, retry_after: Option<Duration>) -> Duration {
        if let Some(after) = retry_after {
            return after.min(Duration::from_secs(60));
        }
        let shift = u32::try_from(attempt).unwrap_or(31).min(31);
        let factor = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        self.initial_backoff.saturating_mul(factor).min(self.max_backoff)
    }
}

pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let secs: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(secs))
}

/// Sleeps for `duration`, waking immediately with `false` if `cancel` triggers.
pub fn sleep_interruptible(duration: Duration, cancel: &CancelToken) -> bool {
    if cancel.is_cancelled() {
        return false;
    }
    if duration.is_zero() {
        return true;
    }
    match cancel.receiver() {
        Some(rx) => match rx.recv_timeout(duration) {
            Err(flume::RecvTimeoutError::Timeout) => true,
            Err(flume::RecvTimeoutError::Disconnected) | Ok(()) => false,
        },
        None => {
            std::thread::sleep(duration);
            true
        }
    }
}
