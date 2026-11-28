//! Retry backoff policy and cancelable sleep helpers.

mod retry;

pub use retry::{MAX_RETRY_AFTER, RetryPolicy, parse_retry_after, sleep_cancelable};
