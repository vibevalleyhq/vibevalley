//! Hosted views: nsh `AppView`s running the TSX bundle from `ui/`, one
//! engine per view. Rust pushes frames, the view posts actions back.

pub mod bridge;
pub mod frames;

use std::collections::HashMap;

use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, ParentElement as _, Render, Styled as _, Window, div,
};
use nsh_platform_gpui::{App as NshApp, AppOptions, AppView, Appearance, Bundle};
use serde_json::{Map, Value, json};

pub use bridge::{Action, Choice, Outbox};

mod late;

/// The server every hosted view talks to (`call`, `state`, `live`,
/// subscriptions), shared app-wide.
pub struct BridgeHub(pub vibevalley_bridge::Hub);

impl gpui_kit::Global for BridgeHub {}

pub struct ServerStartup(pub flume::Receiver<Result<(), String>>);
impl gpui_kit::Global for ServerStartup {}

impl BridgeHub {
    /// The real server under VibeValley's own data folder, started off the UI
    /// thread. `VIBEVALLEY_FAKE_SERVER=<dir>` serves fixtures instead
    /// (`state.json`, `responses.json`) for tests and debug scripts;
    /// `VIBEVALLEY_HOME=<dir>` moves the real one.
    pub fn install(cx: &mut App) {
        let (ready, startup) = flume::bounded(1);
        cx.set_global(ServerStartup(startup));
        let server: std::sync::Arc<dyn vibevalley_bridge::Server> = match std::env::var_os("VIBEVALLEY_FAKE_SERVER") {
            Some(dir) => {
                let fake = vibevalley_bridge::fake::FakeServer::from_dir(std::path::Path::new(&dir));
                let _ = ready.send(fake.as_ref().map(|_| ()).map_err(ToString::to_string));
                std::sync::Arc::new(fake.unwrap_or_else(|_| vibevalley_bridge::fake::FakeServer::new()))
            }
            None => std::sync::Arc::new(late::LateServer::spawn(move || {
                let home = server_home();
                match vibevalley_server::start(crate::serving::config(&home, crate::serving::work_root())) {
                    Ok(started) => {
                        crate::serving::set_voice(started.voice.clone());
                        crate::serving::set_speech(started.media.clone());
                        let hub: std::sync::Arc<dyn vibevalley_bridge::Server> = started.hub.clone();
                        // The loopback API: the CLI finds it through server.json, the helpers' MCP door is on it.
                        match vibevalley_http::serve(started.hub.clone(), "127.0.0.1:0".parse().expect("an address")) {
                            Ok(listener) => {
                                started.board.sessions().set_mcp_url(format!("{}/mcp", listener.url()));
                                match vibevalley_server::home::announce(&home, &listener.url()) {
                                    Ok(announced) => {
                                        std::mem::forget(announced);
                                        let _ = ready.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = ready.send(Err(format!("server.json: {e}")));
                                    }
                                }
                                std::mem::forget(listener);
                            }
                            Err(e) => {
                                let _ = ready.send(Err(format!("vibevalley http: {e}")));
                            }
                        }
                        // The board, profiles and settings live as long as the app.
                        std::mem::forget(started);
                        hub
                    }
                    Err(e) => {
                        let _ = ready.send(Err(format!("vibevalley server: {e}")));
                        std::sync::Arc::new(vibevalley_bridge::fake::FakeServer::new())
                    }
                }
            })),
        };
        cx.set_global(BridgeHub(vibevalley_bridge::Hub::new(server, 4)));
    }
}

struct ChannelOutlet(nsh_engine::HostChannel);

impl vibevalley_bridge::Outlet for ChannelOutlet {
    fn send(&self, event: &str, data: Value) {
        let _ = self.0.send(event.to_string(), data);
    }
}

/// Answers one `host.*` call of a view (event `reply:<id>`).
#[derive(Clone)]
pub struct Replier {
    channel: nsh_engine::HostChannel,
    id: String,
}

impl std::fmt::Debug for Replier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Replier({})", self.id)
    }
}

impl Replier {
    pub fn send(self, envelope: vibevalley_bridge::Envelope) {
        let _ = self
            .channel
            .send(format!("reply:{}", self.id), serde_json::to_value(envelope).unwrap_or(Value::Null));
    }
}

