//! Live opt-in loopback VDP (VibeValley DevTools Protocol) HTTP + WebSocket host server,
//! GPUI foreground dispatcher, `UI.*` probe bridge, and `host.vdpCall` loopback proxy.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt as _, StreamExt as _};
use gpui::{App, AppContext as _, Entity, WindowHandle};
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::home::{DebugEndpointGuard, write_debug_endpoint};
use vibevalley_protocol::{
    SliceKind, VDP_PROTOCOL_VERSION, VdpAckResult, VdpBufferedEvent, VdpCommand, VdpEndpointInfo, VdpError, VdpEvent, VdpLogEntriesResult, VdpNotification,
    VdpRequest, VdpResponse, VdpScreenshotResult, VdpTarget, VdpTargetAttachResult, VdpTargetListResult, VdpUiInspectAtResult, VdpUiNode, VdpVersionInfo,
};
use vibevalley_server::gateway::bridge::{CallerContext, Server as BridgeServer};

use crate::shell::Shell;
pub(crate) use crate::vdp_bus::{BoxFuture, VdpDispatcher, now_millis, ui_requests};
#[cfg(test)]
pub(crate) use crate::vdp_bus::{call_remote_vdp, resolve_loopback_ws_url, resolve_ui_response};

use super::executor::{self, GpuiExecResult};

const EVENT_BROADCAST_CAPACITY: usize = 256;
const EVENT_RING_CAPACITY: usize = 512;
const GPUI_DISPATCH_TIMEOUT: Duration = Duration::from_secs(10);
const UI_REQUEST_DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// GPUI foreground command channel & production dispatcher
// ---------------------------------------------------------------------------

pub(crate) type HostedViewInspectEntry = (String, f32, f32, Entity<crate::hosted::HostedView>);
pub(crate) type PrepareInspectReply = (Vec<HostedViewInspectEntry>, Option<VdpUiInspectAtResult>);

pub(crate) enum GpuiCommand {
    ListTargets {
        attached: HashSet<String>,
        reply: oneshot::Sender<Result<Vec<VdpTarget>, VdpError>>,
    },
    PrepareInspectAt {
        x: f32,
        y: f32,
        reply: oneshot::Sender<PrepareInspectReply>,
    },
    Execute {
        command: VdpCommand,
        reply: oneshot::Sender<GpuiExecResult>,
    },
    SendUiRequest {
        view: Option<String>,
        req_id: String,
        method: &'static str,
        params: Value,
        reply: oneshot::Sender<Result<String, VdpError>>,
    },
    SetUiLogEnabled {
        enabled: bool,
    },
}

pub(crate) struct GpuiVdpDispatcher {
    tx: RwLock<tokio::sync::mpsc::UnboundedSender<GpuiCommand>>,
    server: Option<Arc<dyn BridgeServer>>,
}

impl GpuiVdpDispatcher {
    pub(crate) fn new(tx: tokio::sync::mpsc::UnboundedSender<GpuiCommand>, server: Option<Arc<dyn BridgeServer>>) -> Self {
        Self { tx: RwLock::new(tx), server }
    }

    pub(crate) fn rebind_window(&self, tx: tokio::sync::mpsc::UnboundedSender<GpuiCommand>) {
        *self.tx.write() = tx;
    }

    fn sender(&self) -> tokio::sync::mpsc::UnboundedSender<GpuiCommand> {
        self.tx.read().clone()
    }

    async fn dispatch_ui(&self, view: Option<String>, method: &'static str, params: Value, timeout: Duration) -> Result<Value, VdpError> {
        let req_id = uuid::Uuid::new_v4().to_string();
        let (resp_rx, mut guard) = ui_requests().register(req_id.clone());
        let (send_tx, send_rx) = oneshot::channel();
        let cmd = GpuiCommand::SendUiRequest {
            view,
            req_id,
            method,
            params,
            reply: send_tx,
        };
        self.sender().send(cmd).map_err(|_| VdpError::unavailable("main window is closed"))?;

        match tokio::time::timeout(GPUI_DISPATCH_TIMEOUT, send_rx).await {
            Ok(Ok(Ok(_resolved_view))) => {}
            Ok(Ok(Err(err))) => return Err(err),
            Ok(Err(_)) => return Err(VdpError::unavailable("main window closed before UI request dispatched")),
            Err(_) => return Err(VdpError::timeout("timed out dispatching UI request to main window")),
        }

        match tokio::time::timeout(timeout, resp_rx).await {
            Ok(Ok(result)) => {
                guard.disarm();
                result
            }
            Ok(Err(_)) => Err(VdpError::unavailable("UI probe reply channel closed")),
            Err(_) => Err(VdpError::timeout(format!("{method} timed out after {}ms", timeout.as_millis()))),
        }
    }

