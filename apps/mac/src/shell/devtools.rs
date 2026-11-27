use std::time::Duration;

use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, TitlebarOptions, WeakEntity, Window, WindowBounds, WindowHandle, WindowOptions, div, px, size,
};
use serde_json::json;
use vibevalley_protocol::{SessionsSlice, SliceKind};

use crate::hosted::{BridgeHub, HostedEvent, HostedView, ShellDebugHandle};
use crate::icon::{TOOLTIP_SHOW_DELAY, gpui_tooltip};
use crate::theme::Ui;

use super::Shell;
use super::menus::{CloseWindow, ToggleDevtools};

pub const DEVTOOLS_VISIBLE_TOPIC: &str = "devtools_visible";
pub const INSPECTOR_STATE_TOPIC: &str = "inspector";

pub use crate::env::devtools_enabled;
#[cfg(test)]
pub use crate::env::devtools_enabled_from;

#[derive(Debug, Clone, PartialEq)]
pub struct CapsuleMetrics {
    pub channel: String,
    pub port: u16,
    pub route: String,
    pub active_sessions: u32,
    pub active_subs: u32,
    pub latest_seq: i64,
    pub last_frame_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DevtoolsState {
    pub enabled: bool,
    pub open: bool,
    pub detached: bool,
    pub last_frame_ms: f64,
    pub capsule: CapsuleMetrics,
}

impl DevtoolsState {
    pub fn new(enabled: bool, channel: impl Into<String>, port: u16) -> Self {
        Self {
            enabled,
            open: false,
            detached: false,
            last_frame_ms: 0.0,
            capsule: CapsuleMetrics {
                channel: channel.into(),
                port,
                route: "/issues".to_string(),
                active_sessions: 0,
                active_subs: 0,
                latest_seq: 0,
                last_frame_ms: 0.0,
            },
        }
    }

    pub fn is_overlay_open(&self) -> bool {
        self.enabled && self.open && !self.detached
    }

    pub fn overlay_visibility_frame(&self) -> serde_json::Value {
        json!({ "visible": self.is_overlay_open() })
    }

    pub fn should_record_frame(&self, duration_us: u64) -> bool {
        self.enabled && (self.open || duration_us >= crate::hosted::SLOW_FRAME_US)
    }

    pub fn should_publish_periodic_host_debug(&self) -> bool {
        self.enabled && self.open
    }

    pub fn toggle(&mut self) -> bool {
        if !self.enabled {
            return false;
        }
        if self.open {
            self.open = false;
            self.detached = false;
        } else {
            self.open = true;
            self.detached = false;
        }
        true
    }

    pub fn close(&mut self) -> bool {
        if !self.enabled || (!self.open && !self.detached) {
            return false;
        }
        self.open = false;
        self.detached = false;
        true
    }

    pub fn detach(&mut self) -> bool {
        if !self.enabled {
            return false;
        }
        self.open = true;
        self.detached = true;
        true
    }

    pub fn on_detached_closed(&mut self) -> bool {
        if !self.enabled || !self.detached {
            return false;
        }
        self.detached = false;
        self.open = false;
        true
    }

    pub fn record_frame_ms(&mut self, ms: f64) {
        if !self.enabled {
            return;
        }
        self.last_frame_ms = ms;
        self.capsule.last_frame_ms = ms;
    }

    pub fn format_capsule(&self) -> String {
        let c = &self.capsule;
        let route = if c.route.is_empty() { "/issues" } else { c.route.as_str() };
        format!(
            "{} :{} · {} · {}s/{}sub · seq {} · {:.1}ms",
            c.channel, c.port, route, c.active_sessions, c.active_subs, c.latest_seq, c.last_frame_ms
        )
    }
}

pub struct DevtoolsWindow {
    view: Entity<HostedView>,
    focus: FocusHandle,
    _sub: Subscription,
}

impl Focusable for DevtoolsWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DevtoolsWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = &Ui::get(cx).colors;
        div()
            .id("devtools-window")
            .size_full()
            .bg(colors.bg)
            .text_color(colors.text)
            .key_context("Shell")
            .track_focus(&self.focus)
            .capture_any_mouse_down(|_, _, _| crate::host::restore_window_first_responder())
            .on_action(cx.listener(|_, _: &CloseWindow, window, _| window.remove_window()))
            .on_action(cx.listener(|_, _: &ToggleDevtools, window, _| window.remove_window()))
            .child(self.view.clone())
    }
}

