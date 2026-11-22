//! VibeValley's projection and domain rules: core state folding (`reduce`),
//! per-domain slice projections (`board_slice`, `sessions_slice`, `collab_slice`,
//! `inbox_slice`, `ops_slice`, `farm_frame`), schedules (`cron`), notes (`pkm`),
//! and artifacts (`artifact`).

pub mod artifact;
pub mod brief;
pub mod channel;
#[cfg(feature = "collab")]
pub mod collab;
pub mod core;
pub mod cron;
pub mod deps;
pub mod game;
pub mod inbox;
pub mod moves;
pub mod patrol;
pub mod pkm;
pub mod pr;
pub mod progress;
pub mod prompts;
pub mod refine;
pub mod rules;
#[cfg(any(test, feature = "scenarios"))]
pub mod scenario;
pub mod status;
pub mod text;

pub use crate::core::{
    Applied, Core, SliceMask, Transition, board_slice, channel_summary, collab_slice, cron_from_rules, cron_request_to_rules, cron_to_rules, cron_view,
    empty_space_state, farm_frame, inbox_slice, media_summary, ops_slice, reduce, session_view, sessions_slice, slice_bundle,
};
pub use crate::deps::{
    CheckoutChecks, DagNode, DagProblem, acceptance_ancestors, blocked_issues, child_checks, dag_id_valid, dag_layers, dag_problems, dependency_problems,
    work_constraints,
};
pub use crate::inbox::{InboxEntry, fresh_of, inbox, inbox_entries};
pub use crate::moves::{Move, Refusal, status_move, status_moves};
pub use crate::status::*;

#[cfg(test)]
mod tests_round2;
