//! UI-independent workbench state: open projects and their layout trees, the
//! registry that keeps terminal sessions alive across project switches,
//! save/restore through `vibevalley-store`, and agent-task orchestration.
//!
//! Nothing here depends on GPUI. Plain state types (`Workspace`, `Layout`)
//! never block; anything that touches the disk, git or an agent runtime is
//! either a function documented as blocking or runs on `TaskManager`'s own
//! threads and reports through a channel.

pub mod git;
pub mod layout;
pub mod persist;
pub mod tasks;
pub mod transcript;
pub mod util;
pub mod workspace;

#[cfg(test)]
mod testing;

pub use layout::{Axis, DiffSpec, Group, GroupId, Layout, Node, PaneKind, Split, SplitId, Tab, TabId};
pub use persist::Persistence;
pub use tasks::{PendingPermission, ReviewDiff, RuntimeInfo, TaskCounts, TaskDirs, TaskError, TaskEvent, TaskInfo, TaskManager, TaskPhase, TaskSpec};
pub use workspace::{LoadedProject, OpenProject, RestoreCommand, SaveJob, TerminalEntry, TerminalHandle, Workspace, load_all, load_project, restore_command};
