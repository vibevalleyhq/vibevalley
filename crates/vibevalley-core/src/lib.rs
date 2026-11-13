//! VibeValley's projection and rules on its wire types (`vibevalley-protocol`):
//! the fold of facts into the one state (`reduce`), the frame the page reads
//! (`frame_of`), issue status, stage and moves, the inbox, the farm view,
//! and the issue rules the server's modules use.
//!
//! Source: `apps/server/src/core` and `gateway/projection`.
//! Each module names the files it was ported from. `tests/projection.rs`
//! holds `reduce` and `frame_of` to the JSON VibeValley's own `reduce` and
//! `frameOf` write for the same facts.

pub mod brief;
pub mod channel;
pub mod core;
pub mod deps;
pub mod game;
pub mod inbox;
pub mod moves;
pub mod patrol;
pub mod pr;
pub mod progress;
pub mod refine;
pub mod rules;
pub mod status;
pub mod text;

pub use crate::core::{Applied, Core, Transition, cron_view, empty_space_state, frame_of, reduce, session_view};
pub use crate::deps::{
    CheckoutChecks, DagNode, DagProblem, acceptance_ancestors, blocked_issues, child_checks, dag_id_valid, dag_layers, dag_problems, dependency_problems,
    work_constraints,
};
pub use crate::inbox::{InboxEntry, fresh_of, inbox, inbox_entries};
pub use crate::moves::{Move, Refusal, status_move, status_moves};
pub use crate::status::*;

#[cfg(test)]
mod tests_round2;