    async fn dispatch_inspect_at(&self, x: f32, y: f32) -> Result<Value, VdpError> {
        let (tx, rx) = oneshot::channel();
        self.sender()
            .send(GpuiCommand::PrepareInspectAt { x, y, reply: tx })
            .map_err(|_| VdpError::unavailable("main window is closed"))?;
        let (hosted_views, native_hit) = match tokio::time::timeout(GPUI_DISPATCH_TIMEOUT, rx).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(_)) => return Err(VdpError::unavailable("main window closed during inspect preparation")),
            Err(_) => return Err(VdpError::timeout("UI.inspectAt preparation timed out")),
        };

        let mut candidates = Vec::new();
        if let Some(native) = native_hit {
            candidates.push(native);
        }
        for (surface, ox, oy, _hosted) in hosted_views {
            if let Ok(val) = self.dispatch_ui(Some(surface.clone()), "UI.query", json!({}), Duration::from_millis(900)).await
                && let Some(nodes) = val.get("nodes").and_then(Value::as_array)
            {
                for raw in nodes {
                    if let Ok(node) = serde_json::from_value::<VdpUiNode>(raw.clone())
                        && let Some(hit) = executor::hit_from_hosted_node(&surface, ox, oy, &node)
                    {
                        candidates.push(hit);
                    }
                }
            }
        }
        let best = executor::select_deepest_hit(x, y, candidates).unwrap_or_else(|| VdpUiInspectAtResult {
            hit: false,
            ..Default::default()
        });
        if best.hit {
            let (htx, hrx) = oneshot::channel();
            let _ = self.sender().send(GpuiCommand::Execute {
                command: VdpCommand::UiHighlight(vibevalley_protocol::VdpUiHighlightParams {
                    test_id: best.test_id.clone(),
                    bounds: best.bounds,
                    label: best.text.clone(),
                    source: best.source.clone(),
                    surface: best.surface.clone(),
                }),
                reply: htx,
            });
            let _ = tokio::time::timeout(GPUI_DISPATCH_TIMEOUT, hrx).await;
        }
        serde_json::to_value(best).map_err(|e| VdpError::internal(e.to_string()))
    }
}

fn parse_slice_kind(name: &str) -> Result<SliceKind, VdpError> {
    match name.trim().to_ascii_lowercase().as_str() {
        "board" => Ok(SliceKind::Board),
        "sessions" => Ok(SliceKind::Sessions),
        "collab" => Ok(SliceKind::Collab),
        "inbox" => Ok(SliceKind::Inbox),
        "ops" => Ok(SliceKind::Ops),
        "farm" => Ok(SliceKind::Farm),
        other => Err(VdpError::invalid_params(format!(
            "unknown slice {other:?} (expected board|sessions|collab|inbox|ops|farm)"
        ))),
    }
}

fn effective_ui_view(explicit: Option<String>, attached_target: Option<String>) -> Option<String> {
    explicit.or_else(|| attached_target.as_deref().and_then(|id| id.strip_prefix("view:")).map(str::to_string))
}

