//! VibeValley's projection and domain rules: core state folding (`reduce`),
//! per-domain slice projections (`board_slice`, `sessions_slice`, `collab_slice`,
//! `inbox_slice`, `ops_slice`, `farm_frame`), schedules (`cron`),
//! and artifacts (`artifact`).

pub mod artifact;
pub mod brief;
pub mod channel;
pub mod clock;
#[cfg(feature = "collab")]
pub mod collab;
pub mod core;
pub mod cron;
pub mod deps;
pub mod game;
mod inbox;
pub mod moves;
pub mod pr;
pub mod projection;
pub mod prompts;
pub mod refine;
pub mod retro;
pub mod rules;
#[cfg(any(test, feature = "scenarios"))]
pub mod scenario;
pub mod status;
pub mod text;

pub use crate::clock::{Clock, ManualClock, SharedClock, SystemClock, system_clock};
pub use crate::core::{
    Applied, Core, SliceMask, Transition, board_slice, collab_slice, cron_from_rules, cron_request_to_rules, cron_to_rules, empty_space_state, farm_frame,
    inbox_slice, ops_slice, reduce, sessions_slice, slice_bundle,
};
pub use crate::deps::{
    CheckoutChecks, DagNode, DagProblem, acceptance_ancestors, blocked_issues, child_checks, dag_id_valid, dag_problems, dependency_problems,
};
pub use crate::moves::{Move, Refusal, status_move, status_moves};
pub use crate::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, LiveSessionOverlay, LiveSnapshot, OpsInput, SessionInput, apply_session_telemetry, derive_issues,
    fold_session_telemetry, merge_session_telemetry_usage, overlay_sessions, project_board, project_collab, project_farm, project_inbox, project_ops,
    project_sessions,
};
pub use crate::prompts::work_constraints;
pub use crate::retro::issue_retro;
pub use crate::status::{issue_order, pick_issues};

#[cfg(test)]
mod tests_round2;
