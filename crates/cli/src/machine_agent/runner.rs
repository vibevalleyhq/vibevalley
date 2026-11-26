use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{
    MachineHello, MachineHelloAck, MachineInventory, MachinePong, MachineRuntimeSummary, MachineSessionAck, MachineSessionAttach, MachineSessionInput,
    MachineSessionOpen, MachineSessionOpened, MachineSessionRespond, MachineWireError, MachineWireFrame, MachineWorktreeCleanup, MachineWorktreePrepare,
    MachineWorktreeResult,
};
use vibevalley_runtime::oar::{McpServer, PermissionMode, RefusableOption, Registry, SessionOptions};

use super::auth::{MachineAgentConfig, detect_platform, machine_ws_url};
use super::mcp_proxy::{LocalMcpProxy, PendingMcpMap, resolve_mcp_response};
use super::runtime_probe::probe_runtime_summaries_async;
use super::session::ManagedSession;
use super::transport::TransportSlot;
use super::worktree::WorktreeManager;
use crate::{Failure, exit};

/// Execution-host daemon connecting outbound to `/api/v1/machine/ws` and serving local OAR runtimes.
pub struct MachineAgent {
    config: MachineAgentConfig,
    registry: Arc<Registry>,
    runtimes: Vec<MachineRuntimeSummary>,
    worktrees: Arc<WorktreeManager>,
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    transport: Arc<TransportSlot>,
    pending_mcp: Arc<PendingMcpMap>,
    cancel: CancellationToken,
}

