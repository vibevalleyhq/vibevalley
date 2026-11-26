use std::sync::Arc;
use std::time::Instant;

use gpui::App;
use serde_json::{Map, Value};

use super::connection;
use super::debug::ShellDebugHandle;
use super::late;
use super::remote;

pub type ClientsProvider = dyn Fn() -> Vec<vibevalley_server::gateway::bridge::ClientSnapshot> + Send + Sync;

/// The server every hosted view talks to (`call`, slices, `live`,
/// subscriptions), shared app-wide.
pub struct BridgeHub(
    pub vibevalley_server::gateway::bridge::Bridge,
    #[allow(dead_code, reason = "keeps weak client snapshot provider alive for the app lifetime")] Arc<ClientsProvider>,
);

impl gpui::Global for BridgeHub {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupFailureKind {
    DatabaseSchema,
    Database,
    ServerBoot,
    HttpBind,
    RemoteConnection,
    WorkspaceStore,
}

impl StartupFailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DatabaseSchema => "database_schema",
            Self::Database => "database",
            Self::ServerBoot => "server_boot",
            Self::HttpBind => "http_bind",
            Self::RemoteConnection => "remote_connection",
            Self::WorkspaceStore => "workspace_store",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupFailure {
    pub kind: StartupFailureKind,
    pub summary: String,
    pub detail: Option<String>,
    pub db_path: Option<std::path::PathBuf>,
    pub home_dir: std::path::PathBuf,
}

impl StartupFailure {
    pub fn simple(kind: StartupFailureKind, summary: impl Into<String>, home_dir: std::path::PathBuf) -> Self {
        Self {
            kind,
            summary: summary.into(),
            detail: None,
            db_path: None,
            home_dir,
        }
    }

