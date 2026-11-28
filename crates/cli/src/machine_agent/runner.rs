use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{
    MachineHello, MachineHelloAck, MachineInventory, MachinePong, MachineRuntimeSummary, MachineSessionAck, MachineSessionAttach, MachineSessionInput,
    MachineSessionOpen, MachineSessionOpened, MachineSessionRespond, MachineWireError, MachineWireFrame,
};
use vibevalley_runtime::oar::{McpServer, PermissionMode, RefusableOption, Registry, SessionOptions};

use super::auth::{MachineAgentConfig, detect_platform, machine_ws_url};
use super::mcp_proxy::{LocalMcpProxy, PendingMcpMap, resolve_mcp_response};
use super::runtime_probe::probe_runtime_summaries_async;
use super::session::ManagedSession;
use super::transport::TransportSlot;
use crate::{Failure, exit};

fn sanitize_segment(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("identifier must not be empty".into());
    }
    let clean: String = trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    if clean == "." || clean == ".." || clean.chars().all(|c| c == '.') {
        return Err(format!("invalid path identifier `{raw}`"));
    }
    Ok(clean)
}

fn canonicalize_within(base: &Path, target: &Path) -> Result<PathBuf, String> {
    let base_canon = fs::canonicalize(base).map_err(|e| format!("failed to resolve base {}: {e}", base.display()))?;
    let target_canon = fs::canonicalize(target).map_err(|e| format!("failed to resolve path {}: {e}", target.display()))?;
    if target_canon == base_canon || !target_canon.starts_with(&base_canon) {
        return Err(format!(
            "refusing to operate on `{}`: path must be strictly inside `{}`",
            target.display(),
            base_canon.display()
        ));
    }
    Ok(target_canon)
}

fn prepare_session_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    let slug = sanitize_segment(session_id)?;
    let base = root.join("sessions");
    fs::create_dir_all(&base).map_err(|e| format!("failed to create sessions dir {}: {e}", base.display()))?;
    let target = base.join(slug);
    fs::create_dir_all(&target).map_err(|e| format!("failed to create session dir {}: {e}", target.display()))?;
    canonicalize_within(&base, &target)
}

/// Resolves the session working directory: starts in `explicit` when provided and valid on this host,
/// otherwise creates a neutral isolated directory under `<root>/sessions/<session_id>` (returns `(path, created_neutral)`).
fn resolve_session_workdir(root: &Path, session_id: &str, explicit: Option<&str>) -> Result<(PathBuf, bool), String> {
    if let Some(dir) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = PathBuf::from(dir);
        if candidate.is_absolute() {
            if candidate.is_dir() {
                return Ok((candidate, false));
            }
            // A control-plane host path (e.g. macOS `/Users/...`) may not exist on a remote Linux/container worker;
            // fall back to a dedicated neutral directory under `--workdir` instead of failing open.
        } else {
            if candidate
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
            {
                return Err(format!("relative workdir `{dir}` must not traverse outside --workdir"));
            }
            let joined = root.join(candidate);
            fs::create_dir_all(&joined).map_err(|e| format!("failed to create workdir {}: {e}", joined.display()))?;
            return Ok((canonicalize_within(root, &joined)?, false));
        }
    }
    let neutral = prepare_session_dir(root, session_id)?;
    Ok((neutral, true))
}

/// Execution-host daemon connecting outbound to `/api/v1/machine/ws` and serving local OAR runtimes.
pub struct MachineAgent {
    config: MachineAgentConfig,
    registry: Arc<Registry>,
    runtimes: Vec<MachineRuntimeSummary>,
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    transport: Arc<TransportSlot>,
    pending_mcp: Arc<PendingMcpMap>,
    cancel: CancellationToken,
}

impl MachineAgent {
    pub async fn new_async(config: MachineAgentConfig, registry: Arc<Registry>, cancel: CancellationToken) -> Self {
        let runtimes = probe_runtime_summaries_async(&registry).await;
        Self {
            config,
            registry,
            runtimes,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            transport: Arc::new(TransportSlot::new()),
            pending_mcp: Arc::new(Mutex::new(HashMap::new())),
            cancel,
        }
    }