impl MachineAgent {
    pub async fn new_async(config: MachineAgentConfig, registry: Arc<Registry>, cancel: CancellationToken) -> Self {
        let runtimes = probe_runtime_summaries_async(&registry).await;
        let worktrees = Arc::new(WorktreeManager::new(config.workdir.clone()));
        Self {
            config,
            registry,
            runtimes,
            worktrees,
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
            worktree_supported: WorktreeManager::git_available(),
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
            MachineWireFrame::MachineWorktreePrepare(req) => {
                self.handle_worktree_prepare(req);
            }
            MachineWireFrame::MachineWorktreeCleanup(req) => {
                self.handle_worktree_cleanup(req);
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
            | MachineWireFrame::MachineWorktreeResult(_)
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

        let worktrees = self.worktrees.clone();
        let sessions = self.sessions.clone();
        let transport = self.transport.clone();
        let pending_mcp = self.pending_mcp.clone();
        let cancel = self.cancel.clone();
        let ephemeral = self.config.ephemeral;

        // Spawn off the WS read loop so `MachineMcpResponse` and `MachinePing` keep flowing
        // even when a runtime performs an MCP `initialize` handshake during `runtime.open(...)`.
        tokio::spawn(async move {
            let session_id_for_dir = req.session_id.clone();
            let repo_ref = req.repo_ref.clone();
            let branch = req.branch.clone();
            let base_ref = req.base_ref.clone();
            let explicit_workdir = req.workdir.clone();
            let worktrees_prep = worktrees.clone();

            let prepared = tokio::task::spawn_blocking(move || -> Result<(PathBuf, Option<PathBuf>), String> {
                if let Some(repo) = repo_ref.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    let wt = worktrees_prep.prepare_worktree(&session_id_for_dir, repo, branch.as_deref(), base_ref.as_deref())?;
                    return Ok((wt.workdir.clone(), Some(wt.workdir)));
                }
                if let Some(dir) = explicit_workdir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    match worktrees_prep.resolve_explicit_workdir(dir) {
                        Ok(resolved) => return Ok((resolved, None)),
                        // A control-plane host path (e.g. macOS `/Users/...`) may not exist on a remote Linux/container worker;
                        // fall back to a dedicated isolated directory under `--workdir` instead of failing open.
                        Err(_) if Path::new(dir).is_absolute() => {}
                        Err(err) => return Err(err),
                    }
                }
                let isolated = worktrees_prep.prepare_session_dir(&session_id_for_dir, ephemeral)?;
                Ok((isolated, None))
            })
            .await;

            let (workdir, owned_worktree) = match prepared {
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

            if cancel.is_cancelled() {
                if ephemeral && let Some(wt) = &owned_worktree {
                    let _ = worktrees.cleanup_worktree(wt);
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
                    if ephemeral && let Some(wt) = &owned_worktree {
                        let _ = worktrees.cleanup_worktree(wt);
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
                    if ephemeral && let Some(wt) = &owned_worktree {
                        let _ = worktrees.cleanup_worktree(wt);
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
                if ephemeral && let Some(wt) = &owned_worktree {
                    let _ = worktrees.cleanup_worktree(wt);
                }
                return;
            }

            let mut events_rx = oar_session.events_with_history();
            let managed = Arc::new(ManagedSession::new(
                req.session_id.clone(),
                workdir.clone(),
                owned_worktree,
                ephemeral,
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

        let worktrees = self.worktrees.clone();
        let transport = self.transport.clone();
        tokio::spawn(async move {
            let ack = managed.handle_input(&req, &worktrees).await;
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

    fn handle_worktree_prepare(&self, req: MachineWorktreePrepare) {
        let worktrees = self.worktrees.clone();
        let transport = self.transport.clone();
        tokio::spawn(async move {
            let request_id = req.request_id.clone();
            let res =
                tokio::task::spawn_blocking(move || worktrees.prepare_worktree(&req.task_id, &req.repo_ref, req.branch.as_deref(), req.base_ref.as_deref()))
                    .await;

            let frame = match res {
                Ok(Ok(wt)) => MachineWorktreeResult {
                    request_id,
                    ok: true,
                    workdir: Some(wt.workdir.display().to_string()),
                    branch: Some(wt.branch),
                    error: None,
                },
                Ok(Err(err)) => MachineWorktreeResult {
                    request_id,
                    ok: false,
                    workdir: None,
                    branch: None,
                    error: Some(err),
                },
                Err(join_err) => MachineWorktreeResult {
                    request_id,
                    ok: false,
                    workdir: None,
                    branch: None,
                    error: Some(format!("worktree prepare panicked: {join_err}")),
                },
            };
            transport.send(MachineWireFrame::MachineWorktreeResult(frame));
        });
    }

    fn handle_worktree_cleanup(&self, req: MachineWorktreeCleanup) {
        let worktrees = self.worktrees.clone();
        let transport = self.transport.clone();
        tokio::spawn(async move {
            let request_id = req.request_id.clone();
            let workdir_str = req.workdir.clone();
            let res = tokio::task::spawn_blocking(move || worktrees.cleanup_worktree(Path::new(&req.workdir))).await;
            let frame = match res {
                Ok(Ok(())) => MachineWorktreeResult {
                    request_id,
                    ok: true,
                    workdir: Some(workdir_str),
                    branch: None,
                    error: None,
                },
                Ok(Err(err)) => MachineWorktreeResult {
                    request_id,
                    ok: false,
                    workdir: Some(workdir_str),
                    branch: None,
                    error: Some(err),
                },
                Err(join_err) => MachineWorktreeResult {
                    request_id,
                    ok: false,
                    workdir: Some(workdir_str),
                    branch: None,
                    error: Some(format!("worktree cleanup panicked: {join_err}")),
                },
            };
            transport.send(MachineWireFrame::MachineWorktreeResult(frame));
        });
    }

    /// Gracefully disposes active sessions, shuts down local MCP proxies, and removes tracked ephemeral worktrees.
    pub fn shutdown(&self) {
        self.cancel.cancel();
        let active: Vec<Arc<ManagedSession>> = self.sessions.lock().values().cloned().collect();
        for session in active {
            session.dispose(&self.worktrees);
        }
        if self.config.ephemeral {
            self.worktrees.cleanup_all_tracked();
        }
        self.pending_mcp.lock().clear();
    }
}
