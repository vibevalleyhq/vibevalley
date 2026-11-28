//! GPUI pane hosting the live 3D Papertrails [`DioramaScene`], fed by the
//! server's per-domain state slices and paired with hosted form/phone overlays.

mod bridge;
mod hud;
mod render;
mod surface;
#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Pixels, Point, Subscription};
use serde_json::Value;

use super::frame::Frame;
use super::scene::DioramaScene;
use crate::hosted::{BridgeHub, HostedView};

use bridge::{attach_diorama_bridge, pump_diorama_slices};
use surface::FrameSurface;

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

pub(super) enum SceneState {
    Loading,
    Failed(String),
    Ready(Box<DioramaScene>),
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
}