/// The farm's home: `VIBEVALLEY_HOME`, else `~/.vibevalley` (packages/home).
pub fn server_home() -> std::path::PathBuf {
    vibevalley_server::home::home()
}

/// The bundle's capabilities with the folders the views show files from
/// added to `fs.read`: VibeValley's pixel art and the farm (attachments).
/// Added here because they are only known at run time.
fn capabilities_from(raw: &str) -> String {
    let mut caps: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let assets = crate::pixel::assets_dir();
    let home = server_home();
    let _ = std::fs::create_dir_all(&home);
    let roots = [assets.join("pixel"), assets.join("cursors"), home];
    if !caps["fs"].is_object() {
        caps["fs"] = json!({ "read": [], "write": [] });
    }
    if !caps["fs"]["read"].is_array() {
        caps["fs"]["read"] = json!([]);
    }
    if let Some(read) = caps["fs"]["read"].as_array_mut() {
        // nsh resolves roots to their real paths: only existing folders count.
        read.extend(roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).map(|r| json!(r)));
    }
    caps.to_string()
}

#[cfg(not(debug_assertions))]
const BUNDLE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ui/bundle.js"));
#[cfg(debug_assertions)]
const BUNDLE_JS: &str = "throw new Error('VibeValley UI bundle missing on disk: run vp run mac:check.');\n";
const CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/ui/capabilities.json"));

fn dev_ui_build_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("VIBEVALLEY_UI_BUNDLE") {
        return Some(std::path::PathBuf::from(dir));
    }
    if cfg!(debug_assertions) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui/build");
        if dir.join("bundle.js").is_file() {
            return Some(dir);
        }
    }
    None
}

/// The bundle every hosted view runs: `VIBEVALLEY_UI_BUNDLE` (or `ui/build` in
/// debug builds) when present on disk, else the one embedded at build time.
fn bundle() -> Bundle {
    if let Some(dir) = dev_ui_build_dir() {
        match std::fs::read_to_string(dir.join("bundle.js")) {
            Ok(js) => {
                let raw_caps = std::fs::read_to_string(dir.join("capabilities.json")).unwrap_or_else(|_| CAPABILITIES.to_string());
                if let Ok(b) = Bundle::source(js)
                    .with_app_id(Some("dev.vibevalley.ui"))
                    .with_capabilities_json(Some(&capabilities_from(&raw_caps)))
                {
                    return b;
                }
            }
            Err(e) => eprintln!("ui bundle at {}: {e}; using the embedded bundle", dir.display()),
        }
    }
    Bundle::source(BUNDLE_JS.to_string())
        .with_app_id(Some("dev.vibevalley.ui"))
        .with_capabilities_json(Some(&capabilities_from(CAPABILITIES)))
        .expect("capabilities.json written by nsh build")
}

#[derive(Debug, Clone)]
pub enum HostedEvent {
    Action(Action),
    /// The view's script (re)started: it has no frames, push them all.
    Ready,
    /// A `call` of a `host.*` op, answered by the shell on the UI thread.
    HostCall {
        op: String,
        payload: Value,
        reply: Replier,
    },
}

pub struct HostedView {
    app: Entity<AppView>,
    view: String,
    outbox: Outbox,
    /// Last rev the view reported applied, per topic.
    applied: HashMap<String, u64>,
    ready: bool,
    errors: Vec<String>,
    _bridge: Option<std::sync::Arc<vibevalley_bridge::Client>>,
}

