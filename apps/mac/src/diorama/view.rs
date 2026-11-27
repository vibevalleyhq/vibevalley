//! GPUI pane hosting the live 3D Papertrails [`DioramaScene`], fed by the
//! server's per-domain state slices and paired with hosted form/phone overlays.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, DevicePixels, Entity, EventEmitter, FocusHandle, Focusable, Hsla, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, Point, Render, ScrollEvent, Styled as _, Subscription, Window,
    canvas, div, point, px, size,
};
use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, SessionsSlice, SliceKind};

use super::frame::Frame;
use super::scene::{DioramaAction, DioramaScene};
use crate::hosted::{BridgeHub, HostedEvent, HostedView};

/// Events emitted by [`DioramaView`] to the enclosing [`crate::shell::Shell`].
#[derive(Debug, Clone)]
pub enum DioramaEvent {
    Sound(&'static str),
    HostCall {
        op: vibevalley_protocol::HostOp,
        reply: crate::hosted::Replier,
    },
    /// A VibeValley workbench route (`/issues/<id>`, `/agents`, `/repos`, …).
    Route(String),
    /// Open a native terminal in a session worktree or repository.
    Terminal {
        cwd: String,
        title: String,
    },
}

enum SceneState {
    Loading,
    Failed(String),
    Ready(Box<DioramaScene>),
}

/// Uploads the off-thread wgpu BGRA8 framebuffer into a persistent GPUI dynamic texture.
#[derive(Default)]
struct FrameSurface {
    texture: Option<gpui::DynamicTexture>,
    dims: (u32, u32),
    uploaded_gen: u64,
}

impl Drop for FrameSurface {
    fn drop(&mut self) {
        if let Some(texture) = self.texture {
            texture.remove();
        }
    }
}

impl FrameSurface {
    fn paint_bgra_frame(&mut self, bgra: &[u8], w: u32, h: u32, frame_gen: u64, bounds: Bounds<Pixels>, window: &mut Window) -> bool {
        if w == 0 || h == 0 || bgra.len() < (w as usize) * (h as usize) * 4 {
            return false;
        }
        if self.dims == (w, h)
            && self.uploaded_gen == frame_gen
            && frame_gen != 0
            && let Some(texture) = self.texture
        {
            return window.paint_dynamic_texture(bounds, texture).is_ok();
        }
        let sz = size(DevicePixels(w as i32), DevicePixels(h as i32));
        if self.dims != (w, h) {
            if let Some(texture) = self.texture.take() {
                window.remove_dynamic_texture(texture);
            }
            self.dims = (w, h);
        }
        let byte_len = (w as usize) * (h as usize) * 4;
        let pixels = &bgra[..byte_len];
        let texture = if let Some(texture) = self.texture {
            if window
                .update_dynamic_texture(texture, Bounds::new(point(DevicePixels(0), DevicePixels(0)), sz), pixels, w * 4)
                .is_err()
            {
                return false;
            }
            texture
        } else {
            let Ok(texture) = window.create_dynamic_texture(sz, pixels, w * 4) else {
                return false;
            };
            self.texture = Some(texture);
            texture
        };
        self.uploaded_gen = frame_gen;
        window.paint_dynamic_texture(bounds, texture).is_ok()
    }
}

struct SliceOutlet(tokio::sync::mpsc::UnboundedSender<(String, Value)>);

impl vibevalley_server::gateway::bridge::Outlet for SliceOutlet {
    fn send(&self, event: &str, data: Value) {
        let _ = self.0.send((event.to_string(), data));
    }
}

const DIORAMA_SLICES: &[SliceKind] = &[SliceKind::Farm, SliceKind::Board, SliceKind::Sessions, SliceKind::Inbox, SliceKind::Collab];

fn attach_diorama_bridge(
    bridge: &vibevalley_server::gateway::bridge::Bridge,
    kind: &str,
) -> (
    Arc<vibevalley_server::gateway::bridge::Client>,
    tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
    let identity = crate::hosted::next_client_identity(vibevalley_server::ClientKind::GpuiPixel, kind);
    let client = Arc::new(bridge.attach(identity, Arc::new(SliceOutlet(tx))));
    for slice in DIORAMA_SLICES {
        let topic = format!("slice:{}", slice.as_str());
        if let Err(error) = client.watch(&topic) {
            eprintln!("diorama watch {topic}: {error}");
        }
    }
    (client, rx)
}

fn decode_slice_frame<'a>(event: &'a str, envelope: &Value) -> Option<(&'a str, u64, Value)> {
    let topic = event.strip_prefix("frame:")?;
    let rev = envelope["rev"].as_u64().unwrap_or(0);
    let data = envelope["data"].clone();
    Some((topic, rev, data))
}

