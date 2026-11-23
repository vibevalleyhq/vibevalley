//! The in-process server's contract. `transport::bridge` and `transport::http`
//! serve views through [`Server`]; `Hub` implements it. Payloads, slices, and
//! events are VibeValley's protocol JSON.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use vibevalley_protocol::{ApiError, BizCode, Caller, Envelope, LiveEvent, SliceKind};

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
pub trait Mcp: Send + Sync {
    fn message(&self, token: &str, message: Value) -> Option<Value>;
}

pub type SharedMcp = Arc<dyn Mcp>;

/// Authenticated remote mobile device identity returned by [`RemoteAuth::verify_bearer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDeviceIdentity {
    pub device_id: String,
    pub name: String,
    pub scope: String,
}

/// Remote mobile access gate: reports whether remote access is enabled and
/// validates Bearer device tokens against paired devices.
pub trait RemoteAuth: Send + Sync {
    fn is_enabled(&self) -> bool;
    fn verify_bearer(&self, token: &str) -> Result<RemoteDeviceIdentity, ApiError>;
}

pub type SharedRemoteAuth = Arc<dyn RemoteAuth>;

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
pub trait Server: Send + Sync {
    /// One endpoint by name (`issue.status.update`, ...). Blocking; never
    /// called on the UI thread.
    fn call(&self, op: &str, payload: Value) -> Envelope;
    /// Endpoint invocation carrying caller identity, principal, and trace id.
    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        let _ = ctx;
        self.call(op, payload)
    }
    /// Current JSON snapshot for one domain slice.
    fn slice_snapshot(&self, slice: SliceKind) -> Value;
    /// Current pre-encoded UTF-8 JSON snapshot for one domain slice.
    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        Arc::<str>::from(serde_json::to_string(&self.slice_snapshot(slice)).unwrap_or_else(|_| "null".into()))
    }
    /// Watches one domain slice with Bounded-1 coalescing.
    /// If `after_seq == Some(latest_seq)`, skips the initial send; otherwise
    /// delivers the latest snapshot immediately. Blocks until `stop` disconnects.
    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value));
    /// Direct `tokio::sync::watch` subscription for a domain slice when backed
    /// by [`crate::slice_feed::SliceFeed`], avoiding blocking threads on SSE and bridge pumps.
    fn subscribe_slice(&self, _slice: SliceKind) -> Option<crate::slice_feed::SliceSubscription> {
        None
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
    /// One of `rpc.ts`'s subscriptions. `Err` is a refusal before the first
    /// event. The stream ends when the server drops its sender.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope>;
    /// Subscription invocation carrying caller identity and principal for `can` RBAC enforcement.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let _ = ctx;
        self.subscribe(name, payload)
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
}

/// An envelope refusing with `code`.
pub fn refusal(code: BizCode, message: impl Into<String>) -> Envelope {
    Envelope::failure(&ApiError::new(code, message))
}
