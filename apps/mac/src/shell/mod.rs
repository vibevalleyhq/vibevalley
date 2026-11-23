//! The root view: projects on a rail, each with its layout of panes, a
//! hosted sidebar (rail, files, source control, agents), and the palette.
//!
//! All backend work runs on background threads (`Shell::bg`); results come
//! back to the UI thread and are pushed to the views as frames.

mod devtools;
mod host_bridge;
mod menus;
mod palette;
mod panes;
mod projects;
mod render;
mod settings;

pub use devtools::devtools_enabled;
pub use menus::{bind_keys, update_menus};

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{AppContext as _, Context, Entity, FocusHandle, Focusable, Subscription, Window};
use serde_json::{Value, json};
use vibevalley_files::{FileIndex, FsChange, Watcher};
use vibevalley_git::{Branch, Commit, Status, Worktree};
use vibevalley_terminal::TermSession;
use vibevalley_workspace::{PaneKind, ProjectId, Store, TabId, Workspace, load_all, load_project, prune_missing_projects};

use crate::hosted::frames::{self, PaletteMode, TreeState};
use crate::hosted::{HostedEvent, HostedView, Panel};
use crate::panes::{PaneEntity, SplitBounds};
use crate::terminal::TerminalView;
use crate::theme::{MotionChoice, Settings, ThemeChoice, Ui};

pub(super) const SETTINGS_KEY: &str = crate::theme::SETTINGS_KEY;
pub(super) const ACTIVE_KEY: &str = "app.active_project";
pub(super) const SIDEBAR_MIN: f32 = 180.0;
pub(super) const SIDEBAR_MAX: f32 = 560.0;
pub(super) const INSPECTOR_MIN_VIEWPORT_WIDTH: f32 = 1040.0;

/// UI-side state of one open project: its tree, git state and file index.
pub struct ProjectView {
    pub tree: TreeState,
    pub repo_root: Option<PathBuf>,
    pub status: Option<Status>,
    pub tones: HashMap<PathBuf, &'static str>,
    pub branches: Vec<Branch>,
    pub worktrees: Vec<Worktree>,
    pub worktree_activity: HashMap<PathBuf, frames::WorktreeActivity>,
    pub log: Vec<Commit>,
    pub git_error: Option<String>,
    pub git_busy: bool,
    pub index: Option<Arc<FileIndex>>,
    pub(super) _watcher: Option<Watcher>,
}

pub struct Palette {
    pub view: Entity<HostedView>,
    pub open: bool,
    pub mode: PaletteMode,
    pub query: String,
    /// Bumped per query so late results of an older one are dropped.
    pub(super) seq: u64,
    pub(super) _sub: Subscription,
}

/// Lazily mounted right-side workspace inspector QuickJS surface; dropped immediately when closed.
pub struct InspectorSlot {
    pub view: Entity<HostedView>,
    pub(super) _sub: Subscription,
}

/// A project's git state as the sidebar shows it.
pub struct GitSummary {
    pub branch: Option<String>,
    pub worktrees: Vec<vibevalley_git::Worktree>,
}

pub struct TerminalSlot {
    pub view: Entity<TerminalView>,
    pub(super) _sub: Subscription,
}

pub struct PaneSlot {
    pub entity: PaneEntity,
    pub(super) _sub: Subscription,
}

pub struct PixelSlot {
    pub view: Entity<crate::pixel::view::PixelView>,
    pub(super) _sub: Subscription,
}

#[derive(Debug, Clone, Default)]
pub struct ChatTabStatus {
    pub status: String,
    pub attention: bool,
}

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
    pub(super) save_pending: bool,
    pub(super) fs_tx: flume::Sender<(ProjectId, Vec<FsChange>)>,
    pub(super) git_refresh_pending: BTreeSet<ProjectId>,
}

