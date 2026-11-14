//! The root view: projects on a rail, each with its layout of panes, a
//! hosted sidebar (rail, files, source control, agents), and the palette.
//!
//! All backend work runs on background threads (`Shell::bg`); results come
//! back to the UI thread and are pushed to the views as frames.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyBinding, MouseButton, MouseMoveEvent,
    ParentElement as _, PathPromptOptions, Pixels, Render, Styled as _, Subscription, Window, div, px,
};
use serde_json::{Map, Value, json};
use vibevalley_files::{FileIndex, FsChange, SearchOptions, Watcher};
use vibevalley_git::{Branch, Commit, Repo, Status, Worktree};
use vibevalley_store::{ProjectId, Store};
use vibevalley_terminal::TermSession;
use vibevalley_workspace::{Axis, PaneKind, TabId, TaskManager, TaskPhase, TaskSpec, Workspace, load_all, load_project};

use crate::diff::DiffView;
use crate::hosted::frames::{self, PaletteMode, RailProject, TreeState};
use crate::hosted::{Action, Choice, HostedEvent, HostedView, Panel};
use crate::panes::{PaneEntity, SplitBounds};
use crate::terminal::{SpawnSpec, TerminalEvent, TerminalView};
use crate::theme::{Settings, ThemeChoice, Ui};
use crate::viewer::FileViewer;

gpui_kit::actions!(
    shell,
    [
        ActivateProject1,
        ActivateProject2,
        ActivateProject3,
        ActivateProject4,
        ActivateProject5,
        ActivateProject6,
        ActivateProject7,
        ActivateProject8,
        ActivateProject9,
        GoToFile,
        CommandPalette,
        SearchProject,
        NewTerminal,
        CloseTab,
        SplitRight,
        SplitDown,
        NextTab,
        PrevTab,
        FocusNextGroup,
        ClosePalette,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        ToggleSidebar,
        ToggleTheme,
        Quit,
    ]
);

pub fn bind_keys(cx: &mut gpui_kit::App) {
    use gpui_kit::{Menu, MenuItem};
    use vibevalley_i18n::t;
    cx.set_menus(vec![
        Menu::new("VibeValley").items([MenuItem::action(t("desktop.quit", &[]), Quit)]),
        Menu::new(t("desktop.menu.view", &[])).items([
            MenuItem::action(t("desktop.menu.zoomIn", &[]), ZoomIn),
            MenuItem::action(t("desktop.menu.zoomOut", &[]), ZoomOut),
            MenuItem::action(t("desktop.menu.resetZoom", &[]), ZoomReset),
        ]),
        Menu::new(t("desktop.menu.window", &[])).items([MenuItem::action(t("desktop.menu.close", &[]), CloseTab)]),
    ]);

    cx.bind_keys([
        KeyBinding::new("cmd-1", ActivateProject1, Some("Shell")),
        KeyBinding::new("cmd-2", ActivateProject2, Some("Shell")),
        KeyBinding::new("cmd-3", ActivateProject3, Some("Shell")),
        KeyBinding::new("cmd-4", ActivateProject4, Some("Shell")),
        KeyBinding::new("cmd-5", ActivateProject5, Some("Shell")),
        KeyBinding::new("cmd-6", ActivateProject6, Some("Shell")),
        KeyBinding::new("cmd-7", ActivateProject7, Some("Shell")),
        KeyBinding::new("cmd-8", ActivateProject8, Some("Shell")),
        KeyBinding::new("cmd-9", ActivateProject9, Some("Shell")),
        KeyBinding::new("cmd-b", ToggleSidebar, Some("Shell")),
        KeyBinding::new("cmd-=", ZoomIn, Some("Shell")),
        KeyBinding::new("cmd-+", ZoomIn, Some("Shell")),
        KeyBinding::new("cmd--", ZoomOut, Some("Shell")),
        KeyBinding::new("cmd-0", ZoomReset, Some("Shell")),
        KeyBinding::new("cmd-p", GoToFile, Some("Shell")),
        KeyBinding::new("cmd-shift-p", CommandPalette, Some("Shell")),
        KeyBinding::new("cmd-shift-f", SearchProject, Some("Shell")),
        KeyBinding::new("cmd-t", NewTerminal, Some("Shell")),
        KeyBinding::new("cmd-w", CloseTab, Some("Shell")),
        KeyBinding::new("cmd-d", SplitRight, Some("Shell")),
        KeyBinding::new("cmd-shift-d", SplitDown, Some("Shell")),
        KeyBinding::new("cmd-shift-]", NextTab, Some("Shell")),
        KeyBinding::new("cmd-shift-[", PrevTab, Some("Shell")),
        KeyBinding::new("cmd-`", FocusNextGroup, Some("Shell")),
        KeyBinding::new("escape", ClosePalette, Some("Palette")),
        KeyBinding::new("cmd-q", Quit, Some("Shell")),
        // Terminal-only keys: outside a terminal Cmd+C/V belong to the focused view.
        KeyBinding::new("cmd-c", crate::terminal::Copy, Some("Terminal")),
        KeyBinding::new("cmd-v", crate::terminal::Paste, Some("Terminal")),
        KeyBinding::new("cmd-k", crate::terminal::Clear, Some("Terminal")),
        KeyBinding::new("shift-pageup", crate::terminal::ScrollPageUp, Some("Terminal")),
        KeyBinding::new("shift-pagedown", crate::terminal::ScrollPageDown, Some("Terminal")),
        KeyBinding::new("shift-end", crate::terminal::ScrollToBottom, Some("Terminal")),
    ]);
}

const SETTINGS_KEY: &str = crate::theme::SETTINGS_KEY;
const ACTIVE_KEY: &str = "app.active_project";
const SIDEBAR_MIN: f32 = 180.0;
const SIDEBAR_MAX: f32 = 560.0;

type GitSnapshot = (Repo, Status, Vec<Branch>, Vec<Worktree>, Vec<Commit>);

/// UI-side state of one open project: its tree, git state and file index.
pub struct ProjectView {
    pub tree: TreeState,
    pub repo_root: Option<PathBuf>,
    pub status: Option<Status>,
    pub tones: HashMap<PathBuf, &'static str>,
    pub branches: Vec<Branch>,
    pub worktrees: Vec<Worktree>,
    pub log: Vec<Commit>,
    pub git_error: Option<String>,
    pub git_busy: bool,
    pub index: Option<Arc<FileIndex>>,
    _watcher: Option<Watcher>,
}

pub struct Palette {
    pub view: Entity<HostedView>,
    pub open: bool,
    pub mode: PaletteMode,
    pub query: String,
    /// Bumped per query so late results of an older one are dropped.
    seq: u64,
    _sub: Subscription,
}

/// A project's git state as the sidebar shows it.
pub struct GitSummary {
    pub branch: Option<String>,
    pub worktrees: Vec<vibevalley_git::Worktree>,
}