impl VdpDispatcher for GpuiVdpDispatcher {
    fn list_targets(&self, attached: HashSet<String>) -> BoxFuture<'_, Result<Vec<VdpTarget>, VdpError>> {
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            self.sender()
                .send(GpuiCommand::ListTargets { attached, reply: tx })
                .map_err(|_| VdpError::unavailable("main window is closed"))?;
            match tokio::time::timeout(GPUI_DISPATCH_TIMEOUT, rx).await {
                Ok(Ok(res)) => res,
                Ok(Err(_)) => Err(VdpError::unavailable("main window closed while listing targets")),
                Err(_) => Err(VdpError::timeout("Target.list timed out")),
            }
        })
    }

    fn dispatch(&self, command: VdpCommand, attached_target: Option<String>) -> BoxFuture<'_, Result<Value, VdpError>> {
        Box::pin(async move {
            match command {
                VdpCommand::ServerSlice(params) => {
                    let kind = parse_slice_kind(&params.name)?;
                    let server = self
                        .server
                        .as_ref()
                        .ok_or_else(|| VdpError::unavailable("embedded server bridge is unavailable"))?
                        .clone();
                    let raw = server.slice_snapshot_json_async(kind).await;
                    serde_json::from_str::<Value>(&raw).map_err(|e| VdpError::internal(format!("slice snapshot decode failed: {e}")))
                }
                VdpCommand::ServerInvoke(params) => {
                    let server = self
                        .server
                        .as_ref()
                        .ok_or_else(|| VdpError::unavailable("embedded server bridge is unavailable"))?
                        .clone();
                    let payload = params.params.unwrap_or_else(|| json!({}));
                    let envelope = server.call_with_async(CallerContext::local(), params.method, payload).await;
                    serde_json::to_value(envelope).map_err(|e| VdpError::internal(format!("serialize envelope: {e}")))
                }
                VdpCommand::UiGetTree(params) => {
                    let view = effective_ui_view(params.view.clone(), attached_target);
                    let wire_params = serde_json::to_value(&params).unwrap_or_else(|_| json!({}));
                    self.dispatch_ui(view, "UI.getTree", wire_params, UI_REQUEST_DEFAULT_TIMEOUT).await
                }
                VdpCommand::UiQuery(params) => {
                    let view = effective_ui_view(params.view.clone(), attached_target);
                    let wire_params = serde_json::to_value(&params).unwrap_or_else(|_| json!({}));
                    self.dispatch_ui(view, "UI.query", wire_params, UI_REQUEST_DEFAULT_TIMEOUT).await
                }
                VdpCommand::UiPress(params) => {
                    let view = effective_ui_view(params.view.clone(), attached_target);
                    let wire_params = serde_json::to_value(&params).unwrap_or_else(|_| json!({}));
                    self.dispatch_ui(view, "UI.press", wire_params, UI_REQUEST_DEFAULT_TIMEOUT).await
                }
                VdpCommand::UiWaitFor(params) => {
                    let view = effective_ui_view(params.view.clone(), attached_target);
                    let wait_ms = params.timeout_ms.unwrap_or(5_000).clamp(100, 30_000);
                    let wire_params = serde_json::to_value(&params).unwrap_or_else(|_| json!({}));
                    self.dispatch_ui(view, "UI.waitFor", wire_params, Duration::from_millis(wait_ms + 1_500)).await
                }
                VdpCommand::UiInspectAt(params) => self.dispatch_inspect_at(params.x, params.y).await,
                other => {
                    let (tx, rx) = oneshot::channel();
                    self.sender()
                        .send(GpuiCommand::Execute { command: other, reply: tx })
                        .map_err(|_| VdpError::unavailable("main window is closed"))?;
                    let outcome = match tokio::time::timeout(GPUI_DISPATCH_TIMEOUT, rx).await {
                        Ok(Ok(outcome)) => outcome,
                        Ok(Err(_)) => return Err(VdpError::unavailable("main window closed while handling VDP command")),
                        Err(_) => return Err(VdpError::timeout("VDP command timed out on main window")),
                    };
                    match outcome {
                        GpuiExecResult::Ready(res) => res,
                        GpuiExecResult::PendingWebviewCapture(cap_rx) => match tokio::time::timeout(Duration::from_secs(8), cap_rx).await {
                            Ok(Ok(Ok(cover))) => serde_json::to_value(VdpScreenshotResult {
                                mime: cover.mime,
                                data: cover.data,
                                width: cover.width,
                                height: cover.height,
                            })
                            .map_err(|e| VdpError::internal(e.to_string())),
                            Ok(Ok(Err(reason))) => Err(VdpError::unavailable(reason)),
                            Ok(Err(_)) => Err(VdpError::unavailable("webview capture channel closed")),
                            Err(_) => Err(VdpError::timeout("webview screenshot timed out")),
                        },
                        #[cfg(feature = "shot")]
                        GpuiExecResult::PendingShellPng { image, width, height } => {
                            let shot = tokio::task::spawn_blocking(move || executor::encode_shell_png(image, width, height))
                                .await
                                .map_err(|e| VdpError::internal(format!("screenshot encode task failed: {e}")))??;
                            serde_json::to_value(shot).map_err(|e| VdpError::internal(e.to_string()))
                        }
                    }
                }
            }
        })
    }

    fn set_ui_log_enabled(&self, enabled: bool) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.sender().send(GpuiCommand::SetUiLogEnabled { enabled });
        })
    }
}

