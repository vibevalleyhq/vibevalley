//! Outbound WebSocket machine daemon (`vibevalley machine up`) managing local OAR runtimes,
//! disconnect-resilient sessions with `seq`-indexed ring buffers, idempotent inputs,
//! ephemeral local `/mcp` reverse proxying, and isolated git worktrees.

pub mod mcp_proxy;
pub mod session;
pub mod worktree;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tokio_util::sync::CancellationToken;
use url::Url;
use vibevalley_protocol::{
    MachineHello, MachineHelloAck, MachineInventory, MachinePlatform, MachinePong, MachineRuntimeSummary, MachineSessionAck, MachineSessionAttach,
    MachineSessionInput, MachineSessionOpen, MachineSessionOpened, MachineSessionRespond, MachineWireError, MachineWireFrame, MachineWorktreeCleanup,
    MachineWorktreePrepare, MachineWorktreeResult, ModelEntry, RuntimeCapability,
};
use vibevalley_runtime::oar::{self, McpServer, PermissionMode, RefusableOption, Registry, Runtime, SessionOptions};
pub use vibevalley_runtime::sandbox::Secret;

use self::mcp_proxy::{LocalMcpProxy, PendingMcpMap, resolve_mcp_response};
use self::session::ManagedSession;
use self::worktree::WorktreeManager;
use crate::{Failure, exit, load_secret_json, save_secret_json};

