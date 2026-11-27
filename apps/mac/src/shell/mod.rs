//! The root view: projects on a rail, each with its layout of panes, a
//! hosted sidebar (rail, files, source control, agents), and the palette.
//!
//! All backend work runs on background threads (`Shell::bg`); results come
//! back to the UI thread and are pushed to the views as frames.

mod devtools;
mod host_bridge;
mod lifecycle;
mod menus;
mod palette;
mod pane_layout;
mod panes;
mod projects;
mod render;
mod settings;
mod slots;
mod startup_error;
#[cfg(test)]
mod tests;

pub use devtools::devtools_enabled;
pub use menus::{bind_keys, update_menus};
pub use pane_layout::{numbered_titles, tab_title};
pub use slots::{ChatTabStatus, DioramaSlot, GitSummary, InspectorSlot, Palette, PaneSlot, ProjectView, TerminalSlot};

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use gpui::{Entity, FocusHandle, Subscription};
use serde_json::Value;
use vibevalley_files::FsChange;
use vibevalley_terminal::TermSession;
use vibevalley_workspace::{ProjectId, Store, TabId, Workspace};

use crate::host_types::SplitBounds;
use crate::hosted::{HostedView, Panel};

pub(super) const SETTINGS_KEY: &str = crate::theme::SETTINGS_KEY;
pub(super) const ACTIVE_KEY: &str = "app.active_project";
pub(super) const SIDEBAR_MIN: f32 = 180.0;
pub(super) const SIDEBAR_MAX: f32 = 560.0;
pub(super) const INSPECTOR_MIN_VIEWPORT_WIDTH: f32 = 1040.0;

/// Project store, workspace layout, live terminal/pane slots, file watches, and git state.
pub struct WorkspaceProjects {
    pub store: Option<Arc<Store>>,
    pub(super) project_open: Option<gpui::Task<()>>,
    pub ws: Workspace<TermSession>,
    pub loaded: bool,
    pub(super) server_ready: bool,
    pub(super) workbench_ready: bool,
    pub load_error: Option<String>,
    pub projects: HashMap<ProjectId, ProjectView>,
    /// Every project's branch and worktrees, read for the sidebar whether or
    /// not the project was opened (its full view is built on first open).
    pub git_summaries: HashMap<ProjectId, GitSummary>,
    pub terminals: HashMap<String, TerminalSlot>,
    pub(crate) terminal_notice: Option<String>,
    pub panes: HashMap<(ProjectId, TabId), PaneSlot>,
    pub chat_statuses: HashMap<(ProjectId, TabId), ChatTabStatus>,
    pub(super) chat_watches: HashMap<String, (u64, gpui::Task<()>)>,
    pub chat_menu_group: Option<vibevalley_workspace::GroupId>,
    pub terminal_hooks: vibevalley_terminal::TerminalHooksConfig,
    pub terminal_hooks_menu_group: Option<vibevalley_workspace::GroupId>,
    pub(super) save_pending: bool,
    pub(super) fs_tx: tokio::sync::mpsc::UnboundedSender<(ProjectId, Vec<FsChange>)>,
    pub(super) dir_refresh_pending: BTreeSet<ProjectId>,
    pub(super) git_refresh_pending: BTreeSet<ProjectId>,
    pub(super) summaries_gen: u64,
}

/// Hosted chrome surfaces, layout visibility/widths, active route, and drag/resize tracking.
pub struct HostChrome {
    pub sidebar: Entity<HostedView>,
    pub inspector: Option<InspectorSlot>,
    pub workbench: Entity<HostedView>,
    pub native_workspace: bool,
    pub native_diorama: Option<DioramaSlot>,
    pub modal_overlay: bool,
    pub global_rail_width: f32,
    pub panel: Panel,
    pub inspector_open: bool,
    pub inspector_width: f32,
    pub last_route: Option<String>,
    pub(super) explicit_route: bool,
    pub sidebar_width: f32,
    pub sidebar_visible: bool,
    pub(super) resizing_sidebar: bool,
    pub(super) resizing_inspector: bool,
    pub split_bounds: SplitBounds,
    pub dragging_split: Option<(u64, usize)>,
    pub window_drag_origin: Option<(f32, f32)>,
}

/// Transient overlays, companion processes (island/tray), and host-reported diagnostics.
pub struct NativeOverlays {
    pub(super) island: Option<crate::island::Island>,
    pub(super) island_client: Option<Arc<vibevalley_server::gateway::bridge::Client>>,
    /// VibeValley's opening over the window until the projects are in (`VIBEVALLEY_NO_OPENING=1` skips it).
    pub launch: Option<Entity<crate::diorama::OpeningView>>,
    pub(super) startup: startup_error::StartupUiState,
    pub palette: Option<Palette>,
    pub devtools: devtools::DevtoolsSlot,
    /// Last `host.tray` summary, `host.locale` and `host.opening` from the views.
    pub tray: Option<Value>,
    pub locale: Option<String>,
    pub opening: Option<Value>,
    pub probe: Option<Value>,
}

pub struct Shell {
    pub workspace: WorkspaceProjects,
    pub chrome: HostChrome,
    pub overlays: NativeOverlays,
    pub(super) focus: FocusHandle,
    pub(super) _subs: Vec<Subscription>,
}

pub(super) fn should_mount_inspector(native_workspace: bool, inspector_open: bool, viewport_width: f32) -> bool {
    native_workspace && inspector_open && viewport_width >= INSPECTOR_MIN_VIEWPORT_WIDTH
}

pub(super) fn should_raise_workbench_overlay(modal_overlay: bool, native_workspace: bool, has_diorama: bool) -> bool {
    modal_overlay && (native_workspace || has_diorama)
}
