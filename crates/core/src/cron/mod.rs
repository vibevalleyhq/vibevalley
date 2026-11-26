//! When a scheduled task runs and how that is said. Port of VibeValley
//! `apps/server/src/modules/issue/when.ts`. The next run is the
//! first matching minute strictly after the last run (or creation); a wall
//! time in a daylight-saving gap runs as if the clock had not moved yet, in
//! a fold at the earlier instant.

mod schedule;

pub use schedule::{
    ActorKind, Cron, CronRequest, CronWhen, Zone, after_run, cron_problem, due_crons, due_text, given_zone, is_missed, needs_ok, next_text, when_text,
};

#[cfg(test)]
mod tests;
