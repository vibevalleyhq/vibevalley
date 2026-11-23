//! Ephemeral loopback HTTP proxy (`127.0.0.1:0/mcp`) that tunnels child coding-agent
//! `POST /mcp` JSON-RPC calls over the active machine WebSocket (`MachineMcpRequest` / `MachineMcpResponse`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use vibevalley_protocol::{MachineMcpRequest, MachineMcpResponse, MachineWireFrame};

use super::TransportSlot;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MCP_TIMEOUT: Duration = Duration::from_secs(60);

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

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    () = loop_cancel.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let session_id = session_id.clone();
                        let default_token = default_session_token.clone();
                        let transport = transport.clone();
                        let pending = pending.clone();
                        let conn_cancel = loop_cancel.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, session_id, default_token, transport, pending, conn_cancel).await;
                        });
                    }
                }
            }
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

struct ParsedHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<ParsedHttpRequest, (u16, &'static str)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|_| (400, "Bad Request"))?;
        if n == 0 {
            return Err((400, "Bad Request"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err((431, "Request Header Fields Too Large"));
        }
    };

    let head = std::str::from_utf8(&buf[..header_end - 4]).map_err(|_| (400, "Bad Request"))?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or((400, "Bad Request"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or((400, "Bad Request"))?.to_string();
    let path = parts.next().ok_or((400, "Bad Request"))?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let is_chunked = headers.get("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));

    let mut raw_body = buf[header_end..].to_vec();
    let body_bytes = if is_chunked {
        read_chunked_body(stream, raw_body).await?
    } else {
        let content_length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        if content_length > MAX_BODY_BYTES {
            return Err((413, "Payload Too Large"));
        }
        while raw_body.len() < content_length {
            let n = stream.read(&mut chunk).await.map_err(|_| (400, "Bad Request"))?;
            if n == 0 {
                break;
            }
            raw_body.extend_from_slice(&chunk[..n]);
        }
        raw_body.truncate(content_length);
        raw_body
    };

    let body = String::from_utf8(body_bytes).map_err(|_| (400, "Bad Request"))?;
    Ok(ParsedHttpRequest { method, path, headers, body })
}

async fn read_chunked_body(stream: &mut TcpStream, mut pending: Vec<u8>) -> Result<Vec<u8>, (u16, &'static str)> {
    let mut decoded = Vec::new();
    let mut tmp = [0u8; 4096];
    let mut cursor = 0usize;

    loop {
        while pending[cursor..].windows(2).position(|w| w == b"\r\n").is_none() {
            let n = stream.read(&mut tmp).await.map_err(|_| (400, "Bad Request"))?;
            if n == 0 {
                return Err((400, "Bad Request"));
            }
            pending.extend_from_slice(&tmp[..n]);
            if pending.len() > MAX_BODY_BYTES {
                return Err((413, "Payload Too Large"));
            }
        }
        let line_rel = pending[cursor..].windows(2).position(|w| w == b"\r\n").ok_or((400, "Bad Request"))?;
        let size_line = std::str::from_utf8(&pending[cursor..cursor + line_rel]).map_err(|_| (400, "Bad Request"))?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| (400, "Bad Request"))?;
        cursor += line_rel + 2;
        if size == 0 {
            break;
        }
        if decoded.len() + size > MAX_BODY_BYTES {
            return Err((413, "Payload Too Large"));
        }
        while pending.len() < cursor + size + 2 {
            let n = stream.read(&mut tmp).await.map_err(|_| (400, "Bad Request"))?;
            if n == 0 {
                return Err((400, "Bad Request"));
            }
            pending.extend_from_slice(&tmp[..n]);
        }
        decoded.extend_from_slice(&pending[cursor..cursor + size]);
        cursor += size + 2;
    }

    Ok(decoded)
}

fn bearer_from_headers(headers: &HashMap<String, String>) -> Option<String> {
    let raw = headers.get("authorization")?.trim();
    if raw.len() >= 7 && raw[..7].eq_ignore_ascii_case("bearer ") {
        let tok = raw[7..].trim();
        if !tok.is_empty() {
            return Some(tok.to_string());
        }
    }
    None
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

async fn write_http_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let ct = if content_type.trim().is_empty() {
        "application/json; charset=utf-8"
    } else {
        content_type
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason_phrase(status),
        ct,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    if !body.is_empty() {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.flush().await;
}

async fn handle_connection(
    mut stream: TcpStream,
    session_id: String,
    default_token: String,
    transport: Arc<TransportSlot>,
    pending: Arc<PendingMcpMap>,
    cancel: CancellationToken,
) {
    let req = match read_http_request(&mut stream).await {
        Ok(req) => req,
        Err((status, msg)) => {
            write_http_response(&mut stream, status, "text/plain; charset=utf-8", msg.as_bytes()).await;
            return;
        }
    };

    let path_only = req.path.split('?').next().unwrap_or(req.path.as_str());
    if path_only != "/mcp" {
        write_http_response(&mut stream, 404, "text/plain; charset=utf-8", b"not found").await;
        return;
    }
    if !req.method.eq_ignore_ascii_case("POST") {
        write_http_response(&mut stream, 405, "text/plain; charset=utf-8", b"method not allowed").await;
        return;
    }

    let session_token = bearer_from_headers(&req.headers).unwrap_or(default_token);
    let request_id = Uuid::new_v4().to_string();
    let (resp_tx, resp_rx) = oneshot::channel();
    pending.lock().insert(request_id.clone(), resp_tx);

    let frame = MachineWireFrame::MachineMcpRequest(MachineMcpRequest {
        request_id: request_id.clone(),
        session_id,
        session_token,
        method: req.method,
        path: req.path,
        body: req.body,
    });

    if !transport.send(frame) {
        pending.lock().remove(&request_id);
        write_http_response(
            &mut stream,
            503,
            "application/json; charset=utf-8",
            br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"machine websocket disconnected"}}"#,
        )
        .await;
        return;
    }

    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            pending.lock().remove(&request_id);
            write_http_response(&mut stream, 503, "text/plain; charset=utf-8", b"proxy shutting down").await;
            return;
        }
        res = tokio::time::timeout(DEFAULT_MCP_TIMEOUT, resp_rx) => match res {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => {
                pending.lock().remove(&request_id);
                write_http_response(&mut stream, 502, "text/plain; charset=utf-8", b"upstream closed").await;
                return;
            }
            Err(_) => {
                pending.lock().remove(&request_id);
                write_http_response(&mut stream, 504, "text/plain; charset=utf-8", b"mcp tunnel timeout").await;
                return;
            }
        }
    };

    write_http_response(&mut stream, response.status, &response.content_type, response.body.as_bytes()).await;
}