async fn pump_diorama_slices(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ack_client: Weak<vibevalley_server::gateway::bridge::Client>,
    mut apply: impl FnMut(&str, Value) -> bool,
) {
    while let Some((event, envelope)) = rx.recv().await {
        let Some((topic, rev, data)) = decode_slice_frame(&event, &envelope) else {
            continue;
        };
        if !apply(topic, data) {
            break;
        }
        // Only hold a Weak reference so dropping DioramaView drops Client and closes SliceOutlet.
        if let Some(client) = ack_client.upgrade() {
            client.applied_slice(topic, rev);
        }
    }
}

pub struct DioramaView {
    pub kind: String,
    props: Value,
    scene: SceneState,
    frame: Frame,
    focus: FocusHandle,
    surface: FrameSurface,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    display_scale: f32,
    drag_start: Option<Point<Pixels>>,
    drag_last: Option<Point<Pixels>>,
    drag_moved: f32,
    pump_scheduled: bool,
    pub frames_seen: u64,
    pub taps: Vec<String>,
    pub unpainted_draws: u64,
    phone: Option<(Entity<HostedView>, Subscription)>,
    sheet_request: Option<Value>,
    sheet: Option<(Entity<HostedView>, Subscription)>,
    last_dark: Option<bool>,
    /// Only reveals the cold-load indicator after 150ms so fast loads never flash.
    show_loading: bool,
    _theme_sub: Subscription,
    _slice_task: gpui::Task<()>,
    _bridge: Arc<vibevalley_server::gateway::bridge::Client>,
}

impl EventEmitter<DioramaEvent> for DioramaView {}

