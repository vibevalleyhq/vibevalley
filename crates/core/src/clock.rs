//! Wall-clock abstraction for domain modules (Layer 2 virtual clock).
//!
//! Domain logic that checks calendar/wall-clock deadlines (`cron`, `remote`,
//! `media` TTLs) reads Unix milliseconds through [`Clock`] rather than calling
//! `SystemTime::now()` directly, so tests can advance wall time deterministically
//! via [`ManualClock`] without sleeping.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use vibevalley_protocol::Millis;

/// Source of Unix epoch timestamps in milliseconds.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> Millis;
}

/// Shared handle to a [`Clock`] implementation.
pub type SharedClock = Arc<dyn Clock>;

/// Production wall clock backed by [`SystemTime::now`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> Millis {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(Millis::MAX as u128) as Millis)
            .unwrap_or(0)
    }
}

/// Returns the shared process-wide [`SystemClock`].
pub fn system_clock() -> SharedClock {
    static SYSTEM: OnceLock<SharedClock> = OnceLock::new();
    SYSTEM.get_or_init(|| Arc::new(SystemClock)).clone()
}

/// Deterministic wall clock controlled explicitly by tests.
#[derive(Debug)]
pub struct ManualClock {
    now_ms: AtomicI64,
}

impl ManualClock {
    pub fn new(at_ms: Millis) -> Self {
        Self { now_ms: AtomicI64::new(at_ms) }
    }

    pub fn set(&self, at_ms: Millis) {
        self.now_ms.store(at_ms, Ordering::Release);
    }

    pub fn advance(&self, delta: Duration) -> Millis {
        let delta_ms = i64::try_from(delta.as_millis()).unwrap_or(Millis::MAX);
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
    fn now_ms(&self) -> Millis {
        self.now_ms.load(Ordering::Acquire)
    }
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

    #[test]
    fn manual_clock_supports_new_set_advance_and_saturation() {
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let shared: SharedClock = clock.clone();
        assert_eq!(shared.now_ms(), 1_700_000_000_000);

        assert_eq!(clock.advance(Duration::from_millis(250)), 1_700_000_000_250);
        assert_eq!(shared.now_ms(), 1_700_000_000_250);

        assert_eq!(clock.advance(Duration::from_secs(60)), 1_700_000_060_250);
        assert_eq!(shared.now_ms(), 1_700_000_060_250);

        clock.set(42);
        assert_eq!(shared.now_ms(), 42);

        clock.set(Millis::MAX - 10);
        assert_eq!(clock.advance(Duration::from_secs(1)), Millis::MAX);
        assert_eq!(shared.now_ms(), Millis::MAX);
    }

    #[test]
    fn manual_clock_updates_are_visible_across_threads() {
        let clock = Arc::new(ManualClock::new(100));
        let shared: SharedClock = clock.clone();
        let writer = clock.clone();
        std::thread::spawn(move || {
            writer.advance(Duration::from_millis(500));
        })
        .join()
        .unwrap();
        assert_eq!(shared.now_ms(), 600);
    }
}
