//! Low-level VDP (VibeValley DevTools Protocol) flags, telemetry hooks, UI probe
//! response table, hit-testing helpers, and loopback `host.vdpCall` client.
//!
//! Kept free of `shell`, `hosted`, `log`, and `debug` dependencies so lower layers
//! (`log`, `hosted`, `shell`) can publish events and call remote VDP endpoints without
//! forming a cycle with the top-level `debug` host server.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt as _, StreamExt as _};
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use vibevalley_protocol::{
    HostVdpCallPayload, VdpCommand, VdpError, VdpLogEntry, VdpLogLevel, VdpNotification, VdpPageFrameEvent, VdpRequest, VdpTarget, VdpUiBounds,
    VdpUiConsoleEvent, VdpUiInspectAtResult, VdpUiNode, VdpWireMessage,
};
use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};

const REMOTE_CALL_DEFAULT_TIMEOUT_MS: u64 = 10_000;
const REMOTE_CALL_MIN_TIMEOUT_MS: u64 = 500;
const REMOTE_CALL_MAX_TIMEOUT_MS: u64 = 60_000;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

static VDP_CONFIGURED_PORT: Mutex<Option<u16>> = Mutex::new(None);
static VDP_ENABLED: AtomicBool = AtomicBool::new(false);
static VDP_LOG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub(crate) fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Parses `--remote-debugging-port=<port>` / `--remote-debugging-port <port>` from CLI args,
/// falling back to `VIBEVALLEY_DEBUG_PORT=<port>`. Returns `None` when disabled or invalid.
pub fn parse_debug_port_from<I, S>(args: I, env_port: Option<&str>) -> Option<u16>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let s = arg.as_ref();
        if let Some(raw) = s.strip_prefix("--remote-debugging-port=") {
            return raw.trim().parse::<u16>().ok();
        }
        if s == "--remote-debugging-port" {
            return iter.next().and_then(|next| next.as_ref().trim().parse::<u16>().ok());
        }
    }
    env_port.map(str::trim).filter(|s| !s.is_empty()).and_then(|raw| raw.parse::<u16>().ok())
}

/// Captures `--remote-debugging-port` / `VIBEVALLEY_DEBUG_PORT` once at startup so
/// hosted views created before the main window opens know whether VDP is enabled.
pub fn configure_from_env_and_args() {
    let env_port = std::env::var("VIBEVALLEY_DEBUG_PORT").ok();
    let port = parse_debug_port_from(std::env::args().skip(1), env_port.as_deref());
    *VDP_CONFIGURED_PORT.lock() = port;
    VDP_ENABLED.store(port.is_some(), Ordering::Release);
}

pub(crate) fn configured_port() -> Option<u16> {
    *VDP_CONFIGURED_PORT.lock()
}

pub(crate) fn set_vdp_enabled(enabled: bool) {
    VDP_ENABLED.store(enabled, Ordering::Release);
}

/// Whether VDP remote debugging is enabled for this process.
pub fn vdp_enabled() -> bool {
    VDP_ENABLED.load(Ordering::Acquire)
}

/// Whether VDP live log / frame / UI console streaming is currently active.
pub fn is_vdp_log_active() -> bool {
    VDP_LOG_ACTIVE.load(Ordering::Relaxed)
}

pub(crate) fn set_vdp_log_active(active: bool) {
    VDP_LOG_ACTIVE.store(active, Ordering::Release);
}

// ---------------------------------------------------------------------------
// Dispatcher trait & active VDP sink slot
// ---------------------------------------------------------------------------

pub(crate) trait VdpDispatcher: Send + Sync + 'static {
    fn list_targets(&self, attached: HashSet<String>) -> BoxFuture<'_, Result<Vec<VdpTarget>, VdpError>>;
    fn dispatch(&self, command: VdpCommand, attached_target: Option<String>) -> BoxFuture<'_, Result<Value, VdpError>>;
    fn set_ui_log_enabled(&self, enabled: bool) -> BoxFuture<'_, ()>;
}

pub(crate) type NotificationEmitter = Arc<dyn Fn(VdpNotification) + Send + Sync>;

#[derive(Clone)]
struct ActiveVdpSink {
    emit: NotificationEmitter,
    dispatcher: Arc<dyn VdpDispatcher>,
}