impl Focusable for DioramaView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl DioramaView {
    pub fn new(kind: &str, props: Value, cx: &mut Context<Self>) -> Self {
        let (client, rx) = attach_diorama_bridge(&cx.global::<BridgeHub>().0, kind);
        let ack_client = Arc::downgrade(&client);
        let slice_task = cx.spawn(async move |this, cx| {
            pump_diorama_slices(rx, ack_client, |topic, data| this.update(cx, |v, cx| v.on_slice(topic, data, cx)).is_ok()).await;
        });
        let theme_sub = cx.observe_global::<crate::theme::Ui>(|_, cx| cx.notify());

        let task = cx.background_executor().spawn(async move {
            let dir = crate::assets::diorama_dir();
            match DioramaScene::load_async(&dir).await {
                Ok(scene) => SceneState::Ready(Box::new(scene)),
                Err(error) => SceneState::Failed(error),
            }
        });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _ = this.update(cx, |v, cx| {
                if matches!(v.scene, SceneState::Loading) {
                    v.show_loading = true;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.spawn(async move |this, cx| {
            let scene = task.await;
            let _ = this.update(cx, |v, cx| {
                v.scene = scene;
                v.show_loading = false;
                v.on_scene_ready(cx);
                cx.notify();
            });
        })
        .detach();

        Self {
            kind: kind.to_string(),
            props,
            scene: SceneState::Loading,
            frame: Frame::default(),
            focus: cx.focus_handle(),
            surface: FrameSurface::default(),
            bounds: Rc::new(Cell::new(None)),
            display_scale: 1.0,
            drag_start: None,
            drag_last: None,
            drag_moved: 0.0,
            pump_scheduled: false,
            frames_seen: 0,
            taps: Vec::new(),
            unpainted_draws: 0,
            phone: None,
            sheet_request: None,
            sheet: None,
            last_dark: None,
            show_loading: false,
            _theme_sub: theme_sub,
            _slice_task: slice_task,
            _bridge: client,
        }
    }

    fn on_scene_ready(&mut self, cx: &mut Context<Self>) {
        if let SceneState::Ready(d) = &mut self.scene {
            if self.frames_seen > 0 {
                d.apply_frame(self.frame.clone());
                d.phone.feed(&d.frame.inbox, Instant::now());
            }
            if let Some(repo) = self.props["repo"].as_str() {
                d.repo = Some(repo.to_string());
                d.sync_from_frame();
            }
            self.fetch_agents(cx);
        }
    }

    fn on_slice(&mut self, topic: &str, value: Value, cx: &mut Context<Self>) {
        if value.is_null() {
            return;
        }
        self.frames_seen += 1;
        match topic {
            "slice:farm" => {
                let Ok(farm) = serde_json::from_value::<FarmFrame>(value) else { return };
                self.frame.apply_farm(farm.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_farm(farm);
                }
            }
            "slice:board" => {
                let Ok(board) = serde_json::from_value::<BoardSlice>(value) else { return };
                self.frame.apply_board(board.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_board(board);
                }
            }
            "slice:sessions" => {
                let Ok(sessions) = serde_json::from_value::<SessionsSlice>(value) else {
                    return;
                };
                self.frame.apply_sessions(sessions.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_sessions(sessions);
                }
            }
            "slice:inbox" => {
                let Ok(inbox) = serde_json::from_value::<InboxSlice>(value) else { return };
                self.frame.apply_inbox(inbox.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_inbox(inbox);
                    d.phone.feed(&d.frame.inbox, Instant::now());
                }
            }
            "slice:collab" => {
                let Ok(collab) = serde_json::from_value::<CollabSlice>(value) else { return };
                self.frame.apply_collab(collab.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_collab(collab);
                }
            }
            _ => return,
        }
        cx.notify();
    }

    fn fetch_agents(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = vibevalley_rt::current_or_global_handle().spawn(async move {
            server
                .call_with_async(vibevalley_server::gateway::bridge::CallerContext::local(), "agent.list".into(), json!({}))
                .await
        });
        cx.spawn(async move |this, cx| {
            let Ok(envelope) = task.await else { return };
            let _ = this.update(cx, |v, cx| {
                let agents = match envelope.error() {
                    Some(e) => Err(e.message),
                    None => serde_json::from_value::<Vec<vibevalley_protocol::Agent>>(envelope.data.unwrap_or(Value::Null)).map_err(|err| err.to_string()),
                };
                if let SceneState::Ready(d) = &mut v.scene {
                    match agents {
                        Ok(agents) => d.set_profiles(agents),
                        Err(error) => d.show_toast(error),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

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

    fn dispatch_action(&mut self, action: DioramaAction, cx: &mut Context<Self>) {
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

    fn render_hud(&mut self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let SceneState::Ready(d) = &mut self.scene else {
            return None;
        };
        let active_tod = d.world.time_of_day;
        let cutaway = d.world.roof_cutaway_open();
        let focused_building = d
            .world
            .focused_building
            .as_ref()
            .and_then(|fid| d.world.buildings.iter().find(|b| &b.id == fid).map(|b| (b.label.clone(), b.opens.clone())));
        let anchors = d.anchors.clone();
        let (vw, vh) = self
            .bounds
            .get()
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
            .unwrap_or(d.view_size);
        let hovered_text = d.hovered.as_ref().map(|h| match h {
            vibevalley_diorama::DioramaHit::Plot { title, .. } => title.clone(),
            vibevalley_diorama::DioramaHit::Building { label, .. } => label.clone(),
            vibevalley_diorama::DioramaHit::Helper { name, .. } => name.clone(),
            vibevalley_diorama::DioramaHit::Prop { label, .. } => label.clone(),
            vibevalley_diorama::DioramaHit::Ground => String::new(),
        });
        let toast_text = d.active_toast().map(str::to_string);
        let has_missed = d.phone.ringing.is_some() || d.phone.missed(&d.frame.inbox).next().is_some();
        let shop_coins = d.frame.progress.as_ref().map_or(0, |p| p.coins);
        let daily_summary = d.frame.progress.as_ref().and_then(|p| p.daily.as_ref()).map(|board| {
            let done = board.tasks.iter().filter(|task| task.completed).count() as i64;
            (done, board.tasks.len() as i64)
        });

        let ui_dark = app_dark(window, cx);
        let palette = HudPalette::for_scene(ui_dark, active_tod);
        let hover_bg = palette.hover;

        let tod_buttons = [
            vibevalley_diorama::TimeOfDay::Dawn,
            vibevalley_diorama::TimeOfDay::Noon,
            vibevalley_diorama::TimeOfDay::Dusk,
            vibevalley_diorama::TimeOfDay::Night,
        ]
        .into_iter()
        .map(|tod| {
            let selected = active_tod == tod;
            let button = div()
                .px(px(7.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .bg(if selected { palette.active_bg } else { gpui::rgba(0x00000000).into() })
                .text_color(if selected { palette.active_fg } else { palette.ink })
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            d.set_time_of_day(tod, false);
                            cx.notify();
                        }
                    }),
                )
                .child(t(hud_tod_label_key(tod), &[]));
            if selected { button } else { button.hover(move |s| s.bg(hover_bg)) }
        });

        let cutaway_button = {
            let button = div()
                .px(px(7.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .bg(if cutaway { palette.active_bg } else { gpui::rgba(0x00000000).into() })
                .text_color(if cutaway { palette.active_fg } else { palette.ink })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            d.toggle_cutaway();
                            cx.notify();
                        }
                    }),
                )
                .child(t(hud_cutaway_label_key(cutaway), &[]));
            if cutaway { button } else { button.hover(move |s| s.bg(hover_bg)) }
        };

        let toolbar = div()
            .flex()
            .items_center()
            .gap(px(4.0))
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(10.0))
            .bg(palette.surface)
            .border_1()
            .border_color(palette.border)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .children(tod_buttons)
            .child(hud_divider(&palette))
            .child(cutaway_button)
            .child(
                div()
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|v, _, _, cx| {
                            cx.stop_propagation();
                            if let SceneState::Ready(d) = &mut v.scene {
                                d.reset_camera();
                                cx.notify();
                            }
                        }),
                    )
                    .child(t("web.farm.hud.resetCamera", &[])),
            )
            .child(hud_divider(&palette))
            .child(
                div()
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _, _, cx| {
                            cx.stop_propagation();
                            cx.emit(DioramaEvent::Route("/repos".into()));
                        }),
                    )
                    .child(t("web.farm.menu.repos", &[])),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|v, _, _, cx| {
                            cx.stop_propagation();
                            if let SceneState::Ready(d) = &mut v.scene {
                                if d.phone.open {
                                    d.phone.close();
                                } else {
                                    d.phone.open = true;
                                }
                                cx.notify();
                            }
                        }),
                    )
                    .children(has_missed.then(|| phone_notification_dot(&palette)))
                    .child(t("web.farm.hud.phone", &[])),
            );

        let anchor_pills = anchors.into_iter().map(|anchor| {
            let dot = palette.anchor_dot(&anchor.tone);
            let left_px = (anchor.x * vw - 56.0).clamp(10.0, (vw - 140.0).max(10.0));
            let top_px = (anchor.y * vh - 14.0).clamp(48.0, (vh - 64.0).max(48.0));
            let clicked = anchor.clone();
            div()
                .absolute()
                .left(px(left_px))
                .top(px(top_px))
                .flex()
                .items_center()
                .gap(px(5.0))
                .px(px(8.0))
                .py(px(3.0))
                .rounded(px(8.0))
                .bg(palette.surface)
                .border_1()
                .border_color(palette.border)
                .cursor_pointer()
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            let action = d.activate_anchor(&clicked);
                            v.taps.push(format!("{action:?}"));
                            v.dispatch_action(action, cx);
                        }
                    }),
                )
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(dot))
                .child(div().text_size(px(11.0)).text_color(palette.ink).child(anchor.badge))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(palette.muted)
                        .max_w(px(110.0))
                        .overflow_hidden()
                        .child(anchor.label),
                )
        });

        let shop_pill = {
            let mut pill = div()
                .absolute()
                .top(px(12.0))
                .left(px(14.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .px(px(9.0))
                .py(px(4.0))
                .rounded(px(9.0))
                .bg(palette.surface)
                .border_1()
                .border_color(palette.border)
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|v, _, _, cx| {
                        cx.stop_propagation();
                        let req = match &v.scene {
                            SceneState::Ready(d) => json!({ "kind": "shop", "repo": d.repo }),
                            _ => return,
                        };
                        v.dispatch_action(DioramaAction::OpenForm(req), cx);
                    }),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(palette.ink)
                        .child(t("web.farm.hud.coins", &[("n", shop_coins.into())])),
                );
            if let Some((done, total)) = daily_summary {
                pill = pill.child(hud_divider(&palette)).child(
                    div()
                        .text_size(px(11.5))
                        .text_color(palette.muted)
                        .child(t("web.farm.hud.daily", &[("done", done.into()), ("total", total.into())])),
                );
            }
            pill.child(hud_divider(&palette))
                .child(div().text_size(px(11.5)).text_color(palette.ink).child(t("web.farm.hud.shop", &[])))
        };

        let mut overlay = div()
            .absolute()
            .inset_0()
            .children(anchor_pills)
            .child(shop_pill)
            .child(div().absolute().top(px(12.0)).right(px(12.0)).child(toolbar));

        if let Some(msg) = toast_text.filter(|m| !m.is_empty()) {
            overlay = overlay.child(
                div()
                    .absolute()
                    .top(px(48.0))
                    .left(px(14.0))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .text_size(px(12.0))
                    .text_color(palette.ink)
                    .child(msg),
            );
        }

        if let Some(label) = hovered_text.filter(|s| !s.is_empty()) {
            overlay = overlay.child(
                div()
                    .absolute()
                    .bottom(px(14.0))
                    .left(px(14.0))
                    .px(px(9.0))
                    .py(px(4.0))
                    .rounded(px(8.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .child(label),
            );
        }

        if let Some((label, opens)) = focused_building {
            overlay = overlay.child(
                div()
                    .absolute()
                    .bottom(px(14.0))
                    .left(px((vw * 0.5 - 120.0).max(16.0)))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(10.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(12.0)).text_color(palette.ink).child(label))
                    .child(
                        div()
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .bg(palette.active_bg)
                            .text_color(palette.active_fg)
                            .text_size(px(11.5))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |v, _, _, cx| {
                                    cx.stop_propagation();
                                    if let SceneState::Ready(d) = &mut v.scene {
                                        let action = d.dispatch_building_opens(&opens);
                                        v.dispatch_action(action, cx);
                                    }
                                }),
                            )
                            .child(t("web.farm.hud.enter", &[])),
                    )
                    .child(
                        div()
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .text_color(palette.muted)
                            .hover(move |s| s.bg(hover_bg))
                            .text_size(px(11.5))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|v, _, _, cx| {
                                    cx.stop_propagation();
                                    if let SceneState::Ready(d) = &mut v.scene {
                                        d.exit_focus();
                                        cx.notify();
                                    }
                                }),
                            )
                            .child(t("web.farm.hud.backToYard", &[])),
                    ),
            );
        }

        Some(overlay.into_any_element())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct HudPalette {
    dark: bool,
    surface: Hsla,
    border: Hsla,
    divider: Hsla,
    ink: Hsla,
    muted: Hsla,
    hover: Hsla,
    active_bg: Hsla,
    active_fg: Hsla,
    badge_dot: Hsla,
    badge_halo: Hsla,
    dot_vermilion: Hsla,
    dot_ochre: Hsla,
    dot_water: Hsla,
}