    pub fn from_start_error(err: &vibevalley_server::StartError, home_dir: std::path::PathBuf) -> Self {
        let kind = match err.kind {
            vibevalley_server::StartErrorKind::DatabaseSchema => StartupFailureKind::DatabaseSchema,
            vibevalley_server::StartErrorKind::Database => StartupFailureKind::Database,
            vibevalley_server::StartErrorKind::Storage | vibevalley_server::StartErrorKind::Boot => StartupFailureKind::ServerBoot,
        };
        Self {
            kind,
            summary: err.to_string(),
            detail: err.detail.clone(),
            db_path: err.db_path.clone(),
            home_dir,
        }
    }
}

pub struct ServerStartup(pub tokio::sync::watch::Receiver<Option<Result<(), StartupFailure>>>);
impl gpui::Global for ServerStartup {}

/// Control Plane connection mode active in this running desktop process.
pub struct ActiveDesktopConnection(pub Arc<connection::Mode>);
impl gpui::Global for ActiveDesktopConnection {}

pub fn next_client_identity(kind: vibevalley_server::ClientKind, label: impl Into<String>) -> vibevalley_server::ClientIdentity {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let seq = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    vibevalley_server::ClientIdentity {
        id: format!("{}-{seq}", kind.as_str()),
        kind,
        label: label.into(),
    }
}

pub(super) fn client_identity_for(view: &str, params: &Map<String, Value>) -> vibevalley_server::ClientIdentity {
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
pub(super) struct FailedServer {
    reason: String,
    feeds: FailedFeeds,
}

impl FailedServer {
    pub(super) fn new(reason: impl Into<String>) -> Self {
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
        serde_json::from_str(&self.feeds.feed(slice).snapshot_json()).unwrap_or(Value::Null)
    }

    fn slice_snapshot_json(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> Arc<str> {
        self.feeds.feed(slice).snapshot_json()
    }

    fn watch_slice(
        &self,
        slice: vibevalley_server::gateway::bridge::SliceKind,
        after_seq: Option<i64>,
        stop: &tokio_util::sync::CancellationToken,
        receive: &mut dyn FnMut(i64, &Value),
    ) {
        self.feeds.feed(slice).watch_since_json(after_seq, stop, &mut |seq, json| {
            let value: Value = serde_json::from_str(json).unwrap_or(Value::Null);
            receive(seq, &value);
        });
    }

    fn subscribe_slice(&self, slice: vibevalley_server::gateway::bridge::SliceKind) -> Option<vibevalley_server::SliceSubscription> {
        Some(self.feeds.feed(slice).subscribe())
    }

    fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_server::gateway::bridge::LiveEvent> {
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
        rx
    }

    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<vibevalley_server::gateway::bridge::LiveEvent>> {
        let (_tx, rx) = tokio::sync::broadcast::channel(1);
        Some(rx)
    }

    fn subscribe(
        &self,
        _name: &str,
        _payload: Value,
    ) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), vibevalley_server::gateway::bridge::Envelope> {
        Err(self.unavailable())
    }

    fn subscribe_with(
        &self,
        _ctx: &vibevalley_server::gateway::bridge::CallerContext,
        _name: &str,
        _payload: Value,
    ) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), vibevalley_server::gateway::bridge::Envelope> {
        Err(self.unavailable())
    }

    fn unsubscribe(&self, _id: u64) {}
}

/// Slow `session.openWorkspace` handshakes across tabs must not starve fast UI
/// RPCs (`session.send`, `channel.message.send`, `runtime.list`, issue mutations).
pub(super) const BRIDGE_CONCURRENCY: usize = 16;

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
                let dir = std::path::Path::new(&dir);
                let read_opt = |name: &str| match std::fs::read_to_string(dir.join(name)) {
                    Ok(text) => Ok(Some(text)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(format!("{name}: {e}")),
                };
                let fake = read_opt("state.json")
                    .and_then(|s| read_opt("responses.json").map(|r| (s, r)))
                    .and_then(|(s, r)| vibevalley_server::gateway::bridge::fake::FakeServer::from_fixture_strs(s.as_deref(), r.as_deref()));
                let _ = ready.send_replace(Some(
                    fake.as_ref()
                        .map(|_| ())
                        .map_err(|e| StartupFailure::simple(StartupFailureKind::ServerBoot, e.to_string(), server_home())),
                ));
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
                    tracing::info!(remote_url = %url, "connecting to remote VibeValley control plane");
                    match remote::RemoteServer::new(url.clone(), token, label) {
                        Ok(remote_server) => {
                            host_debug_for_boot.set_boot_info(url, boot_started.elapsed().as_millis() as u64);
                            let _ = ready.send_replace(Some(Ok(())));
                            Arc::new(remote_server)
                        }
                        Err(e) => {
                            let reason = format!("remote control plane: {e}");
                            tracing::error!(error = %reason, "failed to connect to remote control plane");
                            let _ = ready.send_replace(Some(Err(StartupFailure::simple(
                                StartupFailureKind::RemoteConnection,
                                reason.clone(),
                                server_home(),
                            ))));
                            Arc::new(FailedServer::new(reason))
                        }
                    }
                }
                Ok(_) => {
                    cx.set_global(ActiveDesktopConnection(Arc::new(connection::Mode::Embedded)));
                    Arc::new(late::LateServer::spawn(move || {
                        let home = server_home();
                        tracing::info!(home = %home.display(), "starting embedded VibeValley server");
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
                                        tracing::info!(url = %url, boot_ms = boot_started.elapsed().as_millis() as u64, "embedded VibeValley server listening");
                                        host_debug_for_boot.set_boot_info(url.clone(), boot_started.elapsed().as_millis() as u64);
                                        app.set_mcp_url(format!("{url}/mcp"));
                                        match vibevalley_server::home::announce(&home, &url) {
                                            Ok(announced) => {
                                                let _ = ready.send_replace(Some(Ok(())));
                                                (Some(listener), Some(announced))
                                            }
                                            Err(e) => {
                                                let reason = format!("server.json: {e}");
                                                tracing::error!(error = %reason, "failed to announce server.json");
                                                let _ =
                                                    ready.send_replace(Some(Err(StartupFailure::simple(StartupFailureKind::HttpBind, reason, home.clone()))));
                                                (Some(listener), None)
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        tracing::error!(error = %e, "failed to bind embedded HTTP listener");
                                        let _ = ready.send_replace(Some(Err(StartupFailure::simple(StartupFailureKind::HttpBind, e, home.clone()))));
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
                                let failure = StartupFailure::from_start_error(&e, home);
                                tracing::error!(kind = failure.kind.as_str(), error = %failure.summary, "embedded VibeValley server startup failed");
                                let reason = failure.summary.clone();
                                let _ = ready.send_replace(Some(Err(failure)));
                                Arc::new(FailedServer::new(reason))
                            }
                        }
                    }))
                }
                Err(e) => {
                    drop(running_tx);
                    cx.set_global(ActiveDesktopConnection(Arc::new(connection::Mode::Embedded)));
                    let reason = format!("desktop connection config: {e}");
                    tracing::error!(error = %reason, "desktop connection resolution failed");
                    let _ = ready.send_replace(Some(Err(StartupFailure::simple(
                        StartupFailureKind::RemoteConnection,
                        reason.clone(),
                        server_home(),
                    ))));
                    Arc::new(FailedServer::new(reason))
                }
            },
        };
        let bridge = vibevalley_server::gateway::bridge::Bridge::new(server, BRIDGE_CONCURRENCY);
        let bridge_for_clients = bridge.clone();
        let clients_provider: Arc<ClientsProvider> = Arc::new(move || bridge_for_clients.clients_snapshot());
        host_debug.attach_clients(&clients_provider);
        cx.set_global(BridgeHub(bridge, clients_provider));
    }
}

pub(super) struct ChannelOutlet(pub(super) nsh_engine::HostChannel);

impl vibevalley_server::gateway::bridge::Outlet for ChannelOutlet {
    fn send(&self, event: &str, data: Value) {
        let _ = self.0.send(event.to_string(), data);
    }
}

/// Answers one `host.*` call of a view (event `reply:<id>`).
#[derive(Clone)]
pub struct Replier {
    pub(super) channel: nsh_engine::HostChannel,
    pub(super) id: String,
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
pub(super) fn handle_desktop_connection_op(
    op: &str,
    payload: Value,
    home: &std::path::Path,
    active: &connection::Mode,
) -> vibevalley_server::gateway::bridge::Envelope {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PortPreference {
    Explicit(u16),
    ChannelDefault(u16),
}

pub(super) fn port_preference_from(raw_port: Option<&str>, channel_default: u16) -> Result<PortPreference, String> {
    match raw_port.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => raw
            .parse::<u16>()
            .map(PortPreference::Explicit)
            .map_err(|e| format!("invalid VIBEVALLEY_PORT {raw:?}: {e}")),
        None => Ok(PortPreference::ChannelDefault(channel_default)),
    }
}

pub(super) fn bind_preferred_or_ephemeral<T, F>(preference: PortPreference, mut bind: F) -> std::io::Result<T>
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