fn active_sink_slot() -> &'static RwLock<Option<ActiveVdpSink>> {
    static SINK: OnceLock<RwLock<Option<ActiveVdpSink>>> = OnceLock::new();
    SINK.get_or_init(|| RwLock::new(None))
}

pub(crate) fn install_active_vdp(emit: NotificationEmitter, dispatcher: Arc<dyn VdpDispatcher>) {
    *active_sink_slot().write() = Some(ActiveVdpSink { emit, dispatcher });
}

pub(crate) fn clear_active_vdp() {
    *active_sink_slot().write() = None;
}

pub(crate) fn emit_notification(notification: VdpNotification) {
    let sink = active_sink_slot().read().clone();
    if let Some(sink) = sink {
        (sink.emit)(notification);
    }
}

// ---------------------------------------------------------------------------
// Process-wide UI probe response table
// ---------------------------------------------------------------------------

pub(crate) struct PendingUiRequests {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, VdpError>>>>,
}

impl PendingUiRequests {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn register(&self, req_id: String) -> (oneshot::Receiver<Result<Value, VdpError>>, PendingUiGuard<'_>) {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(req_id.clone(), tx);
        let guard = PendingUiGuard {
            map: &self.pending,
            req_id,
            armed: true,
        };
        (rx, guard)
    }

    pub(crate) fn resolve(&self, value: &Value) -> bool {
        let Some(req_id) = value.get("reqId").and_then(Value::as_str) else {
            return false;
        };
        let Some(tx) = self.pending.lock().remove(req_id) else {
            return false;
        };
        let outcome = if let Some(err) = value.get("error").filter(|v| !v.is_null()) {
            let vdp_err = if let Some(msg) = err.as_str() {
                VdpError::internal(msg)
            } else {
                let code = err
                    .get("code")
                    .and_then(Value::as_i64)
                    .and_then(|c| i32::try_from(c).ok())
                    .unwrap_or(VdpError::INTERNAL_ERROR);
                let message = err.get("message").and_then(Value::as_str).unwrap_or("UI probe error").to_string();
                VdpError::new(code, message)
            };
            Err(vdp_err)
        } else {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        };
        tx.send(outcome).is_ok()
    }
}

pub(crate) struct PendingUiGuard<'a> {
    map: &'a Mutex<HashMap<String, oneshot::Sender<Result<Value, VdpError>>>>,
    req_id: String,
    armed: bool,
}

impl PendingUiGuard<'_> {
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingUiGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.map.lock().remove(&self.req_id);
        }
    }
}

pub(crate) fn ui_requests() -> &'static PendingUiRequests {
    static PENDING: OnceLock<PendingUiRequests> = OnceLock::new();
    PENDING.get_or_init(PendingUiRequests::new)
}

/// Resolves an in-flight `UI.*` VDP probe response arriving from a `HostedView`'s engine thread.
pub fn resolve_ui_response(value: &Value) -> bool {
    ui_requests().resolve(value)
}

/// Forwards a `vdp_ui_log` console message emitted by `vdpProbe.ts` to active VDP subscribers.
pub fn emit_ui_console(view: &str, value: &Value) {
    if !vdp_enabled() {
        return;
    }
    let level = value["level"].as_str().map(VdpLogLevel::from_console_level).unwrap_or(VdpLogLevel::Info);
    let message = value["message"].as_str().unwrap_or_default().to_string();
    let timestamp = value["time"].as_i64().unwrap_or_else(now_millis);
    emit_notification(VdpNotification::UiConsole(VdpUiConsoleEvent {
        view: view.to_string(),
        level,
        message,
        timestamp,
    }));
}

/// Forwards an engine error reported by a `HostedView` when VDP is active.
pub fn emit_ui_error(view: &str, message: &str) {
    if !vdp_enabled() {
        return;
    }
    emit_notification(VdpNotification::UiConsole(VdpUiConsoleEvent {
        view: view.to_string(),
        level: VdpLogLevel::Error,
        message: message.to_string(),
        timestamp: now_millis(),
    }));
}

/// Forwards a host tracing event to VDP `Log.entry` subscribers when `Log.enable` is active.
pub fn emit_log_entry(level: VdpLogLevel, source: &str, message: String, fields: Option<Value>) {
    if !is_vdp_log_active() {
        return;
    }
    emit_notification(VdpNotification::LogEntry(VdpLogEntry {
        level,
        source: source.to_string(),
        message,
        timestamp: now_millis(),
        fields,
    }));
}

