//! UI-independent workbench state: open projects and their layout trees, the
//! registry that keeps terminal sessions alive across project switches, and
//! save/restore through `vibevalley-store`.
//!
//! Nothing here depends on GPUI. Plain state types (`Workspace`, `Layout`)
//! never block; anything that touches the disk is a separate function
//! documented as blocking.

pub mod layout;
pub mod persist;
pub mod store;
pub mod util;
pub mod workspace;

#[cfg(test)]
mod testing;

pub use layout::{Axis, DiffSpec, Group, GroupId, Layout, Node, PaneKind, Split, SplitId, Tab, TabHookOverrides, TabId, TerminalLink};
pub use persist::{Persistence, TERMINAL_HOOKS_SETTINGS_KEY, load_terminal_hooks, save_terminal_hooks};
pub use store::{Project, ProjectId, SavedTerminal, Store, StoreError};
pub use vibevalley_terminal::TerminalHooksConfig;
pub use workspace::{
    LoadedProject, OpenProject, RestoreCommand, SaveJob, TerminalEntry, TerminalHandle, Workspace, load_all, load_project, prune_missing_projects,
    restore_command,
};
