use std::time::Duration;

use crate::core::time::SharedClock;

use super::{CronExpr, Zone};

/// Evaluation result for a scheduled job against current wall-clock time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueStatus {
    /// Not yet due; next fire instant in Unix ms.
    Pending { next_at_ms: i64 },
    /// Due now (within the catch-up window).
    Due { scheduled_at_ms: i64 },
    /// Overdue past the missed threshold (e.g., process was asleep or stopped).
    Missed { scheduled_at_ms: i64 },
}

/// Evaluates due and missed cron runs against an injected [`SharedClock`].
#[derive(Clone)]
pub struct CronTicker {
    clock: SharedClock,
    missed_after_ms: i64,
}

impl CronTicker {
    pub fn new(clock: SharedClock, missed_after: Duration) -> Self {
        let missed_after_ms = i64::try_from(missed_after.as_millis()).unwrap_or(i64::MAX);
        Self { clock, missed_after_ms }
    }

    pub fn evaluate(&self, expr: &CronExpr, zone: &Zone, last_run_or_created_ms: i64) -> Option<DueStatus> {
        let now_ms = self.clock.now_ms();
        let scheduled = expr.next_after(last_run_or_created_ms, zone)?;
        if scheduled > now_ms {
            return Some(DueStatus::Pending { next_at_ms: scheduled });
        }
        if now_ms.saturating_sub(scheduled) > self.missed_after_ms {
            Some(DueStatus::Missed { scheduled_at_ms: scheduled })
        } else {
            Some(DueStatus::Due { scheduled_at_ms: scheduled })
        }
    }
}