/// Drains VDP commands on the GPUI foreground thread without blocking Tokio or GPUI.
pub(crate) fn spawn_gpui_command_loop(
    shell: Entity<Shell>,
    window: WindowHandle<Shell>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<GpuiCommand>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        while let Some(cmd) = rx.recv().await {
            let updated = cx.update_window(window.into(), |_, window, cx| match cmd {
                GpuiCommand::ListTargets { attached, reply } => {
                    let targets = executor::collect_targets(shell.read(cx), &attached, cx);
                    let _ = reply.send(Ok(targets));
                }
                GpuiCommand::PrepareInspectAt { x, y, reply } => {
                    let vp = window.viewport_size();
                    let s = shell.read(cx);
                    let hosted = s.hosted_view_origins(f32::from(vp.width), f32::from(vp.height), cx);
                    let native = s.inspect_native_at(x, y, f32::from(vp.width), f32::from(vp.height), cx);
                    let _ = reply.send((hosted, native));
                }
                GpuiCommand::Execute { command, reply } => {
                    let outcome = execute_on_gpui(&shell, command, window, cx);
                    let _ = reply.send(outcome);
                }
                GpuiCommand::SendUiRequest {
                    view,
                    req_id,
                    method,
                    params,
                    reply,
                } => {
                    let res = match executor::resolve_hosted_view(shell.read(cx), view.as_deref(), cx) {
                        Some((resolved_name, hosted)) => {
                            hosted.read(cx).send_vdp_ui_req(&req_id, method, params, cx);
                            Ok(resolved_name)
                        }
                        None => Err(VdpError::unavailable(format!(
                            "UI view {:?} is not mounted",
                            view.as_deref().unwrap_or("workbench")
                        ))),
                    };
                    let _ = reply.send(res);
                }
                GpuiCommand::SetUiLogEnabled { enabled } => {
                    shell.update(cx, |s, cx| {
                        s.for_each_hosted_view(cx, |v, cx| v.set_vdp_log_enabled(enabled, cx));
                    });
                }
            });
            if updated.is_err() {
                break;
            }
        }
    })
    .detach();
}

