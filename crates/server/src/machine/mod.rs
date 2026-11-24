//! Execution Machine Registry (`machine.list` + WS `MachineBus`):
//! owns `Arc<MachineRegistry>` (`"local"` + dynamic remote/sandbox hosts),
//! drives authenticated `/api/v1/machine/ws` connections, serves
//! `MachineAttachmentFetch` via [`Storage`](crate::storage::Storage), projects
//! machine presence into [`LiveState`](crate::context::LiveState) +
//! [`StateFeed`](crate::context::StateFeed), and triggers heartbeats on
//! [`TaskGroup`](crate::context::TaskGroup) system wake notifications.

mod remote;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use parking_lot::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_protocol::{
    LOCAL_MACHINE_ID, Machine as ProtocolMachine, MachineAttachmentData, MachineAttachmentFetch, MachineHello, MachineHelloAck, MachineInfo, MachinePing,
    MachinePlatform, MachineRuntimeSummary, MachineStatus, MachineWireError, MachineWireFrame, Millis, RuntimeCapability,
};
use vibevalley_runtime::machine::{LocalMachine, Machine as RuntimeMachine, MachineRegistry};
use vibevalley_runtime::oar::Registry;

use crate::context::Context;
use crate::context::api::{MachineBus, MachineConnection, SharedMachineBus};
use crate::storage::Storage;

pub use remote::{RemoteDispatchMeta, RemoteMachine, RemoteRuntime, RemoteSession, attach_dispatch_meta};

/// Heartbeat interval advertised in `MachineHelloAck` and used by `gateway::http::machine_ws`.
pub const MACHINE_HEARTBEAT_MS: u64 = 15_000;

fn current_protocol_platform() -> MachinePlatform {
    if cfg!(target_os = "macos") {
        MachinePlatform::Macos
    } else if cfg!(target_os = "linux") {
        MachinePlatform::Linux
    } else {
        MachinePlatform::Other
    }
}

fn local_runtime_summaries(registry: &Registry) -> Vec<MachineRuntimeSummary> {
    registry
        .list()
        .iter()
        .map(|rt| {
            let wire_id = rt.id().strip_prefix("acp:").unwrap_or(rt.id()).to_string();
            let caps = rt.capabilities();
            let mut capabilities = Vec::new();
            if caps.model_selection {
                capabilities.push(RuntimeCapability::ListModels);
            }
            if caps.usage {
                capabilities.push(RuntimeCapability::AccountUsage);
            }
            MachineRuntimeSummary {
                id: wire_id,
                label: rt.display_name().to_string(),
                models: Vec::new(),
                capabilities,
                available: true,
            }
        })
        .collect()
}

fn valid_remote_machine_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id != LOCAL_MACHINE_ID
        && id.len() <= 128
        && !id.contains('/')
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// Manages local + remote/sandbox execution machines and implements the
/// gateway [`MachineBus`] port consumed by `gateway::http::machine_ws`.
pub struct Machine {
    ctx: Arc<Context>,
    registry: Arc<MachineRegistry>,
    local_registry: Arc<Registry>,
    local_name: String,
    local_joined_at: Millis,
    remotes: RwLock<HashMap<String, Arc<RemoteMachine>>>,
    storage: Arc<Storage>,
    server_version: String,
    next_conn_id: AtomicU64,
    cancel: CancellationToken,
}