/// Forwards a GPUI frame timing sample to VDP `Page.frame` subscribers when `Log.enable` is active.
pub fn emit_page_frame(frame_ms: f64, width: f32, height: f32) {
    if !is_vdp_log_active() {
        return;
    }
    emit_notification(VdpNotification::PageFrame(VdpPageFrameEvent {
        frame_ms,
        timestamp: now_millis(),
        width: Some(width),
        height: Some(height),
    }));
}

// ---------------------------------------------------------------------------
// Canvas Inspector hit-testing helpers
// ---------------------------------------------------------------------------

fn contains_point(bounds: &VdpUiBounds, x: f32, y: f32) -> bool {
    bounds.width > 0.0 && bounds.height > 0.0 && x >= bounds.x && x <= (bounds.x + bounds.width) && y >= bounds.y && y <= (bounds.y + bounds.height)
}

fn bounds_area(bounds: &VdpUiBounds) -> f32 {
    (bounds.width.max(0.0)) * (bounds.height.max(0.0))
}

fn is_container_only_node(hit: &VdpUiInspectAtResult) -> bool {
    matches!(hit.role.as_deref(), Some("root" | "route")) || hit.test_id.as_deref().is_some_and(|id| id.starts_with("view:"))
}

/// Chooses the tightest (smallest-area) inspect candidate containing `(x, y)`, preferring leaf nodes over root view wrappers.
pub(crate) fn select_deepest_hit(x: f32, y: f32, candidates: Vec<VdpUiInspectAtResult>) -> Option<VdpUiInspectAtResult> {
    candidates
        .into_iter()
        .filter(|c| c.bounds.as_ref().is_some_and(|b| contains_point(b, x, y)))
        .min_by(|a, b| {
            let a_container = is_container_only_node(a);
            let b_container = is_container_only_node(b);
            a_container.cmp(&b_container).then_with(|| {
                let area_a = a.bounds.as_ref().map_or(f32::MAX, bounds_area);
                let area_b = b.bounds.as_ref().map_or(f32::MAX, bounds_area);
                area_a.total_cmp(&area_b)
            })
        })
}

/// Translates a `vdpProbe` UI node reported by `surface` at window origin `(ox, oy)` into shell window coordinates.
pub(crate) fn hit_from_hosted_node(surface: &str, ox: f32, oy: f32, node: &VdpUiNode) -> Option<VdpUiInspectAtResult> {
    let b = node.bounds?;
    Some(VdpUiInspectAtResult {
        hit: true,
        surface: Some(surface.to_string()),
        test_id: node.test_id.clone(),
        role: node.role.clone(),
        text: node.text.clone(),
        route: node.route.clone(),
        source: node.source.clone(),
        bounds: Some(VdpUiBounds {
            x: b.x + ox,
            y: b.y + oy,
            width: b.width,
            height: b.height,
        }),
    })
}

/// Probes mounted hosted views for Canvas Inspector clicks via the active VDP dispatcher.
pub(crate) async fn inspect_hosted_views_at(
    hosted_views: Vec<(String, f32, f32)>,
    x: f32,
    y: f32,
    native_fallback: Option<VdpUiInspectAtResult>,
    timeout: Duration,
) -> Option<VdpUiInspectAtResult> {
    let dispatcher = active_sink_slot().read().as_ref().map(|s| s.dispatcher.clone());
    let mut candidates = Vec::new();
    if let Some(native) = native_fallback {
        candidates.push(native);
    }
    if let Some(disp) = dispatcher {
        for (surface, ox, oy) in hosted_views {
            if let Ok(val) = disp
                .dispatch(
                    VdpCommand::UiQuery(vibevalley_protocol::VdpUiQueryParams {
                        test_id: None,
                        text: None,
                        role: None,
                        view: Some(surface.clone()),
                    }),
                    None,
                )
                .await
                && let Some(nodes) = val.get("nodes").and_then(Value::as_array)
            {
                for raw in nodes {
                    if let Ok(node) = serde_json::from_value::<VdpUiNode>(raw.clone())
                        && let Some(hit) = hit_from_hosted_node(&surface, ox, oy, &node)
                    {
                        candidates.push(hit);
                    }
                }
            }
        }
    } else {
        let _ = (hosted_views, timeout);
    }
    select_deepest_hit(x, y, candidates)
}