/// Hosted chrome surfaces, layout visibility/widths, active route, and drag/resize tracking.
pub struct HostChrome {
    pub sidebar: Entity<HostedView>,
    pub inspector: Option<InspectorSlot>,
    pub workbench: Entity<HostedView>,
    pub native_workspace: bool,
    pub native_pixel: Option<PixelSlot>,
    pub global_rail_width: f32,
    pub panel: Panel,
    pub inspector_open: bool,
    pub inspector_width: f32,
    pub last_route: Option<String>,
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
    pub(super) island_client: Option<Arc<vibevalley_server::transport::bridge::Client>>,
    /// VibeValley's opening over the window until the projects are in (`VIBEVALLEY_NO_OPENING=1` skips it).
    pub launch: Option<Entity<crate::pixel::view::PixelView>>,
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

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = Ui::get(cx).colors.dark;
        let sidebar = cx.new(|cx| HostedView::new("sidebar", serde_json::from_value(json!({"contextual":true})).unwrap(), dark, window, cx));
        let sub = cx.subscribe_in(&sidebar, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => this.push_sidebar(cx),
        });
        let workbench = cx.new(|cx| {
            HostedView::new(
                "vv",
                serde_json::from_value(json!({"globalShell":true,"route":"/issues"})).unwrap(),
                dark,
                window,
                cx,
            )
        });
        let workbench_sub = cx.subscribe_in(&workbench, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => {
                this.workspace.workbench_ready = true;
                this.finish_opening(true, cx);
            }
        });
        let (fs_tx, fs_rx) = flume::unbounded::<(ProjectId, Vec<FsChange>)>();
        cx.spawn(async move |this, cx| {
            while let Ok((project, changes)) = fs_rx.recv_async().await {
                if this.update(cx, |s, cx| s.on_fs_changes(project, changes, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let quit = cx.on_app_quit(|this: &mut Shell, cx| {
            this.close_devtools(cx);
            this.chrome.inspector = None;
            this.overlays.palette = None;
            this.overlays.island = None;
            this.overlays.island_client = None;
            crate::live_voice::stop(None);
            crate::speech_audio::stop(None);
            crate::audio::stop_queued();
            let jobs = this.workspace.ws.save_jobs();
            let mut ws = std::mem::take(&mut this.workspace.ws);
            this.workspace.projects.clear();
            this.workspace.terminals.clear();
            this.workspace.panes.clear();
            this.workspace.chat_statuses.clear();
            let watches = std::mem::take(&mut this.workspace.chat_watches);
            if let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>() {
                let server = bridge.0.server();
                for (_, (sub_id, _task)) in watches {
                    server.unsubscribe(sub_id);
                }
            }
            let running = crate::serving::RunningServer::take_for_shutdown(cx);
            let store = this.workspace.store.take();
            let background = cx.background_executor().clone();
            async move {
                background
                    .spawn(async move {
                        if let Some(store) = store {
                            for job in jobs {
                                if let Err(e) = job.run(&*store) {
                                    eprintln!("save on quit: {e}");
                                }
                            }
                        }
                        ws.shutdown_all_and_wait();
                        if let Some(running) = running {
                            running.shutdown();
                        }
                    })
                    .await;
            }
        });
        let appearance_sub = cx.observe_window_appearance(window, |this, _, cx| {
            if Ui::get(cx).settings.theme == ThemeChoice::System {
                let settings = Ui::get(cx).settings.clone();
                Ui::apply(settings, cx);
                this.theme_changed(cx);
            }
        });
        let startup_rx = cx.try_global::<crate::hosted::ServerStartup>().map(|s| s.0.clone());
        let already_settled = startup_rx.as_ref().and_then(|rx| rx.borrow().clone());
        let ui_settings = Ui::get(cx).settings.clone();
        let mut shell = Shell {
            workspace: WorkspaceProjects {
                store: None,
                project_open: None,
                ws: Workspace::new(),
                loaded: false,
                server_ready: matches!(already_settled, Some(Ok(()))),
                workbench_ready: false,
                load_error: match &already_settled {
                    Some(Err(e)) => Some(e.clone()),
                    _ => None,
                },
                projects: HashMap::new(),
                git_summaries: HashMap::new(),
                terminals: HashMap::new(),
                terminal_notice: None,
                panes: HashMap::new(),
                chat_statuses: HashMap::new(),
                chat_watches: HashMap::new(),
                chat_menu_group: None,
                save_pending: false,
                fs_tx,
                git_refresh_pending: BTreeSet::new(),
            },
            chrome: HostChrome {
                sidebar,
                inspector: None,
                workbench,
                native_workspace: false,
                native_pixel: None,
                global_rail_width: 76.0,
                panel: Panel::Files,
                inspector_open: ui_settings.inspector_open,
                inspector_width: ui_settings.inspector_width,
                last_route: None,
                sidebar_width: ui_settings.sidebar_width,
                sidebar_visible: ui_settings.sidebar_visible,
                resizing_sidebar: false,
                resizing_inspector: false,
                split_bounds: SplitBounds::default(),
                dragging_split: None,
                window_drag_origin: None,
            },
            overlays: NativeOverlays {
                island: None,
                island_client: None,
                launch: (std::env::var_os("VIBEVALLEY_NO_OPENING").is_none()
                    && ui_settings.effective_motion() != MotionChoice::Off
                    && !matches!(already_settled, Some(Err(_))))
                .then(|| cx.new(|cx| crate::pixel::view::PixelView::new("opening:launch", json!({}), cx))),
                palette: None,
                devtools: devtools::DevtoolsSlot::new(devtools_enabled()),
                tray: None,
                locale: None,
                opening: None,
                probe: None,
            },
            focus: cx.focus_handle(),
            _subs: vec![sub, workbench_sub, quit, appearance_sub],
        };
        if already_settled.is_none()
            && let Some(mut startup) = startup_rx
        {
            cx.spawn(async move |this, cx| {
                while startup.borrow().is_none() {
                    if startup.changed().await.is_err() {
                        break;
                    }
                }
                let result = startup.borrow().clone().unwrap_or_else(|| Err("the server startup channel closed".into()));
                let _ = this.update(cx, |shell, cx| {
                    match result {
                        Ok(()) => {
                            shell.workspace.server_ready = true;
                            shell.sync_chat_watches(cx);
                            shell.finish_opening(true, cx);
                        }
                        Err(error) => {
                            eprintln!("{error}");
                            shell.workspace.load_error = Some(error);
                            shell.finish_opening(false, cx);
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        match crate::island::Island::start() {
            Ok(Some((island, opened))) => {
                shell.overlays.island = Some(island);
                struct IslandOutlet(flume::Sender<(String, Value)>);
                impl vibevalley_server::transport::bridge::Outlet for IslandOutlet {
                    fn send(&self, event: &str, data: Value) {
                        let _ = self.0.send((event.to_string(), data));
                    }
                }
                let (tx, rx) = flume::unbounded::<(String, Value)>();
                let identity = crate::hosted::next_client_identity(vibevalley_server::ClientKind::GpuiShell, "island");
                let client = Arc::new(cx.global::<crate::hosted::BridgeHub>().0.attach(identity, Arc::new(IslandOutlet(tx))));
                if let Err(error) = client.watch("slice:board") {
                    eprintln!("island watch slice:board: {error}");
                }
                shell.overlays.island_client = Some(client.clone());
                cx.spawn(async move |this, cx| {
                    while let Ok((event, envelope)) = rx.recv_async().await {
                        if event != "frame:slice:board" {
                            continue;
                        }
                        let rev = envelope["rev"].as_u64().unwrap_or(0);
                        let board = match serde_json::from_value::<vibevalley_protocol::BoardSlice>(envelope["data"].clone()) {
                            Ok(board) => board,
                            Err(error) => {
                                eprintln!("island board slice: {error}");
                                client.applied_slice("slice:board", rev);
                                continue;
                            }
                        };
                        let alive = this.update(cx, |shell, _| {
                            if let Some(island) = &shell.overlays.island {
                                island.show(&crate::island::glance(&board));
                            }
                        });
                        client.applied_slice("slice:board", rev);
                        if alive.is_err() {
                            break;
                        }
                    }
                })
                .detach();
                cx.spawn(async move |this, cx| {
                    while let Ok(issue) = opened.recv_async().await {
                        if this
                            .update(cx, |shell, cx| {
                                shell.navigate_workbench(&format!("/issues/{issue}"), cx);
                                cx.activate(true);
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
            }
            Ok(None) => {}
            Err(error) => eprintln!("island: {error}"),
        }
        shell.publish_host_debug(cx);
        shell.start_devtools_refresh(cx);
        shell.load(cx);
        shell
    }

    /// Lazily spawns the inspector QuickJS view only when the workspace inspector is visible
    /// at a wide enough viewport, and drops it immediately when closed.
    pub(super) fn sync_inspector(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.chrome.inspector_open {
            self.chrome.inspector = None;
            return;
        }
        if !should_mount_inspector(
            self.chrome.native_workspace,
            self.chrome.inspector_open,
            f32::from(window.viewport_size().width),
        ) {
            return;
        }
        if self.chrome.inspector.is_some() {
            return;
        }
        let dark = Ui::get(cx).colors.dark;
        let view = cx.new(|cx| HostedView::new("sidebar", serde_json::from_value(json!({"role":"inspector"})).unwrap(), dark, window, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => this.push_sidebar(cx),
        });
        self.chrome.inspector = Some(InspectorSlot { view, _sub: sub });
    }

    pub(super) fn publish_host_debug(&self, cx: &gpui::App) {
        let Some(handle) = cx.try_global::<crate::hosted::ShellDebugHandle>() else {
            return;
        };
        let active_project = self.workspace.ws.active_id();
        let projects: Vec<Value> = self
            .workspace
            .ws
            .projects()
            .iter()
            .map(|p| {
                let active_tab = p.layout.active_tab().map(|t| t.id);
                let tabs: Vec<Value> = p
                    .layout
                    .tabs()
                    .map(|t| {
                        json!({
                            "id": t.id,
                            "active": active_tab == Some(t.id),
                            "kind": match &t.kind {
                                PaneKind::Terminal { .. } => "terminal",
                                PaneKind::Chat { .. } => "chat",
                                PaneKind::File { .. } => "file",
                                PaneKind::Diff { .. } => "diff",
                                PaneKind::Hosted { .. } => "hosted",
                                PaneKind::Pixel { .. } => "pixel",
                            },
                            "title": crate::panes::tab_title(self, t, cx),
                        })
                    })
                    .collect();
                json!({
                    "id": p.id(),
                    "name": p.info.name,
                    "root": p.root().to_string_lossy(),
                    "active": active_project == Some(p.id()),
                    "tabs": tabs,
                })
            })
            .collect();
        let active_pixel = self.chrome.native_pixel.as_ref().map(|slot| {
            let view = slot.view.read(cx);
            json!({
                "kind": view.kind,
                "framesSeen": view.frames_seen,
            })
        });
        let routes = json!({
            "current": self.chrome.last_route.as_deref().unwrap_or("/issues"),
            "loaded": self.workspace.loaded,
            "nativeWorkspace": self.chrome.native_workspace,
            "panel": self.chrome.panel.as_str(),
            "sidebarVisible": self.chrome.sidebar_visible,
            "inspectorOpen": self.chrome.inspector_open,
            "activeProjectId": active_project,
            "projects": projects,
            "activePixel": active_pixel,
        });
        let caches = vec![
            crate::hosted::DebugCacheEntry {
                name: "panes".into(),
                entries: self.workspace.panes.len() as u32,
                detail: Some("open pane entities".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "terminals".into(),
                entries: self.workspace.terminals.len() as u32,
                detail: Some("live terminal views".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "projects".into(),
                entries: self.workspace.projects.len() as u32,
                detail: Some("loaded project views".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "chatWatches".into(),
                entries: self.workspace.chat_watches.len() as u32,
                detail: Some("active chat status watches".into()),
            },
        ];
        handle.update_shell(routes, caches);
    }

    /// Runs `work` on a background thread, then `then` on the UI thread.
    pub fn bg<R, W, T>(cx: &mut Context<Self>, work: W, then: T)
    where
        R: Send + 'static,
        W: FnOnce() -> R + Send + 'static,
        T: FnOnce(&mut Self, R, &mut Context<Self>) + 'static,
    {
        let task = cx.background_spawn(async move { work() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |shell, cx| then(shell, result, cx));
        })
        .detach();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let cwd = std::env::current_dir().ok();
        let work_root = crate::serving::work_root();
        let path = crate::host::Storage::configured().database;
        Self::bg(
            cx,
            move || -> Result<_, String> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                let store = Store::open(&path).map_err(|e| e.to_string())?;
                let mut projects = prune_missing_projects(&store, load_all(&store).map_err(|e| e.to_string())?);
                if projects.is_empty() {
                    let initial = cwd
                        .filter(|dir| dir != Path::new("/") && vibevalley_git::Repo::discover(dir).ok().flatten().is_some())
                        .or_else(|| projects::first_workspace_repo(&work_root));
                    if let Some(dir) = initial {
                        projects.push(load_project(&store, &dir).map_err(|e| e.to_string())?);
                    }
                }
                let settings: Settings = vibevalley_workspace::persist::load_setting(&store, SETTINGS_KEY);
                let active: Option<ProjectId> = store.setting(ACTIVE_KEY).ok().flatten().and_then(|v| v.as_i64());
                Ok((Arc::new(store), projects, settings, active))
            },
            |this, result, cx| match result {
                Ok((store, projects, settings, active)) => {
                    let was_dark = Ui::get(cx).colors.dark;
                    let was_ui_size = Ui::get(cx).settings.ui_font_size;
                    let was_motion = Ui::get(cx).settings.effective_motion();
                    this.chrome.sidebar_width = settings.sidebar_width;
                    this.chrome.sidebar_visible = settings.sidebar_visible;
                    this.chrome.inspector_open = settings.inspector_open;
                    if !this.chrome.inspector_open {
                        this.chrome.inspector = None;
                    }
                    this.chrome.inspector_width = settings.inspector_width;
                    let saved_route = settings.last_route.clone();
                    let ui_size = settings.ui_font_size;
                    Ui::apply(settings, cx);
                    let effective_motion = Ui::get(cx).settings.effective_motion();
                    if effective_motion != was_motion {
                        this.notify_motion(effective_motion, cx);
                    }
                    if effective_motion == MotionChoice::Off {
                        this.overlays.launch = None;
                    }
                    if let Some(route) = saved_route
                        && !route.is_empty()
                        && route != "/issues"
                    {
                        this.chrome.last_route = Some(route.clone());
                        this.sync_devtools_route(&route);
                        this.chrome.workbench.update(cx, |v, cx| v.navigate(&route, cx));
                    }
                    if Ui::get(cx).colors.dark != was_dark {
                        this.theme_changed(cx);
                    }
                    if (ui_size - was_ui_size).abs() > 0.01 {
                        this.apply_ui_font_size(cx);
                    }
                    for p in projects {
                        let id = this.workspace.ws.open(p);
                        if let Some(proj) = this.workspace.ws.project_mut(id) {
                            // Workbench pages now belong to the application router.
                            let old_pages: Vec<_> = proj
                                .layout
                                .tabs()
                                .filter(|t| matches!(&t.kind, PaneKind::Hosted { module, .. } if module == "vv" || module == "vibevalley"))
                                .map(|t| t.id)
                                .collect();
                            for tab_id in old_pages {
                                proj.close_tab(tab_id);
                            }
                        }
                    }
                    if let Some(id) = active {
                        this.workspace.ws.activate(id);
                    }
                    this.workspace.store = Some(store);
                    this.workspace.loaded = true;
                    if let Some(id) = this.workspace.ws.active_id() {
                        this.ensure_project_view(id, cx);
                    }
                    this.refresh_summaries(cx);
                    this.sync_chat_watches(cx);
                    this.push_sidebar(cx);
                    this.finish_opening(true, cx);
                    cx.notify();
                }
                Err(e) => {
                    eprintln!("could not load projects: {e}");
                    this.workspace.load_error = Some(e);
                    this.workspace.loaded = true;
                    this.finish_opening(false, cx);
                    cx.notify();
                }
            },
        );
    }

    /// The opening says it is there (or failed), then gives way after a moment.
    pub(super) fn finish_opening(&mut self, ok: bool, cx: &mut Context<Self>) {
        let Some(opening) = self.overlays.launch.clone() else { return };
        if ok && (!self.workspace.loaded || !self.workspace.server_ready || !self.workspace.workbench_ready || self.workspace.load_error.is_some()) {
            return;
        }
        opening.update(cx, |v, _| {
            v.set_phase(
                if ok {
                    crate::pixel::opening::Phase::Ready
                } else {
                    crate::pixel::opening::Phase::Failed
                },
                100.0,
            )
        });
        if !ok {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(350)).await;
            let _ = this.update(cx, |s, cx| {
                s.overlays.launch = None;
                cx.notify();
            });
        })
        .detach();
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        if self.workspace.ws.projects().is_empty() {
            return;
        }
        let jobs = self.workspace.ws.save_jobs();
        let mut ws = std::mem::take(&mut self.workspace.ws);
        let store = self.workspace.store.take();
        std::thread::spawn(move || {
            if let Some(store) = store {
                for job in jobs {
                    let _ = job.run(&*store);
                }
            }
            ws.shutdown_all_and_wait();
        });
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_inspector_mounts_only_when_workspace_inspector_open_and_viewport_wide() {
        assert!(!should_mount_inspector(false, true, 1440.0));
        assert!(!should_mount_inspector(true, false, 1440.0));
        assert!(!should_mount_inspector(true, true, 1039.0));
        assert!(should_mount_inspector(true, true, 1040.0));
        assert!(should_mount_inspector(true, true, 1440.0));
    }
}