fn execute_on_gpui(shell: &Entity<Shell>, command: VdpCommand, window: &mut gpui::Window, cx: &mut App) -> GpuiExecResult {
    match command {
        VdpCommand::ShellGetState => {
            shell.update(cx, |s, cx| executor::step_unpainted_dioramas(s, cx));
            GpuiExecResult::Ready(Ok(executor::dump(shell.read(cx), cx)))
        }
        VdpCommand::ShellNavigate(params) => GpuiExecResult::Ready(shell.update(cx, |s, cx| executor::exec_navigate(s, &params, cx))),
        VdpCommand::ShellOpenPane(params) => GpuiExecResult::Ready(shell.update(cx, |s, cx| executor::exec_open_pane(s, &params, window, cx))),
        VdpCommand::ShellClosePane(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_close_pane(s, &params, window, cx)))),
        VdpCommand::ShellResize(params) => GpuiExecResult::Ready(executor::exec_resize(&params, window)),
        VdpCommand::ShellSetTheme(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_set_theme(s, &params, cx)))),
        VdpCommand::ShellGetTerminalGrid(params) => GpuiExecResult::Ready(executor::exec_get_terminal_grid(shell.read(cx), &params, cx)),
        VdpCommand::ShellSendTerminalInput(params) => GpuiExecResult::Ready(shell.update(cx, |s, cx| executor::exec_send_terminal_input(s, &params, cx))),
        VdpCommand::ShellRunCommand(params) => GpuiExecResult::Ready(executor::exec_run_command(shell, &params, window, cx)),
        VdpCommand::ShellDispatchAction(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_dispatch_action(s, &params, window, cx)))),
        VdpCommand::ShellSave => GpuiExecResult::Ready(Ok(shell.update(cx, executor::exec_save))),
        VdpCommand::ShellQuit => {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                cx.update(|cx| cx.quit());
            })
            .detach();
            GpuiExecResult::Ready(Ok(json!(VdpAckResult { ok: true })))
        }
        VdpCommand::ShellGetUpdateState => GpuiExecResult::Ready(Ok(executor::exec_get_update_state())),
        VdpCommand::ShellSetDioramaClock(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_set_diorama_clock(s, &params, cx)))),
        VdpCommand::PageCaptureScreenshot(params) => executor::capture_screenshot(&params, window, cx),
        VdpCommand::PageDraw => GpuiExecResult::Ready(Ok(executor::exec_page_draw(shell, window, cx))),
        VdpCommand::PageGetMetrics => {
            let metrics = executor::page_metrics(window, cx);
            GpuiExecResult::Ready(serde_json::to_value(metrics).map_err(|e| VdpError::internal(e.to_string())))
        }
        VdpCommand::InputDispatchKey(params) => GpuiExecResult::Ready(
            executor::dispatch_keys(&params, window, cx).and_then(|res| serde_json::to_value(res).map_err(|e| VdpError::internal(e.to_string()))),
        ),
        VdpCommand::InputTypeText(params) => {
            let res = executor::dispatch_text(&params, window, cx);
            GpuiExecResult::Ready(serde_json::to_value(res).map_err(|e| VdpError::internal(e.to_string())))
        }
        VdpCommand::InputDispatchMouse(params) => GpuiExecResult::Ready(
            executor::dispatch_mouse(&params, window, cx).and_then(|res| serde_json::to_value(res).map_err(|e| VdpError::internal(e.to_string()))),
        ),
        VdpCommand::UiHighlight(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_ui_highlight(s, &params, cx)))),
        VdpCommand::UiSetInspectorMode(params) => GpuiExecResult::Ready(Ok(shell.update(cx, |s, cx| executor::exec_ui_set_inspector_mode(s, &params, cx)))),
        // Handled before reaching the GPUI thread:
        VdpCommand::TargetList
        | VdpCommand::TargetAttach(_)
        | VdpCommand::TargetDetach(_)
        | VdpCommand::UiGetTree(_)
        | VdpCommand::UiQuery(_)
        | VdpCommand::UiPress(_)
        | VdpCommand::UiWaitFor(_)
        | VdpCommand::UiInspectAt(_)
        | VdpCommand::ServerSlice(_)
        | VdpCommand::ServerInvoke(_)
        | VdpCommand::LogEnable
        | VdpCommand::LogDisable
        | VdpCommand::LogGetEntries(_) => GpuiExecResult::Ready(Err(VdpError::internal("command should not reach GPUI thread"))),
    }
}

// ---------------------------------------------------------------------------
// VdpHub: sessions, event ring buffer, live broadcast, JSON-RPC routing
// ---------------------------------------------------------------------------

struct EventRing {
    next_id: u64,
    entries: VecDeque<VdpBufferedEvent>,
}

impl EventRing {
    fn new() -> Self {
        Self {
            next_id: 0,
            entries: VecDeque::with_capacity(EVENT_RING_CAPACITY),
        }
    }

    fn push(&mut self, event: VdpEvent) -> VdpBufferedEvent {
        self.next_id += 1;
        let buffered = VdpBufferedEvent { id: self.next_id, event };
        if self.entries.len() >= EVENT_RING_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(buffered.clone());
        buffered
    }

    fn read_since(&self, since_id: u64, limit: usize) -> VdpLogEntriesResult {
        let entries = self.entries.iter().filter(|e| e.id > since_id).take(limit).cloned().collect();
        VdpLogEntriesResult {
            entries,
            latest_id: self.next_id,
        }
    }
}

pub(crate) struct VdpHub {
    endpoint: VdpEndpointInfo,
    dispatcher: Arc<dyn VdpDispatcher>,
    events_tx: broadcast::Sender<VdpEvent>,
    event_ring: Mutex<EventRing>,
    sessions: Mutex<HashMap<String, String>>,
    next_session_seq: AtomicU64,
    log_enabled: AtomicBool,
    sync_global_log_flag: bool,
}