impl HudPalette {
    /// Selects a Papertrails warm-paper HUD surface for daytime light mode, and a
    /// deep translucent warm-charcoal surface whenever dark theme or night lighting is active.
    fn for_scene(ui_dark: bool, tod: vibevalley_diorama::TimeOfDay) -> Self {
        if ui_dark || matches!(tod, vibevalley_diorama::TimeOfDay::Night) {
            Self::dark(&crate::theme::Palette::dark())
        } else {
            Self::light(&crate::theme::Palette::light())
        }
    }

    fn light(theme: &crate::theme::Palette) -> Self {
        Self {
            dark: false,
            surface: gpui::rgba(0xfbf7eeeb).into(),
            border: gpui::rgb(0xdfd4be).into(),
            divider: gpui::rgba(0x7c64473d).into(),
            ink: gpui::rgb(0x2f2318).into(),
            muted: gpui::rgb(0x6e5f4f).into(),
            hover: theme.hover,
            active_bg: theme.accent,
            active_fg: theme.on_accent,
            badge_dot: theme.danger,
            badge_halo: Hsla { a: 0.24, ..theme.danger },
            dot_vermilion: theme.danger,
            dot_ochre: theme.warning,
            dot_water: theme.info,
        }
    }

    fn dark(theme: &crate::theme::Palette) -> Self {
        Self {
            dark: true,
            surface: Hsla { a: 0.88, ..theme.elevated },
            border: Hsla { a: 0.16, ..theme.text },
            divider: Hsla { a: 0.16, ..theme.text },
            ink: theme.text,
            muted: theme.muted,
            hover: theme.hover,
            active_bg: theme.accent,
            active_fg: theme.on_accent,
            badge_dot: theme.danger,
            badge_halo: Hsla { a: 0.28, ..theme.danger },
            dot_vermilion: theme.danger,
            dot_ochre: theme.warning,
            dot_water: theme.info,
        }
    }

