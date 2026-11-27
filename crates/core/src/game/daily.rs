//! Calendar-day lightweight daily tasks driven strictly by delivery and
//! quality metrics (verified checks, reviews, clean deliveries, milestones).
//! Raw token or churn farming does not count toward daily progress.

use std::collections::{BTreeMap, BTreeSet};

use vibevalley_i18n::t;
use vibevalley_protocol::{DailyTask, DailyTaskBoard, DailyTaskKind};

#[derive(Debug, Clone, Copy)]
pub struct DailyTaskSpec {
    pub kind: DailyTaskKind,
    pub target: i64,
    pub reward_coins: i64,
}

const DAILY_POOL: [DailyTaskSpec; 4] = [
    DailyTaskSpec {
        kind: DailyTaskKind::TestsPassed,
        target: 1,
        reward_coins: 25,
    },
    DailyTaskSpec {
        kind: DailyTaskKind::ReviewsCompleted,
        target: 1,
        reward_coins: 20,
    },
    DailyTaskSpec {
        kind: DailyTaskKind::CleanHarvest,
        target: 1,
        reward_coins: 30,
    },
    DailyTaskSpec {
        kind: DailyTaskKind::MilestoneDone,
        target: 1,
        reward_coins: 25,
    },
];

pub const DAILY_TASK_COUNT: usize = 3;

/// Local calendar day (`YYYY-MM-DD`) in the system timezone for millisecond timestamp `at`.
pub fn local_day(at: i64) -> String {
    jiff::Timestamp::from_millisecond(at)
        .map(|ts| ts.to_zoned_datetime(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| "1970-01-01".to_string())
}

fn fnv32a(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h = (h ^ u32::from(*b)).wrapping_mul(0x01000193);
    }
    h
}

/// Deterministic 3 lightweight daily tasks for calendar day `day` (`YYYY-MM-DD`).
/// Rotates out one of the 4 pool archetypes based on the calendar day hash.
pub fn daily_specs_for_day(day: &str) -> Vec<DailyTaskSpec> {
    let skip = (fnv32a(day) as usize) % DAILY_POOL.len();
    DAILY_POOL.iter().enumerate().filter(|(idx, _)| *idx != skip).map(|(_, spec)| *spec).collect()
}

pub fn daily_task_id(day: &str, kind: DailyTaskKind) -> String {
    format!("{day}:{}", kind.as_str())
}

/// Deduplicated per-calendar-day delivery & quality counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DayActivity {
    pub tests_passed: BTreeSet<String>,
    pub reviews_completed: BTreeSet<String>,
    pub clean_harvest: BTreeSet<String>,
    pub milestone_done: BTreeSet<String>,
    pub settled: BTreeMap<String, i64>,
    pub settled_coins: i64,
}

impl DayActivity {
    pub fn count_for(&self, kind: DailyTaskKind) -> i64 {
        match kind {
            DailyTaskKind::TestsPassed => self.tests_passed.len() as i64,
            DailyTaskKind::ReviewsCompleted => self.reviews_completed.len() as i64,
            DailyTaskKind::CleanHarvest => self.clean_harvest.len() as i64,
            DailyTaskKind::MilestoneDone => self.milestone_done.len() as i64,
        }
    }
}

pub fn daily_board_for(by_day: &BTreeMap<String, DayActivity>, day: &str) -> DailyTaskBoard {
    let activity = by_day.get(day);
    let tasks = daily_specs_for_day(day)
        .into_iter()
        .map(|spec| {
            let id = daily_task_id(day, spec.kind);
            let raw = activity.map_or(0, |a| a.count_for(spec.kind));
            let progress = raw.min(spec.target);
            let settled_at = activity.and_then(|a| a.settled.get(&id).copied());
            let settled = settled_at.is_some();
            let completed = progress >= spec.target || settled;
            let key = spec.kind.as_str();
            DailyTask {
                id,
                kind: spec.kind,
                title: t(&format!("server.game.daily.{key}.title"), &[]),
                detail: t(&format!("server.game.daily.{key}.detail"), &[]),
                progress: if settled { spec.target } else { progress },
                target: spec.target,
                reward_coins: spec.reward_coins,
                completed,
                settled,
                settled_at,
            }
        })
        .collect();
    DailyTaskBoard {
        day: day.to_string(),
        tasks,
        settled_coins_today: activity.map_or(0, |a| a.settled_coins),
    }
}

pub fn unsettled_daily_tasks(by_day: &BTreeMap<String, DayActivity>, day: &str) -> Vec<DailyTask> {
    daily_board_for(by_day, day)
        .tasks
        .into_iter()
        .filter(|task| task.completed && !task.settled)
        .collect()
}
