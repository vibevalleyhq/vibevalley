//! Where an issue's work happens on disk: its repository (made when it is a
//! folder under the work root), the issue's worktree on its own branch, the
//! base it forks from, merging it, its conflicts, and the branches left
//! afterwards. It knows nothing of the board's state: callers name the
//! issue's number, repository and the worktree its session works in.

pub(crate) mod check;
mod handoff;
mod manager;

pub use handoff::{HandoffCleanup, HandoffRecord, HoeRegistry, WorktreeKey, WriteLease};
pub use manager::{Changes, Delivery, Joined, Landed, Leave, Leaving, OnDisk, Worktree, issue_branch};
