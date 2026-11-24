//! Hosted views: nsh `AppView`s running the TSX bundle from `ui/`, one
//! engine per view. Rust pushes frames, the view posts actions back.

pub mod bridge;
pub mod connection;
pub mod frames;
pub mod remote;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render, Styled as _,
    Window, div,
};
use nsh_platform_gpui::{App as NshApp, AppOptions, AppView, Appearance, Bundle};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub use bridge::{Action, Outbox, Panel};

mod late;

pub type ClientsProvider = dyn Fn() -> Vec<vibevalley_server::gateway::bridge::ClientSnapshot> + Send + Sync;

/// The server every hosted view talks to (`call`, slices, `live`,
/// subscriptions), shared app-wide.
pub struct BridgeHub(
    pub vibevalley_server::gateway::bridge::Hub,
    #[allow(dead_code, reason = "keeps weak client snapshot provider alive for the app lifetime")] Arc<ClientsProvider>,
);

impl gpui::Global for BridgeHub {}

pub struct ServerStartup(pub tokio::sync::watch::Receiver<Option<Result<(), String>>>);
impl gpui::Global for ServerStartup {}

/// Control Plane connection mode active in this running desktop process.
pub struct ActiveDesktopConnection(pub Arc<connection::Mode>);
impl gpui::Global for ActiveDesktopConnection {}

pub const MAX_DEBUG_FRAMES: usize = 128;
pub const SLOW_FRAME_US: u64 = 16_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugFrameRecord {
    pub seq: u64,
    pub time: i64,
    pub duration_us: u64,
    pub slow: bool,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCacheEntry {
    pub name: String,
    pub entries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

struct ShellDebugInner {
    routes: Value,
    caches: Vec<DebugCacheEntry>,
    bundle_mode: Option<&'static str>,
    loopback_url: Option<String>,
    boot_ms: Option<u64>,
    last_frame_ms: Option<f64>,
    next_frame_seq: u64,
    frames: VecDeque<DebugFrameRecord>,
    clients: Option<Weak<ClientsProvider>>,
}

/// Lightweight GPUI shell state snapshot exposed to `Server::host_debug()`.
#[derive(Clone)]
pub struct ShellDebugHandle {
    inner: Arc<parking_lot::RwLock<ShellDebugInner>>,
}

impl gpui::Global for ShellDebugHandle {}

impl Default for ShellDebugHandle {
    fn default() -> Self {
        Self::new()
    }
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parse_loopback_port(url: &str) -> Option<u16> {
    let rest = url.rsplit_once(':')?.1;
    rest.split('/').next()?.parse::<u16>().ok()
}

impl ShellDebugHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(parking_lot::RwLock::new(ShellDebugInner {
                routes: json!({
                    "current": "/issues",
                    "nativeWorkspace": false,
                    "panel": "files",
                    "inspectorOpen": false,
                    "projects": [],
                }),
                caches: Vec::new(),
                bundle_mode: None,
                loopback_url: None,
                boot_ms: None,
                last_frame_ms: None,
                next_frame_seq: 0,
                frames: VecDeque::with_capacity(MAX_DEBUG_FRAMES),
                clients: None,
            })),
        }
    }

    pub fn update_shell(&self, routes: Value, caches: Vec<DebugCacheEntry>) {
        let mut guard = self.inner.write();
        guard.routes = routes;
        guard.caches = caches;
    }

    pub fn set_boot_info(&self, loopback_url: String, boot_ms: u64) {
        let mut guard = self.inner.write();
        guard.loopback_url = Some(loopback_url);
        guard.boot_ms = Some(boot_ms);
    }

    #[cfg(test)]
    pub fn set_bundle_mode(&self, mode: &'static str) {
        self.inner.write().bundle_mode = Some(mode);
    }

    pub fn attach_clients(&self, provider: &Arc<ClientsProvider>) {
        self.inner.write().clients = Some(Arc::downgrade(provider));
    }

    pub fn loopback_port(&self) -> Option<u16> {
        self.inner.read().loopback_url.as_deref().and_then(parse_loopback_port)
    }

    pub fn record_frame(&self, duration_us: u64, summary: &str) -> DebugFrameRecord {
        let mut guard = self.inner.write();
        guard.next_frame_seq += 1;
        let record = DebugFrameRecord {
            seq: guard.next_frame_seq,
            time: now_millis(),
            duration_us,
            slow: duration_us >= SLOW_FRAME_US,
            summary: summary.to_string(),
        };
        guard.last_frame_ms = Some(duration_us as f64 / 1000.0);
        if guard.frames.len() >= MAX_DEBUG_FRAMES {
            guard.frames.pop_front();
        }
        guard.frames.push_back(record.clone());
        record
    }
}