    fn anchor_dot(&self, tone: &str) -> Hsla {
        match tone {
            "vermilion" => self.dot_vermilion,
            "ochre" => self.dot_ochre,
            _ => self.dot_water,
        }
    }
}

const fn hud_tod_label_key(tod: vibevalley_diorama::TimeOfDay) -> &'static str {
    match tod {
        vibevalley_diorama::TimeOfDay::Dawn => "web.farm.hud.dawn",
        vibevalley_diorama::TimeOfDay::Noon => "web.farm.hud.noon",
        vibevalley_diorama::TimeOfDay::Dusk => "web.farm.hud.dusk",
        vibevalley_diorama::TimeOfDay::Night => "web.farm.hud.night",
    }
}

const fn hud_cutaway_label_key(cutaway: bool) -> &'static str {
    if cutaway { "web.farm.hud.closeRoof" } else { "web.farm.hud.liftRoof" }
}

fn hud_divider(palette: &HudPalette) -> gpui::Div {
    div().w(px(1.0)).h(px(12.0)).mx(px(2.0)).bg(palette.divider)
}

fn phone_notification_dot(palette: &HudPalette) -> gpui::Div {
    div()
        .w(px(8.0))
        .h(px(8.0))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(palette.badge_halo)
        .child(div().w(px(5.0)).h(px(5.0)).rounded_full().bg(palette.badge_dot))
}