impl HostedView {
    /// `view` selects the surface in `ui/App.tsx`; `params` reach it as
    /// `host.params`.
    pub fn new(view: &str, params: Map<String, Value>, dark: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = flume::unbounded::<Value>();
        let (err_tx, err_rx) = flume::unbounded::<String>();
        let options = AppOptions {
            appearance: Appearance::System,
            data_dir: Some(vibevalley_workspace::util::app_support_dir().join("nsh")),
            ..Default::default()
        };
        let name = view.to_string();
        let hub = cx.try_global::<BridgeHub>().map(|h| h.0.clone());
        let mut client = None;
        let app = cx.new(|cx| {
            let app = AppView::new(options, window, cx);
            app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx);
            let host = app.host();
            let mut params = params;
            params.insert("view".into(), json!(name));
            let pixel_dir = crate::pixel::assets_dir().join("pixel");
            let has_pixel_dir = pixel_dir.join("sprites.json").is_file();
            if has_pixel_dir {
                params.insert("pixelDir".into(), json!(pixel_dir));
            }
            host.set_params(params);
            let bridge = hub.map(|hub| std::sync::Arc::new(hub.attach(std::sync::Arc::new(ChannelOutlet(host.clone())))));
            client = bridge.clone();
            let reply_host = host.clone();
            // Runs on the engine thread. Server traffic goes straight to the
            // bridge; everything else is handed to the GPUI thread.
            host.handle("action", move |call| {
                let v = call.data();
                if v["type"].as_str() == Some("call") && v["op"].as_str() == Some("host.pixelDir") {
                    if let Some(id) = v["id"].as_str() {
                        let env = if has_pixel_dir {
                            vibevalley_bridge::Envelope::ok(json!({ "path": pixel_dir }))
                        } else {
                            vibevalley_bridge::refusal(vibevalley_bridge::BizCode::NotFound, "the pixel art is not installed")
                        };
                        let _ = reply_host.send(format!("reply:{id}"), serde_json::to_value(env).unwrap_or(Value::Null));
                    }
                    return;
                }
                if let Some(bridge) = &bridge
                    && route_to_bridge(bridge, v)
                {
                    return;
                }
                let _ = tx.send(v.clone());
            });
            let label = name.clone();
            app.on_error(move |message| {
                eprintln!("hosted view {label}: {message}");
                let _ = err_tx.send(message.to_string());
            });
            load(&app, cx);
            app
        });
        cx.spawn(async move |this, cx| {
            while let Ok(value) = rx.recv_async().await {
                let alive = this.update(cx, |view, cx| view.on_message(value, cx));
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

    fn on_message(&mut self, value: Value, cx: &mut Context<Self>) {
        match bridge::parse_action(&value) {
            Ok(Action::Applied { topic, rev }) => {
                self.applied.insert(topic, rev);
            }
            Ok(Action::Ready) => {
                self.ready = true;
                self.outbox.reset();
                cx.emit(HostedEvent::Ready);
            }
            Ok(Action::Call { id, op, payload }) => {
                let reply = Replier {
                    channel: self.app.read(cx).host(),
                    id,
                };
                cx.emit(HostedEvent::HostCall { op, payload, reply });
            }
            Ok(action) => cx.emit(HostedEvent::Action(action)),
            Err(e) => eprintln!("hosted view {}: {e}", self.view),
        }
    }

    /// Sends `data` as the frame of `topic` unless the view already has it.
    pub fn push(&mut self, topic: &str, data: Value, cx: &App) {
        if let Some((name, envelope)) = self.outbox.envelope(topic, data) {
            let _ = self.app.read(cx).host().send(name, envelope);
        }
    }

    pub fn navigate(&self, route: &str, cx: &App) {
        let _ = self.app.read(cx).host().send("route", json!(route));
    }

    pub fn set_dark(&self, dark: bool, cx: &mut App) {
        self.app
            .update(cx, |app, cx| app.set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx));
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
fn route_to_bridge(bridge: &vibevalley_bridge::Client, v: &Value) -> bool {
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    match v["type"].as_str() {
        Some("call") if !s("op").starts_with("host.") => bridge.call(&s("id"), s("op"), v["payload"].clone()),
        Some("watch") => {
            if let Err(e) = bridge.watch(&s("topic")) {
                eprintln!("bridge: {e}");
            }
        }
        Some("unwatch") => bridge.unwatch(&s("topic")),
        Some("subscribe") => bridge.subscribe(&s("id"), &s("name"), v["payload"].clone()),
        Some("unsubscribe") => bridge.unsubscribe(&s("id")),
        _ => return false,
    }
    true
}

fn load(app: &AppView, cx: &mut Context<AppView>) {
    #[cfg(feature = "nsh-dev")]
    if let Ok(url) = std::env::var("VIBEVALLEY_UI_DEV") {
        app.connect_dev_server(url, cx);
        return;
    }
    let _ = cx;
    app.load(NshApp::Js(bundle()));
}

impl EventEmitter<HostedEvent> for HostedView {}

impl Focusable for HostedView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.app.read(cx).focus_handle(cx)
    }
}

impl Render for HostedView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.app.clone())
    }
}
