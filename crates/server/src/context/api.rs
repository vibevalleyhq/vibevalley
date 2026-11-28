//! Shared server door contracts, caller identities, and non-RPC stream/protocol
//! ports used by server domains without depending on `gateway/`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use vibevalley_protocol::{ApiError, BizCode, Caller, Envelope, LiveEvent, SliceKind};

/// Heap-allocated `Send` future returned by async trait methods across server domains.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Persisted remote access listener settings stored under `settings.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_addr: Option<String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub updated_at: vibevalley_protocol::Millis,
}

/// Narrow port allowing remote listener state persistence in `settings.json` without cross-layer imports.
pub trait RemoteConfigStore: Send + Sync {
    fn get_remote_config(&self) -> Option<RemoteAccessConfig>;
    fn save_remote_config<'a>(&'a self, cfg: RemoteAccessConfig) -> BoxFuture<'a, Result<(), ApiError>>;
}

pub mod media {
    //! Binary media transport contracts, separate from JSON RPC.
    use std::{io::Read, sync::Arc};
    use vibevalley_protocol::{ApiError, AttachmentFile, MediaInput};

    use super::BoxFuture;

    pub trait MediaInputs: Send + Sync + 'static {
        fn upload_async(self: Arc<Self>, id: String, source: Box<dyn Read + Send>) -> BoxFuture<'static, Result<MediaInput, ApiError>>;
        fn content_async(self: Arc<Self>, id: String) -> BoxFuture<'static, Result<AttachmentFile, ApiError>>;
    }
    pub type SharedMediaInputs = Arc<dyn MediaInputs>;

    /// A streamed speech job's events (`GET /api/v1/media/speech/:id/stream`).
    pub trait SpeechStreams: Send + Sync {
        fn claim(&self, id: &str) -> Result<SpeechClaim, ApiError>;
    }

    pub struct SpeechClaim {
        pub events: tokio::sync::mpsc::Receiver<serde_json::Value>,
        /// Called once when the reader goes away.
        pub gone: Box<dyn FnOnce() + Send>,
    }

    pub type SharedSpeechStreams = Arc<dyn SpeechStreams>;
}

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

/// Optional fault-injection gate for DevTools Lab & Overrides.
pub trait FaultGate: Send + Sync {
    fn delay_ms(&self, target: &str) -> u64;
    fn should_disconnect(&self, topic: &str) -> bool;
}

pub type SharedFaultGate = Arc<dyn FaultGate>;

/// Optional debug bridge exposing JSON-encoded GPUI shell state to the in-process server.
pub trait HostDebugBridge: Send + Sync {
    fn snapshot_json(&self) -> String;
}

pub type SharedHostDebug = Arc<dyn HostDebugBridge>;

/// The helpers' MCP door (`POST /mcp`): one JSON-RPC message string from a helper
/// with the bearer token it was given. `None` answers a notification.
pub trait Mcp: Send + Sync + 'static {
    fn message_json(&self, token: &str, message_json: &str) -> Option<String>;

    fn message_json_async(self: Arc<Self>, token: String, message_json: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async move {
            crate::log::spawn_blocking_traced(move || self.message_json(&token, &message_json))
                .await
                .unwrap_or(None)
        })
    }
}

pub type SharedMcp = Arc<dyn Mcp>;

/// Executes one JSON-RPC MCP message or batch asynchronously through [`Mcp::message_json_async`].
pub async fn dispatch_mcp_message_async(door: SharedMcp, token: String, message_json: String) -> Result<Option<String>, String> {
    let parsed: Value = serde_json::from_str(&message_json).map_err(|e| e.to_string())?;
    match parsed {
        Value::Array(batch) => {
            let mut answers = Vec::with_capacity(batch.len());
            for item in batch {
                let item_json = serde_json::to_string(&item).map_err(|e| e.to_string())?;
                if let Some(answer_json) = door.clone().message_json_async(token.clone(), item_json).await
                    && let Ok(answer_val) = serde_json::from_str::<Value>(&answer_json)
                {
                    answers.push(answer_val);
                }
            }
            if answers.is_empty() {
                Ok(None)
            } else {
                serde_json::to_string(&Value::Array(answers)).map(Some).map_err(|e| e.to_string())
            }
        }
        one => {
            let one_json = serde_json::to_string(&one).map_err(|e| e.to_string())?;
            Ok(door.message_json_async(token, one_json).await)
        }
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
/// `gateway::http::machine_ws` to [`MachineBus`].
pub struct MachineConnection {
    pub device: RemoteDeviceIdentity,
    pub incoming: tokio::sync::mpsc::Receiver<vibevalley_protocol::MachineWireFrame>,
    pub outgoing: tokio::sync::mpsc::Sender<vibevalley_protocol::MachineWireFrame>,
}

/// Port connecting the `/api/v1/machine/ws` transport to the machine manager.
pub trait MachineBus: Send + Sync + 'static {
    fn accept_connection(&self, conn: MachineConnection);

    fn mcp_tunnel_async(
        self: Arc<Self>,
        mcp: Option<SharedMcp>,
        req: vibevalley_protocol::MachineMcpRequest,
    ) -> BoxFuture<'static, vibevalley_protocol::MachineMcpResponse> {
        Box::pin(dispatch_mcp_tunnel_async(mcp, req))
    }
}

