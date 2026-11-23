//! Ephemeral loopback HTTP proxy (`127.0.0.1:0/mcp`) that tunnels child coding-agent
//! `POST /mcp` JSON-RPC calls over the active machine WebSocket (`MachineMcpRequest` / `MachineMcpResponse`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use parking_lot::Mutex;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use vibevalley_protocol::{MachineMcpRequest, MachineMcpResponse, MachineWireFrame};

use super::TransportSlot;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MCP_TIMEOUT: Duration = Duration::from_secs(60);
const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const DISCONNECTED_JSONRPC_ERROR: &str = r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"machine websocket disconnected"}}"#;

pub type PendingMcpMap = Mutex<HashMap<String, oneshot::Sender<MachineMcpResponse>>>;

/// Resolves an in-flight proxied MCP request when `MachineWireFrame::MachineMcpResponse` arrives.
pub fn resolve_mcp_response(pending: &PendingMcpMap, response: MachineMcpResponse) -> bool {
    if let Some(tx) = pending.lock().remove(&response.request_id) {
        tx.send(response).is_ok()
    } else {
        false
    }
}

/// Loopback HTTP server bound on `127.0.0.1:0` dedicated to one remote OAR session's `/mcp` traffic.
pub struct LocalMcpProxy {
    url: String,
    cancel: CancellationToken,
}

impl LocalMcpProxy {
    pub async fn start(
        session_id: String,
        default_session_token: String,
        transport: Arc<TransportSlot>,
        pending: Arc<PendingMcpMap>,
        parent_cancel: CancellationToken,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind local MCP proxy: {e}"))?;
        let addr = listener.local_addr().map_err(|e| format!("failed to read local MCP proxy address: {e}"))?;
        let url = format!("http://{addr}/mcp");
        let cancel = parent_cancel.child_token();
        let loop_cancel = cancel.clone();

        let state = ProxyState {
            session_id,
            default_token: default_session_token,
            transport,
            pending,
            cancel: cancel.clone(),
        };
        let app = Router::new()
            .route("/mcp", post(handle_mcp))
            .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
            .with_state(state);

        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(loop_cancel.cancelled_owned()).await;
        });

        Ok(Self { url, cancel })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl Drop for LocalMcpProxy {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[derive(Clone)]
struct ProxyState {
    session_id: String,
    default_token: String,
    transport: Arc<TransportSlot>,
    pending: Arc<PendingMcpMap>,
    cancel: CancellationToken,
}

/// Removes an unresolved `request_id` from `PendingMcpMap` on error, timeout, cancel, or client disconnect.
struct PendingGuard {
    pending: Arc<PendingMcpMap>,
    request_id: String,
    armed: bool,
}

impl PendingGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if self.armed {
            self.pending.lock().remove(&self.request_id);
        }
    }
}

fn bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    if raw.get(..7)?.eq_ignore_ascii_case("bearer ") {
        let tok = raw[7..].trim();
        if !tok.is_empty() {
            return Some(tok.to_string());
        }
    }
    None
}

async fn handle_mcp(State(state): State<ProxyState>, uri: Uri, headers: HeaderMap, body: String) -> Response {
    let session_token = bearer_from_headers(&headers).unwrap_or_else(|| state.default_token.clone());
    let path = uri.path_and_query().map_or_else(|| uri.path().to_string(), |pq| pq.as_str().to_string());
    let request_id = Uuid::new_v4().to_string();
    let (resp_tx, resp_rx) = oneshot::channel();

    state.pending.lock().insert(request_id.clone(), resp_tx);
    let mut guard = PendingGuard {
        pending: state.pending.clone(),
        request_id: request_id.clone(),
        armed: true,
    };

    let frame = MachineWireFrame::MachineMcpRequest(MachineMcpRequest {
        request_id,
        session_id: state.session_id,
        session_token,
        method: "POST".to_string(),
        path,
        body,
    });

    if !state.transport.send(frame) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, HeaderValue::from_static(JSON_CONTENT_TYPE))],
            DISCONNECTED_JSONRPC_ERROR,
        )
            .into_response();
    }

    let response = tokio::select! {
        biased;
        () = state.cancel.cancelled() => {
            return (StatusCode::SERVICE_UNAVAILABLE, "proxy shutting down").into_response();
        }
        res = tokio::time::timeout(DEFAULT_MCP_TIMEOUT, resp_rx) => match res {
            Ok(Ok(resp)) => {
                guard.disarm();
                resp
            }
            Ok(Err(_)) => return (StatusCode::BAD_GATEWAY, "upstream closed").into_response(),
            Err(_) => return (StatusCode::GATEWAY_TIMEOUT, "mcp tunnel timeout").into_response(),
        }
    };

    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let ct = response.content_type.trim();
    let content_type = if ct.is_empty() {
        HeaderValue::from_static(JSON_CONTENT_TYPE)
    } else {
        HeaderValue::from_str(ct).unwrap_or_else(|_| HeaderValue::from_static(JSON_CONTENT_TYPE))
    };

    (status, [(header::CONTENT_TYPE, content_type)], response.body).into_response()
}
