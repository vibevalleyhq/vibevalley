use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Source of Unix epoch timestamps in milliseconds.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// Shared handle to a [`Clock`] implementation.
pub type SharedClock = Arc<dyn Clock>;

/// Production wall clock backed by [`SystemTime::now`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0)
    }
}

/// Returns the shared process-wide [`SystemClock`].
pub fn system_clock() -> SharedClock {
    static SYSTEM: OnceLock<SharedClock> = OnceLock::new();
    SYSTEM.get_or_init(|| Arc::new(SystemClock)).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_returns_positive_unix_millis() {
        let clock = system_clock();
        let first = clock.now_ms();
        let second = SystemClock.now_ms();
        assert!(first > 1_600_000_000_000, "unexpected system clock value: {first}");
        assert!(second >= first);
    }
}
