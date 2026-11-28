/// Tracks monotonic sequence numbers on a consumer side and detects skipped/lagged gaps.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LagGuard {
    last_seq: Option<u64>,
    total_skipped: u64,
}

impl LagGuard {
    pub const fn new() -> Self {
        Self {
            last_seq: None,
            total_skipped: 0,
        }
    }

    /// Observes `seq` and returns how many intermediate sequence numbers were skipped since the prior event.
    pub fn observe(&mut self, seq: u64) -> u64 {
        let skipped = match self.last_seq {
            Some(prev) if seq > prev + 1 => seq - prev - 1,
            _ => 0,
        };
        if self.last_seq.is_none_or(|prev| seq > prev) {
            self.last_seq = Some(seq);
        }
        self.total_skipped = self.total_skipped.saturating_add(skipped);
        skipped
    }

    pub const fn last_seq(&self) -> Option<u64> {
        self.last_seq
    }

    pub const fn total_skipped(&self) -> u64 {
        self.total_skipped
    }
}

#[cfg(test)]
mod tests {
    use super::LagGuard;

    #[test]
    fn lag_guard_counts_gaps_monotonically() {
        let mut guard = LagGuard::new();
        assert_eq!(guard.observe(1), 0);
        assert_eq!(guard.observe(2), 0);
        assert_eq!(guard.observe(5), 2);
        assert_eq!(guard.observe(3), 0);
        assert_eq!(guard.last_seq(), Some(5));
        assert_eq!(guard.total_skipped(), 2);
    }
}
