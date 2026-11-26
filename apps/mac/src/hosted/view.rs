use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render, Styled as _,
    Window, div,
};
use nsh_platform_gpui::{App as NshApp, AppOptions, AppView, Appearance};
use serde_json::{Map, Value, json};
use vibevalley_server::ClientRpc;

use super::bridge::{self, Action, Outbox};
use super::bundle::bundle_for;
use super::connection;
use super::hub::{ActiveDesktopConnection, BridgeHub, ChannelOutlet, Replier, client_identity_for, handle_desktop_connection_op, server_home};

#[derive(Debug, Clone)]
pub enum HostedEvent {
    Action(Action),
    /// The view's script (re)started: it has no frames, push them all.
    Ready,
    /// A decoded `host.*` bridge call answered by the shell on the UI thread.
    HostCall {
        op: vibevalley_protocol::HostOp,
        reply: Replier,
    },
}

enum EngineMessage {
    Action(Value),
    HostCall { id: String, op: vibevalley_protocol::HostOp },
}

pub struct HostedView {
    app: Entity<AppView>,
    view: String,
    outbox: Outbox,
    /// Last rev the view reported applied, per topic.
    applied: HashMap<String, u64>,
    ready: bool,
    errors: Vec<String>,
    _bridge: Option<std::sync::Arc<vibevalley_server::gateway::bridge::Client>>,
}

pub fn ensure_ui_sets() {
    // nsh serves only nsh/base's core part unless the host names more; register both nsh/base and vibevalley/rich.
    static UI_SETS: std::sync::Once = std::sync::Once::new();
    UI_SETS.call_once(|| nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry(), vibevalley_rich::registry()]));
}