impl VdpHub {
    pub(crate) fn new(endpoint: VdpEndpointInfo, dispatcher: Arc<dyn VdpDispatcher>, sync_global_log_flag: bool) -> Self {
        let (events_tx, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        Self {
            endpoint,
            dispatcher,
            events_tx,
            event_ring: Mutex::new(EventRing::new()),
            sessions: Mutex::new(HashMap::new()),
            next_session_seq: AtomicU64::new(1),
            log_enabled: AtomicBool::new(false),
            sync_global_log_flag,
        }
    }

    pub(crate) fn endpoint_info(&self) -> &VdpEndpointInfo {
        &self.endpoint
    }

    pub(crate) fn version_info(&self) -> VdpVersionInfo {
        self.endpoint.version_info()
    }

    pub(crate) fn emit(&self, notification: VdpNotification) {
        let event = VdpEvent::from_notification(&notification, None);
        self.event_ring.lock().push(event.clone());
        let _ = self.events_tx.send(event);
    }

    fn attached_target_ids(&self) -> HashSet<String> {
        self.sessions.lock().values().cloned().collect()
    }

    fn cleanup_sessions(&self, ids: &[String]) {
        let mut guard = self.sessions.lock();
        for id in ids {
            guard.remove(id);
        }
    }

    pub(crate) async fn list_targets(&self) -> Result<Vec<VdpTarget>, VdpError> {
        let attached = self.attached_target_ids();
        self.dispatcher.list_targets(attached).await
    }

    pub(crate) async fn handle_request(&self, req: VdpRequest, owned_sessions: Option<&Mutex<Vec<String>>>) -> VdpResponse {
        let req_id = req.id;
        let session_id = req.session_id.clone();
        let command = match req.decode_command() {
            Ok(cmd) => cmd,
            Err(err) => return VdpResponse::err(req_id, err, session_id),
        };

        let result = match command {
            VdpCommand::TargetList => self
                .list_targets()
                .await
                .and_then(|targets| serde_json::to_value(VdpTargetListResult { targets }).map_err(|e| VdpError::internal(e.to_string()))),
            VdpCommand::TargetAttach(params) => match self.list_targets().await {
                Ok(targets) => {
                    if let Some(mut target) = targets.into_iter().find(|t| t.id == params.target_id) {
                        let seq = self.next_session_seq.fetch_add(1, Ordering::Relaxed);
                        let sid = format!("vdp-sess-{seq}");
                        self.sessions.lock().insert(sid.clone(), target.id.clone());
                        if let Some(owned) = owned_sessions {
                            owned.lock().push(sid.clone());
                        }
                        target.attached = true;
                        serde_json::to_value(VdpTargetAttachResult { session_id: sid, target }).map_err(|e| VdpError::internal(e.to_string()))
                    } else {
                        Err(VdpError::invalid_params(format!("target {:?} not found", params.target_id)))
                    }
                }
                Err(err) => Err(err),
            },
            VdpCommand::TargetDetach(params) => {
                let removed = self.sessions.lock().remove(&params.session_id).is_some();
                if let Some(owned) = owned_sessions {
                    owned.lock().retain(|s| s != &params.session_id);
                }
                serde_json::to_value(VdpAckResult { ok: removed }).map_err(|e| VdpError::internal(e.to_string()))
            }
            VdpCommand::LogEnable => {
                self.log_enabled.store(true, Ordering::Release);
                if self.sync_global_log_flag {
                    super::set_vdp_log_active(true);
                }
                self.dispatcher.set_ui_log_enabled(true).await;
                serde_json::to_value(VdpAckResult { ok: true }).map_err(|e| VdpError::internal(e.to_string()))
            }
            VdpCommand::LogDisable => {
                self.log_enabled.store(false, Ordering::Release);
                if self.sync_global_log_flag {
                    super::set_vdp_log_active(false);
                }
                self.dispatcher.set_ui_log_enabled(false).await;
                serde_json::to_value(VdpAckResult { ok: true }).map_err(|e| VdpError::internal(e.to_string()))
            }
            VdpCommand::LogGetEntries(params) => {
                let since_id = params.since_id.unwrap_or(0);
                let limit = params.limit.unwrap_or(100).clamp(1, EVENT_RING_CAPACITY as u32) as usize;
                let res = self.event_ring.lock().read_since(since_id, limit);
                serde_json::to_value(res).map_err(|e| VdpError::internal(e.to_string()))
            }
            other => {
                let attached_target = session_id.as_deref().and_then(|sid| self.sessions.lock().get(sid).cloned());
                self.dispatcher.dispatch(other, attached_target).await
            }
        };

        match result {
            Ok(val) => VdpResponse::ok(req_id, val, session_id),
            Err(err) => VdpResponse::err(req_id, err, session_id),
        }
    }
}

// ---------------------------------------------------------------------------
// Axum HTTP + WebSocket loopback server & typed auth extractor
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ServerState {
    hub: Arc<VdpHub>,
    shutdown: CancellationToken,
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq as _;
    a.ct_eq(b).into()
}

fn bearer_from_headers(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    if raw.len() > 7 && raw[..7].eq_ignore_ascii_case("bearer ") {
        let tok = raw[7..].trim();
        (!tok.is_empty()).then_some(tok)
    } else {
        None
    }
}

struct VdpAuth;

impl FromRequestParts<ServerState> for VdpAuth {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &ServerState) -> Result<Self, Self::Rejection> {
        let expected = state.hub.endpoint_info().token.as_bytes();
        let header_ok = bearer_from_headers(&parts.headers).is_some_and(|tok| constant_time_eq(tok.as_bytes(), expected));
        let query_ok = if header_ok {
            true
        } else {
            Query::<TokenQuery>::try_from_uri(&parts.uri)
                .ok()
                .and_then(|q| q.0.token)
                .is_some_and(|tok| constant_time_eq(tok.as_bytes(), expected))
        };
        if header_ok || query_ok {
            Ok(VdpAuth)
        } else {
            let body = Json(json!({
                "error": VdpError::unauthorized("unauthorized: valid VDP bearer or query token required")
            }));
            Err((StatusCode::UNAUTHORIZED, body).into_response())
        }
    }
}

