//! UI-independent workbench state: open projects and their layout trees, the
//! registry that keeps terminal sessions alive across project switches, and
//! save/restore through `vibevalley-store`.
//!
//! Nothing here depends on GPUI. Plain state types (`Workspace`, `Layout`)
//! never block; anything that touches the disk is a separate function
//! documented as blocking.

pub mod layout;
pub mod persist;
pub mod util;
pub mod workspace;

#[cfg(test)]
mod testing;

pub use layout::{Axis, DiffSpec, Group, GroupId, Layout, Node, PaneKind, Split, SplitId, Tab, TabId, TerminalLink};
pub use persist::Persistence;
pub use workspace::{LoadedProject, OpenProject, RestoreCommand, SaveJob, TerminalEntry, TerminalHandle, Workspace, load_all, load_project, restore_command};
