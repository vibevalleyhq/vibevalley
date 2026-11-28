use std::time::Duration;

use crate::core::time::SharedClock;

/// Deterministic leading-edge throttle gate driven by an injected [`SharedClock`].
pub struct ThrottleGate {
    clock: SharedClock,
    window_ms: i64,
    last_allowed_ms: Option<i64>,
}

impl ThrottleGate {
    pub fn new(window: Duration, clock: SharedClock) -> Self {
        let window_ms = i64::try_from(window.as_millis()).unwrap_or(i64::MAX);
        Self {
            clock,
            window_ms,
            last_allowed_ms: None,
        }
    }

    /// Returns `true` if at least `window` has elapsed since the previous allowed tick.
    pub fn try_acquire(&mut self) -> bool {
        let now = self.clock.now_ms();
        match self.last_allowed_ms {
            Some(prev) if now.saturating_sub(prev) < self.window_ms => false,
            _ => {
                self.last_allowed_ms = Some(now);
                true
            }
        }
    }

    /// Remaining wait time until the next tick will be allowed, or `Duration::ZERO`.
    pub fn remaining(&self) -> Duration {
        let Some(prev) = self.last_allowed_ms else {
            return Duration::ZERO;
        };
        let elapsed = self.clock.now_ms().saturating_sub(prev);
        if elapsed >= self.window_ms {
            Duration::ZERO
        } else {
            Duration::from_millis((self.window_ms - elapsed) as u64)
        }
    }

    pub fn reset(&mut self) {
        self.last_allowed_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::core::time::ManualClock;

    #[test]
    fn throttle_gate_respects_manual_clock() {
        let clock = Arc::new(ManualClock::new(1_000));
        let mut gate = ThrottleGate::new(Duration::from_millis(500), clock.clone());
        assert!(gate.try_acquire());
        assert!(!gate.try_acquire());
        assert_eq!(gate.remaining(), Duration::from_millis(500));

        clock.advance(Duration::from_millis(300));
        assert!(!gate.try_acquire());
        assert_eq!(gate.remaining(), Duration::from_millis(200));

        clock.advance(Duration::from_millis(200));
        assert!(gate.try_acquire());
    }
}
