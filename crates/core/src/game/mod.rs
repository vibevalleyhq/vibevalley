//! The farm as the state shows it: plays, stations, plots, level and the
//! effects facts set off; achievements come from `data/seeds{,.en}.json`.

mod frame;
pub mod progress;

pub use frame::{
    AchievementDef, achievement_in_words, achievements, effects_of, empty_play, free_station, level_for_commits, level_ups, play_of, played_doing, played_run,
    progress_effects, session_failed_penalty, standings_of,
};
pub(crate) use frame::{farm_view, stationed, view_of};
