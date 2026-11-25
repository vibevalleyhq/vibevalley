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

pub fn devtools_enabled_from(raw: Option<&str>) -> bool {
    raw.map(str::trim) == Some("1")
}

/// DevTools gate: enabled only when `VIBEVALLEY_DEBUG=1`.
pub fn devtools_enabled() -> bool {
    devtools_enabled_from(std::env::var("VIBEVALLEY_DEBUG").ok().as_deref())
}

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
                        let raw = bridge.server().slice_snapshot(SliceKind::Sessions);
                        let (active_sessions, latest_seq) = serde_json::from_value::<SessionsSlice>(raw)
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
                        HostedEvent::Ready => {}
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
            HostedEvent::Ready => this.push_devtools_overlay_visibility(cx),
        });
        self.overlays.devtools.overlay = Some((view, sub));
        self.push_devtools_overlay_visibility(cx);
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
