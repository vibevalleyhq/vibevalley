//! Remote execution host (`RemoteMachine`), remote OAR runtime proxy
//! (`RemoteRuntime`), and disconnect-resilient remote OAR session proxy
//! (`RemoteSession`) multiplexed over a live `/api/v1/machine/ws` connection.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{mpsc, oneshot};
use vibevalley_protocol::{
    MachineHello, MachineInfo, MachineInputKind, MachinePlatform, MachineRuntimeSummary, MachineSessionAck, MachineSessionAttach, MachineSessionEvent,
    MachineSessionInput, MachineSessionOpen, MachineSessionOpened, MachineSessionRecord, MachineSessionRespond, MachineStatus, MachineWireError,
    MachineWireFrame, Millis, RuntimeCapability,
};

use super::types::{Machine, MachineDescriptor, MachinePlatform as RtPlatform, MachineStatus as RtStatus};
use vibevalley_oar::BoxFuture;
use vibevalley_oar::core::{EVENT_SUBSCRIBER_CAPACITY, HISTORY_LIMIT, RECORD_HISTORY_LIMIT, RECORD_SUBSCRIBER_CAPACITY, StatusFold};
use vibevalley_oar::{
    self, AgentError, Capabilities, ContentBlock, ControlAction, ControlOutcome, ControlStatus, Event, EventKind, Installation, InteractionDecision, McpServer,
    ModelInfo, PermissionDecision, PermissionMode, Result as OarResult, Runtime, Session, SessionOptions, SessionStatus, StopReason, Usage, voyage,
};

