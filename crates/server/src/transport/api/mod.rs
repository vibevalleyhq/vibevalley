//! The in-process server's contract. `transport::bridge` and `transport::http`
//! serve views through [`Server`]; `Hub` implements it. Payloads, slices, and
//! events are VibeValley's protocol JSON.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use vibevalley_protocol::{ApiError, BizCode, Caller, Envelope, LiveEvent, SliceKind};

/// Heap-allocated `Send` future returned by async spine trait methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub mod media;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    GpuiWorkbench,
    GpuiChatPane,
    GpuiSidebar,
    GpuiPixel,
    GpuiShell,
    Cli,
    HttpLoopback,
    RemoteDevice,
    Mcp,
    Connector,
    DevTools,
    Internal,
}

impl ClientKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ClientKind::GpuiWorkbench => "gpuiWorkbench",
            ClientKind::GpuiChatPane => "gpuiChatPane",
            ClientKind::GpuiSidebar => "gpuiSidebar",
            ClientKind::GpuiPixel => "gpuiPixel",
            ClientKind::GpuiShell => "gpuiShell",
            ClientKind::Cli => "cli",
            ClientKind::HttpLoopback => "httpLoopback",
            ClientKind::RemoteDevice => "remoteDevice",
            ClientKind::Mcp => "mcp",
            ClientKind::Connector => "connector",
            ClientKind::DevTools => "devTools",
            ClientKind::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentity {
    pub id: String,
    pub kind: ClientKind,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CallerPrincipal {
    #[default]
    LocalOwner,
    #[serde(rename_all = "camelCase")]
    RemoteDevice { device_id: String, scope: String },
    #[serde(rename_all = "camelCase")]
    Connector { app: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerContext {
    pub caller: Caller,
    pub principal: CallerPrincipal,
    pub client: Option<ClientIdentity>,
    pub trace_id: u64,
}

impl CallerContext {
    pub fn local() -> Self {
        Self {
            caller: Caller::User,
            principal: CallerPrincipal::LocalOwner,
            client: None,
            trace_id: 0,
        }
    }

    pub fn from_caller(caller: Caller) -> Self {
        let principal = match caller {
            Caller::Remote => CallerPrincipal::RemoteDevice {
                device_id: String::new(),
                scope: String::new(),
            },
            Caller::User | Caller::Orchestrator | Caller::Session => CallerPrincipal::LocalOwner,
        };
        Self {
            caller,
            principal,
            client: None,
            trace_id: 0,
        }
    }
}

impl Default for CallerContext {
    fn default() -> Self {
        Self::local()
    }
}

/// Optional zero-overhead observer for RPC calls and `Core::apply` commits.
pub trait InvokeObserver: Send + Sync {
    fn on_call_start(&self, ctx: &CallerContext, op: &str, payload: &Value);
    fn on_call_end(&self, ctx: &CallerContext, op: &str, biz_code: u32, duration_us: u64);
    fn on_apply(&self, seq: i64, dirty: vibevalley_core::SliceMask, transitions: &[vibevalley_core::Transition], duration_us: u64);
}

pub type SharedInvokeObserver = Arc<dyn InvokeObserver>;

/// Optional fault-injection gate for DevTools Lab & Overrides.
pub trait FaultGate: Send + Sync {
    fn delay_ms(&self, target: &str) -> u64;
    fn should_disconnect(&self, topic: &str) -> bool;
}

pub type SharedFaultGate = Arc<dyn FaultGate>;

/// Optional debug bridge exposing GPUI shell state to the in-process server.
pub trait HostDebugBridge: Send + Sync {
    fn snapshot(&self) -> Value;
}

pub type SharedHostDebug = Arc<dyn HostDebugBridge>;

/// The helpers' MCP door (`POST /mcp`): one JSON-RPC message from a helper
/// with the bearer token it was given. `None` answers a notification.
pub trait Mcp: Send + Sync + 'static {
    fn message(&self, token: &str, message: Value) -> Option<Value>;

    fn message_async(self: Arc<Self>, token: String, message: Value) -> BoxFuture<'static, Option<Value>> {
        Box::pin(async move { crate::spawn_blocking_traced(move || self.message(&token, message)).await.unwrap_or(None) })
    }
}

pub type SharedMcp = Arc<dyn Mcp>;

/// Executes one JSON-RPC MCP message or batch asynchronously through [`Mcp::message_async`].
pub async fn dispatch_mcp_message_async(door: SharedMcp, token: String, message: Value) -> Option<Value> {
    match message {
        Value::Array(batch) => {
            let mut answers = Vec::with_capacity(batch.len());
            for item in batch {
                if let Some(answer) = door.clone().message_async(token.clone(), item).await {
                    answers.push(answer);
                }
            }
            if answers.is_empty() { None } else { Some(Value::Array(answers)) }
        }
        one => door.message_async(token, one).await,
    }
}

/// Authenticated remote mobile device identity returned by [`RemoteAuth::verify_bearer_async`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDeviceIdentity {
    pub device_id: String,
    pub name: String,
    pub scope: String,
}

