use std::collections::BTreeMap;
use std::time::Duration;

use crate::core::time::SharedClock;

use super::{CronExpr, CronTicker, DueStatus, Zone};

struct JobEntry {
    expr: CronExpr,
    zone: Zone,
    last_run_ms: i64,
}

/// Domain-agnostic ID-only cron scheduler: tracks schedule expressions by `Id`
/// and returns due job IDs without carrying any domain payload.
pub struct CronScheduler<Id> {
    ticker: CronTicker,
    jobs: BTreeMap<Id, JobEntry>,
}

impl<Id: Ord + Clone> CronScheduler<Id> {
    pub fn new(clock: SharedClock, missed_after: Duration) -> Self {
        Self {
            ticker: CronTicker::new(clock, missed_after),
            jobs: BTreeMap::new(),
        }
    }

    pub fn upsert(&mut self, id: Id, expr: CronExpr, zone: Zone, last_run_or_created_ms: i64) {
        self.jobs.insert(
            id,
            JobEntry {
                expr,
                zone,
                last_run_ms: last_run_or_created_ms,
            },
        );
    }

    pub fn remove(&mut self, id: &Id) -> bool {
        self.jobs.remove(id).is_some()
    }

    pub fn mark_ran(&mut self, id: &Id, at_ms: i64) {
        if let Some(entry) = self.jobs.get_mut(id) {
            entry.last_run_ms = at_ms;
        }
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Returns all job IDs currently due or missed on the configured [`SharedClock`].
    pub fn due_ids(&self) -> Vec<(Id, DueStatus)> {
        let mut out = Vec::new();
        for (id, entry) in &self.jobs {
            if let Some(status @ (DueStatus::Due { .. } | DueStatus::Missed { .. })) = self.ticker.evaluate(&entry.expr, &entry.zone, entry.last_run_ms) {
                out.push((id.clone(), status));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::core::time::ManualClock;

    #[test]
    fn scheduler_triggers_due_and_missed_ids_deterministically() {
        let clock = Arc::new(ManualClock::new(0));
        let mut sched = CronScheduler::new(clock.clone(), Duration::from_secs(300));
        let expr = CronExpr::parse("*/5 * * * *").unwrap();
        sched.upsert("job-1", expr, Zone::UTC, 0);

        // Next match is at 5 minutes (300_000 ms).
        clock.set(299_000);
        assert!(sched.due_ids().is_empty());

        clock.set(300_000);
        assert_eq!(sched.due_ids(), vec![("job-1", DueStatus::Due { scheduled_at_ms: 300_000 })]);

        clock.set(601_000);
        assert_eq!(sched.due_ids(), vec![("job-1", DueStatus::Missed { scheduled_at_ms: 300_000 })]);

        sched.mark_ran(&"job-1", 601_000);
        assert!(sched.due_ids().is_empty());
    }
}