impl vibevalley_server::HostDebugBridge for ShellDebugHandle {
    fn snapshot(&self) -> Value {
        let (routes, caches, bundle_mode, loopback_url, boot_ms, last_frame_ms, frames, provider) = {
            let guard = self.inner.read();
            (
                guard.routes.clone(),
                guard.caches.clone(),
                guard.bundle_mode.unwrap_or_else(workbench_bundle_mode),
                guard.loopback_url.clone(),
                guard.boot_ms,
                guard.last_frame_ms,
                guard.frames.iter().cloned().collect::<Vec<_>>(),
                guard.clients.as_ref().and_then(Weak::upgrade),
            )
        };
        let clients: Vec<Value> = provider
            .map(|p| {
                p().into_iter()
                    .map(|c| {
                        json!({
                            "id": c.identity.id,
                            "kind": c.identity.kind.as_str(),
                            "label": c.identity.label,
                            "watches": c.watches,
                            "subscriptions": c.subscriptions,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "routes": routes,
            "clients": clients,
            "bundleMode": bundle_mode,
            "loopbackUrl": loopback_url,
            "bootMs": boot_ms,
            "lastFrameMs": last_frame_ms,
            "frames": frames,
            "caches": caches,
        })
    }
}

pub fn next_client_identity(kind: vibevalley_server::ClientKind, label: impl Into<String>) -> vibevalley_server::ClientIdentity {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let seq = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    vibevalley_server::ClientIdentity {
        id: format!("{}-{seq}", kind.as_str()),
        kind,
        label: label.into(),
    }
}

fn client_identity_for(view: &str, params: &Map<String, Value>) -> vibevalley_server::ClientIdentity {
    let (kind, label) = match view {
        "vv" | "vibevalley" => (vibevalley_server::ClientKind::GpuiWorkbench, view.to_string()),
        "devtools" => (vibevalley_server::ClientKind::DevTools, "devtools".to_string()),
        "sidebar" => {
            let role = params.get("role").and_then(Value::as_str).unwrap_or("sidebar");
            (vibevalley_server::ClientKind::GpuiSidebar, role.to_string())
        }
        "workspace-chat" => (vibevalley_server::ClientKind::GpuiChatPane, "workspace-chat".to_string()),
        "farm-form" | "farm-phone" => (vibevalley_server::ClientKind::GpuiPixel, view.to_string()),
        _ => (vibevalley_server::ClientKind::GpuiShell, view.to_string()),
    };
    next_client_identity(kind, label)
}

struct FailedFeeds {
    board: vibevalley_server::SliceFeed,
    sessions: vibevalley_server::SliceFeed,
    collab: vibevalley_server::SliceFeed,
    inbox: vibevalley_server::SliceFeed,
    ops: vibevalley_server::SliceFeed,
    farm: vibevalley_server::SliceFeed,
}

impl FailedFeeds {
    fn new() -> Self {
        use vibevalley_server::{SliceFeed, gateway::bridge::SliceKind};
        let bundle = vibevalley_server::gateway::bridge::fake::empty_bundle(0);
        Self {
            board: SliceFeed::from_value(SliceKind::Board, bundle.board.seq, &bundle.board),
            sessions: SliceFeed::from_value(SliceKind::Sessions, bundle.sessions.seq, &bundle.sessions),
            collab: SliceFeed::from_value(SliceKind::Collab, bundle.collab.seq, &bundle.collab),
            inbox: SliceFeed::from_value(SliceKind::Inbox, bundle.inbox.seq, &bundle.inbox),
            ops: SliceFeed::from_value(SliceKind::Ops, bundle.ops.seq, &bundle.ops),
            farm: SliceFeed::from_value(SliceKind::Farm, bundle.farm.seq, &bundle.farm),
        }
    }

    fn feed(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> &vibevalley_server::SliceFeed {
        use vibevalley_server::gateway::bridge::SliceKind;
        match slice {
            SliceKind::Board => &self.board,
            SliceKind::Sessions => &self.sessions,
            SliceKind::Collab => &self.collab,
            SliceKind::Inbox => &self.inbox,
            SliceKind::Ops => &self.ops,
            SliceKind::Farm => &self.farm,
        }
    }
}

/// Fallback server installed when embedded or remote server startup fails.
/// Surfaces the root-cause error on every RPC/subscription call while serving
/// empty static slices so the desktop shell can render startup diagnostics.
struct FailedServer {
    reason: String,
    feeds: FailedFeeds,
}

impl FailedServer {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            feeds: FailedFeeds::new(),
        }
    }

    fn unavailable(&self) -> vibevalley_server::gateway::bridge::Envelope {
        use vibevalley_server::gateway::bridge::{ApiError, BizCode, Envelope};
        Envelope::failure(&ApiError::new(
            BizCode::ServiceUnavailable,
            format!("VibeValley server unavailable: {}", self.reason),
        ))
    }
}

impl vibevalley_server::gateway::bridge::Server for FailedServer {
    fn call(&self, _op: &str, _payload: Value) -> vibevalley_server::gateway::bridge::Envelope {
        self.unavailable()
    }

    fn call_with(&self, _ctx: &vibevalley_server::gateway::bridge::CallerContext, _op: &str, _payload: Value) -> vibevalley_server::gateway::bridge::Envelope {
        self.unavailable()
    }

    fn call_with_async(
        self: Arc<Self>,
        _ctx: vibevalley_server::gateway::bridge::CallerContext,
        _op: String,
        _payload: Value,
    ) -> vibevalley_server::gateway::api::BoxFuture<'static, vibevalley_server::gateway::bridge::Envelope> {
        let envelope = self.unavailable();
        Box::pin(async move { envelope })
    }

    fn slice_snapshot(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> Value {
        self.feeds.feed(slice).snapshot_value()
    }

    fn slice_snapshot_json(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> Arc<str> {
        self.feeds.feed(slice).snapshot_json()
    }

    fn watch_slice(
        &self,
        slice: vibevalley_server::gateway::bridge::SliceKind,
        after_seq: Option<i64>,
        stop: &flume::Receiver<()>,
        receive: &mut dyn FnMut(i64, &Value),
    ) {
        self.feeds.feed(slice).watch_since(after_seq, stop, receive);
    }

    fn subscribe_slice(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> Option<vibevalley_server::SliceSubscription> {
        Some(self.feeds.feed(slice).subscribe())
    }

    fn live(&self) -> flume::Receiver<vibevalley_server::gateway::bridge::LiveEvent> {
        let (_tx, rx) = flume::bounded(0);
        rx
    }

    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<vibevalley_server::gateway::bridge::LiveEvent>> {
        let (_tx, rx) = tokio::sync::broadcast::channel(1);
        Some(rx)
    }

    fn subscribe(&self, _name: &str, _payload: Value) -> Result<(u64, flume::Receiver<Value>), vibevalley_server::gateway::bridge::Envelope> {
        Err(self.unavailable())
    }

    fn subscribe_with(
        &self,
        _ctx: &vibevalley_server::gateway::bridge::CallerContext,
        _name: &str,
        _payload: Value,
    ) -> Result<(u64, flume::Receiver<Value>), vibevalley_server::gateway::bridge::Envelope> {
        Err(self.unavailable())
    }

    fn unsubscribe(&self, _id: u64) {}
}

/// Slow `session.openWorkspace` handshakes across tabs must not starve fast UI
/// RPCs (`session.send`, `channel.message.send`, `runtime.list`, issue mutations).
const BRIDGE_CONCURRENCY: usize = 16;

impl BridgeHub {
    /// The real server under VibeValley's own data folder, started off the UI
    /// thread. `VIBEVALLEY_FAKE_SERVER=<dir>` serves fixtures instead
    /// (`state.json`, `responses.json`) for tests and debug scripts;
    /// `VIBEVALLEY_HOME=<dir>` moves the real one.
    pub fn install(cx: &mut App) {
        let boot_started = Instant::now();
        let (ready, startup) = tokio::sync::watch::channel(None);
        cx.set_global(ServerStartup(startup));
        cx.set_global(crate::serving::RunningServer::new());
        let host_debug = ShellDebugHandle::new();
        cx.set_global(host_debug.clone());
        let host_debug_for_boot = host_debug.clone();
        let (running_tx, running_rx) = flume::bounded::<crate::serving::Running>(1);
        cx.spawn(async move |cx| {
            if let Ok(running) = running_rx.recv_async().await {
                let close_now = cx.update(|cx| cx.global_mut::<crate::serving::RunningServer>().install(running));
                if let Some(running) = close_now {
                    cx.background_executor().spawn(async move { running.shutdown() }).detach();
                }
            }
        })
        .detach();
        let server: Arc<dyn vibevalley_server::gateway::bridge::Server> = match std::env::var_os("VIBEVALLEY_FAKE_SERVER") {
            Some(dir) => {
                drop(running_tx);
                cx.set_global(ActiveDesktopConnection(Arc::new(connection::Mode::Embedded)));
                let fake = vibevalley_server::gateway::bridge::fake::FakeServer::from_dir(std::path::Path::new(&dir));
                let _ = ready.send_replace(Some(fake.as_ref().map(|_| ()).map_err(ToString::to_string)));
                Arc::new(fake.unwrap_or_else(|_| vibevalley_server::gateway::bridge::fake::FakeServer::new()))
            }
            None => match connection::resolve(&server_home()) {
                Ok(resolved) if matches!(resolved.mode, connection::Mode::Remote { .. }) => {
                    drop(running_tx);
                    let active_mode = Arc::new(resolved.mode.clone());
                    cx.set_global(ActiveDesktopConnection(active_mode));
                    let connection::Mode::Remote { url, token, label } = resolved.mode else {
                        unreachable!("checked Mode::Remote above");
                    };
                    match remote::RemoteServer::new(url.clone(), token, label) {
                        Ok(remote_server) => {
                            host_debug_for_boot.set_boot_info(url, boot_started.elapsed().as_millis() as u64);
                            let _ = ready.send_replace(Some(Ok(())));
                            Arc::new(remote_server)
                        }
                        Err(e) => {
                            let reason = format!("remote control plane: {e}");
                            let _ = ready.send_replace(Some(Err(reason.clone())));
                            Arc::new(FailedServer::new(reason))
                        }
                    }
                }
                Ok(_) => {
                    cx.set_global(ActiveDesktopConnection(Arc::new(connection::Mode::Embedded)));
                    Arc::new(late::LateServer::spawn(move || {
                        let home = server_home();
                        let mut config: vibevalley_server::Config = crate::serving::config(&home, crate::serving::work_root());
                        config.host_debug = Some(Arc::new(host_debug_for_boot.clone()));
                        match vibevalley_server::create_app_blocking(config) {
                            Ok(app) => {
                                let server = app.server();
                                let preference =
                                    port_preference_from(std::env::var("VIBEVALLEY_PORT").ok().as_deref(), vibevalley_protocol::home::default_port());
                                // The loopback API: the CLI finds it through server.json, the helpers' MCP door is on it.
                                let (listener, announced) = match preference.and_then(|pref| {
                                    bind_preferred_or_ephemeral(pref, |addr| vibevalley_server::gateway::http::serve(server.clone(), addr))
                                        .map_err(|e| format!("vibevalley http: {e}"))
                                }) {
                                    Ok(listener) => {
                                        let url = listener.url();
                                        host_debug_for_boot.set_boot_info(url.clone(), boot_started.elapsed().as_millis() as u64);
                                        app.set_mcp_url(format!("{url}/mcp"));
                                        match vibevalley_server::home::announce(&home, &url) {
                                            Ok(announced) => {
                                                let _ = ready.send_replace(Some(Ok(())));
                                                (Some(listener), Some(announced))
                                            }
                                            Err(e) => {
                                                let _ = ready.send_replace(Some(Err(format!("server.json: {e}"))));
                                                (Some(listener), None)
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let _ = ready.send_replace(Some(Err(e)));
                                        (None, None)
                                    }
                                };
                                let wake_task = app.ctx().task.clone();
                                let wake_observer = crate::host::observe_system_wake(move || {
                                    wake_task.notify_wake();
                                });
                                let running = crate::serving::Running::new(app, listener, announced, Some(wake_observer));
                                if let Err(flume::SendError(running)) = running_tx.send(running) {
                                    running.shutdown();
                                }
                                server
                            }
                            Err(e) => {
                                let reason = format!("vibevalley server: {e}");
                                let _ = ready.send_replace(Some(Err(reason.clone())));
                                Arc::new(FailedServer::new(reason))
                            }
                        }
                    }))
                }
                Err(e) => {
                    drop(running_tx);
                    cx.set_global(ActiveDesktopConnection(Arc::new(connection::Mode::Embedded)));
                    let reason = format!("desktop connection config: {e}");
                    let _ = ready.send_replace(Some(Err(reason.clone())));
                    Arc::new(FailedServer::new(reason))
                }
            },
        };
        let bridge = vibevalley_server::gateway::bridge::Hub::new(server, BRIDGE_CONCURRENCY);
        let bridge_for_clients = bridge.clone();
        let clients_provider: Arc<ClientsProvider> = Arc::new(move || bridge_for_clients.clients_snapshot());
        host_debug.attach_clients(&clients_provider);
        cx.set_global(BridgeHub(bridge, clients_provider));
    }
}

struct ChannelOutlet(nsh_engine::HostChannel);

impl vibevalley_server::gateway::bridge::Outlet for ChannelOutlet {
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
    pub fn send(self, envelope: vibevalley_server::gateway::bridge::Envelope) {
        let _ = self
            .channel
            .send(format!("reply:{}", self.id), serde_json::to_value(envelope).unwrap_or(Value::Null));
    }
}

/// Handles desktop Control Plane connection inspection and switching without touching `crates/protocol`.
fn handle_desktop_connection_op(op: &str, payload: Value, home: &std::path::Path, active: &connection::Mode) -> vibevalley_server::gateway::bridge::Envelope {
    use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};

    let reply_snapshot = || match connection::snapshot(home, active) {
        Ok(snap) => Envelope::ok(serde_json::to_value(snap).unwrap_or(Value::Null)),
        Err(err) => refusal(BizCode::InternalError, err),
    };

    match op {
        "host.connectionState" => reply_snapshot(),
        "host.connectionSave" => {
            let req: connection::ConnectionSaveRequest = match serde_json::from_value(payload) {
                Ok(req) => req,
                Err(err) => return refusal(BizCode::InvalidInput, format!("invalid connection request: {err}")),
            };
            match connection::configure_remote(home, req) {
                Ok(_) => reply_snapshot(),
                Err(err) => refusal(BizCode::InvalidInput, err),
            }
        }
        "host.connectionReset" => match connection::reset(home) {
            Ok(_) => reply_snapshot(),
            Err(err) => refusal(BizCode::InternalError, err),
        },
        _ => refusal(BizCode::RouteNotFound, format!("unknown desktop connection op {op}")),
    }
}

/// The farm's home: `VIBEVALLEY_HOME`, else `$HOME/<current_channel().home_dir_name()>`.
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
    let work_root = crate::serving::work_root();
    let _ = std::fs::create_dir_all(&home);
    let roots = [assets.join("pixel"), assets.join("cursors"), home, work_root];
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
#[cfg(not(debug_assertions))]
const BUNDLE_NSHC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui/bundle.nshc"));
#[cfg(debug_assertions)]
const BUNDLE_JS: &str = "throw new Error('VibeValley UI bundle missing on disk: run vp run mac:check.');\n";
#[cfg(debug_assertions)]
const BUNDLE_NSHC: &[u8] = &[];
const CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/ui/capabilities.json"));

#[cfg(not(debug_assertions))]
const SHELL_BUNDLE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ui-shell/bundle.js"));
#[cfg(not(debug_assertions))]
const SHELL_BUNDLE_NSHC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui-shell/bundle.nshc"));
#[cfg(debug_assertions)]
const SHELL_BUNDLE_JS: &str = "throw new Error('VibeValley shell UI bundle missing on disk: run vp run mac:check.');\n";
#[cfg(debug_assertions)]
const SHELL_BUNDLE_NSHC: &[u8] = &[];
const SHELL_CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/ui-shell/capabilities.json"));

static WORKBENCH_BUNDLE_MODE: OnceLock<&'static str> = OnceLock::new();

pub fn workbench_bundle_mode() -> &'static str {
    WORKBENCH_BUNDLE_MODE
        .get()
        .copied()
        .unwrap_or(if !BUNDLE_NSHC.is_empty() { "nshc" } else { "js" })
}

fn is_workbench_view(view: &str) -> bool {
    matches!(view, "vv" | "vibevalley" | "farm-form" | "farm-phone")
}

fn dir_has_bundle(dir: &std::path::Path) -> bool {
    dir.join("bundle.nshc").is_file() || dir.join("bundle.js").is_file()
}

fn resolve_bundle_dir_from(override_dir: Option<&std::path::Path>, ui_root: &std::path::Path, workbench: bool) -> Option<std::path::PathBuf> {
    if let Some(dir) = override_dir {
        if !workbench {
            let nested = dir.join("build-shell");
            if dir_has_bundle(&nested) {
                return Some(nested);
            }
            if dir.file_name().is_some_and(|n| n == "build") {
                let sibling = dir.with_file_name("build-shell");
                if dir_has_bundle(&sibling) {
                    return Some(sibling);
                }
            }
        }
        return Some(dir.to_path_buf());
    }
    if cfg!(debug_assertions) {
        if !workbench {
            let shell = ui_root.join("build-shell");
            if dir_has_bundle(&shell) {
                return Some(shell);
            }
        }
        let full = ui_root.join("build");
        if dir_has_bundle(&full) {
            return Some(full);
        }
    }
    None
}

fn build_embedded_bundle(bytecode: &[u8], js: &str, caps_json: &str) -> (Bundle, &'static str) {
    if !bytecode.is_empty() {
        // SAFETY: bytecode emitted by `nsh build` in `build.rs` during this build.
        let b = unsafe { Bundle::bytecode(bytecode.to_vec()) };
        if let Ok(b) = b.with_app_id(Some("dev.vibevalley.ui")).with_capabilities_json(Some(caps_json)) {
            return (b, "nshc");
        }
    }
    let b = Bundle::source(js.to_string())
        .with_app_id(Some("dev.vibevalley.ui"))
        .with_capabilities_json(Some(caps_json))
        .expect("capabilities.json written by nsh build");
    (b, "js")
}

fn load_bundle_slot(workbench: bool, bytecode: &[u8], js: &str, fallback_caps: &str) -> (Bundle, &'static str) {
    let override_dir = std::env::var_os("VIBEVALLEY_UI_BUNDLE").map(std::path::PathBuf::from);
    let ui_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
    if let Some(dir) = resolve_bundle_dir_from(override_dir.as_deref(), &ui_root, workbench) {
        let raw_caps = std::fs::read_to_string(dir.join("capabilities.json")).unwrap_or_else(|_| fallback_caps.to_string());
        let caps_json = capabilities_from(&raw_caps);
        let nshc = dir.join("bundle.nshc");
        if nshc.is_file()
            && let Ok(bytes) = std::fs::read(&nshc)
            && !bytes.is_empty()
        {
            // SAFETY: local `nsh build` output under the workspace's own `ui/build*`.
            let b = unsafe { Bundle::bytecode(bytes) };
            if let Ok(b) = b.with_app_id(Some("dev.vibevalley.ui")).with_capabilities_json(Some(&caps_json)) {
                return (b, "nshc");
            }
        }
        match std::fs::read_to_string(dir.join("bundle.js")) {
            Ok(source) if !source.is_empty() => {
                if let Ok(b) = Bundle::source(source)
                    .with_app_id(Some("dev.vibevalley.ui"))
                    .with_capabilities_json(Some(&caps_json))
                {
                    return (b, "js");
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("ui bundle at {}: {e}; using the embedded bundle", dir.display()),
        }
    }
    let caps_json = capabilities_from(fallback_caps);
    build_embedded_bundle(bytecode, js, &caps_json)
}

/// Full workbench bundle for `"vv"`/`"vibevalley"` and pixel farm overlays, lightweight shell
/// bundle for all other hosted surfaces (including `"devtools"`), cached process-wide so views
/// share one load.
fn bundle_for(view: &str) -> Bundle {
    if is_workbench_view(view) {
        static WORKBENCH: OnceLock<Bundle> = OnceLock::new();
        WORKBENCH
            .get_or_init(|| {
                let (bundle, mode) = load_bundle_slot(true, BUNDLE_NSHC, BUNDLE_JS, CAPABILITIES);
                let _ = WORKBENCH_BUNDLE_MODE.set(mode);
                bundle
            })
            .clone()
    } else {
        static SHELL: OnceLock<Bundle> = OnceLock::new();
        SHELL
            .get_or_init(|| load_bundle_slot(false, SHELL_BUNDLE_NSHC, SHELL_BUNDLE_JS, SHELL_CAPABILITIES).0)
            .clone()
    }
}

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
            let pixel_dir = crate::pixel::assets_dir().join("pixel");
            let has_pixel_dir = pixel_dir.join("sprites.json").is_file();
            if has_pixel_dir {
                params.insert("pixelDir".into(), json!(pixel_dir));
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
                        Ok(vibevalley_protocol::HostOp::PixelDir) => {
                            if !id.is_empty() {
                                let env = if has_pixel_dir {
                                    vibevalley_server::gateway::bridge::Envelope::ok(json!({ "path": pixel_dir }))
                                } else {
                                    vibevalley_server::gateway::bridge::refusal(
                                        vibevalley_server::gateway::bridge::BizCode::NotFound,
                                        "the pixel art is not installed",
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
fn route_to_bridge(bridge: &vibevalley_server::gateway::bridge::Client, v: &Value) -> bool {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortPreference {
    Explicit(u16),
    ChannelDefault(u16),
}

fn port_preference_from(raw_port: Option<&str>, channel_default: u16) -> Result<PortPreference, String> {
    match raw_port.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => raw
            .parse::<u16>()
            .map(PortPreference::Explicit)
            .map_err(|e| format!("invalid VIBEVALLEY_PORT {raw:?}: {e}")),
        None => Ok(PortPreference::ChannelDefault(channel_default)),
    }
}

fn bind_preferred_or_ephemeral<T, F>(preference: PortPreference, mut bind: F) -> std::io::Result<T>
where
    F: FnMut(std::net::SocketAddr) -> std::io::Result<T>,
{
    let loopback = |port: u16| std::net::SocketAddr::from(([127, 0, 0, 1], port));
    match preference {
        PortPreference::Explicit(port) => bind(loopback(port)),
        PortPreference::ChannelDefault(port) => match bind(loopback(port)) {
            Ok(bound) => Ok(bound),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse && port != 0 => {
                eprintln!("vibevalley http: 127.0.0.1:{port} is already in use; falling back to an ephemeral port");
                bind(loopback(0))
            }
            Err(err) => Err(err),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn port_preference_parses_explicit_and_channel_defaults() {
        assert_eq!(port_preference_from(None, 8789), Ok(PortPreference::ChannelDefault(8789)));
        assert_eq!(port_preference_from(Some("  "), 8790), Ok(PortPreference::ChannelDefault(8790)));
        assert_eq!(port_preference_from(Some("0"), 8789), Ok(PortPreference::Explicit(0)));
        assert_eq!(port_preference_from(Some("9123"), 8789), Ok(PortPreference::Explicit(9123)));
        assert!(port_preference_from(Some("bogus"), 8789).is_err());
    }

    #[test]
    fn channel_default_port_falls_back_to_ephemeral_on_addr_in_use() {
        let occupied = TcpListener::bind("127.0.0.1:0").expect("occupy loopback port");
        let busy_port = occupied.local_addr().unwrap().port();

        let fallback = bind_preferred_or_ephemeral(PortPreference::ChannelDefault(busy_port), TcpListener::bind)
            .expect("channel default should fall back to ephemeral port");
        let bound_port = fallback.local_addr().unwrap().port();
        assert_ne!(bound_port, 0);
        assert_ne!(bound_port, busy_port);

        let explicit_err = bind_preferred_or_ephemeral(PortPreference::Explicit(busy_port), TcpListener::bind)
            .expect_err("explicit VIBEVALLEY_PORT must not silently fall back on AddrInUse");
        assert_eq!(explicit_err.kind(), ErrorKind::AddrInUse);
    }

    #[test]
    fn is_workbench_view_routes_workbench_and_farm_views() {
        for view in ["vv", "vibevalley", "farm-form", "farm-phone"] {
            assert!(is_workbench_view(view), "{view} should use the full workbench bundle");
        }
        for view in ["sidebar", "palette", "markdown", "workspace-chat", "probe", "devtools"] {
            assert!(!is_workbench_view(view), "{view} should use the lightweight shell bundle");
        }
    }

    #[test]
    fn resolve_bundle_dir_prefers_build_shell_and_falls_back_gracefully() {
        let tmp = std::env::temp_dir().join(format!("vv-bundle-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let build = tmp.join("build");
        let build_shell = tmp.join("build-shell");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("bundle.js"), "/* full */").unwrap();

        assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, true), Some(build.clone()));
        assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, false), Some(build.clone()));

        std::fs::create_dir_all(&build_shell).unwrap();
        std::fs::write(build_shell.join("bundle.nshc"), [1u8, 2, 3]).unwrap();
        assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, false), Some(build_shell.clone()));
        assert_eq!(resolve_bundle_dir_from(Some(&build), &tmp, true), Some(build.clone()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn embedded_bundle_falls_back_to_source_when_bytecode_is_empty() {
        let caps = capabilities_from(r#"{"host":["action"]}"#);
        let (_bundle, mode) = build_embedded_bundle(&[], "export default function() {}", &caps);
        assert_eq!(mode, "js");
    }

    #[test]
    fn embedded_bundle_accepts_non_empty_bytecode_with_empty_source() {
        let caps = capabilities_from(r#"{"host":["action"]}"#);
        let (_bundle, mode) = build_embedded_bundle(&[1u8, 2, 3, 4], "", &caps);
        assert_eq!(mode, "nshc");
    }

    #[test]
    fn client_identity_maps_hosted_surfaces_to_distinct_kinds() {
        let empty = Map::new();
        let wb = client_identity_for("vv", &empty);
        assert_eq!(wb.kind, vibevalley_server::ClientKind::GpuiWorkbench);
        assert_eq!(wb.label, "vv");

        let dt = client_identity_for("devtools", &empty);
        assert_eq!(dt.kind, vibevalley_server::ClientKind::DevTools);
        assert_eq!(dt.label, "devtools");

        let sb = client_identity_for("sidebar", &empty);
        assert_eq!(sb.kind, vibevalley_server::ClientKind::GpuiSidebar);
        assert_eq!(sb.label, "sidebar");

        let mut insp_params = Map::new();
        insp_params.insert("role".into(), json!("inspector"));
        let insp = client_identity_for("sidebar", &insp_params);
        assert_eq!(insp.kind, vibevalley_server::ClientKind::GpuiSidebar);
        assert_eq!(insp.label, "inspector");
        assert_ne!(sb.id, insp.id);

        let chat = client_identity_for("workspace-chat", &empty);
        assert_eq!(chat.kind, vibevalley_server::ClientKind::GpuiChatPane);

        let phone = client_identity_for("farm-phone", &empty);
        assert_eq!(phone.kind, vibevalley_server::ClientKind::GpuiPixel);

        let pal = client_identity_for("palette", &empty);
        assert_eq!(pal.kind, vibevalley_server::ClientKind::GpuiShell);
    }

    #[test]
    fn route_to_bridge_watches_slices_forwards_applied_slice_and_unwatches() {
        use parking_lot::Mutex;
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Notify;
        use vibevalley_server::gateway::bridge::fake::{FakeServer, empty_bundle};
        use vibevalley_server::gateway::bridge::{Hub, Outlet, SliceKind};

        #[derive(Default)]
        struct Recorder {
            events: Mutex<Vec<(String, Value)>>,
            notify: Notify,
        }
        impl Outlet for Recorder {
            fn send(&self, event: &str, data: Value) {
                self.events.lock().push((event.to_string(), data));
                self.notify.notify_waiters();
            }
        }
        impl Recorder {
            fn named(&self, name: &str) -> Vec<Value> {
                self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
            }

            fn wait_for(&self, what: &str, mut f: impl FnMut(&Self) -> bool) {
                vibevalley_runtime::rt::block_on(async {
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            let notified = self.notify.notified();
                            tokio::pin!(notified);
                            notified.as_mut().enable();
                            if f(self) {
                                return;
                            }
                            notified.await;
                        }
                    })
                    .await
                })
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
            }
        }

        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(1)));
        let hub = Hub::new(fake.clone(), 2);
        let rec = Arc::new(Recorder::default());
        let client = hub.attach(next_client_identity(vibevalley_server::ClientKind::GpuiWorkbench, "vv"), rec.clone());

        for topic in [
            "slice:board",
            "slice:sessions",
            "slice:collab",
            "slice:inbox",
            "slice:ops",
            "slice:farm",
            "live",
        ] {
            assert!(route_to_bridge(&client, &json!({ "type": "watch", "topic": topic })));
        }
        // Legacy "state" topic is rejected internally (watch prints error, no watcher attached).
        assert!(route_to_bridge(&client, &json!({ "type": "watch", "topic": "state" })));

        rec.wait_for("slice:board", |r| !r.named("frame:slice:board").is_empty());
        let rev = rec.named("frame:slice:board")[0]["rev"].as_u64().unwrap();
        // `applied` acknowledges backpressure AND returns false so HostedView records debug bookkeeping.
        assert!(!route_to_bridge(&client, &json!({ "type": "applied", "topic": "slice:board", "rev": rev })));

        let mut next = empty_bundle(2);
        next.board.issues.push(vibevalley_protocol::Issue::new("i-1", 1, "Updated", 2));
        fake.swap_bundle(next);

        rec.wait_for("second slice:board after applied_slice", |r| r.named("frame:slice:board").len() >= 2);
        assert_eq!(rec.named("frame:slice:board").last().unwrap()["data"]["issues"][0]["id"], "i-1");

        assert!(route_to_bridge(&client, &json!({ "type": "unwatch", "topic": "slice:board" })));
        vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut yields = 0usize;
                while fake.slice_watchers(SliceKind::Board) != 0 {
                    if yields < 64 {
                        yields += 1;
                        tokio::task::yield_now().await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
            })
            .await
        })
        .expect("timed out waiting for unwatch");
    }

    #[test]
    fn shell_debug_handle_bridges_snapshots_into_server_with_bounded_frames_and_clients() {
        use vibevalley_server::gateway::bridge::fake::FakeServer;
        use vibevalley_server::gateway::bridge::{CallerContext, Envelope, Hub as Bridge, LiveEvent, Outlet, Server, SliceKind};
        use vibevalley_server::{HostDebugBridge, SharedHostDebug};

        struct NoopOutlet;
        impl Outlet for NoopOutlet {
            fn send(&self, _: &str, _: Value) {}
        }

        struct DebugBridgeServer {
            inner: FakeServer,
            host_debug: SharedHostDebug,
        }

        impl Server for DebugBridgeServer {
            fn call(&self, op: &str, payload: Value) -> Envelope {
                self.inner.call(op, payload)
            }
            fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
                self.inner.call_with(ctx, op, payload)
            }
            fn slice_snapshot(&self, slice: SliceKind) -> Value {
                self.inner.slice_snapshot(slice)
            }
            fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
                self.inner.watch_slice(slice, after_seq, stop, receive);
            }
            fn live(&self) -> flume::Receiver<LiveEvent> {
                self.inner.live()
            }
            fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
                self.inner.subscribe(name, payload)
            }
            fn unsubscribe(&self, id: u64) {
                self.inner.unsubscribe(id);
            }
            fn host_debug(&self) -> Option<SharedHostDebug> {
                Some(self.host_debug.clone())
            }
        }

        let handle = ShellDebugHandle::new();
        let server: Arc<dyn Server> = Arc::new(DebugBridgeServer {
            inner: FakeServer::new(),
            host_debug: Arc::new(handle.clone()),
        });
        handle.set_bundle_mode("nshc");
        handle.set_boot_info("http://127.0.0.1:8790".into(), 120);
        assert_eq!(handle.loopback_port(), Some(8790));

        let bridge_hub = Bridge::new(server.clone(), 1);
        let bridge_for_provider = bridge_hub.clone();
        let provider: Arc<ClientsProvider> = Arc::new(move || bridge_for_provider.clients_snapshot());
        handle.attach_clients(&provider);
        let client = bridge_hub.attach(next_client_identity(vibevalley_server::ClientKind::DevTools, "devtools"), Arc::new(NoopOutlet));
        client.watch("slice:sessions").unwrap();

        handle.update_shell(
            json!({
                "current": "/workspace",
                "nativeWorkspace": true,
                "panel": "git",
                "inspectorOpen": true,
                "projects": [{ "id": 1, "name": "vv", "tabs": [] }],
            }),
            vec![DebugCacheEntry {
                name: "panes".into(),
                entries: 3,
                detail: Some("open pane entities".into()),
            }],
        );

        let fast = handle.record_frame(4_200, "Shell::render");
        assert!(!fast.slow);
        assert_eq!(fast.seq, 1);

        let slow = handle.record_frame(16_000, "Shell::render");
        assert!(slow.slow);
        assert_eq!(slow.seq, 2);

        for i in 0..200u64 {
            let rec = handle.record_frame(5_000 + (i % 3) * 10_000, "Shell::render");
            assert_eq!(rec.slow, rec.duration_us >= SLOW_FRAME_US);
        }

        let bridge = server.host_debug().expect("host debug bridge attached");
        let snap = bridge.snapshot();
        assert_eq!(snap["routes"]["current"], "/workspace");
        assert_eq!(snap["routes"]["nativeWorkspace"], true);
        assert_eq!(snap["routes"]["panel"], "git");
        assert_eq!(snap["routes"]["inspectorOpen"], true);
        assert_eq!(snap["bundleMode"], "nshc");
        assert_eq!(snap["loopbackUrl"], "http://127.0.0.1:8790");
        assert_eq!(snap["bootMs"], 120);
        assert_eq!(snap["caches"][0]["name"], "panes");
        assert_eq!(snap["caches"][0]["entries"], 3);

        let clients = snap["clients"].as_array().expect("clients array");
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0]["kind"], "devTools");
        assert_eq!(clients[0]["label"], "devtools");
        assert_eq!(clients[0]["watches"], json!(["slice:sessions"]));

        let frames = snap["frames"].as_array().expect("frames array");
        assert_eq!(frames.len(), MAX_DEBUG_FRAMES);
        assert_eq!(frames.first().unwrap()["seq"], 202 - MAX_DEBUG_FRAMES as u64 + 1);
        assert_eq!(frames.last().unwrap()["seq"], 202);
        assert!(snap["lastFrameMs"].as_f64().is_some());

        drop(client);
        drop(provider);
        assert_eq!(handle.snapshot()["clients"], json!([]));
    }

    #[test]
    fn desktop_connection_host_ops_inspect_save_and_reset_without_leaking_token() {
        let dir = tempfile::tempdir().unwrap();
        let active = connection::Mode::Embedded;

        let initial = handle_desktop_connection_op("host.connectionState", json!({}), dir.path(), &active);
        assert_eq!(initial.biz_code, 0);
        let data = initial.data.unwrap();
        assert_eq!(data["activeMode"], "embedded");
        assert_eq!(data["configuredMode"], "embedded");
        assert_eq!(data["restartRequired"], false);

        let raw_token = "vv_dev_host_op_secret_token_7788";
        let saved = handle_desktop_connection_op(
            "host.connectionSave",
            json!({
                "url": "https://hub.tailnet.ts.net:8791/",
                "token": raw_token,
                "label": "Studio Mac",
            }),
            dir.path(),
            &active,
        );
        assert_eq!(saved.biz_code, 0);
        let saved_data = saved.data.unwrap();
        assert_eq!(saved_data["activeMode"], "embedded");
        assert_eq!(saved_data["configuredMode"], "remote");
        assert_eq!(saved_data["configuredUrl"], "https://hub.tailnet.ts.net:8791");
        assert_eq!(saved_data["configuredLabel"], "Studio Mac");
        assert_eq!(saved_data["tokenHint"], "…7788");
        assert_eq!(saved_data["restartRequired"], true);
        assert!(!saved_data.to_string().contains(raw_token));

        let reset = handle_desktop_connection_op("host.connectionReset", json!({}), dir.path(), &active);
        assert_eq!(reset.biz_code, 0);
        let reset_data = reset.data.unwrap();
        assert_eq!(reset_data["configuredMode"], "embedded");
        assert_eq!(reset_data["restartRequired"], false);
    }

    #[test]
    fn failed_server_reports_service_unavailable_with_root_cause_and_empty_slices() {
        use vibevalley_server::gateway::bridge::{BizCode, CallerContext, Server, SliceKind};

        let root_cause = "vibevalley server: no such column: source_job_id";
        let server = Arc::new(FailedServer::new(root_cause));

        for env in [
            server.call("session.openWorkspace", json!({})),
            server.call_with(&CallerContext::local(), "session.openWorkspace", json!({})),
            vibevalley_runtime::rt::block_on(Arc::clone(&server).call_with_async(CallerContext::local(), "session.openWorkspace".into(), json!({}))),
        ] {
            assert_eq!(env.biz_code, BizCode::ServiceUnavailable.code());
            assert!(env.message.contains(root_cause), "unexpected message: {}", env.message);
            assert!(
                !env.message.to_ascii_lowercase().contains("fake server"),
                "must never mention fake server: {}",
                env.message
            );
        }

        let sub_err = server
            .subscribe("channel.follow", json!({}))
            .expect_err("FailedServer must refuse subscriptions");
        assert_eq!(sub_err.biz_code, BizCode::ServiceUnavailable.code());
        assert!(sub_err.message.contains(root_cause));
        assert!(!sub_err.message.to_ascii_lowercase().contains("fake server"));

        let sub_with_err = server
            .subscribe_with(&CallerContext::local(), "channel.follow", json!({}))
            .expect_err("FailedServer must refuse subscribe_with");
        assert_eq!(sub_with_err.biz_code, BizCode::ServiceUnavailable.code());
        assert!(sub_with_err.message.contains(root_cause));

        // Empty slices render cleanly without panicking and expose cached JSON + async subscriptions.
        for kind in [
            SliceKind::Board,
            SliceKind::Sessions,
            SliceKind::Collab,
            SliceKind::Inbox,
            SliceKind::Ops,
            SliceKind::Farm,
        ] {
            let snap = server.slice_snapshot(kind);
            assert_eq!(snap["seq"], 0);
            let json = server.slice_snapshot_json(kind);
            assert!(json.contains("\"seq\":0"), "slice {kind:?} json: {json}");
            assert!(server.subscribe_slice(kind).is_some());
        }

        // Live streams close immediately without spawning background threads.
        assert!(server.live().try_recv().is_err());
        let mut live_rx = server.subscribe_live().expect("broadcast receiver");
        assert!(matches!(live_rx.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Closed)));
    }

    #[test]
    fn bridge_concurrency_does_not_starve_fast_rpcs_behind_four_slow_session_opens() {
        use parking_lot::Mutex;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;
        use tokio::sync::Notify;
        use vibevalley_server::gateway::api::BoxFuture;
        use vibevalley_server::gateway::bridge::fake::FakeServer;
        use vibevalley_server::gateway::bridge::{CallerContext, Envelope, Hub as Bridge, Outlet, Server, SliceKind};

        struct SlowOpenServer {
            inner: FakeServer,
            open_in_flight: AtomicUsize,
            open_entered: Notify,
            release_opens: Notify,
        }

        impl SlowOpenServer {
            fn new() -> Arc<Self> {
                Arc::new(Self {
                    inner: FakeServer::new(),
                    open_in_flight: AtomicUsize::new(0),
                    open_entered: Notify::new(),
                    release_opens: Notify::new(),
                })
            }
        }

        impl Server for SlowOpenServer {
            fn call(&self, op: &str, payload: Value) -> Envelope {
                self.inner.call(op, payload)
            }
            fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
                self.inner.call_with(ctx, op, payload)
            }
            fn call_with_async(self: Arc<Self>, _ctx: CallerContext, op: String, _payload: Value) -> BoxFuture<'static, Envelope> {
                Box::pin(async move {
                    if op == "session.openWorkspace" {
                        let notified = self.release_opens.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        self.open_in_flight.fetch_add(1, Ordering::SeqCst);
                        self.open_entered.notify_waiters();
                        let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
                        return Envelope::ok(json!({ "id": "w1" }));
                    }
                    Envelope::ok(json!({ "op": op }))
                })
            }
            fn slice_snapshot(&self, slice: SliceKind) -> Value {
                self.inner.slice_snapshot(slice)
            }
            fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
                self.inner.watch_slice(slice, after_seq, stop, receive);
            }
            fn live(&self) -> flume::Receiver<vibevalley_server::gateway::bridge::LiveEvent> {
                self.inner.live()
            }
            fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
                self.inner.subscribe(name, payload)
            }
            fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
                self.inner.subscribe_with(ctx, name, payload)
            }
            fn unsubscribe(&self, id: u64) {
                self.inner.unsubscribe(id);
            }
        }

        #[derive(Default)]
        struct ReplyRecorder {
            replies: Mutex<Vec<(String, Value)>>,
            notify: Notify,
        }

        impl Outlet for ReplyRecorder {
            fn send(&self, event: &str, data: Value) {
                self.replies.lock().push((event.to_string(), data));
                self.notify.notify_waiters();
            }
        }

        impl ReplyRecorder {
            fn has(&self, event: &str) -> bool {
                self.replies.lock().iter().any(|(e, _)| e == event)
            }
        }

        let server = SlowOpenServer::new();
        let bridge = Bridge::new(server.clone(), BRIDGE_CONCURRENCY);
        let rec = Arc::new(ReplyRecorder::default());
        let client = bridge.attach(next_client_identity(vibevalley_server::ClientKind::GpuiWorkbench, "vv"), rec.clone());

        for i in 1..=4 {
            client.call(
                &format!("open-{i}"),
                "session.openWorkspace".into(),
                json!({ "runtime": "claude", "cwd": "/tmp" }),
            );
        }

        vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let entered = server.open_entered.notified();
                    tokio::pin!(entered);
                    entered.as_mut().enable();
                    if server.open_in_flight.load(Ordering::SeqCst) == 4 {
                        break;
                    }
                    entered.await;
                }
            })
            .await
            .expect("all 4 slow session.openWorkspace calls must enter concurrently");

            client.call("fast-1", "runtime.list".into(), Value::Null);
            client.call("fast-2", "channel.message.send".into(), json!({ "channel": "c1", "text": "hi" }));

            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let replied = rec.notify.notified();
                    tokio::pin!(replied);
                    replied.as_mut().enable();
                    if rec.has("reply:fast-1") && rec.has("reply:fast-2") {
                        break;
                    }
                    replied.await;
                }
            })
            .await
            .expect("fast RPCs must complete immediately while 4 slow opens are held in flight");

            assert!(!rec.has("reply:open-1"), "slow opens must still be held in flight when fast RPCs complete");
            server.release_opens.notify_waiters();

            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let replied = rec.notify.notified();
                    tokio::pin!(replied);
                    replied.as_mut().enable();
                    if (1..=4).all(|i| rec.has(&format!("reply:open-{i}"))) {
                        break;
                    }
                    replied.await;
                }
            })
            .await
            .expect("all 4 slow opens must finish after release");
        });
    }
}