fn resolve_dark(ui: Option<&crate::theme::Ui>, appearance: gpui::WindowAppearance) -> bool {
    ui.map_or_else(
        || matches!(appearance, gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark),
        |ui| ui.colors.dark,
    )
}

fn app_dark(window: &Window, cx: &App) -> bool {
    resolve_dark(cx.try_global::<crate::theme::Ui>(), window.appearance())
}

fn motion_enabled(cx: &App) -> bool {
    cx.try_global::<crate::theme::Ui>()
        .is_none_or(|ui| ui.settings.effective_motion() != crate::theme::MotionChoice::Off)
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

/// Subtle Papertrails sprout emblem + slim progress track shown only when cold
/// diorama asset loading exceeds 150ms.
fn diorama_loading_overlay() -> AnyElement {
    let leaf_hi = gpui::rgb(0x9ec867);
    let leaf_lo = gpui::rgb(0x6e9c3c);
    let stem = gpui::rgb(0x527a2d);
    let soil = gpui::rgb(0x5c4430);
    let sprout = div()
        .w(px(28.0))
        .h(px(24.0))
        .relative()
        .child(div().absolute().left(px(4.0)).top(px(4.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_hi))
        .child(div().absolute().left(px(16.0)).top(px(2.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_lo))
        .child(div().absolute().left(px(12.0)).top(px(7.0)).w(px(4.0)).h(px(11.0)).rounded(px(1.5)).bg(stem))
        .child(div().absolute().left(px(6.0)).top(px(18.0)).w(px(16.0)).h(px(4.0)).rounded(px(2.0)).bg(soil));
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.0))
        .child(sprout)
        .child(
            div()
                .w(px(120.0))
                .h(px(4.0))
                .rounded_full()
                .bg(gpui::rgba(0xfdf6e31f))
                .overflow_hidden()
                .child(div().w(px(52.0)).h_full().rounded_full().bg(leaf_hi)),
        )
        .child(
            div()
                .text_size(px(11.5))
                .text_color(gpui::rgba(0xfdf6e399))
                .child(t("web.farm.native.loading", &[])),
        )
        .into_any_element()
}

fn phone_overlay_size(view_size: (f32, f32), phone: &super::phone::Phone) -> (f32, f32) {
    let (vw, vh) = view_size;
    let max_w = (vw - 28.0).max(220.0);
    let max_h = (vh - 76.0).max(220.0);
    let narrow = vw - 16.0 < 640.0;
    let chat_only = narrow && phone.unfolded;
    let game = phone.game && !chat_only;
    let chrome_h: f32 = if game { 90.0 } else { 34.0 };
    let preferred_screen_h: f32 = if phone.unfolded && phone.large {
        680.0
    } else if game || phone.unfolded || phone.ringing.is_some() {
        440.0
    } else {
        296.0
    };
    let h = (preferred_screen_h + chrome_h).min(max_h);
    let apps_w: f32 = if game {
        332.0
    } else if phone.unfolded {
        296.0
    } else {
        240.0
    };
    let preferred_w = if chat_only {
        max_w
    } else if phone.unfolded {
        24.0 + apps_w + 2.0 + if phone.large { (vw - 396.0).clamp(320.0, 560.0) } else { 320.0 }
    } else {
        24.0 + apps_w + 32.0
    };
    (preferred_w.min(max_w), h)
}

#[cfg(test)]
mod tests {
    use vibevalley_diorama::TimeOfDay;

    use super::{HudPalette, hud_cutaway_label_key, hud_tod_label_key, phone_overlay_size};
    use crate::diorama::phone::Phone;

    #[test]
    fn resolve_dark_uses_ui_global_then_window_appearance_fallback() {
        let light_ui = crate::theme::Ui::new(crate::theme::Settings::default(), false);
        let dark_ui = crate::theme::Ui::new(crate::theme::Settings::default(), true);
        assert!(!super::resolve_dark(Some(&light_ui), gpui::WindowAppearance::Dark));
        assert!(super::resolve_dark(Some(&dark_ui), gpui::WindowAppearance::Light));
        assert!(!super::resolve_dark(None, gpui::WindowAppearance::Light));
        assert!(super::resolve_dark(None, gpui::WindowAppearance::Dark));
        assert!(super::resolve_dark(None, gpui::WindowAppearance::VibrantDark));
    }

    #[test]
    fn hud_palette_adapts_to_ui_theme_and_night_diorama() {
        for daytime in [TimeOfDay::Dawn, TimeOfDay::Noon, TimeOfDay::Dusk] {
            let light = HudPalette::for_scene(false, daytime);
            assert!(!light.dark, "daytime light mode ({daytime:?}) should use light HUD palette");
            assert!(light.surface.l > 0.9, "light HUD surface should stay warm paper");
            assert!(light.surface.a < 1.0 && light.surface.a > 0.8);
            assert!(light.ink.l < 0.25, "light HUD ink should be dark for legibility");
            assert!(light.divider.a > 0.1);
            assert_ne!(light.anchor_dot("vermilion"), light.anchor_dot("ochre"));
            assert_ne!(light.anchor_dot("ochre"), light.anchor_dot("water"));
        }

        let dark_night = HudPalette::for_scene(true, TimeOfDay::Night);
        assert!(dark_night.dark);
        assert!(dark_night.surface.l < 0.2, "dark HUD surface should stay deep warm charcoal");
        assert!(dark_night.surface.a < 1.0 && dark_night.surface.a > 0.8);
        assert!(dark_night.ink.l > 0.85, "dark HUD ink should be light cream");
        assert!(dark_night.active_fg.l < 0.2, "dark active pill label should keep high contrast on leaf accent");
        assert!(dark_night.badge_dot.l > 0.5, "dark notification dot should remain crisp and bright");

        for tod in [TimeOfDay::Dawn, TimeOfDay::Noon, TimeOfDay::Dusk, TimeOfDay::Night] {
            let dark = HudPalette::for_scene(true, tod);
            assert_eq!(dark, dark_night, "dark theme must use dark HUD palette at {tod:?}");
        }

        // Night lighting also switches to dark HUD in light mode so no glaring cream pill floats over the night scene.
        assert_eq!(HudPalette::for_scene(false, TimeOfDay::Night), dark_night);
    }

    #[test]
    fn hud_i18n_keys_resolve_in_zh_and_en() {
        let keys = [
            hud_tod_label_key(TimeOfDay::Dawn),
            hud_tod_label_key(TimeOfDay::Noon),
            hud_tod_label_key(TimeOfDay::Dusk),
            hud_tod_label_key(TimeOfDay::Night),
            hud_cutaway_label_key(false),
            hud_cutaway_label_key(true),
            "web.farm.hud.resetCamera",
            "web.farm.menu.repos",
            "web.farm.hud.phone",
            "web.farm.hud.enter",
            "web.farm.hud.backToYard",
        ];

        for key in keys {
            let zh = vibevalley_i18n::t_in("zh", key, &[]);
            let en = vibevalley_i18n::t_in("en", key, &[]);
            assert!(!zh.is_empty() && zh != key, "zh missing translation for {key}: {zh:?}");
            assert!(!en.is_empty() && en != key, "en missing translation for {key}: {en:?}");
            assert_ne!(zh, en, "zh and en translations should differ for {key}");
        }

        assert_eq!(vibevalley_i18n::t_in("zh", hud_cutaway_label_key(false), &[]), "掀顶");
        assert_eq!(vibevalley_i18n::t_in("zh", hud_cutaway_label_key(true), &[]), "合顶");
        assert_eq!(vibevalley_i18n::t_in("en", hud_cutaway_label_key(false), &[]), "Lift roof");
        assert_eq!(vibevalley_i18n::t_in("en", hud_cutaway_label_key(true), &[]), "Close roof");
    }

    #[test]
    fn regression_folded_phone_fits_3x2_icon_grid_and_unfolded_fits_handset_plus_chat() {
        let mut phone = Phone::default();
        phone.open = true;
        let (fw, fh) = phone_overlay_size((1376.0, 900.0), &phone);
        assert_eq!((fw, fh), (296.0, 330.0));

        phone.unfolded = true;
        let (uw, uh) = phone_overlay_size((1376.0, 900.0), &phone);
        assert_eq!((uw, uh), (642.0, 474.0));

        phone.large = true;
        let (lw, lh) = phone_overlay_size((1376.0, 900.0), &phone);
        assert_eq!((lw, lh), (882.0, 714.0));

        phone.unfolded = false;
        phone.large = false;
        phone.game = true;
        let (gw, gh) = phone_overlay_size((1376.0, 900.0), &phone);
        assert_eq!((gw, gh), (388.0, 530.0));

        phone.unfolded = true;
        phone.game = false;
        let (nw, nh) = phone_overlay_size((500.0, 600.0), &phone);
        assert_eq!((nw, nh), (472.0, 474.0));
    }

    #[test]
    fn regression_dropping_diorama_bridge_and_task_releases_all_slice_watches() {
        use std::collections::BTreeSet;
        use std::sync::Arc;
        use std::time::Duration;

        use parking_lot::Mutex;
        use tokio::sync::Notify;
        use vibevalley_server::gateway::bridge::Bridge;
        use vibevalley_server::gateway::bridge::fake::{FakeServer, empty_bundle};

        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(1)));
        let bridge = Bridge::new(fake.clone(), 2);

        for visit in 0..3 {
            let (client, rx) = super::attach_diorama_bridge(&bridge, "farm");
            assert_eq!(Arc::strong_count(&client), 1, "visit {visit}: no extra strong Arc");

            let weak_client = Arc::downgrade(&client);
            let seen_topics = Arc::new(Mutex::new(BTreeSet::new()));
            let notify = Arc::new(Notify::new());

            let task_topics = seen_topics.clone();
            let task_notify = notify.clone();
            let task_ack = weak_client.clone();
            let pump_handle = vibevalley_rt::current_or_global_handle().spawn(async move {
                super::pump_diorama_slices(rx, task_ack, move |topic, _data| {
                    task_topics.lock().insert(topic.to_string());
                    task_notify.notify_waiters();
                    true
                })
                .await;
            });

            vibevalley_rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = notify.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if seen_topics.lock().len() == super::DIORAMA_SLICES.len() {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .expect("all 5 diorama slices should deliver initial frames");

            vibevalley_rt::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    while Arc::strong_count(&client) != 1 {
                        tokio::task::yield_now().await;
                    }
                })
                .await;
            });
            assert_eq!(Arc::strong_count(&client), 1, "pump task must hold Weak<Client> only");
            let snapshot = bridge.clients_snapshot();
            assert_eq!(snapshot.len(), 1);
            assert_eq!(snapshot[0].watches.len(), super::DIORAMA_SLICES.len());
            for slice in super::DIORAMA_SLICES {
                assert_eq!(fake.slice_watchers(*slice), 1, "expected active watcher for {slice:?}");
            }

            if visit % 2 == 0 {
                // Drop _bridge first (like an entity drop before task cancellation): SliceOutlet must close rx so the task exits.
                drop(client);
                assert_eq!(weak_client.strong_count(), 0);
                assert!(weak_client.upgrade().is_none());
                vibevalley_rt::block_on(async {
                    tokio::time::timeout(Duration::from_secs(3), pump_handle)
                        .await
                        .expect("slice pump task should exit once SliceOutlet drops")
                        .expect("slice pump task should not panic");
                });
            } else {
                // Cancel task first (matching DioramaView dropping _slice_task before _bridge), then drop _bridge.
                pump_handle.abort();
                vibevalley_rt::block_on(async {
                    let _ = tokio::time::timeout(Duration::from_secs(1), pump_handle).await;
                });
                drop(client);
                assert_eq!(weak_client.strong_count(), 0);
                assert!(weak_client.upgrade().is_none());
            }

            assert!(bridge.clients_snapshot().is_empty(), "visit {visit}: bridge client leaked");
            vibevalley_rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    let mut yields = 0usize;
                    while super::DIORAMA_SLICES.iter().any(|slice| fake.slice_watchers(*slice) != 0) {
                        if yields < 64 {
                            yields += 1;
                            tokio::task::yield_now().await;
                        } else {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    }
                })
                .await
                .expect("all 5 FakeServer slice watchers should drop to 0");
            });
        }
    }
}