pub const MACHINE_AUTH_FILE: &str = "machine-auth.json";
const RECONNECT_MIN_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(16);
const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Persisted credentials for a non-ephemeral execution machine (`$VIBEVALLEY_HOME/machine-auth.json`, `0o600`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAuthConfig {
    pub server: String,
    pub token: Secret,
    pub machine_id: String,
    pub machine_name: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

pub fn machine_auth_path(home: &Path) -> PathBuf {
    home.join(MACHINE_AUTH_FILE)
}

/// Loads `$VIBEVALLEY_HOME/machine-auth.json`, returning `Ok(None)` when absent.
pub fn load_machine_auth(home: &Path) -> Result<Option<MachineAuthConfig>, Failure> {
    load_secret_json(&machine_auth_path(home), "machine credentials")
}

/// Persists `config` atomically to `$VIBEVALLEY_HOME/machine-auth.json` with `0o600` permissions on Unix.
pub fn save_machine_auth(home: &Path, config: &MachineAuthConfig) -> Result<PathBuf, Failure> {
    save_secret_json(home, MACHINE_AUTH_FILE, config, "machine credentials")
}

/// Converts a normalized `http://` or `https://` server base URL into `<ws(s)://server>/api/v1/machine/ws`.
pub fn machine_ws_url(server_url: &str) -> Result<String, Failure> {
    let parsed = Url::parse(server_url.trim()).map_err(|e| Failure::usage("InvalidValue", format!("invalid server URL {server_url:?}: {e}")))?;
    let ws_scheme = match parsed.scheme() {
        "http" => "ws",
        "https" => "wss",
        "ws" => "ws",
        "wss" => "wss",
        other => {
            return Err(Failure::usage(
                "InvalidValue",
                format!("unsupported server URL scheme {other:?} (expected http or https)"),
            ));
        }
    };
    let mut base = parsed;
    base.set_scheme(ws_scheme)
        .map_err(|()| Failure::usage("InvalidValue", format!("failed to construct WebSocket URL for {server_url:?}")))?;
    let trimmed = base.as_str().trim_end_matches('/');
    Ok(format!("{trimmed}/api/v1/machine/ws"))
}

/// Detects the wire `MachinePlatform` for this daemon process.
pub fn detect_platform(ephemeral: bool) -> MachinePlatform {
    let in_container = std::env::var("VIBEVALLEY_SANDBOX").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        || Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists();
    if ephemeral || in_container {
        MachinePlatform::Container
    } else if cfg!(target_os = "macos") {
        MachinePlatform::Macos
    } else if cfg!(target_os = "linux") {
        MachinePlatform::Linux
    } else {
        MachinePlatform::Other
    }
}

/// Builds the local OAR `Registry` according to `--runtime` filters and `--scripted`.
pub fn build_runtime_registry(filter: &[String], scripted: bool) -> Arc<Registry> {
    let mut registry = Registry::new();
    let filter_set: HashSet<String> = filter
        .iter()
        .map(|s| s.trim().strip_prefix("acp:").unwrap_or(s.trim()).to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Pure `--scripted` without explicit external `--runtime` flags stays 100% deterministic and offline.
    if scripted && filter_set.is_empty() {
        registry.register(Arc::new(oar::scripted::ScriptedRuntime::new("scripted", oar::scripted::Script::echo())));
        return Arc::new(registry);
    }

    let defaults = oar::default_runtimes();
    let want_scripted = scripted || filter_set.contains("scripted");
    for runtime in defaults.list() {
        let bare = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id());
        if bare == "scripted" {
            if want_scripted {
                registry.register(Arc::new(oar::scripted::ScriptedRuntime::new("scripted", oar::scripted::Script::echo())));
            }
            continue;
        }
        if filter_set.is_empty() || filter_set.contains(bare) || filter_set.contains(runtime.id()) {
            registry.register(runtime.clone());
        }
    }
    Arc::new(registry)
}

/// Probes each runtime in `registry` in parallel with bounded per-runtime timeout and maps to `MachineRuntimeSummary`.
pub async fn probe_runtime_summaries_async(registry: &Registry) -> Vec<MachineRuntimeSummary> {
    let runtimes = registry.list().to_vec();
    let mut set = tokio::task::JoinSet::new();
    for (idx, runtime) in runtimes.into_iter().enumerate() {
        set.spawn(async move { (idx, probe_single_runtime_async(&runtime).await) });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            results.push(item);
        }
    }
    results.sort_by_key(|(idx, _)| *idx);
    results.into_iter().map(|(_, s)| s).collect()
}

async fn probe_single_runtime_async(runtime: &Arc<dyn Runtime>) -> MachineRuntimeSummary {
    let bare_id = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id()).to_string();
    let label = runtime.display_name().to_string();
    let caps = runtime.capabilities();

    let installation = tokio::time::timeout(RUNTIME_PROBE_TIMEOUT, runtime.installation())
        .await
        .unwrap_or(oar::Installation::NotInstalled);
    let available = matches!(installation, oar::Installation::Available { .. });

    // Only call `list_models()` eagerly for fast in-process runtimes (`scripted`) so daemon startup stays instant.
    let models = if available && bare_id == "scripted" {
        runtime
            .list_models()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|m| ModelEntry {
                id: m.id,
                name: m.display_name,
                effort_levels: m.effort_levels,
                default_effort: m.default_effort,
                is_default: m.is_default,
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut capabilities = Vec::new();
    if caps.model_selection {
        capabilities.push(RuntimeCapability::ListModels);
    }
    if caps.usage {
        capabilities.push(RuntimeCapability::AccountUsage);
    }
    capabilities.push(RuntimeCapability::McpServers);
    capabilities.push(RuntimeCapability::Tools);

    MachineRuntimeSummary {
        id: bare_id,
        label,
        models,
        capabilities,
        available,
    }
}

/// Active outbound WebSocket channel slot shared across event pumps and local `/mcp` proxies.
pub struct TransportSlot {
    active: Mutex<Option<(u64, mpsc::UnboundedSender<MachineWireFrame>)>>,
    generation: AtomicU64,
}

impl Default for TransportSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportSlot {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    pub fn install(&self, tx: mpsc::UnboundedSender<MachineWireFrame>) -> u64 {
        let id = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self.active.lock() = Some((id, tx));
        id
    }

    pub fn clear_if(&self, id: u64) {
        let mut guard = self.active.lock();
        if guard.as_ref().is_some_and(|(cur, _)| *cur == id) {
            *guard = None;
        }
    }

    pub fn send(&self, frame: MachineWireFrame) -> bool {
        let guard = self.active.lock();
        guard.as_ref().is_some_and(|(_, tx)| tx.send(frame).is_ok())
    }
}

#[derive(Debug, Clone)]
pub struct MachineAgentConfig {
    pub server_url: String,
    pub token: Secret,
    pub machine_id: String,
    pub name: String,
    pub ephemeral: bool,
    pub workdir: PathBuf,
    pub once: bool,
    pub reconnect_base_delay: Duration,
    pub reconnect_max_delay: Duration,
}

impl MachineAgentConfig {
    pub fn new(server_url: String, token: Secret, machine_id: String, name: String, workdir: PathBuf) -> Self {
        Self {
            server_url,
            token,
            machine_id,
            name,
            ephemeral: false,
            workdir,
            once: false,
            reconnect_base_delay: RECONNECT_MIN_DELAY,
            reconnect_max_delay: RECONNECT_MAX_DELAY,
        }
    }
}

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
