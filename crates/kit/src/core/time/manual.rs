use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use super::Clock;

/// Deterministic wall clock controlled explicitly by tests.
#[derive(Debug)]
pub struct ManualClock {
    now_ms: AtomicI64,
}

impl ManualClock {
    pub fn new(at_ms: i64) -> Self {
        Self { now_ms: AtomicI64::new(at_ms) }
    }

    pub fn set(&self, at_ms: i64) {
        self.now_ms.store(at_ms, Ordering::Release);
    }

    pub fn advance(&self, delta: Duration) -> i64 {
        let delta_ms = i64::try_from(delta.as_millis()).unwrap_or(i64::MAX);
        let mut current = self.now_ms.load(Ordering::Acquire);
        loop {
            let next = current.saturating_add(delta_ms);
            match self.now_ms.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return next,
                Err(observed) => current = observed,
            }
        }
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now_ms.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::core::time::SharedClock;

    #[test]
    fn manual_clock_supports_new_set_advance_and_saturation() {
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let shared: SharedClock = clock.clone();
        assert_eq!(shared.now_ms(), 1_700_000_000_000);

        assert_eq!(clock.advance(Duration::from_millis(250)), 1_700_000_000_250);
        assert_eq!(shared.now_ms(), 1_700_000_000_250);

        clock.set(42);
        assert_eq!(shared.now_ms(), 42);

        clock.set(i64::MAX - 10);
        assert_eq!(clock.advance(Duration::from_secs(1)), i64::MAX);
        assert_eq!(shared.now_ms(), i64::MAX);
    }
}