pub struct Shell {
    pub store: Option<Arc<Store>>,
    pub ws: Workspace<TermSession>,
    pub loaded: bool,
    server_ready: bool,
    island: Option<crate::island::Island>,
    /// VibeValley's opening over the window until the projects are in (`VIBEVALLEY_NO_OPENING=1` skips it).
    pub launch: Option<Entity<crate::pixel::view::PixelView>>,
    pub load_error: Option<String>,
    pub projects: HashMap<ProjectId, ProjectView>,
    /// Every project's branch and worktrees, read for the sidebar whether or
    /// not the project was opened (its full view is built on first open).
    pub git_summaries: HashMap<ProjectId, GitSummary>,
    pub terminals: HashMap<String, Entity<TerminalView>>,
    pub panes: HashMap<(ProjectId, TabId), PaneEntity>,
    pub sidebar: Entity<HostedView>,
    pub inspector: Entity<HostedView>,
    pub workbench: Entity<HostedView>,
    pub native_workspace: bool,
    pub native_pixel: Option<Entity<crate::pixel::view::PixelView>>,
    pub global_rail_width: f32,
    pub palette: Option<Palette>,
    pub panel: Panel,
    pub inspector_open: bool,
    pub inspector_width: f32,
    pub tasks: Option<TaskManager>,
    pub selected_task: Option<String>,
    pub sidebar_width: f32,
    pub sidebar_visible: bool,
    /// Last `host.tray` summary, `host.locale` and `host.opening` from the views.
    pub tray: Option<Value>,
    pub locale: Option<String>,
    pub opening: Option<Value>,
    pub probe: Option<Value>,
    resizing_sidebar: bool,
    resizing_inspector: bool,
    pub split_bounds: SplitBounds,
    pub dragging_split: Option<(u64, usize)>,
    focus: FocusHandle,
    save_pending: bool,
    fs_tx: flume::Sender<(ProjectId, Vec<FsChange>)>,
    git_refresh_pending: BTreeSet<ProjectId>,
    _subs: Vec<Subscription>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = Ui::get(cx).colors.dark;
        let sidebar = cx.new(|cx| HostedView::new("sidebar", serde_json::from_value(json!({"contextual":true})).unwrap(), dark, window, cx));
        let sub = cx.subscribe_in(&sidebar, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => this.push_sidebar(cx),
        });
        let inspector = cx.new(|cx| HostedView::new("sidebar", serde_json::from_value(json!({"role":"inspector"})).unwrap(), dark, window, cx));
        let inspector_sub = cx.subscribe_in(&inspector, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
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
            HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => {}
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
        let quit = cx.on_app_quit(|this: &mut Shell, _| {
            this.island = None;
            crate::live_voice::stop(None);
            crate::speech_audio::stop(None);
            crate::audio::stop_queued();
            let jobs = this.ws.save_jobs();
            let store = this.store.clone();
            async move {
                if let Some(store) = store {
                    let done = std::thread::spawn(move || {
                        for job in jobs {
                            if let Err(e) = job.run(&*store) {
                                eprintln!("save on quit: {e}");
                            }
                        }
                    });
                    let _ = done.join();
                }
            }
        });
        let mut shell = Shell {
            store: None,
            ws: Workspace::new(),
            loaded: false,
            server_ready: false,
            island: None,
            launch: (std::env::var_os("VIBEVALLEY_NO_OPENING").is_none())
                .then(|| cx.new(|cx| crate::pixel::view::PixelView::new("opening:launch", json!({}), cx))),
            load_error: None,
            projects: HashMap::new(),
            git_summaries: HashMap::new(),
            terminals: HashMap::new(),
            panes: HashMap::new(),
            sidebar,
            inspector,
            workbench,
            native_workspace: false,
            native_pixel: None,
            global_rail_width: 76.0,
            palette: None,
            panel: Panel::Files,
            inspector_open: true,
            inspector_width: 280.0,
            tasks: None,
            selected_task: None,
            sidebar_width: Ui::get(cx).settings.sidebar_width,
            sidebar_visible: Ui::get(cx).settings.sidebar_visible,
            tray: None,
            locale: None,
            opening: None,
            probe: None,
            resizing_sidebar: false,
            resizing_inspector: false,
            split_bounds: SplitBounds::default(),
            dragging_split: None,
            focus: cx.focus_handle(),
            save_pending: false,
            fs_tx,
            git_refresh_pending: BTreeSet::new(),
            _subs: vec![sub, inspector_sub, workbench_sub, quit],
        };
        if let Some(startup) = cx.try_global::<crate::hosted::ServerStartup>().map(|s| s.0.clone()) {
            cx.spawn(async move |this, cx| {
                let result = startup.recv_async().await.unwrap_or_else(|_| Err("the server startup channel closed".into()));
                let _ = this.update(cx, |shell, cx| {
                    match result {
                        Ok(()) => {
                            shell.server_ready = true;
                            shell.finish_opening(true, cx);
                        }
                        Err(error) => {
                            eprintln!("{error}");
                            shell.load_error = Some(error);
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
                shell.island = Some(island);
                let frames = cx.global::<crate::hosted::BridgeHub>().0.server().state();
                cx.spawn(async move |this, cx| {
                    while let Ok(value) = frames.recv_async().await {
                        let frame = match serde_json::from_value::<vibevalley_protocol::StateFrame>(value) {
                            Ok(frame) => frame,
                            Err(error) => {
                                eprintln!("island frame: {error}");
                                continue;
                            }
                        };
                        if this
                            .update(cx, |shell, _| {
                                if let Some(island) = &shell.island {
                                    island.show(&crate::island::glance(&frame));
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
                cx.spawn(async move |this, cx| {
                    while let Ok(issue) = opened.recv_async().await {
                        if this
                            .update(cx, |shell, cx| {
                                shell.native_workspace = false;
                                shell.native_pixel = None;
                                shell.workbench.update(cx, |view, cx| view.navigate(&format!("/issues/{issue}"), cx));
                                cx.activate(true);
                                cx.notify();
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
        shell.load(cx);
        shell
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
        let path = std::env::var_os("VIBEVALLEY_STORE").map(PathBuf::from).unwrap_or_else(Store::default_path);
        Self::bg(
            cx,
            move || -> Result<_, String> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                let store = Store::open(&path).map_err(|e| e.to_string())?;
                let mut projects = load_all(&store).map_err(|e| e.to_string())?;
                if projects.is_empty()
                    && let Some(cwd) = cwd
                {
                    projects.push(load_project(&store, &cwd).map_err(|e| e.to_string())?);
                }
                let settings: Settings = vibevalley_workspace::persist::load_setting(&store, SETTINGS_KEY);
                let active: Option<ProjectId> = store.setting(ACTIVE_KEY).ok().flatten().and_then(|v| v.as_i64());
                Ok((Arc::new(store), projects, settings, active))
            },
            |this, result, cx| match result {
                Ok((store, projects, settings, active)) => {
                    let theme_changed = settings.theme != Ui::get(cx).settings.theme;
                    this.sidebar_width = settings.sidebar_width;
                    this.sidebar_visible = settings.sidebar_visible;
                    Ui::apply(settings, cx);
                    if theme_changed {
                        this.theme_changed(cx);
                    }
                    for p in projects {
                        let id = this.ws.open(p);
                        if let Some(proj) = this.ws.project_mut(id) {
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
                        this.ws.activate(id);
                    }
                    this.start_tasks(store.clone(), cx);
                    this.store = Some(store);
                    this.loaded = true;
                    if let Some(id) = this.ws.active_id() {
                        this.ensure_project_view(id, cx);
                    }
                    this.refresh_summaries(cx);
                    this.push_sidebar(cx);
                    this.finish_opening(true, cx);
                    cx.notify();
                }
                Err(e) => {
                    eprintln!("could not load projects: {e}");
                    this.load_error = Some(e);
                    this.loaded = true;
                    this.finish_opening(false, cx);
                    cx.notify();
                }
            },
        );
    }

    /// The opening says it is there (or failed), then gives way after a moment.
    fn finish_opening(&mut self, ok: bool, cx: &mut Context<Self>) {
        let Some(opening) = self.launch.clone() else { return };
        if ok && (!self.loaded || !self.server_ready || self.load_error.is_some()) {
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
            cx.background_executor().timer(std::time::Duration::from_millis(900)).await;
            let _ = this.update(cx, |s, cx| {
                s.launch = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn start_tasks(&mut self, store: Arc<Store>, cx: &mut Context<Self>) {
        let (manager, rx) = TaskManager::new(
            vibevalley_oar::default_runtimes(),
            store,
            Arc::new(vibevalley_workspace::git::SystemGit),
            Default::default(),
        );
        self.tasks = Some(manager.clone());
        cx.spawn(async move |this, cx| {
            while let Ok(event) = rx.recv_async().await {
                let alive = this.update(cx, |s, cx| {
                    if let vibevalley_workspace::TaskEvent::Transcript { task_id, .. } = &event {
                        s.push_transcript(task_id, cx);
                    }
                    s.push_agents(cx);
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    // ---- projects -------------------------------------------------------

    pub fn activate_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.ws.activate_index(index) {
            self.show_workspace(cx);
            self.after_activate(id, window, cx);
        }
    }

    pub fn activate_project(&mut self, id: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        if self.ws.activate(id) {
            self.after_activate(id, window, cx);
        }
    }

    pub fn ensure_project_at(&mut self, path: &Path, cx: &mut Context<Self>) -> Option<ProjectId> {
        let cleaned: PathBuf = path.components().collect();
        let path = if cleaned.as_os_str().is_empty() { path.to_path_buf() } else { cleaned };
        if let Some(p) = self.ws.projects().iter().find(|p| p.root() == path) {
            return Some(p.id());
        }
        if !path.is_dir() {
            return None;
        }
        let loaded = self.store.as_ref().and_then(|s| load_project(&**s, &path).ok()).unwrap_or_else(|| {
            let next_id = self.ws.projects().iter().map(|p| p.id()).min().unwrap_or(0).min(0) - 1;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            vibevalley_workspace::LoadedProject {
                info: vibevalley_store::Project {
                    id: next_id,
                    path: path.clone(),
                    name,
                    position: self.ws.projects().len() as i64,
                    last_opened_ms: 0,
                },
                layout: None,
                terminals: Vec::new(),
            }
        });
        let id = self.ws.open(loaded);
        self.ensure_project_view(id, cx);
        Some(id)
    }

    pub fn activate_path(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        if let Some(id) = self.ensure_project_at(&path, cx) {
            self.activate_project(id, window, cx);
        }
    }

    fn after_activate(&mut self, id: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_project_view(id, cx);
        if let Some(store) = self.store.clone() {
            Self::bg(
                cx,
                move || {
                    let _ = store.touch_project(id);
                    let _ = store.set_setting(ACTIVE_KEY, &json!(id));
                },
                |_, _, _| {},
            );
        }
        self.push_sidebar(cx);
        self.focus_active_pane(window, cx);
        cx.notify();
    }

    fn add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add Project".into()),
        });
        let store = self.store.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let (Some(path), Some(store)) = (paths.into_iter().next(), store) else {
                return;
            };
            let loaded = cx.background_spawn(async move { load_project(&*store, &path) }).await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match loaded {
                    Ok(p) => {
                        let id = s.ws.open(p);
                        s.activate_project(id, window, cx);
                        s.refresh_summaries(cx);
                    }
                    Err(e) => eprintln!("add project: {e}"),
                });
            });
        })
        .detach();
    }

    fn close_project(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(job) = self.ws.close(id) else { return };
        self.projects.remove(&id);
        self.panes.retain(|(p, _), _| *p != id);
        let live: BTreeSet<String> = self.ws.projects().iter().flat_map(|p| p.layout.terminal_ids()).collect();
        self.terminals.retain(|tid, _| live.contains(tid));
        if let Some(store) = self.store.clone() {
            Self::bg(
                cx,
                move || {
                    let _ = job.run(&*store);
                    let _ = store.remove_project(id);
                },
                |_, _, _| {},
            );
        }
        if let Some(active) = self.ws.active_id() {
            self.ensure_project_view(active, cx);
        }
        self.refresh_summaries(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    /// Starts the watcher, lists the root, reads git state and indexes files
    /// the first time a project is shown.
    pub fn ensure_project_view(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        if self.projects.contains_key(&id) {
            return;
        }
        let Some(root) = self.ws.project(id).map(|p| p.root().to_path_buf()) else {
            return;
        };
        let tx = self.fs_tx.clone();
        let watcher = Watcher::new(&root, move |changes| {
            let _ = tx.send((id, changes));
        })
        .map_err(|e| eprintln!("watch {}: {e}", root.display()))
        .ok();
        self.projects.insert(
            id,
            ProjectView {
                tree: TreeState::new(root.clone()),
                repo_root: None,
                status: None,
                tones: HashMap::new(),
                branches: Vec::new(),
                worktrees: Vec::new(),
                log: Vec::new(),
                git_error: None,
                git_busy: false,
                index: None,
                _watcher: watcher,
            },
        );
        self.load_dirs(id, cx);
        self.refresh_git(id, cx);
        if let Some(tasks) = self.tasks.clone() {
            let history_root = root.clone();
            Self::bg(
                cx,
                move || tasks.load_history(id, &history_root),
                |s, r, cx| {
                    if let Err(e) = r {
                        eprintln!("agent history: {e}");
                    }
                    s.push_agents(cx);
                },
            );
        }
        let index_root = root.clone();
        Self::bg(
            cx,
            move || FileIndex::build(&index_root),
            move |s, index, cx| match index {
                Ok(index) => {
                    if let Some(pv) = s.projects.get_mut(&id) {
                        pv.index = Some(Arc::new(index));
                    }
                    s.refresh_palette(cx);
                }
                Err(e) => eprintln!("index {}: {e}", root.display()),
            },
        );
    }

    fn load_dirs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.projects.get(&id) else { return };
        let wanted = pv.tree.wanted();
        if wanted.is_empty() {
            self.push_sidebar(cx);
            return;
        }
        let root = pv.tree.root.clone();
        Self::bg(
            cx,
            move || {
                wanted
                    .into_iter()
                    .map(|dir| {
                        let listed = vibevalley_files::list_dir(&root, &dir, false);
                        (dir, listed)
                    })
                    .collect::<Vec<_>>()
            },
            move |s, listed, cx| {
                if let Some(pv) = s.projects.get_mut(&id) {
                    for (dir, result) in listed {
                        match result {
                            Ok(entries) => {
                                pv.tree.children.insert(dir, entries);
                            }
                            Err(e) => {
                                eprintln!("list {}: {e}", dir.display());
                                pv.tree.expanded.remove(&dir);
                                pv.tree.children.insert(dir, Vec::new());
                            }
                        }
                    }
                }
                s.push_sidebar(cx);
            },
        );
    }

    /// Reads the branch and worktrees of every project the sidebar lists.
    pub fn refresh_summaries(&mut self, cx: &mut Context<Self>) {
        let roots: Vec<(ProjectId, std::path::PathBuf)> = self.ws.projects().iter().map(|p| (p.id(), p.root().to_path_buf())).collect();
        Self::bg(
            cx,
            move || {
                roots
                    .into_iter()
                    .filter_map(|(id, root)| {
                        let repo = Repo::discover(&root).ok()??;
                        let branch = repo.status().ok().and_then(|s| s.branch);
                        let worktrees = repo.worktrees().unwrap_or_default();
                        Some((id, GitSummary { branch, worktrees }))
                    })
                    .collect::<Vec<_>>()
            },
            |s, read, cx| {
                s.git_summaries = read.into_iter().collect();
                s.push_sidebar(cx);
            },
        );
    }

    pub fn refresh_git(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.projects.get_mut(&id) else { return };
        pv.git_busy = true;
        let root = pv.tree.root.clone();
        Self::bg(
            cx,
            move || -> Result<Option<GitSnapshot>, String> {
                let Some(repo) = Repo::discover(&root).map_err(|e| e.to_string())? else {
                    return Ok(None);
                };
                let status = repo.status().map_err(|e| e.to_string())?;
                let branches = repo.branches().unwrap_or_default();
                let worktrees = repo.worktrees().unwrap_or_default();
                let log = repo.log(None, 0, 50).unwrap_or_default();
                Ok(Some((repo, status, branches, worktrees, log)))
            },
            move |s, result, cx| {
                if let Some(pv) = s.projects.get_mut(&id) {
                    pv.git_busy = false;
                    match result {
                        Ok(Some((repo, status, branches, worktrees, log))) => {
                            pv.tones = frames::path_tones(repo.root(), &status);
                            pv.repo_root = Some(repo.root().to_path_buf());
                            pv.status = Some(status);
                            pv.branches = branches;
                            pv.worktrees = worktrees;
                            pv.log = log;
                            pv.git_error = None;
                        }
                        Ok(None) => {
                            pv.status = None;
                            pv.git_error = Some("This project is not a git repository.".into());
                        }
                        Err(e) => pv.git_error = Some(e),
                    }
                }
                s.push_sidebar(cx);
                s.reload_diffs(id, cx);
            },
        );
    }

    fn on_fs_changes(&mut self, id: ProjectId, changes: Vec<FsChange>, cx: &mut Context<Self>) {
        let mut git = false;
        let mut files = Vec::new();
        if let Some(pv) = self.projects.get_mut(&id) {
            for change in &changes {
                if Watcher::is_git_state_path(&change.path) {
                    git = true;
                    continue;
                }
                git = true;
                pv.tree.invalidate(&change.path);
                files.push(change.path.clone());
            }
            if pv.tree.children.is_empty() || !files.is_empty() {
                self.load_dirs(id, cx);
            }
        }
        for ((p, _), pane) in &self.panes {
            if *p == id
                && let PaneEntity::File(viewer) = pane
            {
                let path = viewer.read(cx).path().to_path_buf();
                if files.contains(&path) {
                    viewer.update(cx, |v, cx| v.reload(cx));
                }
            }
        }
        if git && self.git_refresh_pending.insert(id) {
            // Debounced: a checkout or build touches many files at once.
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                let _ = this.update(cx, |s, cx| {
                    s.git_refresh_pending.remove(&id);
                    s.refresh_git(id, cx);
                });
            })
            .detach();
        }
    }

    fn reload_diffs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        for ((p, _), pane) in &self.panes {
            if *p == id
                && let PaneEntity::Diff(view) = pane
            {
                view.update(cx, |v, cx| v.reload(cx));
            }
        }
    }

    // ---- frames -------------------------------------------------------------

    pub fn push_sidebar(&mut self, cx: &mut Context<Self>) {
        let rail_items: Vec<RailProject> = self
            .ws
            .projects()
            .iter()
            .map(|p| RailProject {
                id: p.id(),
                name: &p.info.name,
                path: p.root(),
                active: Some(p.id()) == self.ws.active_id(),
                attention: p.needs_attention(),
                terminals: p.live_terminals(),
            })
            .collect();
        let mut rail = frames::rail(&rail_items, self.panel.name());
        rail["inspectorOpen"] = Value::Bool(self.inspector_open);
        if let Some(arr) = rail["projects"].as_array_mut() {
            for (i, p) in self.ws.projects().iter().enumerate() {
                let Some(item) = arr.get_mut(i) else { continue };
                let pv = self.projects.get(&p.id());
                let summary = self.git_summaries.get(&p.id());
                let worktrees = pv.map(|v| &v.worktrees).filter(|w| !w.is_empty()).or(summary.map(|s| &s.worktrees));
                item["branch"] = json!(
                    pv.and_then(|v| v.status.as_ref()?.branch.clone())
                        .or_else(|| summary.and_then(|s| s.branch.clone()))
                );
                item["mainRoot"] = json!(worktrees.and_then(|ws| ws.iter().find(|w| w.is_main).map(|w| w.path.to_string_lossy().into_owned())));
                item["worktrees"] = json!(
                    worktrees
                        .map(|ws| {
                            ws.iter()
                                .map(|w| {
                                    json!({
                                        "path": w.path.to_string_lossy(),
                                        "branch": w.branch,
                                        "main": w.is_main,
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                );
                let active_tab = p.layout.active_tab().map(|t| t.id);
                let names = crate::panes::numbered_titles(self, p.layout.tabs(), cx);
                let tabs: Vec<Value> = p
                    .layout
                    .tabs()
                    .map(|t| {
                        let title = names.get(&t.id).cloned().unwrap_or_else(|| crate::panes::tab_title(self, t, cx));
                        let (kind, running, running_agent, running_label, attention) = match &t.kind {
                            PaneKind::Terminal { terminal_id } => {
                                let status = self.terminals.get(terminal_id).and_then(|v| v.read(cx).running_status());
                                let att = p.terminal(terminal_id).is_some_and(|e| e.attention);
                                (
                                    "terminal",
                                    status.is_some(),
                                    status.as_ref().map(|(a, _)| a.clone()),
                                    status.map(|(_, l)| l),
                                    att,
                                )
                            }
                            PaneKind::File { .. } => ("file", false, None, None, false),
                            PaneKind::Diff { .. } => ("diff", false, None, None, false),
                            PaneKind::Agent { .. } => ("agent", false, None, None, false),
                            PaneKind::Hosted { .. } => ("hosted", false, None, None, false),
                            PaneKind::Pixel { .. } => ("pixel", false, None, None, false),
                        };
                        json!({
                            "id": t.id,
                            "title": title,
                            "active": active_tab == Some(t.id),
                            "kind": kind,
                            "running": running,
                            "runningAgent": running_agent,
                            "runningLabel": running_label,
                            "attention": attention,
                        })
                    })
                    .collect();
                item["tabs"] = Value::Array(tabs);
            }
        }
        let (files, git) = match self.ws.active_id().and_then(|id| self.projects.get(&id)) {
            Some(pv) => (
                frames::file_tree(&pv.tree, &pv.tones),
                frames::git_panel(&frames::GitView {
                    status: pv.status.as_ref(),
                    branches: &pv.branches,
                    worktrees: &pv.worktrees,
                    log: &pv.log,
                    error: pv.git_error.as_deref(),
                    busy: pv.git_busy,
                }),
            ),
            None => (json!({ "items": [], "loading": !self.loaded }), json!({ "repo": false, "busy": !self.loaded })),
        };
        self.sidebar.update(cx, |v, cx| {
            v.push("rail", rail.clone(), cx);
            v.push("files", files.clone(), cx);
            v.push("git", git.clone(), cx);
        });
        self.inspector.update(cx, |v, cx| {
            v.push("rail", rail, cx);
            v.push("files", files, cx);
            v.push("git", git, cx);
        });
        self.push_agents(cx);
    }

    pub fn push_agents(&mut self, cx: &mut Context<Self>) {
        let Some(tasks) = &self.tasks else { return };
        let project = self.ws.active_id();
        let list = tasks.tasks(project);
        let pending = tasks.pending_permissions();
        let runtimes: Vec<Value> = tasks.runtimes().iter().map(|r| json!({ "id": r.id, "name": r.display_name })).collect();
        let mut agents = frames::tasks(&list, self.selected_task.as_deref());
        agents["runtimes"] = Value::Array(runtimes);
        agents["counts"] = {
            let c = tasks.counts(project);
            json!({ "running": c.running, "waiting": c.waiting, "review": c.review, "failed": c.failed })
        };
        let inbox = frames::inbox(&pending, &list);
        self.sidebar.update(cx, |v, cx| {
            v.push("agents", agents.clone(), cx);
            v.push("inbox", inbox.clone(), cx);
        });
        self.inspector.update(cx, |v, cx| {
            v.push("agents", agents, cx);
            v.push("inbox", inbox, cx);
        });
    }

    fn push_transcript(&mut self, task_id: &str, cx: &mut Context<Self>) {
        let Some(tasks) = &self.tasks else { return };
        let running = tasks
            .task(task_id)
            .is_some_and(|t| matches!(t.phase, TaskPhase::Running | TaskPhase::Preparing));
        let (entries, _) = tasks.transcript(task_id, 0);
        let mut frame = frames::transcript(&entries, running);
        if let Some(t) = tasks.task(task_id) {
            let (tone, label) = frames::phase_tone(t.phase);
            frame["task"] = json!({ "id": t.id, "title": t.title, "tone": tone, "label": label, "createdMs": t.created_ms });
        }
        for ((_, _), pane) in &self.panes {
            if let PaneEntity::Hosted { view, task: Some(t), .. } = pane
                && t == task_id
            {
                let frame = frame.clone();
                view.update(cx, |v, cx| v.push("transcript", frame, cx));
            }
        }
    }

    // ---- actions from hosted views --------------------------------------

    pub fn on_action(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.ws.active_id();
        match action {
            Action::GlobalRail { rail_width } => {
                self.global_rail_width = rail_width.clamp(56.0, 80.0);
                cx.notify();
            }
            Action::GlobalRoute { path } => {
                self.native_workspace = path == "/workspace";
                if !path.starts_with("/farm") && path != "/tree" {
                    self.native_pixel = None;
                }
                cx.notify();
            }
            Action::Applied { .. } | Action::Ready => {}
            Action::Probe { results } => {
                eprintln!("bridge probe: {results}");
                self.probe = Some(results);
            }
            Action::Call { op, .. } => eprintln!("host call {op} reached the shell without a reply handle"),
            Action::OpenTerminal { cwd, title, command } => {
                self.open_terminal_at(cwd, title, command, window, cx);
            }
            Action::ActivateProject { id } => self.activate_project(id, window, cx),
            Action::ActivatePath { path } => self.activate_path(path, window, cx),
            Action::ActivateTab { path, tab_id } => {
                self.activate_path(path, window, cx);
                if let Some(p) = self.ws.active_mut() {
                    p.layout.activate(tab_id);
                }
                self.layout_changed(window, cx);
            }
            Action::CloseTabAt { path, tab_id } => {
                self.activate_path(path, window, cx);
                self.close_tab(tab_id, window, cx);
            }
            Action::NewTerminalAt { path } => {
                self.activate_path(path, window, cx);
                self.new_terminal(None, window, cx);
            }
            Action::AddProject => self.add_project(window, cx),
            Action::CloseProject { id } => self.close_project(id, cx),
            Action::ShowPanel { panel } => {
                self.panel = panel;
                self.inspector_open = true;
                self.push_sidebar(cx);
                cx.notify();
            }
            Action::ExpandDir { path } => {
                if let Some(id) = active
                    && let Some(pv) = self.projects.get_mut(&id)
                {
                    pv.tree.expanded.insert(path);
                    self.load_dirs(id, cx);
                }
            }
            Action::CollapseDir { path } => {
                if let Some(pv) = active.and_then(|id| self.projects.get_mut(&id)) {
                    pv.tree.expanded.remove(&path);
                }
                self.push_sidebar(cx);
            }
            Action::OpenFile { path } => self.open_file(path, None, window, cx),
            Action::OpenFarm { repo } => {
                let props = if repo.is_empty() { json!({}) } else { json!({ "repo": repo }) };
                self.show_pixel("farm", props, window, cx)
            }
            Action::OpenTree => self.show_pixel("tree", json!({}), window, cx),
            Action::RevealInTerminal { path } => {
                let dir = if path.is_dir() {
                    path
                } else {
                    path.parent().map(Path::to_path_buf).unwrap_or(path)
                };
                self.new_terminal(Some(SpawnSpec::shell(dir)), window, cx);
            }
            Action::OpenDiff { path, staged } => {
                let spec = if staged {
                    vibevalley_workspace::DiffSpec::Staged
                } else {
                    vibevalley_workspace::DiffSpec::Unstaged
                };
                self.open_pane(PaneKind::Diff { spec, path, repo: None }, window, cx);
            }
            Action::OpenCommit { id } => self.open_pane(
                PaneKind::Diff {
                    spec: vibevalley_workspace::DiffSpec::Commit { id },
                    path: None,
                    repo: None,
                },
                window,
                cx,
            ),
            Action::Stage { paths } => self.git_op(move |r| r.stage(&paths), cx),
            Action::Unstage { paths } => self.git_op(move |r| r.unstage(&paths), cx),
            Action::Discard { paths } => self.git_op(move |r| r.discard(&paths), cx),
            Action::Commit { message } => self.git_op(move |r| r.commit(&message).map(|_| ()), cx),
            Action::Checkout { branch } => self.git_op(move |r| r.checkout(&branch), cx),
            Action::RefreshGit => {
                if let Some(id) = active {
                    self.refresh_git(id, cx);
                }
            }
            Action::PaletteQuery { query } => {
                if let Some(p) = &mut self.palette {
                    p.query = query;
                }
                self.refresh_palette(cx);
            }
            Action::PaletteSelect { id } => self.palette_select(&id, window, cx),
            Action::PaletteClose => self.close_palette(window, cx),
            Action::Search { query, regex, case_sensitive } => {
                if let Some(p) = &mut self.palette {
                    p.query = query;
                }
                self.run_search(regex, case_sensitive, cx);
            }
            Action::OpenHit { path, line } => self.open_file(path, Some(line), window, cx),
            Action::Decide { id, choice } => self.decide(&id, choice, cx),
            Action::CreateTask { prompt, runtime } => self.create_task(prompt, runtime, window, cx),
            Action::SelectTask { id } => {
                self.selected_task = Some(id.clone());
                self.open_pane(PaneKind::Agent { task_id: id.clone() }, window, cx);
                self.push_transcript(&id, cx);
                self.push_agents(cx);
            }
            Action::PromptTask { id, text } => {
                if let Some(t) = &self.tasks
                    && let Err(e) = t.prompt(&id, &text)
                {
                    eprintln!("prompt task {id}: {e}");
                }
            }
            Action::AbortTask { id } => {
                if let Some(t) = &self.tasks {
                    let _ = t.abort(&id);
                }
            }
        }
    }

    /// A terminal tab at `cwd`, optionally running `command` first.
    pub fn open_terminal_at(
        &mut self,
        cwd: PathBuf,
        title: Option<String>,
        command: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        self.show_workspace(cx);
        let cwd = if cwd.is_dir() {
            let cleaned: PathBuf = cwd.components().collect();
            let norm = if cleaned.as_os_str().is_empty() { cwd } else { cleaned };
            if (self.ws.projects().iter().any(|p| p.root() == norm) || norm.join(".git").exists())
                && let Some(id) = self.ensure_project_at(&norm, cx)
            {
                self.ws.activate(id);
                self.ensure_project_view(id, cx);
            }
            norm
        } else {
            self.ws.active().map(|p| p.root().to_path_buf())?
        };
        let mut spec = SpawnSpec::shell(cwd);
        if let Some(command) = command.filter(|c| !c.trim().is_empty()) {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            spec.program = Some(shell.clone());
            spec.args = vec!["-lc".into(), format!("{command}; exec {shell} -l")];
        }
        let _ = title;
        let has_command = spec.program.is_some();
        let project = self.ws.active_mut()?;
        let unspawned = (!has_command && spec.cwd == project.root())
            .then(|| {
                project.layout.tabs().find_map(|t| match &t.kind {
                    PaneKind::Terminal { terminal_id } if !self.terminals.contains_key(terminal_id) => Some(terminal_id.clone()),
                    _ => None,
                })
            })
            .flatten();
        let id = unspawned.unwrap_or_else(|| project.new_terminal_tab().0);
        let view = self.make_terminal(&id, spec, cx);
        self.terminals.insert(id.clone(), view);
        self.layout_changed(window, cx);
        Some(id)
    }

    /// A pixel scene's ask: a VibeValley page (the hosted `vv` view, given
    /// the route) or a terminal.
    pub fn on_pixel_event(&mut self, event: crate::pixel::view::PixelEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            crate::pixel::view::PixelEvent::Route(route) => self.open_pane(
                PaneKind::Hosted {
                    module: "vv".into(),
                    props: json!({ "route": route }),
                },
                window,
                cx,
            ),
            crate::pixel::view::PixelEvent::Pixel { scene, props } => self.open_pane(PaneKind::Pixel { scene, props }, window, cx),
            crate::pixel::view::PixelEvent::Terminal { cwd, title } => {
                self.open_terminal_at(PathBuf::from(cwd), Some(title), None, window, cx);
            }
        }
    }

    /// The `host.*` ops of the bridge: VibeValley's host capabilities
    /// (packages/protocol/src/host.ts) and VibeValley's terminal.
    pub fn host_call(&mut self, op: &str, payload: Value, reply: crate::hosted::Replier, window: &mut Window, cx: &mut Context<Self>) {
        use vibevalley_bridge::{BizCode, Envelope, refusal};
        if op.starts_with("host.update") {
            return crate::update::host_call(op, reply, cx);
        }
        let text = |k: &str| payload[k].as_str().unwrap_or_default().to_string();
        let envelope = match op {
            "host.info" => {
                let settings = &Ui::get(cx).settings;
                let mut fonts: Vec<String> = window
                    .text_system()
                    .all_font_names()
                    .into_iter()
                    .filter(|name| {
                        let lower = name.to_lowercase();
                        lower.contains("nerd")
                            || lower.contains(" nf")
                            || lower.contains("-nf")
                            || lower.contains("mono")
                            || lower.contains("menlo")
                            || lower.contains("monaco")
                            || lower.contains("consolas")
                            || lower.contains("courier")
                            || lower.contains("fira code")
                            || lower.contains("sarasa")
                            || lower.contains("maple")
                    })
                    .collect();
                fonts.sort();
                fonts.dedup();
                Envelope::ok(json!({
                    "name": "desktop",
                    "version": crate::update::version(),
                    "titleBar": { "top": 28, "left": 68 },
                    "terminal": true,
                    "monoFont": settings.mono_font,
                    "monoFonts": fonts,
                    "terminalFontSize": settings.terminal_font_size,
                    "uiFontSize": settings.ui_font_size,
                    "capabilities": ["notify", "tray", "locale", "reveal", "theme", "font", "opening", "openTerminal", "openUrl", "openFile", "pixelDir", "playAudio", "readFile", "commandLine", "seekAudio", "pcm", "pickFile", "saveFile", "update", "mossVoice"],
                }))
            }
            "host.cliState" | "host.cliInstall" | "host.cliRemove" => {
                let op = op.to_string();
                Self::bg(
                    cx,
                    move || {
                        let cli = crate::command_line::CommandLine::current()?;
                        match op.as_str() {
                            "host.cliInstall" => cli.install(),
                            "host.cliRemove" => cli.remove(),
                            _ => Ok(cli.state()),
                        }
                    },
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        })
                    },
                );
                return;
            }
            "host.font" => {
                let mut settings = Ui::get(cx).settings.clone();
                if let Some(family) = payload["monoFont"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    settings.mono_font = family.to_string();
                }
                if let Some(size) = payload["terminalFontSize"].as_f64() {
                    settings.terminal_font_size = (size as f32).clamp(9.0, 32.0);
                }
                if let Some(size) = payload["uiFontSize"].as_f64() {
                    settings.ui_font_size = (size as f32).clamp(10.0, 24.0);
                }
                let mono = settings.mono_font.clone();
                let term_size = settings.terminal_font_size;
                let ui_size = settings.ui_font_size;
                Ui::apply(settings, cx);
                self.save_settings(cx);
                cx.notify();
                Envelope::ok(json!({
                    "monoFont": mono,
                    "terminalFontSize": term_size,
                    "uiFontSize": ui_size,
                }))
            }
            "host.notify" => {
                let (title, body) = (text("title"), text("body"));
                Self::bg(
                    cx,
                    move || crate::host::notify(&title, &body),
                    |_, r, _| {
                        if let Err(e) = r {
                            eprintln!("notify: {e}");
                        }
                    },
                );
                Envelope::void()
            }
            "host.tray" => match serde_json::from_value::<crate::tray::Summary>(payload.clone()) {
                Ok(summary) => {
                    crate::tray::update(&summary);
                    self.tray = Some(payload.clone());
                    Envelope::void()
                }
                Err(error) => refusal(BizCode::InvalidInput, error.to_string()),
            },
            "host.locale" => {
                self.locale = payload.as_str().map(str::to_string);
                Envelope::void()
            }
            "host.reveal" => match payload.as_str() {
                Some(path) if path.starts_with('/') => {
                    let path = PathBuf::from(path);
                    Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
                    Envelope::void()
                }
                _ => refusal(BizCode::InvalidInput, "reveal takes an absolute path"),
            },
            "host.theme" => {
                let want = match payload.as_str() {
                    Some("light") => Some(false),
                    Some("dark") => Some(true),
                    Some("system") => Some(matches!(
                        window.appearance(),
                        gpui_kit::WindowAppearance::Dark | gpui_kit::WindowAppearance::VibrantDark
                    )),
                    _ => None,
                };
                match want {
                    Some(dark) => {
                        if dark != Ui::get(cx).colors.dark {
                            self.toggle_theme(cx);
                        }
                        Envelope::void()
                    }
                    None => refusal(BizCode::InvalidInput, "theme is light, dark or system"),
                }
            }
            "host.opening" => match serde_json::from_value::<crate::serving::Opening>(payload.clone()) {
                Ok(state) => {
                    if let Some(opening) = &self.launch {
                        opening.update(cx, |view, _| view.set_phase(state.phase.pixel(), state.progress.clamp(0.0, 100.0)));
                    }
                    self.opening = Some(payload.clone());
                    if state.phase == crate::serving::OpeningPhase::Ready {
                        self.finish_opening(true, cx);
                    }
                    cx.notify();
                    Envelope::void()
                }
                Err(error) => refusal(BizCode::InvalidInput, error.to_string()),
            },
            "host.openTerminal" => {
                let cwd = PathBuf::from(text("cwd"));
                let title = payload["title"].as_str().map(str::to_string);
                let command = payload["command"].as_str().map(str::to_string);
                match self.open_terminal_at(cwd, title, command, window, cx) {
                    Some(id) => Envelope::ok(json!({ "terminalId": id })),
                    None => refusal(BizCode::Refused, "no project is open to hold the terminal"),
                }
            }
            "host.openUrl" => {
                let url = text("url");
                if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                    cx.open_url(&url);
                    Envelope::void()
                } else {
                    refusal(BizCode::InvalidInput, "only http(s) and mailto URLs open")
                }
            }
            // Opens a file in the system's default app (a PDF, a picture).
            "host.openFile" => match payload["path"].as_str() {
                Some(path) if path.starts_with('/') && std::path::Path::new(path).exists() => {
                    let path = PathBuf::from(path);
                    Self::bg(
                        cx,
                        move || crate::host::open(&path),
                        |_, r, _| {
                            if let Err(e) = r {
                                eprintln!("open: {e}");
                            }
                        },
                    );
                    Envelope::void()
                }
                _ => refusal(BizCode::InvalidInput, "openFile takes the absolute path of an existing file"),
            },
            "host.pickFile" => {
                let chosen = cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: false,
                    prompt: None,
                });
                cx.spawn(async move |_, cx| {
                    let result = match chosen.await {
                        Ok(Ok(Some(paths))) => match paths.into_iter().next() {
                            Some(path) => cx.background_spawn(async move { crate::host::file_info(&path) }).await.map(Some),
                            None => Ok(None),
                        },
                        Ok(Ok(None)) => Ok(None),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    reply.send(match result {
                        Ok(file) => Envelope::ok(json!(file)),
                        Err(error) => refusal(BizCode::Refused, error),
                    });
                })
                .detach();
                return;
            }
            "host.saveFile" => {
                let source = PathBuf::from(text("path"));
                if !source.is_absolute() || !source.is_file() {
                    reply.send(refusal(BizCode::InvalidInput, "saveFile requires an absolute path to a regular file"));
                    return;
                }
                let name = payload["name"]
                    .as_str()
                    .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'))
                    .or_else(|| source.file_name().and_then(|s| s.to_str()));
                let directory = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
                let chosen = cx.prompt_for_new_path(&directory, name);
                cx.spawn(async move |_, cx| {
                    let result = match chosen.await {
                        Ok(Ok(Some(target))) => cx.background_spawn(async move { crate::host::copy_file(&source, &target).map(|_| true) }).await,
                        Ok(Ok(None)) => Ok(false),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    reply.send(match result {
                        Ok(saved) => Envelope::ok(json!({"saved": saved})),
                        Err(error) => refusal(BizCode::Refused, error),
                    });
                })
                .detach();
                return;
            }
            "host.speechState" => Envelope::ok(json!(crate::speech_audio::state(&text("id")))),
            "host.speechStart" => match crate::serving::speech().and_then(|speech| crate::speech_audio::start(speech, &text("id"))) {
                Ok(state) => Envelope::ok(json!(state)),
                Err(error) => refusal(BizCode::Refused, error),
            },
            "host.speechStop" => Envelope::ok(json!(crate::speech_audio::stop(Some(&text("id"))))),
            "host.voiceState" => Envelope::ok(json!(crate::live_voice::state(&text("id")))),
            "host.voiceStart" => match crate::serving::voice().and_then(|voice| crate::live_voice::start(voice, text("id"))) {
                Ok(state) => Envelope::ok(json!(state)),
                Err(error) => refusal(BizCode::Refused, error),
            },
            "host.voiceStop" => Envelope::ok(json!(crate::live_voice::stop(Some(&text("id"))))),
            "host.voiceMute" => match payload["muted"].as_bool() {
                Some(muted) => Envelope::ok(json!(crate::live_voice::mute(&text("id"), muted))),
                None => refusal(BizCode::InvalidInput, "voiceMute requires a boolean muted value"),
            },
            "host.playAudio" => {
                let seconds = payload["position"].as_f64().unwrap_or(0.0);
                let path = payload["path"].as_str().map(PathBuf::from);
                let data = payload["data"].as_str().map(str::to_string);
                let kind = text("type");
                crate::audio::dispatch(reply, move || match (path, data) {
                    (Some(path), None) => crate::audio::play(&path, seconds),
                    (None, Some(data)) if data.len() <= crate::host::MAX_SOUND_BASE64 && seconds == 0.0 => crate::host::play_audio_data(&data, &kind),
                    _ => Err("playAudio requires one file path or at most 2 MB of encoded sound".into()),
                });
                return;
            }
            "host.seekAudio" => {
                let seconds = payload["position"].as_f64().unwrap_or(f64::NAN);
                crate::audio::dispatch(reply, move || crate::audio::seek(seconds));
                return;
            }
            "host.audioState" => {
                crate::audio::dispatch(reply, || Ok(crate::audio::state()));
                return;
            }
            "host.pcmStart" => {
                let format = serde_json::from_value::<crate::audio::PcmFormat>(payload.clone());
                crate::audio::dispatch(reply, move || crate::audio::start_pcm(format.map_err(|e| e.to_string())?));
                return;
            }
            "host.pcmAppend" => {
                let data = text("data");
                crate::audio::dispatch(reply, move || crate::audio::append_pcm(&data));
                return;
            }
            // A file the user dropped on a view: nsh gives views file: URLs
            // and no way to read them.
            "host.readFile" => {
                let path = payload["path"].as_str().unwrap_or_default();
                let path = path.strip_prefix("file://").unwrap_or(path);
                let path = percent_decode(path);
                if !path.starts_with('/') {
                    refusal(BizCode::InvalidInput, "readFile takes an absolute path or a file: URL")
                } else {
                    let path = PathBuf::from(path);
                    Self::bg(
                        cx,
                        move || crate::host::read_file(&path),
                        move |_, r, _| {
                            reply.send(match r {
                                Ok(v) => Envelope::ok(v),
                                Err(e) => refusal(BizCode::InvalidInput, e),
                            });
                        },
                    );
                    return;
                }
            }
            "host.stopAudio" => {
                crate::audio::dispatch(reply, || {
                    crate::audio::stop();
                    Ok(())
                });
                return;
            }
            // VibeValley's built pixel art: sprites.json and its PNGs.
            "host.pixelDir" => {
                let dir = crate::pixel::assets_dir().join("pixel");
                if dir.join("sprites.json").is_file() {
                    Envelope::ok(json!({ "path": dir }))
                } else {
                    refusal(BizCode::NotFound, "the pixel art is not installed")
                }
            }
            other => refusal(BizCode::RouteNotFound, format!("the host has no op {other}")),
        };
        reply.send(envelope);
    }

    fn git_op(&mut self, op: impl FnOnce(&Repo) -> vibevalley_git::Result<()> + Send + 'static, cx: &mut Context<Self>) {
        let Some(id) = self.ws.active_id() else { return };
        let Some(root) = self.projects.get(&id).map(|p| p.repo_root.clone().unwrap_or(p.tree.root.clone())) else {
            return;
        };
        Self::bg(
            cx,
            move || -> Result<(), String> {
                let repo = Repo::discover(&root).map_err(|e| e.to_string())?.ok_or("not a repository")?;
                op(&repo).map_err(|e| e.to_string())
            },
            move |s, result, cx| {
                if let Err(e) = result
                    && let Some(pv) = s.projects.get_mut(&id)
                {
                    pv.git_error = Some(e);
                }
                s.refresh_git(id, cx);
            },
        );
    }

    fn decide(&mut self, id: &str, choice: Choice, cx: &mut Context<Self>) {
        let Some(tasks) = self.tasks.clone() else { return };
        if let Some(rest) = id.strip_prefix("perm:")
            && let Some((task, request)) = rest.split_once(':')
        {
            let decision = match choice {
                Choice::Primary => vibevalley_oar::PermissionDecision::AllowOnce,
                Choice::Secondary => vibevalley_oar::PermissionDecision::Deny { message: None },
            };
            if let Err(e) = tasks.respond_permission(task, request, decision) {
                eprintln!("permission {id}: {e}");
            }
        } else if let Some(task) = id.strip_prefix("review:") {
            let task = task.to_string();
            match choice {
                Choice::Primary => Self::bg(
                    cx,
                    move || tasks.merge(&task, true),
                    |s, r, cx| {
                        if let Err(e) = r {
                            eprintln!("merge: {e}");
                        }
                        s.push_agents(cx);
                    },
                ),
                Choice::Secondary => {
                    let _ = tasks.prompt(&task, "The review sent this back: keep working on it.");
                }
            }
        }
        self.push_agents(cx);
    }

    fn create_task(&mut self, prompt: String, runtime: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(tasks), Some(project)) = (self.tasks.clone(), self.ws.active()) else {
            return;
        };
        let title: String = prompt.lines().next().unwrap_or("Task").chars().take(60).collect();
        let spec = TaskSpec {
            project_id: project.id(),
            project_root: project.root().to_path_buf(),
            title,
            prompt,
            runtime_id: runtime.unwrap_or_else(|| "scripted".into()),
            model: None,
            permission_mode: Default::default(),
            isolate: project.root().join(".git").exists(),
        };
        let id = tasks.create(spec);
        self.selected_task = Some(id.clone());
        self.open_pane(PaneKind::Agent { task_id: id.clone() }, window, cx);
        self.push_transcript(&id, cx);
        self.push_agents(cx);
    }

    // ---- palette --------------------------------------------------------

    pub fn open_palette(&mut self, mode: PaletteMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_none() {
            let dark = Ui::get(cx).colors.dark;
            let view = cx.new(|cx| HostedView::new("palette", Map::new(), dark, window, cx));
            let sub = cx.subscribe_in(&view, window, |this, _, event: &HostedEvent, window, cx| match event {
                HostedEvent::Action(a) => this.on_action(a.clone(), window, cx),
                HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
                HostedEvent::Ready => this.refresh_palette(cx),
            });
            self.palette = Some(Palette {
                view,
                open: false,
                mode,
                query: String::new(),
                seq: 0,
                _sub: sub,
            });
        }
        let p = self.palette.as_mut().expect("palette");
        if p.mode != mode {
            p.query.clear();
        }
        p.mode = mode;
        p.open = true;
        let handle = p.view.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.refresh_palette(cx);
        cx.notify();
    }

    pub fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.palette {
            p.open = false;
        }
        self.focus_active_pane(window, cx);
        cx.notify();
    }

    fn refresh_palette(&mut self, cx: &mut Context<Self>) {
        let index = self.ws.active_id().and_then(|id| self.projects.get(&id)).and_then(|pv| pv.index.clone());
        let Some(p) = &mut self.palette else { return };
        if !p.open {
            return;
        }
        p.seq += 1;
        let mode = p.mode;
        let query = p.query.clone();
        match mode {
            PaletteMode::Commands => {
                let frame = frames::palette(mode, &query, frames::palette_commands(), false, None);
                p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            }
            PaletteMode::Files => {
                let Some(index) = index else {
                    let frame = frames::palette(mode, &query, Vec::new(), true, Some("Indexing files…"));
                    p.view.update(cx, |v, cx| v.push("palette", frame, cx));
                    return;
                };
                let seq = p.seq;
                Self::bg(
                    cx,
                    move || index.query(&query, 200),
                    move |s, matches, cx| {
                        let Some(p) = &s.palette else { return };
                        if p.seq != seq {
                            return;
                        }
                        let frame = frames::palette(PaletteMode::Files, &p.query, frames::file_matches(&matches), false, None);
                        p.view.update(cx, |v, cx| v.push("palette", frame, cx));
                    },
                );
            }
            PaletteMode::Search => self.run_search(false, false, cx),
        }
    }

    fn run_search(&mut self, regex: bool, case_sensitive: bool, cx: &mut Context<Self>) {
        let root = self.ws.active().map(|p| p.root().to_path_buf());
        let (Some(p), Some(root)) = (&mut self.palette, root) else { return };
        p.seq += 1;
        let seq = p.seq;
        let query = p.query.clone();
        if query.trim().is_empty() {
            let frame = frames::palette(PaletteMode::Search, &query, Vec::new(), false, Some("Type to search file contents."));
            p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            return;
        }
        let loading = frames::palette(PaletteMode::Search, &query, Vec::new(), true, None);
        p.view.update(cx, |v, cx| v.push("palette", loading, cx));
        Self::bg(
            cx,
            move || {
                let opts = SearchOptions {
                    regex,
                    case_sensitive,
                    whole_word: false,
                    max_results: 500,
                };
                let mut hits = Vec::new();
                let result = vibevalley_files::search(&root, &query, &opts, &mut |hit| {
                    hits.push(hit);
                    hits.len() < 500
                });
                (root, hits, result.err().map(|e| e.to_string()))
            },
            move |s, (root, hits, error), cx| {
                let Some(p) = &s.palette else { return };
                if p.seq != seq {
                    return;
                }
                let note = error.or_else(|| hits.is_empty().then(|| "No matches.".to_string()));
                let frame = frames::palette(PaletteMode::Search, &p.query, frames::search_hits(&root, &hits), false, note.as_deref());
                p.view.update(cx, |v, cx| v.push("palette", frame, cx));
            },
        );
    }

    fn palette_select(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.close_palette(window, cx);
        if let Some(rel) = id.strip_prefix("file:") {
            if let Some(root) = self.ws.active().map(|p| p.root().to_path_buf()) {
                self.open_file(root.join(rel), None, window, cx);
            }
            return;
        }
        if let Some(rest) = id.strip_prefix("hit:")
            && let Some((path, line)) = rest.rsplit_once(':')
        {
            self.open_file(PathBuf::from(path), line.parse().ok(), window, cx);
            return;
        }
        match id {
            "terminal.new" => self.new_terminal(None, window, cx),
            "pane.split_right" => self.split(Axis::Horizontal, window, cx),
            "pane.split_down" => self.split(Axis::Vertical, window, cx),
            "pane.close" => self.close_active_tab(window, cx),
            "palette.files" => self.open_palette(PaletteMode::Files, window, cx),
            "palette.search" => self.open_palette(PaletteMode::Search, window, cx),
            "panel.files" | "panel.git" | "panel.agents" => {
                self.show_workspace(cx);
                self.panel = match id {
                    "panel.git" => Panel::Git,
                    "panel.agents" => Panel::Agents,
                    _ => Panel::Files,
                };
                self.inspector_open = true;
                self.push_sidebar(cx);
                cx.notify();
            }
            "git.diff" => self.on_action(Action::OpenDiff { path: None, staged: false }, window, cx),
            "git.diff_staged" => self.on_action(Action::OpenDiff { path: None, staged: true }, window, cx),
            "project.add" => self.add_project(window, cx),
            "project.close" => {
                if let Some(id) = self.ws.active_id() {
                    self.close_project(id, cx);
                }
            }
            "sidebar.toggle" => self.toggle_sidebar(cx),
            "font.increase" => self.adjust_font_size(1.0, cx),
            "font.decrease" => self.adjust_font_size(-1.0, cx),
            "font.reset" => self.reset_font_size(cx),
            "theme.toggle" => self.toggle_theme(cx),
            other => eprintln!("unknown command {other}"),
        }
    }

    fn show_workspace(&mut self, cx: &mut Context<Self>) {
        self.native_workspace = true;
        self.native_pixel = None;
        self.workbench.update(cx, |v, cx| v.navigate("/workspace", cx));
        cx.notify();
    }

    fn show_pixel(&mut self, scene: &str, mut props: Value, window: &mut Window, cx: &mut Context<Self>) {
        if props.get("cwd").is_none() {
            props["cwd"] = json!(self.ws.active().map(|p| p.root().to_path_buf()));
        }
        let view = cx.new(|cx| crate::pixel::view::PixelView::new(scene, props, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::pixel::view::PixelEvent, window, cx| {
            this.on_pixel_event(event.clone(), window, cx)
        });
        self._subs.push(sub);
        self.native_workspace = false;
        self.native_pixel = Some(view);
        cx.notify();
    }

    // ---- panes ----------------------------------------------------------

    pub fn open_pane(&mut self, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) {
        if let PaneKind::Hosted { module, props } = &kind
            && (module == "vv" || module == "vibevalley")
        {
            self.native_workspace = false;
            self.native_pixel = None;
            self.workbench.update(cx, |v, cx| v.navigate(props["route"].as_str().unwrap_or("/issues"), cx));
            cx.notify();
            return;
        }
        if let PaneKind::Pixel { scene, props } = kind {
            self.show_pixel(&scene, props, window, cx);
            return;
        }
        self.show_workspace(cx);
        let Some(project) = self.ws.active_mut() else { return };
        project.layout.open(kind);
        self.layout_changed(window, cx);
    }

    pub fn open_file(&mut self, path: PathBuf, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        let Some(project) = self.ws.active_mut() else { return };
        let tab = project.layout.open(PaneKind::File { path: path.clone() });
        let pid = project.id();
        if let Some(pv) = self.projects.get_mut(&pid) {
            pv.tree.selected = Some(path);
        }
        self.ensure_panes(window, cx);
        if let (Some(line), Some(PaneEntity::File(v))) = (line, self.panes.get(&(pid, tab))) {
            v.update(cx, |v, cx| v.scroll_to_line(line, cx));
        }
        self.push_sidebar(cx);
        self.layout_changed(window, cx);
    }

    pub fn new_terminal(&mut self, spec: Option<SpawnSpec>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        let Some(project) = self.ws.active_mut() else { return };
        let (id, _) = project.new_terminal_tab();
        if let Some(spec) = spec {
            let view = self.make_terminal(&id, spec, cx);
            self.terminals.insert(id, view);
        }
        self.layout_changed(window, cx);
    }

    /// `$EDITOR file` in a new terminal tab (the viewer's "Open in editor").
    pub fn open_in_editor(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let cwd = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let spec = SpawnSpec {
            cwd,
            program: Some(shell.clone()),
            args: vec!["-lc".into(), format!("${{EDITOR:-vi}} {quoted}; exec {shell} -l")],
            env: Vec::new(),
            history: None,
        };
        self.new_terminal(Some(spec), window, cx);
    }

    fn split(&mut self, axis: Axis, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.ws.active_mut() else { return };
        let group = project.layout.focused;
        let id = vibevalley_workspace::util::new_id();
        project.layout.split(group, axis, PaneKind::Terminal { terminal_id: id });
        self.layout_changed(window, cx);
    }

    fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.ws.active_mut() else { return };
        let Some(tab) = project.layout.active_tab().map(|t| t.id) else { return };
        self.close_tab(tab, window, cx);
    }

    pub fn close_tab(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.ws.active_mut() else { return };
        let pid = project.id();
        if let Some(PaneKind::Terminal { terminal_id }) = project.close_tab(tab) {
            self.terminals.remove(&terminal_id);
        }
        self.panes.remove(&(pid, tab));
        if self.ws.active().is_some_and(|p| p.layout.tabs().next().is_none()) {
            self.new_terminal(None, window, cx);
            return;
        }
        self.layout_changed(window, cx);
    }

    pub fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        self.focus_active_pane(window, cx);
        self.schedule_save(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    pub fn focus_active_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        let Some(project) = self.ws.active() else { return };
        let Some(tab) = project.layout.active_tab() else { return };
        let handle = match &tab.kind {
            PaneKind::Terminal { terminal_id } => self.terminals.get(terminal_id).map(|t| t.read(cx).focus_handle(cx)),
            _ => self.panes.get(&(project.id(), tab.id)).map(|p| p.focus_handle(cx)),
        };
        window.focus(&handle.unwrap_or_else(|| self.focus.clone()), cx);
    }

    /// Creates the entities for every visible tab of the active project.
    /// Entities of hidden projects stay alive in the maps.
    pub fn ensure_panes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pid) = self.ws.active_id() else { return };
        let Some(project) = self.ws.active() else { return };
        let visible: Vec<(TabId, PaneKind)> = project
            .layout
            .groups()
            .iter()
            .filter_map(|g| g.active_tab().map(|t| (t.id, t.kind.clone())))
            .collect();
        let root = project.root().to_path_buf();
        for (tab, kind) in visible {
            match kind {
                PaneKind::Terminal { terminal_id } => {
                    if self.terminals.contains_key(&terminal_id) {
                        continue;
                    }
                    let saved = self.ws.active_mut().and_then(|p| p.take_restorable(&terminal_id));
                    let spec = match saved {
                        Some(saved) => SpawnSpec {
                            cwd: if saved.cwd.is_dir() { saved.cwd.clone() } else { root.clone() },
                            program: None,
                            args: Vec::new(),
                            env: Vec::new(),
                            history: Some(saved.scrollback).filter(|s| !s.trim().is_empty()),
                        },
                        None => SpawnSpec::shell(root.clone()),
                    };
                    let view = self.make_terminal(&terminal_id, spec, cx);
                    self.terminals.insert(terminal_id, view);
                }
                kind => {
                    if self.panes.contains_key(&(pid, tab)) {
                        continue;
                    }
                    let pane = self.make_pane(pid, &root, kind, window, cx);
                    self.panes.insert((pid, tab), pane);
                }
            }
        }
    }

    fn make_terminal(&mut self, id: &str, spec: SpawnSpec, cx: &mut Context<Self>) -> Entity<TerminalView> {
        let cwd = spec.cwd.clone();
        let view = cx.new(|cx| TerminalView::new(spec, cx));
        let tid = id.to_string();
        let sub = cx.subscribe(&view, move |this: &mut Shell, view, event: &TerminalEvent, cx| {
            let owner = this.ws.projects().iter().find(|p| p.layout.terminal_ids().contains(&tid)).map(|p| p.id());
            let Some(owner) = owner else { return };
            let on_screen = this.ws.active_id() == Some(owner);
            let Some(project) = this.ws.project_mut(owner) else { return };
            match event {
                TerminalEvent::Spawned => {
                    if let Some(session) = view.read(cx).session() {
                        project.attach_terminal(&tid, session.clone(), cwd.clone(), None);
                    }
                }
                TerminalEvent::TitleChanged => {
                    let title = view.read(cx).title().map(str::to_string);
                    if let Some(entry) = project.terminal_mut(&tid) {
                        entry.title = title;
                    }
                }
                TerminalEvent::Bell | TerminalEvent::CommandFinished => {
                    if !on_screen && let Some(entry) = project.terminal_mut(&tid) {
                        entry.attention = true;
                    }
                }
                TerminalEvent::Exited => {
                    if let Some(entry) = project.terminal_mut(&tid) {
                        entry.exited = true;
                    }
                }
                TerminalEvent::SpawnFailed(e) => eprintln!("terminal {tid}: {e}"),
            }
            this.push_sidebar(cx);
            cx.notify();
        });
        self._subs.push(sub);
        view
    }

    fn make_pane(&mut self, pid: ProjectId, root: &Path, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) -> PaneEntity {
        let dark = Ui::get(cx).colors.dark;
        match kind {
            PaneKind::File { path } => {
                let view = cx.new(|cx| FileViewer::new(path, cx));
                let sub = cx.subscribe_in(&view, window, |this, view, event: &crate::viewer::ViewerEvent, window, cx| match event {
                    crate::viewer::ViewerEvent::OpenInEditor => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_in_editor(&path, window, cx);
                    }
                    crate::viewer::ViewerEvent::Preview => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_pane(
                            PaneKind::Hosted {
                                module: "markdown".into(),
                                props: json!({ "path": path }),
                            },
                            window,
                            cx,
                        );
                    }
                });
                self._subs.push(sub);
                PaneEntity::File(view)
            }
            PaneKind::Diff { spec, path, repo } => {
                let repo = repo.unwrap_or_else(|| root.to_path_buf());
                let view = cx.new(|cx| DiffView::new(repo, spec, path, cx));
                let sub = cx.subscribe(&view, move |this: &mut Shell, _, _: &crate::diff::DiffChanged, cx| {
                    this.refresh_git(pid, cx);
                });
                self._subs.push(sub);
                PaneEntity::Diff(view)
            }
            PaneKind::Agent { task_id } => {
                let mut params = Map::new();
                params.insert("taskId".into(), json!(task_id));
                let view = cx.new(|cx| HostedView::new("agent", params, dark, window, cx));
                self.subscribe_hosted(&view, Some(task_id.clone()), None, window, cx);
                let pane = PaneEntity::Hosted {
                    view,
                    task: Some(task_id.clone()),
                };
                cx.defer_in(window, move |this, _, cx| this.push_transcript(&task_id, cx));
                pane
            }
            PaneKind::Hosted { module, props } => {
                let mut params = props.as_object().cloned().unwrap_or_default();
                params.insert("module".into(), json!(module));
                let doc = (module == "markdown").then(|| props["path"].as_str().map(PathBuf::from)).flatten();
                let view = cx.new(|cx| HostedView::new(&module, params, dark, window, cx));
                self.subscribe_hosted(&view, None, doc.clone(), window, cx);
                if let Some(path) = doc.clone() {
                    self.push_doc(&view, path, cx);
                }
                PaneEntity::Hosted { view, task: None }
            }
            PaneKind::Pixel { scene, mut props } => {
                if !props.is_object() {
                    props = json!({});
                }
                if props.get("cwd").is_none() {
                    props["cwd"] = json!(root);
                }
                let view = cx.new(|cx| crate::pixel::view::PixelView::new(&scene, props, cx));
                let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::pixel::view::PixelEvent, window, cx| {
                    this.on_pixel_event(event.clone(), window, cx)
                });
                self._subs.push(sub);
                PaneEntity::Pixel(view)
            }
            PaneKind::Terminal { .. } => unreachable!("terminals are kept in Shell::terminals"),
        }
    }

    fn subscribe_hosted(&mut self, view: &Entity<HostedView>, task: Option<String>, doc: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        let sub = cx.subscribe_in(view, window, move |this, view, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(a) => this.on_action(a.clone(), window, cx),
            HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => {
                if let Some(t) = &task {
                    this.push_transcript(t, cx);
                }
                if let Some(path) = &doc {
                    this.push_doc(view, path.clone(), cx);
                }
            }
        });
        self._subs.push(sub);
    }

    fn push_doc(&mut self, view: &Entity<HostedView>, path: PathBuf, cx: &mut Context<Self>) {
        let view = view.clone();
        Self::bg(
            cx,
            move || (std::fs::read_to_string(&path), path),
            move |_, (text, path), cx| {
                let frame = match text {
                    Ok(text) => json!({ "path": path, "markdown": text }),
                    Err(e) => json!({ "path": path, "error": e.to_string() }),
                };
                view.update(cx, |v, cx| v.push("doc", frame, cx));
            },
        );
    }

    // ---- persistence and theme -----------------------------------------

    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        if self.save_pending || self.store.is_none() {
            return;
        }
        self.save_pending = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(800)).await;
            let _ = this.update(cx, |s, cx| {
                s.save_pending = false;
                s.save_now(cx);
            });
        })
        .detach();
    }

    pub fn save_now(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let jobs = self.ws.save_jobs();
        Self::bg(
            cx,
            move || {
                for job in jobs {
                    if let Err(e) = job.run(&*store) {
                        eprintln!("save: {e}");
                    }
                }
            },
            |_, _, _| {},
        );
    }

    fn save_settings(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let mut settings = Ui::get(cx).settings.clone();
        settings.sidebar_width = self.sidebar_width;
        settings.sidebar_visible = self.sidebar_visible;
        Self::bg(
            cx,
            move || vibevalley_workspace::persist::save_setting(&*store, SETTINGS_KEY, &settings),
            |_, r, _| {
                if let Err(e) = r {
                    eprintln!("save settings: {e}");
                }
            },
        );
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_visible = !self.sidebar_visible;
        self.save_settings(cx);
        cx.notify();
    }

    pub fn toggle_inspector(&mut self, cx: &mut Context<Self>) {
        self.inspector_open = !self.inspector_open;
        self.push_sidebar(cx);
        cx.notify();
    }

    pub fn adjust_font_size(&mut self, delta: f32, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        settings.terminal_font_size = (settings.terminal_font_size + delta).clamp(9.0, 32.0);
        Ui::apply(settings, cx);
        self.save_settings(cx);
        cx.notify();
    }

    pub fn reset_font_size(&mut self, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        settings.terminal_font_size = 13.0;
        Ui::apply(settings, cx);
        self.save_settings(cx);
        cx.notify();
    }

    pub fn toggle_theme(&mut self, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        settings.theme = match settings.theme {
            ThemeChoice::Dark => ThemeChoice::Light,
            ThemeChoice::Light => ThemeChoice::Dark,
        };
        Ui::apply(settings, cx);
        self.theme_changed(cx);
        self.save_settings(cx);
    }

    /// Tells every open terminal and hosted view about the new theme.
    fn theme_changed(&mut self, cx: &mut Context<Self>) {
        let dark = Ui::get(cx).colors.dark;
        for t in self.terminals.values() {
            t.update(cx, |t, cx| t.apply_theme(cx));
        }
        self.sidebar.update(cx, |v, cx| v.set_dark(dark, cx));
        self.inspector.update(cx, |v, cx| v.set_dark(dark, cx));
        self.workbench.update(cx, |v, cx| v.set_dark(dark, cx));
        if let Some(p) = &self.palette {
            p.view.update(cx, |v, cx| v.set_dark(dark, cx));
        }
        for pane in self.panes.values() {
            if let PaneEntity::Hosted { view, .. } = pane {
                view.update(cx, |v, cx| v.set_dark(dark, cx));
            }
        }
        cx.notify();
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.resizing_sidebar {
            self.sidebar_width = (f32::from(e.position.x) - self.global_rail_width).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
            cx.notify();
        } else if self.resizing_inspector {
            let win_w = f32::from(window.viewport_size().width);
            self.inspector_width = (win_w - f32::from(e.position.x)).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
            cx.notify();
        } else if let Some((split, index)) = self.dragging_split
            && let Some(project) = self.ws.active_mut()
            && let Some(fraction) = self.split_bounds.fraction(&project.layout, split, index, e.position)
        {
            project.layout.resize(split, index, fraction);
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, cx: &mut Context<Self>) {
        if self.resizing_sidebar {
            self.resizing_sidebar = false;
            self.save_settings(cx);
        }
        if self.resizing_inspector {
            self.resizing_inspector = false;
        }
        if self.dragging_split.take().is_some() {
            self.schedule_save(cx);
        }
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_panes(window, cx);
        let colors = Ui::get(cx).colors.clone();
        let sidebar_w: Pixels = px(self.sidebar_width);
        let main = crate::panes::render_main(self, window, cx);
        let palette = self.palette.as_ref().filter(|p| p.open).map(|p| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(72.0))
                .bg(gpui_kit::hsla(0.0, 0.0, 0.0, 0.25))
                .key_context("Palette")
                .on_action(cx.listener(|this, _: &ClosePalette, window, cx| this.close_palette(window, cx)))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                .child(
                    div()
                        .w(px(620.0))
                        .h(px(420.0))
                        .rounded(px(12.0))
                        .overflow_hidden()
                        .shadow_lg()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(p.view.clone()),
                )
        });
        let launch = self.launch.clone().map(|o| div().absolute().inset_0().child(o));
        div()
            .id("shell")
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .bg(colors.bg)
            .text_color(colors.text)
            .key_context("Shell")
            .track_focus(&self.focus)
            .on_action(cx.listener(|s, _: &ActivateProject1, w, cx| s.activate_index(0, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject2, w, cx| s.activate_index(1, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject3, w, cx| s.activate_index(2, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject4, w, cx| s.activate_index(3, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject5, w, cx| s.activate_index(4, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject6, w, cx| s.activate_index(5, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject7, w, cx| s.activate_index(6, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject8, w, cx| s.activate_index(7, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject9, w, cx| s.activate_index(8, w, cx)))
            .on_action(cx.listener(|s, _: &GoToFile, w, cx| s.open_palette(PaletteMode::Files, w, cx)))
            .on_action(cx.listener(|s, _: &CommandPalette, w, cx| s.open_palette(PaletteMode::Commands, w, cx)))
            .on_action(cx.listener(|s, _: &SearchProject, w, cx| s.open_palette(PaletteMode::Search, w, cx)))
            .on_action(cx.listener(|s, _: &NewTerminal, w, cx| s.new_terminal(None, w, cx)))
            .on_action(cx.listener(|s, _: &CloseTab, w, cx| s.close_active_tab(w, cx)))
            .on_action(cx.listener(|s, _: &SplitRight, w, cx| s.split(Axis::Horizontal, w, cx)))
            .on_action(cx.listener(|s, _: &SplitDown, w, cx| s.split(Axis::Vertical, w, cx)))
            .on_action(cx.listener(|s, _: &NextTab, w, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.tab_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &PrevTab, w, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.tab_cycle(-1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &FocusNextGroup, w, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.focus_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &ZoomIn, _, cx| s.adjust_font_size(1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomOut, _, cx| s.adjust_font_size(-1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomReset, _, cx| s.reset_font_size(cx)))
            .on_action(cx.listener(|s, _: &ToggleSidebar, _, cx| s.toggle_sidebar(cx)))
            .on_action(cx.listener(|s, _: &ToggleTheme, _, cx| s.toggle_theme(cx)))
            .on_action(cx.listener(|_, _: &Quit, _, cx| cx.quit()))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(|s, _, _, cx| s.on_mouse_up(cx)))
            .child(div().size_full().child(self.workbench.clone()))
            .children(self.native_workspace.then(|| {
                let inspector_w: Pixels = px(self.inspector_width);
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .left(px(self.global_rail_width))
                    .flex()
                    .flex_row()
                    .bg(colors.bg)
                    .children(
                        self.sidebar_visible
                            .then(|| div().w(sidebar_w).h_full().flex_none().child(self.sidebar.clone())),
                    )
                    .children(self.sidebar_visible.then(|| {
                        div()
                            .id("sidebar-divider")
                            .w(px(4.0))
                            .h_full()
                            .flex_none()
                            .bg(colors.border)
                            .cursor_col_resize()
                            .on_mouse_down(MouseButton::Left, cx.listener(|s, _, _, _| s.resizing_sidebar = true))
                    }))
                    .child(div().flex_1().h_full().min_w_0().child(main))
                    .children(self.inspector_open.then(|| {
                        div()
                            .id("inspector-divider")
                            .w(px(4.0))
                            .h_full()
                            .flex_none()
                            .bg(colors.border)
                            .cursor_col_resize()
                            .on_mouse_down(MouseButton::Left, cx.listener(|s, _, _, _| s.resizing_inspector = true))
                    }))
                    .children(
                        self.inspector_open
                            .then(|| div().w(inspector_w).h_full().flex_none().child(self.inspector.clone())),
                    )
            }))
            .children(
                self.native_pixel
                    .clone()
                    .map(|view| div().absolute().top_0().bottom_0().right_0().left(px(self.global_rail_width)).child(view)),
            )
            .children(palette)
            .children(launch)
    }
}

/// `%XX` escapes of a `file:` URL's path decoded (spaces, CJK names).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod url_tests {
    #[test]
    fn file_urls_decode() {
        assert_eq!(super::percent_decode("/tmp/%E6%88%AA%E5%9B%BE%201.png"), "/tmp/截图 1.png");
        assert_eq!(super::percent_decode("/a%zzb%"), "/a%zzb%");
    }
}