pub struct DevtoolsSlot {
    pub state: DevtoolsState,
    pub overlay: Option<(Entity<HostedView>, Subscription)>,
    pub detached_window: Option<WindowHandle<DevtoolsWindow>>,
    pub detached_view: Option<WeakEntity<HostedView>>,
    pub(super) _detached_sub: Option<Subscription>,
    pub inspecting: bool,
    pub highlighted: Option<vibevalley_protocol::VdpUiInspectAtResult>,
}

impl DevtoolsSlot {
    pub fn new(enabled: bool) -> Self {
        let channel = vibevalley_protocol::home::current_channel();
        Self {
            state: DevtoolsState::new(enabled, channel.as_str(), channel.default_port()),
            overlay: None,
            detached_window: None,
            detached_view: None,
            _detached_sub: None,
            inspecting: false,
            highlighted: None,
        }
    }
}

impl Shell {
    pub(super) fn start_devtools_refresh(&self, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let probe = this.update(cx, |shell, cx| {
                    let route = shell.chrome.last_route.as_deref().unwrap_or("/issues").to_string();
                    let bridge = cx.try_global::<BridgeHub>().map(|b| b.0.clone());
                    let debug = cx.try_global::<ShellDebugHandle>().cloned();
                    (shell.workspace.server_ready, route, bridge, debug)
                });
                let Ok((server_ready, route, bridge, debug)) = probe else {
                    break;
                };
                let (port, active_sessions, active_subs, latest_seq) = cx
                    .background_executor()
                    .spawn(async move {
                        let port = debug.as_ref().and_then(ShellDebugHandle::loopback_port);
                        let Some(bridge) = bridge else {
                            return (port, 0u32, 0u32, 0i64);
                        };
                        let clients = bridge.clients_snapshot();
                        let active_subs: u32 = clients.iter().map(|c| (c.watches.len() + c.subscriptions.len()) as u32).sum();
                        if !server_ready {
                            return (port, 0, active_subs, 0);
                        }
                        let raw = bridge.server().clone().slice_snapshot_json_async(SliceKind::Sessions).await;
                        let (active_sessions, latest_seq) = serde_json::from_str::<SessionsSlice>(&raw)
                            .map(|slice| (slice.sessions.len() as u32, slice.seq))
                            .unwrap_or((0, 0));
                        (port, active_sessions, active_subs, latest_seq)
                    })
                    .await;
                let alive = this.update(cx, |shell, cx| {
                    let prev = shell.overlays.devtools.state.capsule.clone();
                    if let Some(bound_port) = port {
                        shell.overlays.devtools.state.capsule.port = bound_port;
                    }
                    shell.overlays.devtools.state.capsule.route = route;
                    shell.overlays.devtools.state.capsule.active_sessions = active_sessions;
                    shell.overlays.devtools.state.capsule.active_subs = active_subs;
                    shell.overlays.devtools.state.capsule.latest_seq = latest_seq;
                    if shell.overlays.devtools.state.should_publish_periodic_host_debug() {
                        shell.publish_host_debug(cx);
                    }
                    if shell.overlays.devtools.state.capsule != prev {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn sync_devtools_route(&mut self, route: &str) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        self.overlays.devtools.state.capsule.route = if route.is_empty() { "/issues".to_string() } else { route.to_string() };
    }

    fn push_devtools_overlay_visibility(&self, cx: &mut Context<Self>) {
        if let Some((view, _)) = &self.overlays.devtools.overlay {
            let frame = self.overlays.devtools.state.overlay_visibility_frame();
            view.update(cx, |v, cx| v.push(DEVTOOLS_VISIBLE_TOPIC, frame, cx));
        }
    }

    pub fn toggle_devtools(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        let was_detached = self.overlays.devtools.state.detached;
        self.overlays.devtools.state.toggle();
        if was_detached || !self.overlays.devtools.state.open {
            self.close_detached_devtools_window(cx);
            self.push_devtools_overlay_visibility(cx);
        } else {
            self.publish_host_debug(cx);
            self.ensure_devtools_overlay(window, cx);
            self.push_devtools_overlay_visibility(cx);
        }
        cx.notify();
    }

    pub fn close_devtools(&mut self, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        self.overlays.devtools.state.close();
        self.close_detached_devtools_window(cx);
        self.push_devtools_overlay_visibility(cx);
        cx.notify();
    }

    pub fn detach_devtools(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        self.overlays.devtools.state.detach();
        self.overlays.devtools.overlay = None;
        self.publish_host_debug(cx);
        if let Some(handle) = self.overlays.devtools.detached_window {
            let active = handle.update(cx, |_, win, cx| {
                win.activate_window();
                cx.activate(true);
            });
            if active.is_ok() {
                cx.notify();
                return;
            }
            self.overlays.devtools.detached_window = None;
            self.overlays.devtools.detached_view = None;
            self.overlays.devtools._detached_sub = None;
        }
        let dark = Ui::get(cx).colors.dark;
        let main_shell = cx.weak_entity();
        let main_window = window.window_handle();
        let bounds = Bounds::centered(None, size(px(980.0), px(640.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("VibeValley DevTools".into()),
                appears_transparent: false,
                traffic_light_position: None,
            }),
            ..Default::default()
        };
        let mut created_view: Option<WeakEntity<HostedView>> = None;
        match cx.open_window(options, |devtools_window, cx| {
            cx.new(|cx| {
                let view = cx.new(|cx| {
                    HostedView::new(
                        "devtools",
                        serde_json::from_value(json!({ "detached": true })).unwrap(),
                        dark,
                        devtools_window,
                        cx,
                    )
                });
                created_view = Some(view.downgrade());
                let sub = cx.subscribe_in(&view, devtools_window, move |_, _, event: &HostedEvent, _, cx| {
                    let main_shell = main_shell.clone();
                    match event {
                        HostedEvent::Action(action) => {
                            let action = action.clone();
                            cx.spawn(async move |_, cx| {
                                let _ = cx.update_window(main_window, |_, window, cx| {
                                    let _ = main_shell.update(cx, |shell, cx| shell.on_action(action, window, cx));
                                });
                            })
                            .detach();
                        }
                        HostedEvent::HostCall { op, reply } => {
                            let op = op.clone();
                            let reply = reply.clone();
                            cx.spawn(async move |_, cx| {
                                let _ = cx.update_window(main_window, |_, window, cx| {
                                    let _ = main_shell.update(cx, |shell, cx| shell.host_call(op, reply, window, cx));
                                });
                            })
                            .detach();
                        }
                        HostedEvent::Ready => {
                            let main_shell = main_shell.clone();
                            cx.spawn(async move |_, cx| {
                                let _ = cx.update_window(main_window, |_, _, cx| {
                                    let _ = main_shell.update(cx, |shell, cx| shell.push_devtools_inspector(cx));
                                });
                            })
                            .detach();
                        }
                    }
                });
                let focus = cx.focus_handle();
                devtools_window.focus(&view.read(cx).focus_handle(cx), cx);
                DevtoolsWindow { view, focus, _sub: sub }
            })
        }) {
            Ok(handle) => {
                let detached_id = handle.window_id();
                let shell_weak = cx.weak_entity();
                let closed_sub = cx.on_window_closed(move |cx, closed_id| {
                    if closed_id == detached_id {
                        let _ = shell_weak.update(cx, |shell, cx| shell.on_detached_devtools_closed(cx));
                    }
                });
                self.overlays.devtools.detached_window = Some(handle);
                self.overlays.devtools.detached_view = created_view;
                self.overlays.devtools._detached_sub = Some(closed_sub);
                tracing::info!("opened detached devtools window");
            }
            Err(error) => {
                tracing::warn!("failed to open detached devtools window: {error}");
                self.overlays.devtools.state.on_detached_closed();
            }
        }
        cx.notify();
    }

    pub(super) fn on_detached_devtools_closed(&mut self, cx: &mut Context<Self>) {
        self.overlays.devtools.detached_window = None;
        self.overlays.devtools.detached_view = None;
        self.overlays.devtools._detached_sub = None;
        self.overlays.devtools.state.on_detached_closed();
        cx.notify();
    }

    fn close_detached_devtools_window(&mut self, cx: &mut Context<Self>) {
        self.overlays.devtools.detached_view = None;
        self.overlays.devtools._detached_sub = None;
        if let Some(handle) = self.overlays.devtools.detached_window.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }

    pub(super) fn ensure_devtools_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.is_overlay_open() || self.overlays.devtools.overlay.is_some() {
            return;
        }
        let dark = Ui::get(cx).colors.dark;
        let view = cx.new(|cx| HostedView::new("devtools", serde_json::from_value(json!({ "detached": false })).unwrap(), dark, window, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => {
                this.push_devtools_overlay_visibility(cx);
                this.push_devtools_inspector(cx);
            }
        });
        self.overlays.devtools.overlay = Some((view, sub));
        self.push_devtools_overlay_visibility(cx);
        self.push_devtools_inspector(cx);
    }

    pub(super) fn push_devtools_inspector(&self, cx: &mut Context<Self>) {
        let payload = json!({
            "inspecting": self.overlays.devtools.inspecting,
            "selection": self.overlays.devtools.highlighted,
        });
        self.devtools_for_each_view(cx, |v, cx| v.push(INSPECTOR_STATE_TOPIC, payload.clone(), cx));
    }

    pub fn set_devtools_inspecting(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if !self.overlays.devtools.state.enabled {
            return;
        }
        if self.overlays.devtools.inspecting != enabled {
            self.overlays.devtools.inspecting = enabled;
            self.push_devtools_inspector(cx);
            cx.notify();
        }
    }

    pub fn set_devtools_highlight(&mut self, hit: Option<vibevalley_protocol::VdpUiInspectAtResult>, cx: &mut Context<Self>) {
        self.overlays.devtools.highlighted = hit;
        self.push_devtools_inspector(cx);
        cx.notify();
    }

    pub(super) fn is_point_in_devtools_chrome(&self, x: f32, y: f32, window: &Window) -> bool {
        if !self.overlays.devtools.state.enabled {
            return false;
        }
        let vp = window.viewport_size();
        let w = f32::from(vp.width);
        let h = f32::from(vp.height);
        if y >= (h - 44.0) && (x >= (w * 0.5 - 220.0) && x <= (w * 0.5 + 220.0)) {
            return true;
        }
        if self.overlays.devtools.state.is_overlay_open() {
            let top = h - 44.0 - 460.0;
            let bottom = h - 44.0;
            if x >= 24.0 && x <= (w - 24.0) && y >= top && y <= bottom {
                return true;
            }
        }
        false
    }

    /// Collects mounted [`HostedView`] entities and their shell window origins `(surface, ox, oy, view)` overlapping the window.
    pub(crate) fn hosted_view_origins(&self, vp_w: f32, vp_h: f32, cx: &App) -> Vec<(String, f32, f32, Entity<HostedView>)> {
        let mut views = Vec::new();
        if let Some(palette) = self.overlays.palette.as_ref().filter(|p| p.open) {
            let palette_w = (vp_w - 32.0).clamp(280.0, 620.0);
            let palette_top = if vp_h < 520.0 { 24.0 } else { 72.0 };
            let ox = ((vp_w - palette_w) * 0.5).max(0.0);
            views.push(("palette".to_string(), ox, palette_top, palette.view.clone()));
        }
        if self.chrome.native_workspace {
            if self.chrome.sidebar_visible {
                views.push(("sidebar".to_string(), self.chrome.global_rail_width, 0.0, self.chrome.sidebar.clone()));
            }
            if let Some(inspector) = &self.chrome.inspector {
                views.push((
                    "inspector".to_string(),
                    (vp_w - self.chrome.inspector_width).max(0.0),
                    0.0,
                    inspector.view.clone(),
                ));
            }
            if let Some(project) = self.workspace.ws.active()
                && let Some(tab) = project.layout.active_tab()
                && let Some(crate::panes::PaneEntity::Hosted(pane_view)) = self.workspace.panes.get(&(project.id(), tab.id)).map(|s| &s.entity)
            {
                let left = self.chrome.global_rail_width + if self.chrome.sidebar_visible { self.chrome.sidebar_width + 1.0 } else { 0.0 };
                let module = pane_view.read(cx).view_name().to_string();
                views.push((format!("pane:{module}"), left, 0.0, pane_view.clone()));
            }
        }
        views.push(("workbench".to_string(), 0.0, 0.0, self.chrome.workbench.clone()));
        views
    }

    /// Collects native GPUI shell chrome, diorama canvas, and pane elements containing `(x, y)` with `.rs` source locations.
    pub(crate) fn inspect_native_at(&self, x: f32, y: f32, vp_w: f32, vp_h: f32, cx: &App) -> Option<vibevalley_protocol::VdpUiInspectAtResult> {
        use vibevalley_protocol::{VdpUiBounds, VdpUiInspectAtResult};
        use vibevalley_workspace::PaneKind;

        let mut candidates = Vec::new();
        let rail_w = self.chrome.global_rail_width;

        if self.overlays.devtools.state.enabled {
            let cap_w = 340.0f32.min(vp_w - 16.0).max(160.0);
            candidates.push(VdpUiInspectAtResult {
                hit: true,
                surface: Some("shell".into()),
                test_id: Some("devtools-capsule".into()),
                role: Some("button".into()),
                text: Some(self.overlays.devtools.state.format_capsule()),
                route: None,
                source: Some("apps/mac/src/shell/devtools.rs:475".into()),
                bounds: Some(VdpUiBounds {
                    x: (vp_w - cap_w) * 0.5,
                    y: (vp_h - 36.0).max(0.0),
                    width: cap_w,
                    height: 26.0,
                }),
            });
        }

        if let Some(slot) = &self.chrome.native_diorama {
            candidates.push(VdpUiInspectAtResult {
                hit: true,
                surface: Some("diorama".into()),
                test_id: Some("diorama-canvas".into()),
                role: Some("canvas".into()),
                text: Some(slot.view.read(cx).debug_state()["kind"].as_str().unwrap_or("diorama").to_string()),
                route: Some("/farm".into()),
                source: Some("apps/mac/src/diorama/view.rs:1".into()),
                bounds: Some(VdpUiBounds {
                    x: rail_w,
                    y: 0.0,
                    width: (vp_w - rail_w).max(0.0),
                    height: vp_h,
                }),
            });
        }

        if self.chrome.native_workspace {
            if self.chrome.sidebar_visible {
                let div_x = rail_w + self.chrome.sidebar_width;
                candidates.push(VdpUiInspectAtResult {
                    hit: true,
                    surface: Some("shell".into()),
                    test_id: Some("sidebar-divider".into()),
                    role: Some("separator".into()),
                    text: None,
                    route: None,
                    source: Some("apps/mac/src/shell/render.rs:80".into()),
                    bounds: Some(VdpUiBounds {
                        x: (div_x - 3.0).max(0.0),
                        y: 0.0,
                        width: 6.0,
                        height: vp_h,
                    }),
                });
            }
            if self.chrome.inspector.is_some() {
                let div_x = (vp_w - self.chrome.inspector_width).max(0.0);
                candidates.push(VdpUiInspectAtResult {
                    hit: true,
                    surface: Some("shell".into()),
                    test_id: Some("inspector-divider".into()),
                    role: Some("separator".into()),
                    text: None,
                    route: None,
                    source: Some("apps/mac/src/shell/render.rs:98".into()),
                    bounds: Some(VdpUiBounds {
                        x: (div_x - 3.0).max(0.0),
                        y: 0.0,
                        width: 6.0,
                        height: vp_h,
                    }),
                });
            }

            let main_left = rail_w + if self.chrome.sidebar_visible { self.chrome.sidebar_width + 1.0 } else { 0.0 };
            let main_right = vp_w
                - if self.chrome.inspector.is_some() {
                    self.chrome.inspector_width + 1.0
                } else {
                    0.0
                };
            let main_bounds = VdpUiBounds {
                x: main_left,
                y: 0.0,
                width: (main_right - main_left).max(0.0),
                height: vp_h,
            };
            if let Some(project) = self.workspace.ws.active()
                && let Some(tab) = project.layout.active_tab()
            {
                let (test_id, role, source) = match &tab.kind {
                    PaneKind::Terminal { terminal_id, .. } => (format!("pane:terminal:{terminal_id}"), "terminal", "apps/mac/src/panes.rs:1"),
                    PaneKind::File { path } => {
                        let is_md = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"));
                        (
                            format!("pane:file:{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("file")),
                            "document",
                            if is_md {
                                "apps/mac/src/markdown_pane.rs:1"
                            } else {
                                "apps/mac/src/viewer.rs:1"
                            },
                        )
                    }
                    PaneKind::Diff { .. } => ("pane:diff".to_string(), "diff", "apps/mac/src/diff.rs:1"),
                    PaneKind::Diorama { scene, .. } => (format!("pane:diorama:{scene}"), "canvas", "apps/mac/src/diorama/view.rs:1"),
                    PaneKind::Hosted { module, .. } => (format!("pane:hosted:{module}"), "region", "apps/mac/src/hosted/view.rs:1"),
                    PaneKind::Chat { .. } => ("pane:chat".to_string(), "region", "apps/mac/src/panes.rs:1"),
                };
                candidates.push(VdpUiInspectAtResult {
                    hit: true,
                    surface: Some("workspace".into()),
                    test_id: Some(test_id),
                    role: Some(role.into()),
                    text: Some(super::tab_title(self, tab, cx)),
                    route: Some("/workspace".into()),
                    source: Some(source.into()),
                    bounds: Some(main_bounds),
                });
            }
        }

        crate::vdp_bus::select_deepest_hit(x, y, candidates)
    }

    pub fn handle_inspector_click(&mut self, x: f32, y: f32, window: &Window, cx: &mut Context<Self>) {
        let vp = window.viewport_size();
        let vp_w = f32::from(vp.width);
        let vp_h = f32::from(vp.height);
        let native_hit = self.inspect_native_at(x, y, vp_w, vp_h, cx);
        let hosted_views: Vec<(String, f32, f32)> = self
            .hosted_view_origins(vp_w, vp_h, cx)
            .into_iter()
            .map(|(surface, ox, oy, _)| (surface, ox, oy))
            .collect();
        self.overlays.devtools.inspecting = false;
        self.overlays.devtools.highlighted = native_hit.clone();
        self.push_devtools_inspector(cx);
        cx.notify();

        let shell_weak = cx.weak_entity();
        let win_handle = window.window_handle();
        cx.spawn(async move |_, cx| {
            let best = crate::vdp_bus::inspect_hosted_views_at(hosted_views, x, y, native_hit, Duration::from_millis(800)).await;
            if let Some(hit) = best {
                let _ = cx.update_window(win_handle, |_, _, cx| {
                    let _ = shell_weak.update(cx, |shell, cx| {
                        shell.set_devtools_highlight(Some(hit), cx);
                    });
                });
            }
        })
        .detach();
    }

    pub fn jump_to_devtools_source(&mut self, raw_path: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return;
        }
        let candidate = std::path::PathBuf::from(trimmed);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            let from_active = self.workspace.ws.active().map(|p| p.root().join(trimmed)).filter(|p| p.exists());
            let from_any = self.workspace.ws.projects().iter().find_map(|p| {
                let c = p.root().join(trimmed);
                c.exists().then_some(c)
            });
            let from_repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|p| p.parent())
                .map(|root| root.join(trimmed))
                .filter(|p| p.exists());
            from_active.or(from_any).or(from_repo).unwrap_or(candidate)
        };
        if resolved.exists() {
            self.open_file_adjacent(resolved, line, window, cx);
        }
    }

