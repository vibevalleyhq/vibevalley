//! The farm as the state shows it: plays, stations, plots, level and the
//! effects facts set off; achievements come from `data/seeds{,.en}.json`.

pub mod daily;
mod frame;
pub mod progress;
pub mod shop;
#[cfg(test)]
mod tests;

pub use daily::{DAILY_TASK_COUNT, DayActivity, daily_board_for, daily_specs_for_day, daily_task_id, local_day, unsettled_daily_tasks};
pub use frame::{
    AchievementDef, achievement_in_words, achievements, effects_of, empty_play, free_station, level_for_commits, level_ups, play_of, played_doing, played_run,
    progress_effects, session_failed_penalty, standings_of,
};
pub(crate) use frame::{farm_view, stationed, view_of};
pub use shop::{DecorationSpec, ShopItemSpec, purchased_issue_templates, shop_catalog, shop_item, shop_items_view, yard_decorations_for};
