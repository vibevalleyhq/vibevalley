use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

use gpui::{AppContext as _, Context, FocusHandle, Focusable, Window};
use serde_json::{Value, json};
use vibevalley_files::FsChange;
use vibevalley_workspace::{PaneKind, ProjectId, Store, Workspace, load_all, load_project, prune_missing_projects};

use crate::hosted::{HostedEvent, HostedView, Panel};
use crate::panes::SplitBounds;
use crate::theme::{MotionChoice, Settings, ThemeChoice, Ui};

use super::{ACTIVE_KEY, HostChrome, NativeOverlays, SETTINGS_KEY, Shell, WorkspaceProjects, devtools, devtools_enabled, projects, startup_error};

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
                this.chrome.workbench.read(cx).push_update_state(crate::update::state(), cx);
                this.finish_opening(true, cx);
            }
        });
        let mut update_rx = crate::update::subscribe();
        cx.spawn(async move |this, cx| {
            while update_rx.changed().await.is_ok() {
                let state = update_rx.borrow_and_update().clone();
                if this.update(cx, |shell, cx| shell.notify_update_state(state, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let (fs_tx, fs_rx) = flume::unbounded::<(ProjectId, Vec<FsChange>)>();
        cx.spawn(async move |this, cx| {
            while let Ok(first) = fs_rx.recv_async().await {
                let mut batches = vec![first];
                while let Ok(more) = fs_rx.try_recv() {
                    batches.push(more);
                }
                if this.update(cx, |s, cx| s.on_fs_changes_batch(batches, cx)).is_err() {
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
        let initial_failure = match &already_settled {
            Some(Err(failure)) => Some(failure.clone()),
            _ => None,
        };
        let ui_settings = Ui::get(cx).settings.clone();
        let mut shell = Shell {
            workspace: WorkspaceProjects {
                store: None,
                project_open: None,
                ws: Workspace::new(),
                loaded: false,
                server_ready: matches!(already_settled, Some(Ok(()))),
                workbench_ready: false,
                load_error: initial_failure.as_ref().map(|f| f.summary.clone()),
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
                dir_refresh_pending: BTreeSet::new(),
                git_refresh_pending: BTreeSet::new(),
                summaries_gen: 0,
            },
            chrome: HostChrome {
                sidebar,
                inspector: None,
                workbench,
                native_workspace: false,
                native_diorama: None,
                modal_overlay: false,
                global_rail_width: 76.0,
                panel: Panel::Files,
                inspector_open: ui_settings.inspector_open,
                inspector_width: ui_settings.inspector_width,
                last_route: None,
                explicit_route: false,
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
                .then(|| cx.new(crate::diorama::OpeningView::new)),
                startup: startup_error::StartupUiState::new(initial_failure),
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
                let result = startup.borrow().clone().unwrap_or_else(|| {
                    Err(crate::hosted::StartupFailure::simple(
                        crate::hosted::StartupFailureKind::ServerBoot,
                        "the server startup channel closed",
                        crate::hosted::server_home(),
                    ))
                });
                let _ = this.update(cx, |shell, cx| {
                    match result {
                        Ok(()) => {
                            shell.workspace.server_ready = true;
                            shell.overlays.startup.slow = false;
                            shell.sync_chat_watches(cx);
                            if shell.workspace.loaded {
                                shell.sync_all_project_mounts(cx);
                            }
                            shell.finish_opening(true, cx);
                        }
                        Err(failure) => {
                            eprintln!("{}", failure.summary);
                            shell.workspace.load_error = Some(failure.summary.clone());
                            shell.overlays.startup.failure = Some(failure);
                            shell.overlays.startup.slow = false;
                            shell.finish_opening(false, cx);
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(std::time::Duration::from_secs(15)).await;
                let _ = this.update(cx, |shell, cx| {
                    if !shell.workspace.server_ready && shell.overlays.startup.failure.is_none() {
                        shell.overlays.startup.slow = true;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        match crate::island::Island::start() {
            Ok(Some((island, opened))) => {
                shell.overlays.island = Some(island);
                struct IslandOutlet(flume::Sender<(String, Value)>);
                impl vibevalley_server::gateway::bridge::Outlet for IslandOutlet {
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
                    if !this.chrome.explicit_route
                        && let Some(route) = saved_route
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
                    if this.workspace.server_ready {
                        this.sync_all_project_mounts(cx);
                    }
                    this.push_sidebar(cx);
                    this.finish_opening(true, cx);
                    cx.notify();
                }
                Err(e) => {
                    eprintln!("could not load projects: {e}");
                    tracing::error!(error = %e, "could not load workspace store");
                    if this.overlays.startup.failure.is_none() {
                        this.overlays.startup.failure = Some(crate::hosted::StartupFailure::simple(
                            crate::hosted::StartupFailureKind::WorkspaceStore,
                            e.clone(),
                            crate::hosted::server_home(),
                        ));
                    }
                    this.workspace.load_error = Some(e);
                    this.workspace.loaded = true;
                    this.finish_opening(false, cx);
                    cx.notify();
                }
            },
        );
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