async fn handle_version(_auth: VdpAuth, State(state): State<ServerState>) -> Json<VdpVersionInfo> {
    Json(state.hub.version_info())
}

async fn handle_list(_auth: VdpAuth, State(state): State<ServerState>) -> Response {
    match state.hub.list_targets().await {
        Ok(targets) => Json(targets).into_response(),
        Err(err) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": err }))).into_response(),
    }
}

async fn handle_ws(_auth: VdpAuth, ws: WebSocketUpgrade, State(state): State<ServerState>) -> Response {
    ws.on_upgrade(move |socket| serve_ws_connection(socket, state.hub, state.shutdown))
}

async fn serve_ws_connection(socket: WebSocket, hub: Arc<VdpHub>, shutdown: CancellationToken) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsMessage>();
    let mut events_rx = hub.events_tx.subscribe();
    let owned_sessions = Arc::new(Mutex::new(Vec::<String>::new()));

    let writer_shutdown = shutdown.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = writer_shutdown.cancelled() => {
                    let _ = ws_tx.send(WsMessage::Close(None)).await;
                    break;
                }
                msg = out_rx.recv() => {
                    let Some(msg) = msg else { break; };
                    if ws_tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let req = match serde_json::from_str::<VdpRequest>(&text) {
                            Ok(req) => req,
                            Err(err) => {
                                let resp = VdpResponse::err(0, VdpError::parse_error(format!("invalid VDP JSON-RPC request: {err}")), None);
                                if let Ok(wire) = serde_json::to_string(&resp) {
                                    let _ = out_tx.send(WsMessage::Text(wire.into()));
                                }
                                continue;
                            }
                        };
                        let hub = hub.clone();
                        let out = out_tx.clone();
                        let owned = owned_sessions.clone();
                        tokio::spawn(async move {
                            let resp = hub.handle_request(req, Some(&owned)).await;
                            if let Ok(wire) = serde_json::to_string(&resp) {
                                let _ = out.send(WsMessage::Text(wire.into()));
                            }
                        });
                    }
                    Some(Ok(WsMessage::Ping(payload))) => {
                        let _ = out_tx.send(WsMessage::Pong(payload));
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(WsMessage::Binary(_) | WsMessage::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            ev = events_rx.recv() => {
                match ev {
                    Ok(event) => {
                        let always_forward = matches!(event.method.as_str(), "Target.created" | "Target.destroyed");
                        if (always_forward || hub.log_enabled.load(Ordering::Relaxed))
                            && let Ok(wire) = serde_json::to_string(&event)
                        {
                            let _ = out_tx.send(WsMessage::Text(wire.into()));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    let cleanup: Vec<String> = std::mem::take(&mut *owned_sessions.lock());
    hub.cleanup_sessions(&cleanup);
    drop(out_tx);
    let _ = writer.await;
}

/// Running loopback VDP HTTP + WebSocket server bound strictly to `127.0.0.1:<port>`.
pub struct VdpServer {
    hub: Arc<VdpHub>,
    cancel: CancellationToken,
    _cancel_guard: DropGuard,
    _endpoint_guard: DebugEndpointGuard,
}

impl VdpServer {
    /// Starts the loopback VDP server on `127.0.0.1:<port>` (pass `0` for an OS ephemeral port)
    /// and writes `<home>/debug.json` atomically with `0600` permissions.
    pub(crate) fn start(port: u16, home: PathBuf, channel: String, app_version: String, dispatcher: Arc<dyn VdpDispatcher>) -> Result<Self, String> {
        Self::start_inner(port, home, channel, app_version, dispatcher, true)
    }

    #[cfg(test)]
    pub(crate) fn start_for_test(port: u16, home: PathBuf, dispatcher: Arc<dyn VdpDispatcher>) -> Result<Self, String> {
        Self::start_inner(port, home, "dev".into(), "0.0.0-test".into(), dispatcher, false)
    }

    fn start_inner(
        port: u16,
        home: PathBuf,
        channel: String,
        app_version: String,
        dispatcher: Arc<dyn VdpDispatcher>,
        sync_global_log_flag: bool,
    ) -> Result<Self, String> {
        let std_listener =
            std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).map_err(|e| format!("failed to bind VDP loopback port {port}: {e}"))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("failed to set VDP listener nonblocking: {e}"))?;
        let bound_port = std_listener.local_addr().map_err(|e| format!("failed to read VDP local_addr: {e}"))?.port();

        let token = crate::host::random_seed_hex();
        let endpoint = VdpEndpointInfo {
            protocol_version: VDP_PROTOCOL_VERSION.to_string(),
            pid: std::process::id(),
            channel,
            app_version,
            home: home.to_string_lossy().into_owned(),
            port: bound_port,
            http_url: format!("http://127.0.0.1:{bound_port}"),
            ws_url: format!("ws://127.0.0.1:{bound_port}/devtools"),
            token,
            started_at: now_millis(),
        };

        let endpoint_guard = write_debug_endpoint(&home, &endpoint).map_err(|e| format!("failed to write debug.json: {e}"))?;

        let hub = Arc::new(VdpHub::new(endpoint, dispatcher, sync_global_log_flag));
        let cancel = CancellationToken::new();
        let cancel_guard = cancel.clone().drop_guard();
        let loop_cancel = cancel.clone();

        let router = Router::new()
            .route("/json/version", get(handle_version))
            .route("/json/list", get(handle_list))
            .route("/devtools", get(handle_ws))
            .with_state(ServerState {
                hub: hub.clone(),
                shutdown: cancel.clone(),
            });

        let handle = vibevalley_rt::current_or_global_handle();
        let _entered = handle.enter();
        let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| format!("failed to adopt tokio TcpListener: {e}"))?;
        handle.spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(loop_cancel.cancelled_owned()).await;
        });

        Ok(Self {
            hub,
            cancel,
            _cancel_guard: cancel_guard,
            _endpoint_guard: endpoint_guard,
        })
    }

    pub(crate) fn hub(&self) -> Arc<VdpHub> {
        self.hub.clone()
    }

    pub fn endpoint_info(&self) -> &VdpEndpointInfo {
        self.hub.endpoint_info()
    }

    /// Cancels the Axum server and drops the `debug.json` guard.
    pub fn shutdown(self) {
        self.cancel.cancel();
    }
}