/// Remote mobile access gate: reports whether remote access is enabled and
/// validates Bearer device tokens against paired devices.
pub trait RemoteAuth: Send + Sync + 'static {
    fn is_enabled(&self) -> bool;
    fn verify_bearer_async(self: Arc<Self>, token: String) -> BoxFuture<'static, Result<RemoteDeviceIdentity, ApiError>>;
}

pub type SharedRemoteAuth = Arc<dyn RemoteAuth>;

/// Authenticated bidirectional WebSocket frame channels handed from
/// `transport::http::machine_ws` to the server's [`MachineBus`].
pub struct MachineConnection {
    pub device: RemoteDeviceIdentity,
    pub incoming: flume::Receiver<vibevalley_protocol::MachineWireFrame>,
    pub outgoing: flume::Sender<vibevalley_protocol::MachineWireFrame>,
}

/// Spine port connecting the `/api/v1/machine/ws` transport to the server's
/// execution-layer machine manager without importing `crate::*` into
/// `transport/`.
pub trait MachineBus: Send + Sync + 'static {
    fn accept_connection(&self, conn: MachineConnection);

    fn mcp_tunnel_async(
        self: Arc<Self>,
        server: Arc<dyn Server>,
        req: vibevalley_protocol::MachineMcpRequest,
    ) -> BoxFuture<'static, vibevalley_protocol::MachineMcpResponse> {
        Box::pin(dispatch_mcp_tunnel_async(server, req))
    }
}

pub type SharedMachineBus = Arc<dyn MachineBus>;

/// Executes a reverse-tunneled MCP JSON-RPC HTTP request against `server.mcp()`,
/// preserving the same single/batch semantics and device-token guard as `POST /mcp`.
pub async fn dispatch_mcp_tunnel_async(server: Arc<dyn Server>, req: vibevalley_protocol::MachineMcpRequest) -> vibevalley_protocol::MachineMcpResponse {
    let reply = |status: u16, body: String| vibevalley_protocol::MachineMcpResponse {
        request_id: req.request_id.clone(),
        status,
        content_type: "application/json".to_string(),
        body,
    };
    let (door, message) = match validate_mcp_tunnel(&*server, &req) {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };
    match dispatch_mcp_message_async(door, req.session_token.clone(), message).await {
        Some(answer) => reply(200, serde_json::to_string(&answer).unwrap_or_default()),
        None => reply(202, String::new()),
    }
}

fn validate_mcp_tunnel(
    server: &dyn Server,
    req: &vibevalley_protocol::MachineMcpRequest,
) -> Result<(SharedMcp, Value), vibevalley_protocol::MachineMcpResponse> {
    let reply = |status: u16, body: String| vibevalley_protocol::MachineMcpResponse {
        request_id: req.request_id.clone(),
        status,
        content_type: "application/json".to_string(),
        body,
    };
    if req.session_token.starts_with("vv_dev_") {
        return Err(reply(403, serde_json::json!({ "error": "forbidden" }).to_string()));
    }
    if !req.method.eq_ignore_ascii_case("POST") {
        return Err(reply(405, serde_json::json!({ "error": "use POST" }).to_string()));
    }
    let normalized_path = req.path.trim().trim_end_matches('/');
    if !normalized_path.is_empty() && normalized_path != "/mcp" {
        return Err(reply(404, serde_json::json!({ "error": "no such route" }).to_string()));
    }
    let Some(door) = server.mcp() else {
        return Err(reply(503, serde_json::json!({ "error": "no MCP here" }).to_string()));
    };
    let Ok(message) = serde_json::from_str::<Value>(&req.body) else {
        let error = serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return Err(reply(400, error.to_string()));
    };
    Ok((door, message))
}

/// Live MOSS realtime line handle consumed by the desktop host audio pipeline.
pub trait LiveVoiceLine: Send + Sync {
    fn url(&self) -> &str;
    fn bearer_token(&self) -> &str;
    fn session_update(&self) -> String;
    fn outgoing(&self) -> flume::Receiver<String>;
    fn heard(&self, raw: &str);
}

/// Narrow live voice controller port consumed by the desktop host without
/// importing `modules::collab::voice`.
pub trait LiveVoicePort: Send + Sync {
    fn grant(&self) -> Result<vibevalley_protocol::VoiceGrant, ApiError>;
    fn moss_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError>;
    fn start(&self, channel: &str, uid: &str) -> Result<vibevalley_protocol::VoiceCall, ApiError>;
    fn heard(&self, agent_id: &str, text: &str, turn: Option<&str>) -> Result<(), ApiError>;
    fn said(&self, agent_id: &str, text: &str) -> Result<(), ApiError>;
    fn stop(&self, agent_id: &str);
}

pub type SharedLiveVoice = Arc<dyn LiveVoicePort>;

