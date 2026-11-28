use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement as _, Pixels, Point, Render, ScrollEvent, Styled as _, Subscription, Window, canvas, div, px,
};
use serde_json::{Value, json};

use super::super::scene::DioramaAction;
use super::hud::{app_dark, diorama_loading_overlay, motion_enabled, phone_overlay_size};
use super::{DioramaEvent, DioramaView, SceneState};
use crate::hosted::{HostedEvent, HostedView};

impl DioramaView {
    fn overlay(&mut self, name: &'static str, request: Value, window: &mut Window, cx: &mut Context<Self>) -> (Entity<HostedView>, Subscription) {
        let params = request.as_object().cloned().unwrap_or_default();
        let dark = app_dark(window, cx);
        let view = cx.new(|cx| HostedView::new(name, params, dark, window, cx));
        let sub = cx.subscribe_in(&view, window, move |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(crate::hosted::Action::DismissFarmForm) => {
                if name == "farm-phone" {
                    if let SceneState::Ready(d) = &mut this.scene {
                        d.phone.close();
                    }
                } else {
                    this.sheet = None;
                }
                window.focus(&this.focus, cx);
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::GlobalRoute { path }) => {
                this.sheet = None;
                cx.emit(DioramaEvent::Route(path.clone()));
            }
            HostedEvent::Action(crate::hosted::Action::FarmHandset {
                unfolded,
                large,
                game,
                active_call,
            }) if name == "farm-phone" => {
                if let SceneState::Ready(d) = &mut this.scene {
                    d.phone.unfolded = *unfolded;
                    d.phone.large = *large;
                    d.phone.game = *game;
                    d.phone.active_call = *active_call;
                }
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::SilenceFarmPhone) => {
                if let SceneState::Ready(d) = &mut this.scene {
                    d.phone.silence();
                }
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::FarmCall { id, answered }) => {
                if let SceneState::Ready(d) = &mut this.scene
                    && let Some(call) = d.frame.inbox.iter().find(|c| &c.id == id).cloned()
                {
                    d.phone.settle(call, *answered);
                }
                cx.notify();
            }
            HostedEvent::HostCall { op, reply } => cx.emit(DioramaEvent::HostCall {
                op: op.clone(),
                reply: reply.clone(),
            }),
            _ => {}
        });
        (view, sub)
    }

    fn mount_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let dark = app_dark(window, cx);
        if self.last_dark != Some(dark) {
            self.last_dark = Some(dark);
            if let Some((view, _)) = &self.phone {
                view.update(cx, |v, cx| v.set_dark(dark, cx));
            }
            if let Some((view, _)) = &self.sheet {
                view.update(cx, |v, cx| v.set_dark(dark, cx));
            }
        }
        if let Some(request) = self.sheet_request.take() {
            self.sheet = Some(self.overlay("farm-form", request, window, cx));
        }
        let SceneState::Ready(d) = &self.scene else { return };
        let phone = &d.phone;
        let calls = json!({
            "open": phone.open,
            "narrow": d.view_size.0 - 16.0 < 640.0,
            "ringing": phone.ringing,
            "missed": phone.missed(&d.frame.inbox).collect::<Vec<_>>(),
            "log": phone.log,
        });
        let unfolded = phone.unfolded;
        let open = phone.open;
        if self.phone.is_none() && open {
            self.phone = Some(self.overlay("farm-phone", json!({ "calls": calls, "unfolded": unfolded }), window, cx));
        }
        if let Some((view, _)) = &self.phone {
            view.update(cx, |v, cx| v.push("calls", calls, cx));
        }
    }

    fn norm_point(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let bounds = self.bounds.get()?;
        let w = f32::from(bounds.size.width).max(1.0);
        let h = f32::from(bounds.size.height).max(1.0);
        let nx = (f32::from(at.x - bounds.origin.x) / w).clamp(0.0, 1.0);
        let ny = (f32::from(at.y - bounds.origin.y) / h).clamp(0.0, 1.0);
        Some((nx, ny))
    }

    fn schedule_pump(&mut self, cx: &mut Context<Self>) {
        if self.pump_scheduled {
            return;
        }
        self.pump_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(66)).await;
            let _ = this.update(cx, |v, cx| {
                v.pump_scheduled = false;
                if matches!(v.scene, SceneState::Ready(_)) {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn dispatch_action(&mut self, action: DioramaAction, cx: &mut Context<Self>) {
        match action {
            DioramaAction::OpenForm(req) => {
                self.sheet_request = Some(req);
            }
            DioramaAction::Route(path) => {
                cx.emit(DioramaEvent::Route(path));
            }
            DioramaAction::OpenTerminal { cwd, title } => {
                cx.emit(DioramaEvent::Terminal { cwd, title });
            }
            DioramaAction::OpenPhone => {
                if let SceneState::Ready(d) = &mut self.scene {
                    d.phone.open = true;
                    d.phone.unfolded = true;
                }
                if let Some((phone, _)) = &self.phone {
                    phone.update(cx, |v, cx| v.push("unfold", json!(self.taps.len()), cx));
                }
            }
            DioramaAction::FocusedBuilding | DioramaAction::None => {}
        }
        cx.notify();
    }

    pub fn set_clock(&mut self, tod: Option<f32>) {
        if let (SceneState::Ready(d), Some(t)) = (&mut self.scene, tod) {
            let choice = match t.rem_euclid(1.0) {
                x if x < 0.28 => vibevalley_diorama::TimeOfDay::Dawn,
                x if x < 0.62 => vibevalley_diorama::TimeOfDay::Noon,
                x if x < 0.82 => vibevalley_diorama::TimeOfDay::Dusk,
                _ => vibevalley_diorama::TimeOfDay::Night,
            };
            d.set_time_of_day(choice, true);
        }
    }

    pub fn debug_state(&self) -> Value {
        let scene = match &self.scene {
            SceneState::Loading => json!("loading"),
            SceneState::Failed(e) => json!({ "failed": e }),
            SceneState::Ready(d) => d.debug_state(),
        };
        let placed = self.bounds.get().map(|b| {
            json!({
                "w": f32::from(b.size.width),
                "h": f32::from(b.size.height),
                "scale": self.display_scale,
            })
        });
        json!({
            "kind": self.kind,
            "frames_seen": self.frames_seen,
            "scene": scene,
            "placed": placed,
            "taps": self.taps,
            "unpainted_draws": self.unpainted_draws,
        })
    }

    pub fn draw_unpainted(&mut self, cx: &App) {
        if let SceneState::Ready(d) = &mut self.scene {
            let (vw, vh) = self
                .bounds
                .get()
                .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
                .unwrap_or(d.view_size);
            d.tick_and_submit(vw, vh, self.display_scale, true, motion_enabled(cx));
            self.unpainted_draws += 1;
        }
    }
}

impl Render for DioramaView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.display_scale = window.scale_factor();
        self.mount_sheet(window, cx);
        let allow_animation = motion_enabled(cx);
        let is_ready = matches!(self.scene, SceneState::Ready(_));
        let mut sounds = Vec::new();
        if let SceneState::Ready(d) = &mut self.scene {
            let (vw, vh) = self
                .bounds
                .get()
                .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
                .unwrap_or(d.view_size);
            let active = window.is_window_active();
            d.tick_and_submit(vw, vh, window.scale_factor(), active, allow_animation);
            sounds.extend(d.drain_sounds());
            if active || d.latest_bgra().is_none() {
                if allow_animation && d.is_active_motion() {
                    window.request_animation_frame();
                } else if allow_animation || d.needs_frame() {
                    self.schedule_pump(cx);
                }
            }
        }
        for cue in sounds {
            cx.emit(DioramaEvent::Sound(cue));
        }

        let loading_overlay = matches!(self.scene, SceneState::Loading) && self.show_loading;
        let failed_message = match &self.scene {
            SceneState::Failed(e) => Some(e.clone()),
            _ => None,
        };
        let bounds_cell = self.bounds.clone();
        let entity = cx.entity();
        let canvas_element: Option<AnyElement> = is_ready.then(|| {
            canvas(
                move |bounds, _, _| bounds,
                move |bounds, _, window, cx| {
                    bounds_cell.set(Some(bounds));
                    entity.update(cx, |v, _cx| {
                        let mut surface = std::mem::take(&mut v.surface);
                        if let SceneState::Ready(d) = &mut v.scene {
                            let vw = f32::from(bounds.size.width);
                            let vh = f32::from(bounds.size.height);
                            if (d.view_size.0 - vw).abs() > 1.0 || (d.view_size.1 - vh).abs() > 1.0 {
                                d.tick_and_submit(vw, vh, window.scale_factor(), window.is_window_active(), allow_animation);
                            }
                            if let Some((w, h, frame_gen, bgra)) = d.latest_bgra() {
                                surface.paint_bgra_frame(bgra, w, h, frame_gen, bounds, window);
                            }
                        }
                        v.surface = surface;
                    });
                },
            )
            .size_full()
            .into_any_element()
        });

        let hud = self.render_hud(window, cx);
        let canvas_layer = div()
            .id("diorama")
            .track_focus(&self.focus)
            .size_full()
            .bg(gpui::rgb(0x1e2620))
            .on_key_down(cx.listener(|v, e: &KeyDownEvent, _, cx| {
                let SceneState::Ready(d) = &mut v.scene else { return };
                match e.keystroke.key.as_str() {
                    "escape" => {
                        if d.phone.open {
                            d.phone.close();
                        } else if !d.exit_focus() && d.world.roof_cutaway_open() {
                            d.world.set_roof_cutaway(false);
                            d.touch();
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }
                    " " | "space" => {
                        d.toggle_cutaway();
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "r" => {
                        d.reset_camera();
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "p" => {
                        if d.phone.open {
                            d.phone.close();
                        } else {
                            d.phone.open = true;
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "1" => {
                        d.set_time_of_day(vibevalley_diorama::TimeOfDay::Dawn, false);
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "2" => {
                        d.set_time_of_day(vibevalley_diorama::TimeOfDay::Noon, false);
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "3" => {
                        d.set_time_of_day(vibevalley_diorama::TimeOfDay::Dusk, false);
                        cx.stop_propagation();
                        cx.notify();
                    }
                    "4" => {
                        d.set_time_of_day(vibevalley_diorama::TimeOfDay::Night, false);
                        cx.stop_propagation();
                        cx.notify();
                    }
                    _ => {}
                }
            }))
            .on_mouse_move(cx.listener(|v, e: &MouseMoveEvent, _, cx| {
                if v.sheet.is_some() || !matches!(v.scene, SceneState::Ready(_)) {
                    return;
                }
                if let Some(prev) = v.drag_last {
                    let dx = f32::from(e.position.x - prev.x);
                    let dy = f32::from(e.position.y - prev.y);
                    v.drag_moved += dx.hypot(dy);
                    v.drag_last = Some(e.position);
                    if v.drag_moved > 4.0
                        && let SceneState::Ready(d) = &mut v.scene
                    {
                        d.pan(dx, dy);
                        cx.notify();
                    }
                    return;
                }
                if let Some((nx, ny)) = v.norm_point(e.position)
                    && let SceneState::Ready(d) = &mut v.scene
                {
                    d.hover_at(nx, ny);
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|v, e: &MouseDownEvent, window, cx| {
                    if v.sheet.is_some() || !matches!(v.scene, SceneState::Ready(_)) {
                        return;
                    }
                    window.focus(&v.focus, cx);
                    v.drag_start = Some(e.position);
                    v.drag_last = Some(e.position);
                    v.drag_moved = 0.0;
                    cx.notify();
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|v, e: &gpui::MouseUpEvent, _, cx| {
                    if !matches!(v.scene, SceneState::Ready(_)) {
                        return;
                    }
                    let moved = v.drag_moved;
                    v.drag_start = None;
                    v.drag_last = None;
                    v.drag_moved = 0.0;
                    if moved <= 5.0
                        && v.sheet.is_none()
                        && let Some((nx, ny)) = v.norm_point(e.position)
                        && let SceneState::Ready(d) = &mut v.scene
                    {
                        let action = d.click_at(nx, ny, false);
                        v.taps.push(format!("{action:?}"));
                        v.dispatch_action(action, cx);
                    }
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|v, _, _, cx| {
                    v.drag_start = None;
                    v.drag_last = None;
                    v.drag_moved = 0.0;
                    cx.notify();
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|v, e: &MouseDownEvent, _, cx| {
                    if v.sheet.is_some() || !matches!(v.scene, SceneState::Ready(_)) {
                        return;
                    }
                    if let Some((nx, ny)) = v.norm_point(e.position)
                        && let SceneState::Ready(d) = &mut v.scene
                    {
                        let action = d.click_at(nx, ny, true);
                        v.taps.push(format!("{action:?}"));
                        v.dispatch_action(action, cx);
                    }
                }),
            )
            .on_scroll(cx.listener(|v, e: &ScrollEvent, _, cx| {
                if v.sheet.is_some() || !matches!(v.scene, SceneState::Ready(_)) {
                    return;
                }
                let dy = f32::from(e.delta.pixel_delta(px(20.0)).y);
                let delta = (dy / 32.0).clamp(-3.0, 3.0);
                if delta.abs() > 0.001 {
                    let (nx, ny) = v.norm_point(e.position).unwrap_or((0.5, 0.5));
                    if let SceneState::Ready(d) = &mut v.scene {
                        d.zoom_at(delta, nx, ny);
                    }
                    cx.notify();
                }
            }))
            .children(loading_overlay.then(diorama_loading_overlay))
            .children(failed_message.map(|m| div().p_4().text_color(gpui::rgb(0xfdf6e3)).child(m)))
            .children(canvas_element);

        let sheet = self.sheet.as_ref().map(|(view, _)| view.clone());
        let phone = self.phone.as_ref().and_then(|(view, _)| match &self.scene {
            SceneState::Ready(d) if d.phone.open => {
                let (w, h) = phone_overlay_size(d.view_size, &d.phone);
                Some(div().absolute().right(px(14.0)).bottom(px(14.0)).w(px(w)).h(px(h)).child(view.clone()))
            }
            _ => None,
        });

        let sheet_scrim = if app_dark(window, cx) {
            gpui::rgba(0x00000080)
        } else {
            gpui::rgba(0x1c191740)
        };

        div()
            .relative()
            .size_full()
            .child(canvas_layer)
            .children(hud)
            .children(phone)
            .children(sheet.map(|view| {
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(sheet_scrim)
                    .child(div().w(px(540.0)).max_w_full().h(px(430.0)).max_h_full().child(view))
            }))
    }
}