    pub fn runtime_summaries(&self) -> &[MachineRuntimeSummary] {
        &self.runtimes
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Runs the outbound WebSocket connection loop with bounded exponential backoff (`1s..=16s`),
    /// preserving active local OAR sessions across transient disconnects until cancelled or `--once` completes.
    pub async fn run(&self) -> Result<(), Failure> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ws_url = machine_ws_url(&self.config.server_url)?;
        let mut delay = self.config.reconnect_base_delay;
        let max_delay = self.config.reconnect_max_delay.max(delay);

        loop {
            if self.cancel.is_cancelled() {
                break;
            }

            let mut request = ws_url
                .as_str()
                .into_client_request()
                .map_err(|e| Failure::usage("InvalidValue", format!("invalid WebSocket URL {ws_url:?}: {e}")))?;
            if !self.config.token.is_empty() {
                let header_value = format!("Bearer {}", self.config.token.expose())
                    .parse()
                    .map_err(|_| Failure::usage("InvalidValue", "token contains invalid HTTP header characters"))?;
                request.headers_mut().insert("Authorization", header_value);
            }
            request
                .headers_mut()
                .insert("X-VibeValley-Client", "machine".parse().expect("valid static header"));

            let connect_result = tokio::select! {
                biased;
                () = self.cancel.cancelled() => break,
                res = tokio_tungstenite::connect_async(request) => res,
            };

            match connect_result {
                Ok((ws_stream, _)) => {
                    let received_ack = self.drive_connection(ws_stream).await;
                    if received_ack {
                        delay = self.config.reconnect_base_delay;
                    }
                    if self.config.once || self.cancel.is_cancelled() {
                        break;
                    }
                }
                Err(WsError::Http(resp)) if matches!(resp.status().as_u16(), 401 | 403) => {
                    let status = resp.status().as_u16();
                    let tag = if status == 401 { "Unauthorized" } else { "Forbidden" };
                    self.shutdown();
                    return Err(Failure {
                        code: exit::REFUSED,
                        tag: tag.into(),
                        text: format!("machine WebSocket rejected with HTTP {status}"),
                        biz_code: None,
                        status: Some(status),
                        next: vec![],
                    });
                }
                Err(err) => {
                    if self.config.once {
                        self.shutdown();
                        return Err(Failure::new(exit::UNREACHABLE, "Unreachable", format!("failed to connect to {ws_url}: {err}")));
                    }
                }
            }

            tokio::select! {
                biased;
                () = self.cancel.cancelled() => break,
                () = tokio::time::sleep(delay) => {}
            }
            delay = (delay * 2).min(max_delay);
        }

        self.shutdown();
        Ok(())
    }