/// What the server provides to the views and transports.
pub trait Server: Send + Sync + 'static {
    /// One endpoint by name (`issue.status.update`, ...). Blocking; never
    /// called on the UI thread.
    fn call(&self, op: &str, payload: Value) -> Envelope;
    /// Endpoint invocation carrying caller identity, principal, and trace id.
    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        let _ = ctx;
        self.call(op, payload)
    }
    /// Asynchronous endpoint invocation carrying caller identity, principal, and trace id.
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        Box::pin(async move {
            match crate::spawn_blocking_traced(move || self.call_with(&ctx, &op, payload)).await {
                Ok(env) => env,
                Err(e) => refusal(BizCode::InternalError, e.to_string()),
            }
        })
    }
    /// Current JSON snapshot for one domain slice.
    fn slice_snapshot(&self, slice: SliceKind) -> Value;
    /// Current pre-encoded UTF-8 JSON snapshot for one domain slice.
    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        Arc::<str>::from(serde_json::to_string(&self.slice_snapshot(slice)).unwrap_or_else(|_| "null".into()))
    }
    /// Asynchronous pre-encoded UTF-8 JSON snapshot for one domain slice.
    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move {
            crate::spawn_blocking_traced(move || self.slice_snapshot_json(slice))
                .await
                .unwrap_or_else(|_| Arc::<str>::from("null"))
        })
    }
    /// Watches one domain slice with Bounded-1 coalescing.
    /// If `after_seq == Some(latest_seq)`, skips the initial send; otherwise
    /// delivers the latest snapshot immediately. Blocks until `stop` disconnects.
    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value));
    /// Optional asynchronous readiness hook for proxies that finish startup
    /// off-thread (such as desktop `LateServer`). Returning `None` indicates
    /// the server is immediately ready for [`Self::subscribe_slice`] and
    /// [`Self::subscribe_live`].
    fn ready_async(&self) -> Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> {
        None
    }
    /// Direct `tokio::sync::watch` subscription for a domain slice when backed
    /// by [`crate::app::slice::SliceFeed`], avoiding blocking threads on SSE and bridge pumps.
    fn subscribe_slice(&self, _slice: SliceKind) -> Option<crate::app::slice::SliceSubscription> {
        None
    }
    /// Asynchronous `tokio::sync::watch` subscription for a domain slice.
    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<crate::app::slice::SliceSubscription>> {
        Box::pin(async move { crate::spawn_blocking_traced(move || self.subscribe_slice(slice)).await.ok().flatten() })
    }
    /// Current fault-injection gate, if attached.
    fn fault_gate(&self) -> Option<SharedFaultGate> {
        None
    }
    /// `LiveEvent`s from now on; a new receiver per call.
    fn live(&self) -> flume::Receiver<LiveEvent>;
    /// Broadcast subscription for `LiveEvent`s when backed by a broadcast ring
    /// buffer, allowing SSE and bridge consumers to stream directly.
    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<LiveEvent>> {
        None
    }
    /// One of `api.ts`'s subscriptions. `Err` is a refusal before the first
    /// event. The stream ends when the server drops its sender.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope>;
    /// Subscription invocation carrying caller identity and principal for `can` RBAC enforcement.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let _ = ctx;
        self.subscribe(name, payload)
    }
    /// Asynchronous subscription invocation carrying caller identity and principal for `can` RBAC enforcement.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, flume::Receiver<Value>), Envelope>> {
        use std::sync::atomic::{AtomicBool, Ordering};
        Box::pin(async move {
            struct CancelFlag(Arc<AtomicBool>);
            impl Drop for CancelFlag {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Release);
                }
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let guard = CancelFlag(cancelled.clone());
            let result = crate::spawn_blocking_traced(move || {
                let opened = self.subscribe_with(&ctx, &name, payload);
                if cancelled.load(Ordering::Acquire)
                    && let Ok((id, _)) = &opened
                {
                    self.unsubscribe(*id);
                }
                opened
            })
            .await;
            std::mem::forget(guard);
            match result {
                Ok(res) => res,
                Err(e) => Err(refusal(BizCode::InternalError, e.to_string())),
            }
        })
    }
    fn unsubscribe(&self, id: u64);
    /// Optional local binary media transport.
    fn media_inputs(&self) -> Option<media::SharedMediaInputs> {
        None
    }
    /// Streamed speech for the page, when the server runs it.
    fn speech_streams(&self) -> Option<media::SharedSpeechStreams> {
        None
    }
    /// The helpers' MCP door, when the server has one.
    fn mcp(&self) -> Option<SharedMcp> {
        None
    }
    /// Optional host shell debug bridge attached by the desktop app.
    fn host_debug(&self) -> Option<SharedHostDebug> {
        None
    }
    /// Optional live voice controller port attached by the started server.
    fn voice(&self) -> Option<SharedLiveVoice> {
        None
    }
    /// Optional remote device authenticator attached by the started server.
    fn remote_auth(&self) -> Option<SharedRemoteAuth> {
        None
    }
    /// Optional execution-layer machine WS bus attached by the started server.
    fn machine_bus(&self) -> Option<SharedMachineBus> {
        None
    }
}

/// An envelope refusing with `code`.
pub fn refusal(code: BizCode, message: impl Into<String>) -> Envelope {
    Envelope::failure(&ApiError::new(code, message))
}