pub type SharedMachineBus = Arc<dyn MachineBus>;

/// Executes a reverse-tunneled MCP JSON-RPC HTTP request against `mcp`,
/// preserving the same single/batch semantics and device-token guard as `POST /mcp`.
pub async fn dispatch_mcp_tunnel_async(mcp: Option<SharedMcp>, req: vibevalley_protocol::MachineMcpRequest) -> vibevalley_protocol::MachineMcpResponse {
    let reply = |status: u16, body: String| vibevalley_protocol::MachineMcpResponse {
        request_id: req.request_id.clone(),
        status,
        content_type: "application/json".to_string(),
        body,
    };
    if req.session_token.trim().is_empty() {
        return reply(401, r#"{"error":"unauthorized"}"#.to_string());
    }
    if req.session_token.starts_with("vv_dev_") {
        return reply(403, r#"{"error":"forbidden"}"#.to_string());
    }
    if !req.method.eq_ignore_ascii_case("POST") {
        return reply(405, r#"{"error":"use POST"}"#.to_string());
    }
    let normalized_path = req.path.trim().trim_end_matches('/');
    if !normalized_path.is_empty() && normalized_path != "/mcp" {
        return reply(404, r#"{"error":"no such route"}"#.to_string());
    }
    let Some(door) = mcp else {
        return reply(503, r#"{"error":"no MCP here"}"#.to_string());
    };
    match dispatch_mcp_message_async(door, req.session_token.clone(), req.body.clone()).await {
        Ok(Some(body)) => reply(200, body),
        Ok(None) => reply(202, String::new()),
        Err(_) => reply(
            400,
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}"#.to_string(),
        ),
    }
}

/// Live MOSS realtime line handle consumed by the desktop host audio pipeline.
pub trait LiveVoiceLine: Send + Sync {
    fn url(&self) -> &str;
    fn bearer_token(&self) -> &str;
    fn session_update(&self) -> String;
    fn take_outgoing(&self) -> Option<tokio::sync::mpsc::Receiver<String>>;
    fn heard(&self, raw: &str);
}

/// Narrow live voice controller port consumed by the desktop host.
pub trait LiveVoicePort: Send + Sync {
    fn grant(&self) -> Result<vibevalley_protocol::VoiceGrant, ApiError>;
    fn moss_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError>;
    fn asr_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError>;
    fn can_transcribe(&self) -> bool;
    fn transcribe_wav_async(&self, wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>>;
    fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>>;
    fn start(&self, channel: &str, uid: &str) -> Result<vibevalley_protocol::VoiceCall, ApiError>;
    fn heard(&self, agent_id: &str, text: &str, turn: Option<&str>) -> Result<(), ApiError>;
    fn said(&self, agent_id: &str, text: &str) -> Result<(), ApiError>;
    fn stop(&self, agent_id: &str);
}

pub type SharedLiveVoice = Arc<dyn LiveVoicePort>;

/// Non-RPC stream and protocol ports exposed outside the JSON-RPC and
/// slice/subscription surface (`mcp`, `remote`, `machine`, `media_input`,
/// `voice`, `speech`).
#[derive(Clone, Default)]
pub struct GatewayPorts {
    pub mcp: Option<SharedMcp>,
    pub remote: Option<SharedRemoteAuth>,
    pub machine: Option<SharedMachineBus>,
    pub media_input: Option<media::SharedMediaInputs>,
    pub voice: Option<SharedLiveVoice>,
    pub speech: Option<media::SharedSpeechStreams>,
}

/// An envelope refusing with `code`.
pub fn refusal(code: BizCode, message: impl Into<String>) -> Envelope {
    Envelope::failure(&ApiError::new(code, message))
}

/// Decoded subscription request passed from the router/gateway boundary into server domains.
pub(crate) enum DomainSubscription {
    ChannelFollow(<vibevalley_protocol::subscriptions::ChannelFollow as vibevalley_protocol::Subscription>::Payload),
    ChannelReports(<vibevalley_protocol::subscriptions::ChannelReports as vibevalley_protocol::Subscription>::Payload),
    NoteFollow(<vibevalley_protocol::subscriptions::NoteFollow as vibevalley_protocol::Subscription>::Payload),
    NoteSuggestionFollow(<vibevalley_protocol::subscriptions::NoteSuggestionFollow as vibevalley_protocol::Subscription>::Payload),
    NotePresenceFollow(<vibevalley_protocol::subscriptions::NotePresenceFollow as vibevalley_protocol::Subscription>::Payload),
    SessionWatch(<vibevalley_protocol::subscriptions::SessionWatch as vibevalley_protocol::Subscription>::Payload),
    IssueWatch(<vibevalley_protocol::subscriptions::IssueWatch as vibevalley_protocol::Subscription>::Payload),
}

/// Decoded native-only endpoint input passed from the gateway/router boundary into storage.
pub(crate) enum NativeEndpointInput {
    Attachment(String),
    MediaInput(String),
    MediaInputUpload(String, std::path::PathBuf),
}

/// Typed native-only endpoint response returned before gateway JSON encoding.
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum NativeEndpointOutput {
    AttachmentFile(vibevalley_protocol::AttachmentFile),
    MediaInput(vibevalley_protocol::MediaInput),
}