pub use vibevalley_oar::RemoteDispatchMeta;

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// Normalizes strongly-typed `SessionOptions::remote_dispatch` metadata and
/// falls back to the `vibevalley` HTTP MCP `Authorization: Bearer` header when
/// `mcp_session_token` was not provided explicitly.
fn resolve_dispatch_meta(meta: Option<RemoteDispatchMeta>, mcp_servers: &[McpServer]) -> RemoteDispatchMeta {
    let raw = meta.unwrap_or_default();
    let mut resolved = RemoteDispatchMeta {
        session_id: non_empty(raw.session_id),
        repo_ref: non_empty(raw.repo_ref),
        mcp_session_token: non_empty(raw.mcp_session_token),
        ..Default::default()
    };
    if resolved.mcp_session_token.is_none() {
        for server in mcp_servers {
            if let McpServer::Http { name, headers, .. } = server
                && name == "vibevalley"
            {
                for (hk, hv) in headers {
                    if hk.eq_ignore_ascii_case("authorization")
                        && let Some((scheme, token)) = hv.trim().split_once(char::is_whitespace)
                        && scheme.eq_ignore_ascii_case("bearer")
                    {
                        let token = token.trim();
                        if !token.is_empty() {
                            resolved.mcp_session_token = Some(token.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }
    resolved
}

fn to_rt_platform(platform: MachinePlatform) -> RtPlatform {
    match platform {
        MachinePlatform::Macos => RtPlatform::Macos,
        MachinePlatform::Linux => RtPlatform::Linux,
        MachinePlatform::Container => RtPlatform::Container,
        MachinePlatform::Other => RtPlatform::Other,
    }
}

fn to_rt_status(status: MachineStatus) -> RtStatus {
    match status {
        MachineStatus::Online => RtStatus::Online,
        MachineStatus::Offline => RtStatus::Offline,
        MachineStatus::Draining => RtStatus::Draining,
    }
}

fn capabilities_from_summary(summary: &MachineRuntimeSummary) -> Capabilities {
    if let Some(spec) = vibevalley_oar::runtime_spec(&summary.id) {
        let mut caps = spec.capabilities;
        caps.model_selection |= summary.capabilities.contains(&RuntimeCapability::ListModels);
        caps.usage |= summary.capabilities.contains(&RuntimeCapability::AccountUsage);
        return caps;
    }
    Capabilities {
        resume: true,
        steer: true,
        queue: true,
        permission_requests: true,
        model_selection: summary.capabilities.contains(&RuntimeCapability::ListModels) || !summary.models.is_empty(),
        subagents: false,
        usage: summary.capabilities.contains(&RuntimeCapability::AccountUsage),
        config_options: true,
    }
}

fn render_content(blocks: &[ContentBlock]) -> String {
    let mut parts = Vec::with_capacity(blocks.len());
    for block in blocks {
        match block {
            ContentBlock::Text(text) => parts.push(text.clone()),
            ContentBlock::File { path, lines: Some((a, b)) } => parts.push(format!("@{}:{a}-{b}", path.display())),
            ContentBlock::File { path, lines: None } => parts.push(format!("@{}", path.display())),
            ContentBlock::Image { path } => parts.push(format!("[image: {}]", path.display())),
        }
    }
    parts.join("\n")
}

fn merge_system_prompts(system: Option<&str>, append: Option<&str>) -> Option<String> {
    match (system.map(str::trim).filter(|s| !s.is_empty()), append.map(str::trim).filter(|s| !s.is_empty())) {
        (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
        (Some(a), None) => Some(a.to_string()),
        (None, Some(b)) => Some(b.to_string()),
        (None, None) => None,
    }
}

fn decode_wire_event(ev: &MachineSessionEvent) -> Option<Event> {
    let raw = ev.event_json.trim();
    if raw.is_empty() {
        return ev.terminal.then(|| Event {
            seq: ev.seq,
            agent_path: Vec::new(),
            at_ms: u64::try_from(ev.at).unwrap_or(0),
            kind: EventKind::SessionEnded,
        });
    }
    if let Ok(mut event) = serde_json::from_str::<Event>(raw) {
        if ev.seq > 0 {
            event.seq = ev.seq;
        }
        return Some(event);
    }
    if let Ok(kind) = serde_json::from_str::<EventKind>(raw) {
        return Some(Event {
            seq: ev.seq,
            agent_path: Vec::new(),
            at_ms: u64::try_from(ev.at).unwrap_or(0),
            kind,
        });
    }
    None
}

enum PendingReply {
    SessionOpened(MachineSessionOpened),
    SessionAck(MachineSessionAck),
    WireError(MachineWireError),
    Disconnected(String),
}

struct LiveLink {
    conn_id: u64,
    outgoing: mpsc::Sender<MachineWireFrame>,
}

struct RemoteMeta {
    name: String,
    platform: MachinePlatform,
    status: MachineStatus,
    ephemeral: bool,
    joined_at: Millis,
    last_seen_at: Option<Millis>,
    runtimes: Vec<MachineRuntimeSummary>,
}

struct RemoteMachineInner {
    machine_id: String,
    meta: Mutex<RemoteMeta>,
    link: Mutex<Option<LiveLink>>,
    pending: Mutex<HashMap<String, oneshot::Sender<PendingReply>>>,
    sessions: Mutex<HashMap<String, Arc<RemoteSessionInner>>>,
}

impl RemoteMachineInner {
    fn new(hello: &MachineHello, conn_id: u64, outgoing: mpsc::Sender<MachineWireFrame>, at: Millis) -> Arc<Self> {
        Arc::new(Self {
            machine_id: hello.machine_id.clone(),
            meta: Mutex::new(RemoteMeta {
                name: hello.name.clone(),
                platform: hello.platform,
                status: MachineStatus::Online,
                ephemeral: hello.ephemeral,
                joined_at: at,
                last_seen_at: Some(at),
                runtimes: hello.runtimes.clone(),
            }),
            link: Mutex::new(Some(LiveLink { conn_id, outgoing })),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn reconnect(&self, hello: &MachineHello, conn_id: u64, outgoing: mpsc::Sender<MachineWireFrame>, at: Millis) -> Vec<MachineSessionAttach> {
        {
            let mut meta = self.meta.lock();
            meta.name = hello.name.clone();
            meta.platform = hello.platform;
            meta.status = MachineStatus::Online;
            meta.ephemeral = hello.ephemeral;
            meta.last_seen_at = Some(at);
            if !hello.runtimes.is_empty() {
                meta.runtimes = hello.runtimes.clone();
            }
        }
        // Replacing the old link drops its outgoing sender, closing any stale WS gracefully.
        let prev = self.link.lock().replace(LiveLink { conn_id, outgoing });
        drop(prev);

        // Build `session.attach` frames for every active non-ended session so missed events replay losslessly.
        let active: Vec<(String, u64)> = self
            .sessions
            .lock()
            .iter()
            .filter_map(|(id, session)| {
                let st = session.state.lock();
                (!st.ended && !st.disposed).then(|| (id.clone(), st.last_seq))
            })
            .collect();
        active
            .into_iter()
            .map(|(session_id, after_seq)| MachineSessionAttach {
                request_id: format!("att_{}", uuid::Uuid::new_v4().simple()),
                session_id,
                after_seq,
            })
            .collect()
    }

    pub(crate) fn update_inventory(&self, runtimes: Vec<MachineRuntimeSummary>, at: Millis) {
        let mut meta = self.meta.lock();
        meta.runtimes = runtimes;
        meta.last_seen_at = Some(at);
    }

    pub(crate) fn touch_last_seen(&self, at: Millis) {
        self.meta.lock().last_seen_at = Some(at);
    }

    /// Marks the connection disconnected only if `conn_id` is still the active link.
    /// Returns `Some(ephemeral)` when this disconnect actually transitioned the machine.
    pub(crate) fn on_disconnect(&self, conn_id: u64) -> Option<bool> {
        {
            let mut link = self.link.lock();
            if link.as_ref().is_none_or(|l| l.conn_id != conn_id) {
                return None;
            }
            link.take();
        }
        let reason = format!("machine `{}` disconnected", self.machine_id);
        let pending: Vec<_> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in pending {
            let _ = tx.send(PendingReply::Disconnected(reason.clone()));
        }
        let ephemeral = {
            let mut meta = self.meta.lock();
            meta.status = MachineStatus::Offline;
            meta.ephemeral
        };
        if ephemeral {
            let sessions: Vec<_> = self.sessions.lock().drain().map(|(_, s)| s).collect();
            for session in sessions {
                session.finish_abruptly(format!("ephemeral sandbox `{}` disconnected", self.machine_id));
            }
        }
        Some(ephemeral)
    }

    pub(crate) fn close(&self) {
        self.link.lock().take();
        let pending: Vec<_> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in pending {
            let _ = tx.send(PendingReply::Disconnected("server shutting down".into()));
        }
        let sessions: Vec<_> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.finish_abruptly("server shutting down".into());
        }
    }

    pub(crate) fn try_send_frame(&self, frame: MachineWireFrame) -> Result<(), String> {
        let sender = self
            .link
            .lock()
            .as_ref()
            .map(|l| l.outgoing.clone())
            .ok_or_else(|| format!("machine `{}` is offline", self.machine_id))?;
        sender.try_send(frame).map_err(|_| format!("machine `{}` link closed", self.machine_id))
    }

    pub(crate) async fn send_frame_async(&self, frame: MachineWireFrame) -> Result<(), String> {
        let sender = self
            .link
            .lock()
            .as_ref()
            .map(|l| l.outgoing.clone())
            .ok_or_else(|| format!("machine `{}` is offline", self.machine_id))?;
        tokio::time::timeout(Duration::from_secs(5), sender.send(frame))
            .await
            .map_err(|_| format!("machine `{}` link closed", self.machine_id))?
            .map_err(|_| format!("machine `{}` link closed", self.machine_id))
    }

    async fn send_rpc_async(&self, request_id: String, frame: MachineWireFrame, timeout: Duration) -> Result<PendingReply, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(request_id.clone(), tx);
        if let Err(err) = self.send_frame_async(frame).await {
            self.pending.lock().remove(&request_id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(format!("machine `{}` request `{request_id}` timed out", self.machine_id))
            }
            Ok(Err(_)) => {
                self.pending.lock().remove(&request_id);
                Err(format!("machine `{}` disconnected", self.machine_id))
            }
        }
    }

    pub(crate) fn handle_session_opened(&self, opened: MachineSessionOpened) {
        if let Some(tx) = self.pending.lock().remove(&opened.request_id) {
            let _ = tx.send(PendingReply::SessionOpened(opened));
        }
    }

    pub(crate) fn handle_session_ack(&self, ack: MachineSessionAck) {
        if let Some(tx) = self.pending.lock().remove(&ack.request_id) {
            let _ = tx.send(PendingReply::SessionAck(ack));
        }
    }

    pub(crate) fn handle_wire_error(&self, err: MachineWireError) {
        if let Some(req_id) = err.request_id.as_deref()
            && let Some(tx) = self.pending.lock().remove(req_id)
        {
            let _ = tx.send(PendingReply::WireError(err));
        }
    }

    pub(crate) fn handle_session_event(&self, ev: MachineSessionEvent) {
        let session = self.sessions.lock().get(&ev.session_id).cloned();
        let Some(session) = session else {
            return;
        };
        let ended = session.ingest_event(ev);
        if ended {
            self.sessions.lock().remove(&session.session_id);
        }
    }

    pub(crate) fn handle_session_record(&self, rec: MachineSessionRecord) {
        let session = self.sessions.lock().get(&rec.session_id).cloned();
        if let Some(session) = session {
            session.ingest_record(rec);
        }
    }

    pub(crate) fn info(&self) -> MachineInfo {
        let meta = self.meta.lock();
        MachineInfo {
            id: self.machine_id.clone(),
            name: meta.name.clone(),
            platform: meta.platform,
            status: meta.status,
            here: false,
            ephemeral: meta.ephemeral,
            joined_at: meta.joined_at,
            last_seen_at: meta.last_seen_at,
            runtimes: meta.runtimes.clone(),
        }
    }

    pub(crate) fn protocol_machine(&self) -> vibevalley_protocol::Machine {
        let meta = self.meta.lock();
        vibevalley_protocol::Machine {
            id: self.machine_id.clone(),
            name: meta.name.clone(),
            here: false,
            online: meta.status == MachineStatus::Online,
            joined_at: meta.joined_at,
            platform: Some(meta.platform),
            status: Some(meta.status),
            ephemeral: meta.ephemeral,
            runtimes: meta.runtimes.iter().map(|r| r.id.clone()).collect(),
        }
    }

    pub(crate) fn status(&self) -> MachineStatus {
        self.meta.lock().status
    }

    fn descriptor(&self) -> MachineDescriptor {
        let meta = self.meta.lock();
        MachineDescriptor {
            machine_id: self.machine_id.clone(),
            label: meta.name.clone(),
            platform: to_rt_platform(meta.platform),
            status: to_rt_status(meta.status),
            ephemeral: meta.ephemeral,
            local: false,
        }
    }
}

/// Remote host registered in `MachineRegistry`, backed by a live WS tunnel.
pub struct RemoteMachine {
    inner: Arc<RemoteMachineInner>,
}

impl RemoteMachine {
    pub fn new(hello: &MachineHello, conn_id: u64, outgoing: mpsc::Sender<MachineWireFrame>, at: Millis) -> Arc<Self> {
        Arc::new(Self {
            inner: RemoteMachineInner::new(hello, conn_id, outgoing, at),
        })
    }

    pub fn reconnect(&self, hello: &MachineHello, conn_id: u64, outgoing: mpsc::Sender<MachineWireFrame>, at: Millis) -> Vec<MachineSessionAttach> {
        self.inner.reconnect(hello, conn_id, outgoing, at)
    }

    pub fn update_inventory(&self, runtimes: Vec<MachineRuntimeSummary>, at: Millis) {
        self.inner.update_inventory(runtimes, at);
    }

    pub fn touch_last_seen(&self, at: Millis) {
        self.inner.touch_last_seen(at);
    }

    pub fn on_disconnect(&self, conn_id: u64) -> Option<bool> {
        self.inner.on_disconnect(conn_id)
    }

    pub fn close(&self) {
        self.inner.close();
    }

    pub fn status(&self) -> MachineStatus {
        self.inner.status()
    }

    pub fn try_send_frame(&self, frame: MachineWireFrame) -> Result<(), String> {
        self.inner.try_send_frame(frame)
    }

    pub fn handle_session_opened(&self, opened: MachineSessionOpened) {
        self.inner.handle_session_opened(opened);
    }

    pub fn handle_session_ack(&self, ack: MachineSessionAck) {
        self.inner.handle_session_ack(ack);
    }

    pub fn handle_session_event(&self, ev: MachineSessionEvent) {
        self.inner.handle_session_event(ev);
    }

    pub fn handle_session_record(&self, rec: MachineSessionRecord) {
        self.inner.handle_session_record(rec);
    }

    pub fn handle_wire_error(&self, err: MachineWireError) {
        self.inner.handle_wire_error(err);
    }

    pub fn info(&self) -> MachineInfo {
        self.inner.info()
    }

    pub fn protocol_machine(&self) -> vibevalley_protocol::Machine {
        self.inner.protocol_machine()
    }
}

impl Machine for RemoteMachine {
    fn descriptor(&self) -> MachineDescriptor {
        self.inner.descriptor()
    }

    fn machine_id(&self) -> &str {
        &self.inner.machine_id
    }

    fn runtimes(&self) -> Vec<Arc<dyn Runtime>> {
        let summaries = self.inner.meta.lock().runtimes.clone();
        summaries
            .into_iter()
            .map(|summary| {
                Arc::new(RemoteRuntime {
                    machine: self.inner.clone(),
                    summary,
                }) as Arc<dyn Runtime>
            })
            .collect()
    }
}

/// OAR `Runtime` proxy forwarding `open` onto a remote machine over WS.
pub struct RemoteRuntime {
    machine: Arc<RemoteMachineInner>,
    summary: MachineRuntimeSummary,
}

impl Runtime for RemoteRuntime {
    fn id(&self) -> &str {
        &self.summary.id
    }

    fn display_name(&self) -> &str {
        if self.summary.label.is_empty() {
            &self.summary.id
        } else {
            &self.summary.label
        }
    }

    fn capabilities(&self) -> Capabilities {
        capabilities_from_summary(&self.summary)
    }

    fn installation(&self) -> BoxFuture<'_, Installation> {
        Box::pin(async move {
            if self.machine.status() != MachineStatus::Online {
                return Installation::Unusable {
                    reason: format!("machine `{}` is offline", self.machine.machine_id),
                };
            }
            if !self.summary.available {
                return Installation::NotInstalled;
            }
            Installation::Available {
                version: None,
                path: PathBuf::from(format!("machine://{}/{}", self.machine.machine_id, self.summary.id)),
            }
        })
    }

    fn list_models(&self) -> BoxFuture<'_, OarResult<Vec<ModelInfo>>> {
        Box::pin(async move {
            Ok(self
                .summary
                .models
                .iter()
                .map(|m| ModelInfo {
                    id: m.id.clone(),
                    display_name: if m.name.is_empty() { m.id.clone() } else { m.name.clone() },
                    effort_levels: m.effort_levels.clone(),
                    default_effort: m.default_effort.clone(),
                    is_default: m.is_default,
                })
                .collect())
        })
    }

    fn list_mcp_servers(&self) -> BoxFuture<'_, OarResult<Option<Vec<vibevalley_oar::HostMcpServer>>>> {
        Box::pin(async { Ok(None) })
    }

    fn open(&self, opts: SessionOptions) -> BoxFuture<'_, OarResult<Arc<dyn Session>>> {
        Box::pin(async move {
            if self.machine.status() != MachineStatus::Online {
                return Err(AgentError::NotAvailable(format!("machine `{}` is offline", self.machine.machine_id)));
            }
            let meta = resolve_dispatch_meta(opts.remote_dispatch, &opts.mcp_servers);
            let env: BTreeMap<String, String> = opts.env.into_iter().collect();
            let session_id = meta
                .session_id
                .or_else(|| opts.resume.clone())
                .unwrap_or_else(|| format!("rs_{}", uuid::Uuid::new_v4().simple()));
            let request_id = format!("open_{}", uuid::Uuid::new_v4().simple());
            let workdir = (!opts.cwd.as_os_str().is_empty()).then(|| opts.cwd.to_string_lossy().into_owned());
            let system_prompt = merge_system_prompts(opts.system_prompt.as_deref(), opts.append_system_prompt.as_deref());

            let inner = RemoteSessionInner::new(session_id.clone(), self.summary.id.clone(), self.machine.clone(), workdir.clone());
            // Register before sending `session.open` so early `session.event` frames are never dropped.
            self.machine.sessions.lock().insert(session_id.clone(), inner.clone());

            let frame = MachineWireFrame::MachineSessionOpen(MachineSessionOpen {
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                runtime_id: self.summary.id.clone(),
                repo_ref: meta.repo_ref,
                workdir,
                system_prompt,
                model: opts.model,
                effort: opts.effort,
                mcp_session_token: meta.mcp_session_token,
                env,
            });

            let timeout = opts.request_timeout.unwrap_or(DEFAULT_RPC_TIMEOUT);
            let reply = match self.machine.send_rpc_async(request_id, frame, timeout).await {
                Ok(reply) => reply,
                Err(err) => {
                    self.machine.sessions.lock().remove(&session_id);
                    return Err(AgentError::Io(err));
                }
            };

            match reply {
                PendingReply::SessionOpened(opened) if opened.ok => {
                    if let Some(dir) = opened.workdir.filter(|w| !w.is_empty()) {
                        inner.state.lock().workdir = Some(dir);
                    }
                    Ok(Arc::new(RemoteSession { inner }) as Arc<dyn Session>)
                }
                PendingReply::SessionOpened(opened) => {
                    self.machine.sessions.lock().remove(&session_id);
                    Err(AgentError::Rejected(opened.error.unwrap_or_else(|| "remote refused session open".into())))
                }
                PendingReply::WireError(err) => {
                    self.machine.sessions.lock().remove(&session_id);
                    Err(AgentError::Protocol(format!("{}: {}", err.code, err.message)))
                }
                PendingReply::Disconnected(reason) => {
                    self.machine.sessions.lock().remove(&session_id);
                    Err(AgentError::Io(reason))
                }
                PendingReply::SessionAck(_) => {
                    self.machine.sessions.lock().remove(&session_id);
                    Err(AgentError::Protocol("unexpected reply to session.open".into()))
                }
            }
        })
    }
}

struct RemoteSessionState {
    last_seq: u64,
    last_record_seq: Option<u64>,
    fold: StatusFold,
    history: VecDeque<Event>,
    subscribers: Vec<mpsc::Sender<Event>>,
    records: VecDeque<voyage::Record>,
    record_subscribers: Vec<mpsc::Sender<voyage::Record>>,
    workdir: Option<String>,
    ended: bool,
    disposed: bool,
}

struct RemoteSessionInner {
    session_id: String,
    runtime_id: String,
    machine: Arc<RemoteMachineInner>,
    state: Mutex<RemoteSessionState>,
}

impl RemoteSessionInner {
    fn new(session_id: String, runtime_id: String, machine: Arc<RemoteMachineInner>, workdir: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            session_id,
            runtime_id,
            machine,
            state: Mutex::new(RemoteSessionState {
                last_seq: 0,
                last_record_seq: None,
                fold: StatusFold::new(),
                history: VecDeque::new(),
                subscribers: Vec::new(),
                records: VecDeque::new(),
                record_subscribers: Vec::new(),
                workdir,
                ended: false,
                disposed: false,
            }),
        })
    }

    fn emit_local_locked(session_id: &str, state: &mut RemoteSessionState, event: Event) {
        state.fold.apply(&event);
        state.subscribers.retain(|tx| match tx.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    session_id = %session_id,
                    capacity = EVENT_SUBSCRIBER_CAPACITY,
                    "remote session event subscriber full; evicting slow consumer"
                );
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
        if state.history.len() == HISTORY_LIMIT {
            state.history.pop_front();
        }
        let is_end = matches!(event.kind, EventKind::SessionEnded);
        state.history.push_back(event);
        if is_end {
            state.ended = true;
            state.subscribers.clear();
            state.record_subscribers.clear();
        }
    }

    fn ingest_event(&self, ev: MachineSessionEvent) -> bool {
        let mut state = self.state.lock();
        if state.ended {
            return true;
        }
        // Monotonic deduplication guarantees lossless replay without duplicates across reconnects.
        if ev.seq > 0 && ev.seq <= state.last_seq {
            return false;
        }
        let Some(event) = decode_wire_event(&ev) else {
            return false;
        };
        if ev.seq > 0 {
            state.last_seq = ev.seq;
        }
        let is_session_ended = matches!(event.kind, EventKind::SessionEnded);
        Self::emit_local_locked(&self.session_id, &mut state, event);
        if ev.terminal && !is_session_ended {
            let end_seq = state.last_seq.saturating_add(1);
            Self::emit_local_locked(
                &self.session_id,
                &mut state,
                Event {
                    seq: end_seq,
                    agent_path: Vec::new(),
                    at_ms: u64::try_from(ev.at).unwrap_or_else(|_| voyage::now_ms()),
                    kind: EventKind::SessionEnded,
                },
            );
        }
        state.ended
    }

    fn ingest_record(&self, rec: MachineSessionRecord) {
        let Ok(record) = serde_json::from_str::<voyage::Record>(&rec.record_json) else {
            return;
        };
        let mut state = self.state.lock();
        if state.ended {
            return;
        }
        if state.last_record_seq.is_some_and(|last| rec.seq <= last) {
            return;
        }
        state.last_record_seq = Some(rec.seq);
        state.record_subscribers.retain(|tx| match tx.try_send(record.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    session_id = %self.session_id,
                    capacity = RECORD_SUBSCRIBER_CAPACITY,
                    "remote session record subscriber full; evicting slow consumer"
                );
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
        if state.records.len() == RECORD_HISTORY_LIMIT {
            state.records.pop_front();
        }
        state.records.push_back(record);
    }

    fn finish_abruptly(&self, reason: String) {
        let mut state = self.state.lock();
        if state.ended {
            return;
        }
        let at_ms = voyage::now_ms();
        let err_seq = state.last_seq.saturating_add(1);
        Self::emit_local_locked(
            &self.session_id,
            &mut state,
            Event {
                seq: err_seq,
                agent_path: Vec::new(),
                at_ms,
                kind: EventKind::Error { message: reason },
            },
        );
        if state.fold.turn_active() {
            let turn_seq = err_seq.saturating_add(1);
            Self::emit_local_locked(
                &self.session_id,
                &mut state,
                Event {
                    seq: turn_seq,
                    agent_path: Vec::new(),
                    at_ms,
                    kind: EventKind::TurnFinished {
                        reason: StopReason::Error,
                        usage: Usage::default(),
                    },
                },
            );
        }
        let end_seq = state.last_seq.saturating_add(2);
        Self::emit_local_locked(
            &self.session_id,
            &mut state,
            Event {
                seq: end_seq,
                agent_path: Vec::new(),
                at_ms,
                kind: EventKind::SessionEnded,
            },
        );
    }

    async fn send_input_async(
        &self,
        kind: MachineInputKind,
        text: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        input_id: Option<&str>,
    ) -> OarResult<String> {
        {
            let state = self.state.lock();
            if state.disposed {
                return Err(AgentError::Rejected("disposed: the session was disposed".into()));
            }
            if state.ended {
                return Err(AgentError::Rejected("runtime_exited: the remote session has ended".into()));
            }
        }
        let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
        let input_id = input_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("inp_{}", uuid::Uuid::new_v4().simple()));
        let frame = MachineWireFrame::MachineSessionInput(MachineSessionInput {
            request_id: request_id.clone(),
            session_id: self.session_id.clone(),
            input_id: input_id.clone(),
            kind,
            text,
            model,
            effort,
        });
        let reply = self
            .machine
            .send_rpc_async(request_id, frame, DEFAULT_RPC_TIMEOUT)
            .await
            .map_err(AgentError::Io)?;
        match reply {
            PendingReply::SessionAck(ack) if ack.ok => Ok(input_id),
            PendingReply::SessionAck(ack) => Err(AgentError::Rejected(ack.error.unwrap_or_else(|| "remote rejected input".into()))),
            PendingReply::WireError(err) => Err(AgentError::Protocol(format!("{}: {}", err.code, err.message))),
            PendingReply::Disconnected(reason) => Err(AgentError::Io(reason)),
            PendingReply::SessionOpened(_) => Err(AgentError::Protocol("unexpected reply to session.input".into())),
        }
    }

    async fn send_respond_async(&self, target_id: &str, allow: bool, answer: Option<String>) -> OarResult<()> {
        let frame = MachineWireFrame::MachineSessionRespond(MachineSessionRespond {
            request_id: format!("resp_{}", uuid::Uuid::new_v4().simple()),
            session_id: self.session_id.clone(),
            target_id: target_id.to_string(),
            allow,
            answer,
        });
        self.machine.send_frame_async(frame).await.map_err(AgentError::Io)
    }
}

/// Disconnect-resilient OAR `Session` proxy over `/api/v1/machine/ws`.
pub struct RemoteSession {
    inner: Arc<RemoteSessionInner>,
}

impl RemoteSession {
    pub fn workdir(&self) -> Option<String> {
        self.inner.state.lock().workdir.clone()
    }
}

impl Session for RemoteSession {
    fn id(&self) -> String {
        self.inner.session_id.clone()
    }

    fn control<'a>(&'a self, action: ControlAction, arg: &'a str, input_id: &'a str, span_id: &'a str) -> BoxFuture<'a, OarResult<ControlOutcome>> {
        Box::pin(async move {
            let (kind, text) = match action {
                ControlAction::Prompt => (MachineInputKind::Prompt, Some(arg.to_string())),
                ControlAction::Steer => (MachineInputKind::Steer, Some(arg.to_string())),
                ControlAction::Queue => (MachineInputKind::Queue, Some(arg.to_string())),
                ControlAction::Abort => (MachineInputKind::Abort, None),
                ControlAction::Withdraw | ControlAction::Compact | ControlAction::StopTask => {
                    return Ok(ControlOutcome {
                        action,
                        status: ControlStatus::Unsupported,
                        code: "unsupported".into(),
                        reason: "control action is not supported on remote machines".into(),
                        span_id: span_id.into(),
                        input_id: input_id.into(),
                    });
                }
            };
            match self.inner.send_input_async(kind, text, None, None, Some(input_id)).await {
                Ok(effective_input_id) => Ok(ControlOutcome {
                    action,
                    status: ControlStatus::Accepted,
                    code: String::new(),
                    reason: String::new(),
                    span_id: span_id.into(),
                    input_id: effective_input_id,
                }),
                Err(AgentError::Rejected(reason)) => Ok(ControlOutcome {
                    action,
                    status: ControlStatus::Rejected,
                    code: reason.split(':').next().unwrap_or("rejected").trim().to_string(),
                    reason,
                    span_id: span_id.into(),
                    input_id: input_id.into(),
                }),
                Err(err) => Err(err),
            }
        })
    }

    fn records(&self) -> Vec<voyage::Record> {
        self.inner.state.lock().records.iter().cloned().collect()
    }

    fn subscribe_records(&self, after: Option<u64>) -> mpsc::Receiver<voyage::Record> {
        let (tx, rx) = mpsc::channel(RECORD_SUBSCRIBER_CAPACITY);
        let mut state = self.inner.state.lock();
        let mut keep = true;
        for rec in &state.records {
            if after.is_none_or(|a| rec.seq > a) && tx.try_send(rec.clone()).is_err() {
                keep = false;
                break;
            }
        }
        if keep && !state.ended {
            state.record_subscribers.push(tx);
        }
        rx
    }

    fn runtime_id(&self) -> &str {
        &self.inner.runtime_id
    }

    fn status(&self) -> SessionStatus {
        self.inner.state.lock().fold.status()
    }

    fn events(&self) -> mpsc::Receiver<Event> {
        let (tx, rx) = mpsc::channel(EVENT_SUBSCRIBER_CAPACITY);
        let mut state = self.inner.state.lock();
        if !state.ended {
            state.subscribers.push(tx);
        }
        rx
    }

    fn events_with_history(&self) -> mpsc::Receiver<Event> {
        let (tx, rx) = mpsc::channel(EVENT_SUBSCRIBER_CAPACITY);
        let mut state = self.inner.state.lock();
        let skip = state.history.len().saturating_sub(EVENT_SUBSCRIBER_CAPACITY);
        let mut keep = true;
        for event in state.history.iter().skip(skip) {
            if tx.try_send(event.clone()).is_err() {
                keep = false;
                break;
            }
        }
        if keep && !state.ended {
            state.subscribers.push(tx);
        }
        rx
    }

    fn prompt(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, OarResult<()>> {
        Box::pin(async move {
            self.inner
                .send_input_async(MachineInputKind::Prompt, Some(render_content(&content)), None, None, None)
                .await?;
            Ok(())
        })
    }

    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, OarResult<()>> {
        Box::pin(async move {
            self.inner
                .send_input_async(MachineInputKind::Steer, Some(render_content(&content)), None, None, None)
                .await?;
            Ok(())
        })
    }

    fn queue(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, OarResult<()>> {
        Box::pin(async move {
            self.inner
                .send_input_async(MachineInputKind::Queue, Some(render_content(&content)), None, None, None)
                .await?;
            Ok(())
        })
    }

    fn abort(&self) -> BoxFuture<'_, OarResult<()>> {
        Box::pin(async move {
            self.inner.send_input_async(MachineInputKind::Abort, None, None, None, None).await?;
            Ok(())
        })
    }

    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: PermissionDecision) -> BoxFuture<'a, OarResult<()>> {
        Box::pin(async move {
            let (allow, answer) = match decision {
                PermissionDecision::AllowOnce => (true, None),
                PermissionDecision::AllowAlways => (true, Some("always".into())),
                PermissionDecision::Deny { message } => (false, message),
            };
            self.inner.send_respond_async(request_id, allow, answer).await
        })
    }

    fn respond_interaction<'a>(&'a self, request_id: &'a str, decision: InteractionDecision) -> BoxFuture<'a, OarResult<()>> {
        Box::pin(async move {
            let (allow, answer) = match decision {
                InteractionDecision::Select { option_id } => (true, Some(option_id)),
                InteractionDecision::Custom { text } => (true, Some(text)),
                InteractionDecision::Cancel => (false, None),
            };
            self.inner.send_respond_async(request_id, allow, answer).await
        })
    }

    fn set_config<'a>(&'a self, model: Option<&'a str>, effort: Option<&'a str>, _permission_mode: Option<PermissionMode>) -> BoxFuture<'a, OarResult<()>> {
        Box::pin(async move {
            self.inner
                .send_input_async(MachineInputKind::SetConfig, None, model.map(String::from), effort.map(String::from), None)
                .await?;
            Ok(())
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if !self.mark_disposed() {
                return;
            }
            let _ = self.inner.machine.send_frame_async(self.dispose_frame()).await;
            self.finish_disposal();
        })
    }

    fn signal_dispose(&self) {
        if !self.mark_disposed() {
            return;
        }
        let _ = self.inner.machine.try_send_frame(self.dispose_frame());
        self.finish_disposal();
    }
}

impl RemoteSession {
    fn mark_disposed(&self) -> bool {
        let mut state = self.inner.state.lock();
        if state.disposed {
            return false;
        }
        state.disposed = true;
        true
    }

    fn dispose_frame(&self) -> MachineWireFrame {
        MachineWireFrame::MachineSessionInput(MachineSessionInput {
            request_id: format!("disp_{}", uuid::Uuid::new_v4().simple()),
            session_id: self.inner.session_id.clone(),
            input_id: format!("inp_{}", uuid::Uuid::new_v4().simple()),
            kind: MachineInputKind::Dispose,
            text: None,
            model: None,
            effort: None,
        })
    }

    fn finish_disposal(&self) {
        self.inner.machine.sessions.lock().remove(&self.inner.session_id);
        let mut state = self.inner.state.lock();
        if !state.ended {
            let end_seq = state.last_seq.saturating_add(1);
            RemoteSessionInner::emit_local_locked(
                &self.inner.session_id,
                &mut state,
                Event {
                    seq: end_seq,
                    agent_path: Vec::new(),
                    at_ms: voyage::now_ms(),
                    kind: EventKind::SessionEnded,
                },
            );
        }
    }
}