    pub(super) fn render_inspector_overlay(&self, window: &Window, cx: &Context<Self>) -> Option<gpui::Div> {
        let inspecting = self.overlays.devtools.inspecting;
        let hit = self.overlays.devtools.highlighted.as_ref();
        if !inspecting && hit.is_none() {
            return None;
        }
        let colors = &Ui::get(cx).colors;
        let mono = Ui::get(cx).mono();
        let vp = window.viewport_size();
        let vp_w = f32::from(vp.width);
        let vp_h = f32::from(vp.height);

        let mut overlay = div().absolute().inset_0();
        if inspecting {
            overlay = overlay.child(
                div()
                    .id("inspector-mode-banner")
                    .absolute()
                    .top(px(8.0))
                    .left(px((vp_w * 0.5 - 150.0).max(8.0)))
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(999.0))
                    .bg(colors.accent)
                    .text_color(colors.bg)
                    .font_family(mono.clone())
                    .text_xs()
                    .child(vibevalley_i18n::t("desktop.devtools.inspectingHint", &[])),
            );
        }
        if let Some(sel) = hit
            && let Some(b) = sel.bounds
            && b.width > 0.0
            && b.height > 0.0
        {
            let tag = match (&sel.test_id, &sel.source) {
                (Some(id), Some(src)) => format!("{id} · {src}"),
                (Some(id), None) => id.clone(),
                (None, Some(src)) => src.clone(),
                (None, None) => sel.surface.clone().unwrap_or_else(|| "element".to_string()),
            };
            let badge_top = if b.y >= 24.0 { b.y - 22.0 } else { (b.y + b.height + 4.0).min(vp_h - 24.0) };
            let badge_left = b.x.clamp(8.0, (vp_w - 280.0).max(8.0));
            overlay = overlay
                .child(
                    div()
                        .id("inspector-highlight-box")
                        .absolute()
                        .left(px(b.x))
                        .top(px(b.y))
                        .w(px(b.width))
                        .h(px(b.height))
                        .border_2()
                        .border_color(colors.accent)
                        .bg(gpui::hsla(0.58, 0.75, 0.52, 0.12)),
                )
                .child(
                    div()
                        .id("inspector-highlight-label")
                        .absolute()
                        .left(px(badge_left))
                        .top(px(badge_top))
                        .px(px(6.0))
                        .py(px(2.0))
                        .rounded(px(4.0))
                        .bg(colors.accent)
                        .text_color(colors.bg)
                        .font_family(mono)
                        .text_xs()
                        .child(tag),
                );
        }
        Some(overlay)
    }

    pub(super) fn devtools_for_each_view(&self, cx: &mut Context<Self>, mut f: impl FnMut(&mut HostedView, &mut Context<HostedView>)) {
        if let Some((view, _)) = &self.overlays.devtools.overlay {
            view.update(cx, &mut f);
        }
        if let Some(view) = self.overlays.devtools.detached_view.as_ref().and_then(WeakEntity::upgrade) {
            view.update(cx, &mut f);
        }
    }

    pub(super) fn render_devtools_overlay(&self, cx: &Context<Self>) -> Option<gpui::Stateful<gpui::Div>> {
        if !self.overlays.devtools.state.is_overlay_open() {
            return None;
        }
        let (view, _) = self.overlays.devtools.overlay.as_ref()?;
        let colors = &Ui::get(cx).colors;
        Some(
            div()
                .id("devtools-overlay")
                .absolute()
                .bottom(px(44.0))
                .left(px(24.0))
                .right(px(24.0))
                .h(px(460.0))
                .rounded(px(12.0))
                .overflow_hidden()
                .bg(colors.elevated)
                .border_1()
                .border_color(colors.border)
                .shadow_lg()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(view.clone()),
        )
    }

    pub(super) fn render_devtools_capsule(&self, cx: &mut Context<Self>) -> Option<gpui::Div> {
        if !self.overlays.devtools.state.enabled {
            return None;
        }
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let mono = ui.mono();
        let state = &self.overlays.devtools.state;
        let frame_color = if state.capsule.last_frame_ms >= 50.0 {
            colors.danger
        } else if state.capsule.last_frame_ms >= 16.0 {
            colors.warning
        } else {
            colors.success
        };
        let dot_color = if state.open { colors.accent } else { frame_color };
        let label = state.format_capsule();
        Some(
            div().absolute().left_0().right_0().bottom(px(10.0)).flex().flex_row().justify_center().child(
                div()
                    .id("devtools-capsule")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .py(px(4.0))
                    .rounded(px(999.0))
                    .bg(colors.elevated)
                    .border_1()
                    .border_color(if state.open { colors.accent } else { colors.border })
                    .shadow_md()
                    .cursor_pointer()
                    .font_family(mono)
                    .text_xs()
                    .text_color(colors.text)
                    .hover(move |style| style.bg(colors.surface))
                    .tooltip(gpui_tooltip("Toggle DevTools", &colors))
                    .tooltip_show_delay(TOOLTIP_SHOW_DELAY)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|s, _, window, cx| {
                            cx.stop_propagation();
                            s.toggle_devtools(window, cx);
                        }),
                    )
                    .child(div().w(px(6.0)).h(px(6.0)).rounded(px(999.0)).bg(dot_color))
                    .child(label),
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devtools_enable_gate_matches_only_one() {
        assert!(devtools_enabled_from(Some("1")));
        assert!(devtools_enabled_from(Some(" 1 ")));
        assert!(!devtools_enabled_from(None));
        assert!(!devtools_enabled_from(Some("")));
        assert!(!devtools_enabled_from(Some("0")));
        assert!(!devtools_enabled_from(Some("true")));
    }

    #[test]
    fn disabled_devtools_ignores_all_transitions_and_frame_recording() {
        let mut state = DevtoolsState::new(false, "dev", 8790);
        assert!(!state.is_overlay_open());
        assert!(!state.toggle());
        assert!(!state.open);
        assert!(!state.detached);
        assert!(!state.detach());
        assert!(!state.open);
        assert!(!state.detached);
        assert!(!state.close());
        assert!(!state.on_detached_closed());
        state.record_frame_ms(12.5);
        assert_eq!(state.last_frame_ms, 0.0);
        assert_eq!(state.capsule.last_frame_ms, 0.0);
    }

    #[test]
    fn enabled_devtools_transitions_closed_overlay_detached_closed() {
        let mut state = DevtoolsState::new(true, "dev", 8790);
        assert!(!state.open);
        assert!(!state.detached);
        assert!(!state.is_overlay_open());

        assert!(state.toggle());
        assert!(state.open);
        assert!(!state.detached);
        assert!(state.is_overlay_open());

        assert!(state.detach());
        assert!(state.open);
        assert!(state.detached);
        assert!(!state.is_overlay_open());

        assert!(state.on_detached_closed());
        assert!(!state.open);
        assert!(!state.detached);
        assert!(!state.is_overlay_open());

        assert!(state.toggle());
        assert!(state.is_overlay_open());
        assert!(state.close());
        assert!(!state.open);
        assert!(!state.detached);

        assert!(state.detach());
        assert!(state.detached);
        assert!(state.toggle());
        assert!(!state.open);
        assert!(!state.detached);
    }

    #[test]
    fn capsule_formatting_includes_all_five_live_signals() {
        let mut state = DevtoolsState::new(true, "alpha", 8789);
        state.capsule.route = "/workspace".into();
        state.capsule.active_sessions = 3;
        state.capsule.active_subs = 7;
        state.capsule.latest_seq = 142;
        state.record_frame_ms(4.25);

        let text = state.format_capsule();
        assert!(text.contains("alpha :8789"), "missing channel/port in {text}");
        assert!(text.contains("/workspace"), "missing route in {text}");
        assert!(text.contains("3s/7sub"), "missing sessions/subs in {text}");
        assert!(text.contains("seq 142"), "missing seq in {text}");
        assert!(text.contains("4.2ms") || text.contains("4.3ms"), "missing frame ms in {text}");
    }

    #[test]
    fn cached_overlay_visibility_frame_tracks_open_close_reopen_and_ready_reset() {
        let mut state = DevtoolsState::new(true, "dev", 8790);
        let mut outbox = crate::hosted::Outbox::default();

        assert!(state.toggle());
        let (event, env) = outbox
            .envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame())
            .expect("initial open pushes devtools_visible frame");
        assert_eq!(event, "frame:devtools_visible");
        assert_eq!(env["rev"], 1);
        assert_eq!(env["data"], json!({ "visible": true }));

        assert!(
            outbox.envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame()).is_none(),
            "unchanged visibility is deduplicated"
        );

        outbox.reset();
        let (_, ready_env) = outbox
            .envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame())
            .expect("Ready re-pushes current visibility");
        assert_eq!(ready_env["rev"], 1);
        assert_eq!(ready_env["data"], json!({ "visible": true }));

        assert!(state.close());
        let (_, hidden_env) = outbox
            .envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame())
            .expect("closing pushes visible=false");
        assert_eq!(hidden_env["rev"], 2);
        assert_eq!(hidden_env["data"], json!({ "visible": false }));

        assert!(state.toggle());
        let (_, reopened_env) = outbox
            .envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame())
            .expect("reopening cached overlay pushes visible=true");
        assert_eq!(reopened_env["rev"], 3);
        assert_eq!(reopened_env["data"], json!({ "visible": true }));

        assert!(state.toggle());
        assert!(!state.is_overlay_open());
        outbox.reset();
        let (_, closed_ready_env) = outbox
            .envelope(DEVTOOLS_VISIBLE_TOPIC, state.overlay_visibility_frame())
            .expect("Ready after close pushes visible=false");
        assert_eq!(closed_ready_env["rev"], 1);
        assert_eq!(closed_ready_env["data"], json!({ "visible": false }));
    }

    #[test]
    fn frame_recording_and_periodic_host_debug_gate_on_open_or_slow_frame() {
        let disabled = DevtoolsState::new(false, "dev", 8790);
        assert!(!disabled.should_record_frame(1_000));
        assert!(!disabled.should_record_frame(crate::hosted::SLOW_FRAME_US));
        assert!(!disabled.should_publish_periodic_host_debug());

        let mut state = DevtoolsState::new(true, "dev", 8790);
        assert!(!state.should_record_frame(4_200));
        assert!(!state.should_record_frame(crate::hosted::SLOW_FRAME_US - 1));
        assert!(state.should_record_frame(crate::hosted::SLOW_FRAME_US));
        assert!(state.should_record_frame(42_000));
        assert!(!state.should_publish_periodic_host_debug());

        assert!(state.toggle());
        assert!(state.should_record_frame(1_000));
        assert!(state.should_record_frame(crate::hosted::SLOW_FRAME_US));
        assert!(state.should_publish_periodic_host_debug());

        assert!(state.detach());
        assert!(!state.is_overlay_open());
        assert!(state.should_record_frame(1_000));
        assert!(state.should_publish_periodic_host_debug());

        assert!(state.on_detached_closed());
        assert!(!state.should_record_frame(4_200));
        assert!(state.should_record_frame(crate::hosted::SLOW_FRAME_US));
        assert!(!state.should_publish_periodic_host_debug());
    }
}