    /// Runs a single connected WebSocket lifecycle; returns `true` if `MachineHelloAck` was received.
    async fn drive_connection<S>(&self, ws_stream: tokio_tungstenite::WebSocketStream<S>) -> bool
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut ws_sink, mut ws_source) = ws_stream.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<MachineWireFrame>();
        let conn_id = self.transport.install(out_tx.clone());

        let hello = MachineWireFrame::MachineHello(MachineHello {
            machine_id: self.config.machine_id.clone(),
            name: self.config.name.clone(),
            platform: detect_platform(self.config.ephemeral),
            ephemeral: self.config.ephemeral,
            runtimes: self.runtimes.clone(),
        });
        let inventory = MachineWireFrame::MachineInventory(MachineInventory {
            machine_id: self.config.machine_id.clone(),
            runtimes: self.runtimes.clone(),
        });
        let _ = out_tx.send(hello);
        let _ = out_tx.send(inventory);

        let writer_cancel = self.cancel.child_token();
        let writer_stop = writer_cancel.clone();
        let writer_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    () = writer_stop.cancelled() => {
                        let _ = ws_sink.send(WsMessage::Close(None)).await;
                        let _ = ws_sink.flush().await;
                        break;
                    }
                    maybe_frame = out_rx.recv() => {
                        let Some(frame) = maybe_frame else { break };
                        let Ok(text) = serde_json::to_string(&frame) else { continue };
                        if ws_sink.send(WsMessage::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut received_ack = false;
        loop {
            let incoming = tokio::select! {
                biased;
                () = self.cancel.cancelled() => break,
                next = ws_source.next() => next,
            };
            let Some(msg_res) = incoming else {
                break;
            };
            let Ok(msg) = msg_res else {
                break;
            };
            match msg {
                WsMessage::Text(text) => match serde_json::from_str::<MachineWireFrame>(text.as_str()) {
                    Ok(frame) => {
                        if matches!(frame, MachineWireFrame::MachineHelloAck(_)) {
                            received_ack = true;
                        }
                        self.handle_frame(frame);
                    }
                    Err(err) => {
                        let _ = out_tx.send(MachineWireFrame::MachineWireError(MachineWireError {
                            request_id: None,
                            code: "invalid_frame".into(),
                            message: format!("failed to decode MachineWireFrame: {err}"),
                        }));
                    }
                },
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) | WsMessage::Frame(_) => {}
                WsMessage::Close(_) => break,
            }
        }

        self.transport.clear_if(conn_id);
        writer_cancel.cancel();
        let _ = writer_task.await;
        received_ack
    }

    fn handle_frame(&self, frame: MachineWireFrame) {
        match frame {
            MachineWireFrame::MachineHelloAck(MachineHelloAck { .. }) => {}
            MachineWireFrame::MachinePing(ping) => {
                self.transport.send(MachineWireFrame::MachinePong(MachinePong { ts: ping.ts }));
            }
            MachineWireFrame::MachineSessionOpen(req) => {
                self.handle_session_open(req);
            }
            MachineWireFrame::MachineSessionInput(req) => {
                self.handle_session_input(req);
            }
            MachineWireFrame::MachineSessionRespond(req) => {
                self.handle_session_respond(req);
            }
            MachineWireFrame::MachineSessionAttach(req) => {
                self.handle_session_attach(req);
            }
            MachineWireFrame::MachineMcpResponse(resp) => {
                let _ = resolve_mcp_response(&self.pending_mcp, resp);
            }
            MachineWireFrame::MachineHello(_)
            | MachineWireFrame::MachineInventory(_)
            | MachineWireFrame::MachinePong(_)
            | MachineWireFrame::MachineSessionOpened(_)
            | MachineWireFrame::MachineSessionAck(_)
            | MachineWireFrame::MachineSessionEvent(_)
            | MachineWireFrame::MachineSessionRecord(_)
            | MachineWireFrame::MachineMcpRequest(_)
            | MachineWireFrame::MachineAttachmentFetch(_)
            | MachineWireFrame::MachineAttachmentData(_)
            | MachineWireFrame::MachineWireError(_) => {}
        }
    }

    fn handle_session_open(&self, req: MachineSessionOpen) {
        if let Some(existing) = self.sessions.lock().get(&req.session_id).cloned() {
            self.transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                request_id: req.request_id,
                session_id: req.session_id,
                ok: true,
                workdir: Some(existing.workdir.display().to_string()),
                error: None,
            }));
            return;
        }

        let Some(runtime) = self.registry.get(&req.runtime_id) else {
            self.transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                request_id: req.request_id,
                session_id: req.session_id,
                ok: false,
                workdir: None,
                error: Some(format!("runtime `{}` is not available on machine `{}`", req.runtime_id, self.config.machine_id)),
            }));
            return;
        };

        let workdir_root = self.config.workdir.clone();
        let sessions = self.sessions.clone();
        let transport = self.transport.clone();
        let pending_mcp = self.pending_mcp.clone();
        let cancel = self.cancel.clone();
        let ephemeral = self.config.ephemeral;

        // Spawn off the WS read loop so `MachineMcpResponse` and `MachinePing` keep flowing
        // even when a runtime performs an MCP `initialize` handshake during `runtime.open(...)`.
        tokio::spawn(async move {
            let session_id_for_dir = req.session_id.clone();
            let explicit_workdir = req.workdir.clone();

            let prepared = tokio::task::spawn_blocking(move || resolve_session_workdir(&workdir_root, &session_id_for_dir, explicit_workdir.as_deref())).await;

            let (workdir, created_neutral) = match prepared {
                Ok(Ok(pair)) => pair,
                Ok(Err(err)) => {
                    transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                        request_id: req.request_id,
                        session_id: req.session_id,
                        ok: false,
                        workdir: None,
                        error: Some(err),
                    }));
                    return;
                }
                Err(join_err) => {
                    transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                        request_id: req.request_id,
                        session_id: req.session_id,
                        ok: false,
                        workdir: None,
                        error: Some(format!("workdir task panicked: {join_err}")),
                    }));
                    return;
                }
            };
            let ephemeral_dir = (ephemeral && created_neutral).then(|| workdir.clone());

            if cancel.is_cancelled() {
                if let Some(dir) = &ephemeral_dir {
                    let _ = fs::remove_dir_all(dir);
                }
                return;
            }

            let proxy = match LocalMcpProxy::start(
                req.session_id.clone(),
                req.mcp_session_token.clone().unwrap_or_default(),
                transport.clone(),
                pending_mcp,
                cancel.clone(),
            )
            .await
            {
                Ok(proxy) => proxy,
                Err(err) => {
                    if let Some(dir) = &ephemeral_dir {
                        let _ = fs::remove_dir_all(dir);
                    }
                    transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                        request_id: req.request_id,
                        session_id: req.session_id,
                        ok: false,
                        workdir: None,
                        error: Some(err),
                    }));
                    return;
                }
            };

            let mut headers = Vec::new();
            if let Some(tok) = req.mcp_session_token.as_deref().filter(|t| !t.is_empty()) {
                headers.push(("authorization".to_string(), format!("Bearer {tok}")));
            }
            let mcp_server = McpServer::Http {
                name: "vibevalley".into(),
                url: proxy.url().to_string(),
                headers,
            };

            let refused = runtime.refused_options();
            let mut opts = SessionOptions {
                cwd: workdir.clone(),
                model: req.model.clone().filter(|s| !s.trim().is_empty()),
                permission_mode: PermissionMode::Bypass,
                env: req.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                mcp_servers: vec![mcp_server],
                ..Default::default()
            };
            if let Some(prompt) = req.system_prompt.clone().filter(|s| !s.trim().is_empty()) {
                if !refused.contains(&RefusableOption::SystemPrompt) {
                    opts.system_prompt = Some(prompt);
                } else if !refused.contains(&RefusableOption::AppendSystemPrompt) {
                    opts.append_system_prompt = Some(prompt);
                }
            }
            if let Some(effort) = req.effort.clone().filter(|s| !s.trim().is_empty())
                && !refused.contains(&RefusableOption::Effort)
            {
                opts.effort = Some(effort);
            }

            let oar_session = match runtime.open(opts).await {
                Ok(session) => session,
                Err(err) => {
                    proxy.shutdown();
                    if let Some(dir) = &ephemeral_dir {
                        let _ = fs::remove_dir_all(dir);
                    }
                    transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                        request_id: req.request_id,
                        session_id: req.session_id,
                        ok: false,
                        workdir: None,
                        error: Some(err.to_string()),
                    }));
                    return;
                }
            };

            if cancel.is_cancelled() {
                proxy.shutdown();
                oar_session.dispose().await;
                if let Some(dir) = &ephemeral_dir {
                    let _ = fs::remove_dir_all(dir);
                }
                return;
            }

            let mut events_rx = oar_session.events_with_history();
            let managed = Arc::new(ManagedSession::new(
                req.session_id.clone(),
                workdir.clone(),
                ephemeral_dir,
                oar_session,
                Some(proxy),
            ));
            sessions.lock().insert(req.session_id.clone(), managed.clone());

            // Emit `MachineSessionOpened` BEFORE spawning the event pump so the server always sees Opened before seq=1.
            transport.send(MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                request_id: req.request_id,
                session_id: req.session_id,
                ok: true,
                workdir: Some(workdir.display().to_string()),
                error: None,
            }));

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => break,
                        event = events_rx.recv() => {
                            let Some(ev) = event else { break };
                            let wire = managed.record_and_forward(&ev, &transport);
                            if wire.terminal {
                                break;
                            }
                        }
                    }
                }
            });
        });
    }

    fn handle_session_input(&self, req: MachineSessionInput) {
        let Some(managed) = self.sessions.lock().get(&req.session_id).cloned() else {
            self.transport.send(MachineWireFrame::MachineSessionAck(MachineSessionAck {
                request_id: req.request_id,
                session_id: req.session_id.clone(),
                input_id: req.input_id,
                ok: false,
                error: Some(format!("session `{}` not found on machine", req.session_id)),
            }));
            return;
        };

        let transport = self.transport.clone();
        tokio::spawn(async move {
            let ack = managed.handle_input(&req).await;
            transport.send(MachineWireFrame::MachineSessionAck(ack));
        });
    }

    fn handle_session_respond(&self, req: MachineSessionRespond) {
        let Some(managed) = self.sessions.lock().get(&req.session_id).cloned() else {
            self.transport.send(MachineWireFrame::MachineSessionAck(MachineSessionAck {
                request_id: req.request_id,
                session_id: req.session_id.clone(),
                input_id: req.target_id,
                ok: false,
                error: Some(format!("session `{}` not found on machine", req.session_id)),
            }));
            return;
        };

        let transport = self.transport.clone();
        tokio::spawn(async move {
            let ack = managed.handle_respond(&req).await;
            transport.send(MachineWireFrame::MachineSessionAck(ack));
        });
    }

    fn handle_session_attach(&self, req: MachineSessionAttach) {
        let Some(managed) = self.sessions.lock().get(&req.session_id).cloned() else {
            self.transport.send(MachineWireFrame::MachineWireError(MachineWireError {
                request_id: Some(req.request_id),
                code: "session_not_found".into(),
                message: format!("session `{}` not found on machine", req.session_id),
            }));
            return;
        };
        managed.attach_and_replay(req.after_seq, &self.transport);
    }

    /// Gracefully disposes active sessions, shuts down local MCP proxies, and removes ephemeral session workspaces.
    pub fn shutdown(&self) {
        self.cancel.cancel();
        let active: Vec<Arc<ManagedSession>> = self.sessions.lock().values().cloned().collect();
        for session in active {
            session.dispose();
        }
        self.pending_mcp.lock().clear();
    }
}