impl HostedView {
    /// `view` selects the surface in `ui/App.tsx`; `params` reach it as
    /// `host.params`.
    pub fn new(view: &str, params: Map<String, Value>, dark: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        ensure_ui_sets();
        let (tx, rx) = flume::unbounded::<EngineMessage>();
        let (err_tx, err_rx) = flume::unbounded::<String>();
        let options = AppOptions {
            appearance: Appearance::System,
            data_dir: Some(crate::host::Storage::configured().views),
            inline_root: true,
            ..Default::default()
        };
        let name = view.to_string();
        let hub = cx.try_global::<BridgeHub>().map(|h| h.0.clone());
        let active_connection = cx
            .try_global::<ActiveDesktopConnection>()
            .map(|c| c.0.clone())
            .unwrap_or_else(|| Arc::new(connection::Mode::Embedded));
        let mut client = None;
        let ui_font_size = cx.try_global::<crate::theme::Ui>().map(|ui| ui.settings.ui_font_size).unwrap_or(13.0);
        let motion = cx.try_global::<crate::theme::Ui>().map(|ui| ui.settings.effective_motion()).unwrap_or_default();
        let app = cx.new(|cx| {
            let app = AppView::new(options, window, cx);
            app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx);
            let scale = ui_font_size / 13.0;
            if (scale - 1.0).abs() > 0.01 {
                app.set_font_scale(Some(scale), cx);
            }
            let host = app.host();
            let mut params = params;
            params.insert("view".into(), json!(name));
            params.entry("locale").or_insert_with(|| json!(vibevalley_i18n::locale()));
            params.entry("motion").or_insert_with(|| json!(motion.as_str()));
            params.entry("connectionMode").or_insert_with(|| json!(active_connection.as_str()));
            params.entry("randomSeed").or_insert_with(|| json!(crate::host::random_seed_hex()));
            let assets_dir = crate::assets::assets_dir();
            let has_assets_dir = assets_dir.is_dir();
            if has_assets_dir {
                params.insert("assetsDir".into(), json!(assets_dir));
            }
            let identity = client_identity_for(&name, &params);
            host.set_params(params);
            let bridge = hub.map(|hub| Arc::new(hub.attach(identity, Arc::new(ChannelOutlet(host.clone())))));
            client = bridge.clone();
            let reply_host = host.clone();
            // Runs on the engine thread. Server traffic and stateless host ops
            // answer directly here; decoded shell host ops go to the GPUI thread.
            host.handle("action", move |call| {
                let v = call.data();
                if v["type"].as_str() == Some("call")
                    && let Some(op) = v["op"].as_str()
                    && op.starts_with("host.")
                {
                    let id = v["id"].as_str().unwrap_or_default();
                    if matches!(op, "host.connectionState" | "host.connectionSave" | "host.connectionReset") {
                        if !id.is_empty() {
                            let op_name = op.to_string();
                            let payload = v["payload"].clone();
                            let reply_id = id.to_string();
                            let reply_host = reply_host.clone();
                            let active = active_connection.clone();
                            vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(move || {
                                let env = handle_desktop_connection_op(&op_name, payload, &server_home(), &active);
                                let _ = reply_host.send(format!("reply:{reply_id}"), serde_json::to_value(env).unwrap_or(Value::Null));
                            });
                        }
                        return;
                    }
                    match crate::host::decode_host_op(op, v["payload"].clone()) {
                        Err(env) => {
                            if !id.is_empty() {
                                let _ = reply_host.send(format!("reply:{id}"), serde_json::to_value(env).unwrap_or(Value::Null));
                            }
                        }
                        Ok(vibevalley_protocol::HostOp::AssetsDir) => {
                            if !id.is_empty() {
                                let env = if has_assets_dir {
                                    vibevalley_server::gateway::bridge::Envelope::ok(json!({ "path": assets_dir }))
                                } else {
                                    vibevalley_server::gateway::bridge::refusal(
                                        vibevalley_server::gateway::bridge::BizCode::NotFound,
                                        "the assets directory is not installed",
                                    )
                                };
                                let _ = reply_host.send(format!("reply:{id}"), serde_json::to_value(env).unwrap_or(Value::Null));
                            }
                        }
                        Ok(host_op) => {
                            if let Some(env) = crate::host::handle_stateless_op(&host_op) {
                                if !id.is_empty() {
                                    let _ = reply_host.send(format!("reply:{id}"), serde_json::to_value(env).unwrap_or(Value::Null));
                                }
                            } else if !id.is_empty() {
                                let _ = tx.send(EngineMessage::HostCall {
                                    id: id.to_string(),
                                    op: host_op,
                                });
                            }
                        }
                    }
                    return;
                }
                if let Some(bridge) = &bridge
                    && route_to_bridge(bridge, v)
                {
                    return;
                }
                let _ = tx.send(EngineMessage::Action(v.clone()));
            });
            let label = name.clone();
            app.on_error(move |message| {
                eprintln!("hosted view {label}: {message}");
                let _ = err_tx.send(message.to_string());
            });
            load(&app, &name, cx);
            app
        });
        cx.spawn(async move |this, cx| {
            while let Ok(message) = rx.recv_async().await {
                let alive = this.update(cx, |view, cx| view.on_message(message, cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Ok(message) = err_rx.recv_async().await {
                if this.update(cx, |view, _| view.errors.push(message)).is_err() {
                    break;
                }
            }
        })
        .detach();
        HostedView {
            app,
            view: view.to_string(),
            outbox: Outbox::default(),
            applied: HashMap::new(),
            ready: false,
            errors: Vec::new(),
            _bridge: client,
        }
    }

    fn on_message(&mut self, message: EngineMessage, cx: &mut Context<Self>) {
        match message {
            EngineMessage::HostCall { id, op } => {
                let reply = Replier {
                    channel: self.app.read(cx).host(),
                    id,
                };
                cx.emit(HostedEvent::HostCall { op, reply });
            }
            EngineMessage::Action(value) => match bridge::parse_action(&value) {
                Ok(Action::Applied { topic, rev }) => {
                    self.applied.insert(topic, rev);
                }
                Ok(Action::Ready) => {
                    self.ready = true;
                    self.outbox.reset();
                    self.applied.clear();
                    cx.emit(HostedEvent::Ready);
                }
                Ok(Action::Call { id, op, payload }) => {
                    let reply = Replier {
                        channel: self.app.read(cx).host(),
                        id,
                    };
                    match crate::host::decode_host_op(&op, payload) {
                        Ok(host_op) => cx.emit(HostedEvent::HostCall { op: host_op, reply }),
                        Err(envelope) => reply.send(*envelope),
                    }
                }
                Ok(action) => cx.emit(HostedEvent::Action(action)),
                Err(e) => eprintln!("hosted view {}: {e}", self.view),
            },
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Sends `data` as the frame of `topic` unless the view already has it.
    pub fn push(&mut self, topic: &str, data: Value, cx: &App) {
        if let Some((name, envelope)) = self.outbox.envelope(topic, data) {
            let _ = self.app.read(cx).host().send(name, envelope);
        }
    }

    pub fn play_farm_sound(&self, name: &str, cx: &App) {
        let _ = self.app.read(cx).host().send("farm-sound", json!(name));
    }

    pub fn navigate(&self, route: &str, cx: &App) {
        let _ = self.app.read(cx).host().send("route", json!(route));
    }

    pub fn set_dark(&self, dark: bool, cx: &mut App) {
        self.app
            .update(cx, |app, cx| app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx));
    }

    pub fn set_locale(&self, locale: &str, cx: &App) {
        let _ = self.app.read(cx).host().send("locale", json!(locale));
    }

    pub fn set_motion(&self, motion: crate::theme::MotionChoice, cx: &App) {
        let _ = self.app.read(cx).host().send("motion", json!(motion.as_str()));
    }

    pub fn set_ui_font_size(&self, size: f32, cx: &mut App) {
        let scale = size / 13.0;
        let scale = ((scale - 1.0).abs() > 0.01).then_some(scale);
        self.app.update(cx, |app, cx| app.set_font_scale(scale, cx));
    }

    /// For the debug dump: what was sent and what the view applied.
    pub fn debug_state(&self) -> Value {
        let mut topics: Vec<&String> = self.applied.keys().collect();
        topics.sort();
        json!({
            "view": self.view,
            "ready": self.ready,
            "applied": topics.iter().map(|t| json!({ "topic": t, "rev": self.applied[*t], "sent": self.outbox.rev(t) })).collect::<Vec<_>>(),
            "errors": self.errors,
        })
    }
}

/// Handles the server half of the bridge on the engine thread; `false` for
/// actions the shell handles (including `call`s of `host.*` ops).
pub(super) fn route_to_bridge(bridge: &vibevalley_server::gateway::bridge::Client, v: &Value) -> bool {
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    match v["type"].as_str() {
        Some("call") if !s("op").starts_with("host.") => bridge.call(&s("id"), s("op"), v["payload"].clone()),
        Some("watch") => {
            if let Err(e) = bridge.watch(&s("topic")) {
                eprintln!("bridge: {e}");
            }
        }
        Some("applied") => {
            if let Some(topic) = v["topic"].as_str()
                && topic.starts_with("slice:")
                && let Some(rev) = v["rev"].as_u64()
            {
                bridge.applied_slice(topic, rev);
            }
            return false;
        }
        Some("unwatch") => bridge.unwatch(&s("topic")),
        Some("subscribe") => bridge.subscribe(&s("id"), &s("name"), v["payload"].clone()),
        Some("unsubscribe") => bridge.unsubscribe(&s("id")),
        _ => return false,
    }
    true
}

fn load(app: &AppView, view: &str, cx: &mut Context<AppView>) {
    #[cfg(feature = "nsh-dev")]
    if let Ok(url) = std::env::var("VIBEVALLEY_UI_DEV") {
        app.connect_dev_server(url, cx);
        return;
    }
    let _ = cx;
    app.load(NshApp::Js(bundle_for(view)));
}

impl EventEmitter<HostedEvent> for HostedView {}

impl Focusable for HostedView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.app.read(cx).focus_handle(cx)
    }
}

impl Render for HostedView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = div().size_full().child(self.app.clone());
        if self.view != "farm-phone" {
            return view;
        }
        // nsh keymaps deliver presses; the runner also needs to know when a held duck key is released.
        view.capture_key_up(cx.listener(|this, event: &gpui::KeyUpEvent, _, cx| {
            let key = event.keystroke.key.as_ref();
            if matches!(key, "down" | "x") {
                let _ = this.app.read(cx).host().send("farm-key-up", json!(key));
            }
        }))
    }
}