impl Machine {
    pub fn open(ctx: Arc<Context>, local_registry: Arc<Registry>, storage: Arc<Storage>, server_version: String) -> Arc<Self> {
        let local_name = "Local".to_string();
        let local_joined_at = ctx.now();
        let registry = Arc::new(MachineRegistry::new());
        registry.register(Arc::new(LocalMachine::new(local_registry.clone()).with_label(local_name.clone())));

        let cancel = ctx.task.child_token();
        let manager = Arc::new(Self {
            ctx,
            registry,
            local_registry,
            local_name,
            local_joined_at,
            remotes: RwLock::new(HashMap::new()),
            storage,
            server_version,
            next_conn_id: AtomicU64::new(1),
            cancel,
        });

        let local_machine = manager.local_protocol_machine();
        if manager.ctx.live.upsert_machine(local_machine) {
            manager.ctx.mark_dirty(SliceMask::SESSIONS);
        }

        // Probe every connected remote machine immediately whenever macOS wakes from sleep.
        let weak_self = Arc::downgrade(&manager);
        let wake_cancel = manager.cancel.clone();
        let mut wake_rx = manager.ctx.task.subscribe_wake();
        manager.ctx.spawn("machine.wake_probe", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = wake_cancel.cancelled() => return,
                    res = wake_rx.changed() => {
                        if res.is_err() {
                            return;
                        }
                        let _ = *wake_rx.borrow_and_update();
                        let Some(mgr) = weak_self.upgrade() else { return };
                        mgr.ping_online_remotes();
                    }
                }
            }
        });

        manager
    }

    /// Returns the [`SharedMachineBus`] adapter for wiring into [`crate::context::api::GatewayPorts`].
    pub fn bus(self: &Arc<Self>) -> SharedMachineBus {
        Arc::new(MachineBusAdapter(self.clone()))
    }

    pub fn registry(&self) -> &Arc<MachineRegistry> {
        &self.registry
    }

    pub fn close(&self) {
        self.cancel.cancel();
        let remotes: Vec<_> = self.remotes.read().values().cloned().collect();
        for remote in remotes {
            remote.inner().close();
        }
    }

    fn local_protocol_machine(&self) -> ProtocolMachine {
        let runtimes = local_runtime_summaries(&self.local_registry).into_iter().map(|r| r.id).collect();
        ProtocolMachine {
            id: LOCAL_MACHINE_ID.to_string(),
            name: self.local_name.clone(),
            here: true,
            online: true,
            joined_at: self.local_joined_at,
            platform: Some(current_protocol_platform()),
            status: Some(MachineStatus::Online),
            ephemeral: false,
            runtimes,
        }
    }

    fn local_info(&self) -> MachineInfo {
        MachineInfo {
            id: LOCAL_MACHINE_ID.to_string(),
            name: self.local_name.clone(),
            platform: current_protocol_platform(),
            status: MachineStatus::Online,
            here: true,
            ephemeral: false,
            worktree_supported: true,
            joined_at: self.local_joined_at,
            last_seen_at: Some(self.ctx.now()),
            runtimes: local_runtime_summaries(&self.local_registry),
        }
    }

    /// Lists `"local"` first followed by all registered remote & sandbox machines sorted by id.
    pub fn list(&self) -> Vec<MachineInfo> {
        let mut out = Vec::new();
        out.push(self.local_info());
        let mut remotes: Vec<MachineInfo> = self.remotes.read().values().map(|m| m.info()).collect();
        remotes.sort_by(|a, b| a.id.cmp(&b.id));
        out.extend(remotes);
        out
    }

    pub fn resolve_machine(&self, machine_id: Option<&str>) -> Option<Arc<dyn RuntimeMachine>> {
        let id = machine_id.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(LOCAL_MACHINE_ID);
        self.registry.get(id)
    }

    fn emit_changed(&self, machine: ProtocolMachine) {
        if self.ctx.live.upsert_machine(machine) {
            self.ctx.mark_dirty(SliceMask::SESSIONS);
        }
    }

    fn emit_removed(&self, machine_id: &str) {
        if self.ctx.live.remove_machine(machine_id) {
            self.ctx.mark_dirty(SliceMask::SESSIONS);
        }
    }

    fn ping_online_remotes(&self) {
        let ping = MachineWireFrame::MachinePing(MachinePing { ts: self.ctx.now() });
        let remotes: Vec<_> = self.remotes.read().values().cloned().collect();
        for remote in remotes {
            if remote.inner().status() == MachineStatus::Online {
                let _ = remote.inner().send_frame(ping.clone());
            }
        }
    }

    fn handle_hello(&self, mut hello: MachineHello, conn_id: u64, outgoing: &flume::Sender<MachineWireFrame>) -> Result<Arc<RemoteMachine>, MachineWireError> {
        hello.machine_id = hello.machine_id.trim().to_string();
        if !valid_remote_machine_id(&hello.machine_id) {
            return Err(MachineWireError {
                request_id: None,
                code: "invalid_machine_id".into(),
                message: format!("invalid remote machineId `{}`", hello.machine_id),
            });
        }
        if hello.name.trim().is_empty() {
            hello.name = hello.machine_id.clone();
        }
        let at = self.ctx.now();
        let (remote, attaches) = {
            let mut remotes = self.remotes.write();
            if let Some(existing) = remotes.get(&hello.machine_id).cloned() {
                let attaches = existing.inner().reconnect(&hello, conn_id, outgoing.clone(), at);
                (existing, attaches)
            } else {
                let created = RemoteMachine::new(&hello, conn_id, outgoing.clone(), at);
                remotes.insert(hello.machine_id.clone(), created.clone());
                (created, Vec::new())
            }
        };

        self.registry.register(remote.clone() as Arc<dyn RuntimeMachine>);
        self.emit_changed(remote.protocol_machine());

        let _ = outgoing.send(MachineWireFrame::MachineHelloAck(MachineHelloAck {
            machine_id: hello.machine_id,
            server_version: self.server_version.clone(),
            heartbeat_ms: MACHINE_HEARTBEAT_MS,
        }));
        for attach in attaches {
            let _ = outgoing.send(MachineWireFrame::MachineSessionAttach(attach));
        }
        Ok(remote)
    }

    fn handle_disconnect(&self, remote: &Arc<RemoteMachine>, conn_id: u64) {
        let Some(ephemeral) = remote.inner().on_disconnect(conn_id) else {
            return;
        };
        let machine_id = remote.machine_id();
        if ephemeral {
            self.remotes.write().remove(machine_id);
            self.registry.unregister(machine_id);
            self.emit_removed(machine_id);
        } else {
            self.registry.notify_updated(machine_id);
            self.emit_changed(remote.protocol_machine());
        }
    }

    fn handle_attachment_fetch(&self, req: MachineAttachmentFetch, outgoing: flume::Sender<MachineWireFrame>) {
        let span = tracing::debug_span!("machine.conn", op = "attachment_fetch", request_id = %req.request_id);
        let storage = self.storage.clone();
        self.ctx.task.spawn(
            async move {
                let reply = match storage.read_attachment_bytes(&req.attachment_id).await {
                    Ok((mime, bytes)) => MachineAttachmentData {
                        request_id: req.request_id,
                        ok: true,
                        mime: Some(mime),
                        bytes_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                        error: None,
                    },
                    Err(err) => MachineAttachmentData {
                        request_id: req.request_id,
                        ok: false,
                        mime: None,
                        bytes_b64: None,
                        error: Some(err.message),
                    },
                };
                let _ = outgoing.send_async(MachineWireFrame::MachineAttachmentData(reply)).await;
            }
            .instrument(span),
        );
    }

    async fn drive_connection(self: Arc<Self>, conn: MachineConnection) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let span = tracing::debug_span!("machine.conn", conn_id, machine_id = tracing::field::Empty);
        async move {
            let cancel = self.cancel.clone();
            let mut active: Option<Arc<RemoteMachine>> = None;

            loop {
                let frame = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    res = conn.incoming.recv_async() => match res {
                        Ok(frame) => frame,
                        Err(_) => break,
                    },
                };

                match frame {
                    MachineWireFrame::MachineHello(hello) => match self.handle_hello(hello, conn_id, &conn.outgoing) {
                        Ok(remote) => {
                            tracing::Span::current().record("machine_id", remote.machine_id());
                            active = Some(remote);
                        }
                        Err(err) => {
                            let _ = conn.outgoing.send_async(MachineWireFrame::MachineWireError(err)).await;
                            break;
                        }
                    },
                    MachineWireFrame::MachineInventory(inv) => {
                        if let Some(remote) = &active {
                            remote.inner().update_inventory(inv.runtimes, self.ctx.now());
                            self.registry.notify_updated(remote.machine_id());
                            self.emit_changed(remote.protocol_machine());
                        } else {
                            let _ = conn
                                .outgoing
                                .send_async(MachineWireFrame::MachineWireError(MachineWireError {
                                    request_id: None,
                                    code: "hello_required".into(),
                                    message: "expected machine.hello before machine.inventory".into(),
                                }))
                                .await;
                        }
                    }
                    MachineWireFrame::MachinePong(_) => {
                        if let Some(remote) = &active {
                            remote.inner().touch_last_seen(self.ctx.now());
                        }
                    }
                    MachineWireFrame::MachinePing(_) => {
                        if let Some(remote) = &active {
                            remote.inner().touch_last_seen(self.ctx.now());
                        }
                    }
                    MachineWireFrame::MachineSessionOpened(opened) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_session_opened(opened);
                        }
                    }
                    MachineWireFrame::MachineSessionAck(ack) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_session_ack(ack);
                        }
                    }
                    MachineWireFrame::MachineSessionEvent(ev) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_session_event(ev);
                        }
                    }
                    MachineWireFrame::MachineSessionRecord(rec) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_session_record(rec);
                        }
                    }
                    MachineWireFrame::MachineWorktreeResult(res) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_worktree_result(res);
                        }
                    }
                    MachineWireFrame::MachineAttachmentFetch(req) => {
                        if active.is_some() {
                            self.handle_attachment_fetch(req, conn.outgoing.clone());
                        } else {
                            let _ = conn
                                .outgoing
                                .send_async(MachineWireFrame::MachineAttachmentData(MachineAttachmentData {
                                    request_id: req.request_id,
                                    ok: false,
                                    mime: None,
                                    bytes_b64: None,
                                    error: Some("expected machine.hello first".into()),
                                }))
                                .await;
                        }
                    }
                    MachineWireFrame::MachineWireError(err) => {
                        if let Some(remote) = &active {
                            remote.inner().handle_wire_error(err);
                        }
                    }
                    // Server-to-machine frames should not be sent by peers; ignore gracefully.
                    MachineWireFrame::MachineHelloAck(_)
                    | MachineWireFrame::MachineSessionOpen(_)
                    | MachineWireFrame::MachineSessionInput(_)
                    | MachineWireFrame::MachineSessionRespond(_)
                    | MachineWireFrame::MachineSessionAttach(_)
                    | MachineWireFrame::MachineMcpRequest(_)
                    | MachineWireFrame::MachineMcpResponse(_)
                    | MachineWireFrame::MachineAttachmentData(_)
                    | MachineWireFrame::MachineWorktreePrepare(_)
                    | MachineWireFrame::MachineWorktreeCleanup(_) => {}
                }
            }

            if let Some(remote) = active {
                self.handle_disconnect(&remote, conn_id);
            }
        }
        .instrument(span)
        .await
    }
}

/// Thin `Arc<Machine>` wrapper implementing [`MachineBus`] so `accept_connection`
/// can spawn connection loops with a self-owned `Arc<Machine>`.
pub struct MachineBusAdapter(pub Arc<Machine>);

impl MachineBus for MachineBusAdapter {
    fn accept_connection(&self, conn: MachineConnection) {
        let manager = self.0.clone();
        manager.ctx.task.spawn(manager.clone().drive_connection(conn));
    }
}