// ---------------------------------------------------------------------------
// HostOp::VdpCall loopback client proxy (for DevToolsApp remote attachment)
// ---------------------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim_matches(['[', ']']);
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    trimmed.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

pub(crate) fn resolve_loopback_ws_url(req: &HostVdpCallPayload) -> Result<String, String> {
    let base = if let Some(ws_url) = req.ws_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = url::Url::parse(ws_url).map_err(|e| format!("invalid wsUrl: {e}"))?;
        if parsed.scheme() != "ws" {
            return Err("vdpCall only permits loopback ws:// URLs".into());
        }
        let host = parsed.host_str().ok_or_else(|| "wsUrl missing host".to_string())?;
        if !is_loopback_host(host) {
            return Err(format!("vdpCall refused non-loopback host {host:?}"));
        }
        parsed
    } else if let Some(port) = req.port {
        if port == 0 {
            return Err("vdpCall requires a non-zero port".into());
        }
        url::Url::parse(&format!("ws://127.0.0.1:{port}/devtools")).map_err(|e| e.to_string())?
    } else {
        return Err("vdpCall requires wsUrl or port".into());
    };

    let mut target = base;
    if let Some(token) = req.token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let has_token = target.query_pairs().any(|(k, _)| k == "token");
        if !has_token {
            target.query_pairs_mut().append_pair("token", token);
        }
    }
    Ok(target.into())
}

fn biz_code_for_vdp_error(code: i32) -> BizCode {
    match code {
        VdpError::UNAUTHORIZED => BizCode::Unauthorized,
        VdpError::METHOD_NOT_FOUND => BizCode::RouteNotFound,
        VdpError::INVALID_PARAMS | VdpError::INVALID_REQUEST | VdpError::PARSE_ERROR => BizCode::InvalidInput,
        VdpError::TIMEOUT | VdpError::UNAVAILABLE => BizCode::ServiceUnavailable,
        _ => BizCode::Refused,
    }
}

/// Executes one JSON-RPC call against a local running VibeValley instance's VDP WebSocket
/// on behalf of `DevToolsApp.tsx` (`host.vdpCall`).
pub async fn call_remote_vdp(req: HostVdpCallPayload) -> Envelope {
    let url = match resolve_loopback_ws_url(&req) {
        Ok(url) => url,
        Err(msg) => return refusal(BizCode::InvalidInput, msg),
    };
    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(REMOTE_CALL_DEFAULT_TIMEOUT_MS)
            .clamp(REMOTE_CALL_MIN_TIMEOUT_MS, REMOTE_CALL_MAX_TIMEOUT_MS),
    );
    let method = req.method;
    let params = req.params.unwrap_or_else(|| json!({}));
    let session_id = req.session_id;

    let work = async move {
        let (mut ws, _) = match tokio_tungstenite::connect_async(&url).await {
            Ok(conn) => conn,
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                return refusal(BizCode::Unauthorized, format!("VDP rejected credentials (HTTP {})", resp.status()));
            }
            Err(err) => return refusal(BizCode::ServiceUnavailable, format!("VDP connect failed: {err}")),
        };

        let request = VdpRequest::new(1, method, params, session_id);
        let wire = match serde_json::to_string(&request) {
            Ok(s) => s,
            Err(err) => return refusal(BizCode::InvalidInput, format!("serialize VDP request: {err}")),
        };
        if let Err(err) = ws.send(tokio_tungstenite::tungstenite::Message::Text(wire.into())).await {
            return refusal(BizCode::ServiceUnavailable, format!("VDP send failed: {err}"));
        }

        while let Some(frame) = ws.next().await {
            match frame {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                    if let Ok(VdpWireMessage::Response(resp)) = serde_json::from_str::<VdpWireMessage>(&text)
                        && resp.id == 1
                    {
                        let _ = ws.close(None).await;
                        return match resp.into_result() {
                            Ok(val) => Envelope::ok(val),
                            Err(err) => refusal(biz_code_for_vdp_error(err.code), err.message),
                        };
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => return refusal(BizCode::ServiceUnavailable, format!("VDP read failed: {err}")),
            }
        }
        refusal(BizCode::ServiceUnavailable, "VDP connection closed before response")
    };

    match tokio::time::timeout(timeout, work).await {
        Ok(env) => env,
        Err(_) => refusal(BizCode::ServiceUnavailable, format!("VDP call timed out after {}ms", timeout.as_millis())),
    }
}
