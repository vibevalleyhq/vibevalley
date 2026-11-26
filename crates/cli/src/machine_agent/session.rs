//! Per-session `seq`-indexed event ring buffer (bounded 4096), bounded `input_id` deduplication,
//! and OAR `Session` control/respond dispatch.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use vibevalley_protocol::{MachineInputKind, MachineSessionAck, MachineSessionEvent, MachineSessionInput, MachineSessionRespond, MachineWireFrame};
use vibevalley_runtime::oar::{self, ContentBlock, EventKind, InteractionDecision, InteractionOption, PermissionDecision};

use super::mcp_proxy::LocalMcpProxy;
use super::transport::TransportSlot;
use super::worktree::WorktreeManager;

pub const EVENT_RING_CAPACITY: usize = 4096;
pub const INPUT_DEDUP_CAPACITY: usize = 1024;

/// Bounded per-session ring buffer storing monotonically sequenced `MachineSessionEvent`s (`seq = 1..`).
#[derive(Debug)]
pub struct EventRingBuffer {
    capacity: usize,
    next_seq: u64,
    events: VecDeque<MachineSessionEvent>,
}

impl EventRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_seq: 1,
            events: VecDeque::new(),
        }
    }

    pub fn push(&mut self, session_id: &str, event: &oar::Event) -> MachineSessionEvent {
        let seq = self.next_seq;
        self.next_seq += 1;
        let wire = MachineSessionEvent {
            session_id: session_id.to_string(),
            seq,
            at: event.at_ms as i64,
            event_json: serde_json::to_string(event).unwrap_or_else(|_| "{}".into()),
            terminal: matches!(event.kind, EventKind::SessionEnded),
        };
        if self.events.len() == self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(wire.clone());
        wire
    }

    /// Returns every buffered event with `seq > after_seq` in strictly ascending order.
    pub fn replay_after(&self, after_seq: u64) -> Vec<MachineSessionEvent> {
        self.events.iter().filter(|ev| ev.seq > after_seq).cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn last_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputOutcome {
    pub ok: bool,
    pub error: Option<String>,
}

/// Bounded per-session seen-set for `input_id` idempotency across reconnect retries.
#[derive(Debug)]
pub struct InputDeduplicator {
    capacity: usize,
    order: VecDeque<String>,
    seen: HashMap<String, InputOutcome>,
}

impl InputDeduplicator {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            order: VecDeque::new(),
            seen: HashMap::new(),
        }
    }

    pub fn get(&self, input_id: &str) -> Option<&InputOutcome> {
        if input_id.is_empty() {
            return None;
        }
        self.seen.get(input_id)
    }

    pub fn record(&mut self, input_id: String, outcome: InputOutcome) {
        if input_id.is_empty() {
            return;
        }
        if self.seen.contains_key(&input_id) {
            return;
        }
        if self.order.len() == self.capacity
            && let Some(evicted) = self.order.pop_front()
        {
            self.seen.remove(&evicted);
        }
        self.order.push_back(input_id.clone());
        self.seen.insert(input_id, outcome);
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

struct SessionState {
    ring: EventRingBuffer,
    dedup: InputDeduplicator,
    pending_interactions: HashMap<String, Vec<InteractionOption>>,
}

/// Live local OAR session managed by `MachineAgent`, surviving transient WS disconnects.
pub struct ManagedSession {
    pub session_id: String,
    pub workdir: PathBuf,
    owned_worktree: Option<PathBuf>,
    ephemeral_workdir: bool,
    oar_session: Arc<dyn oar::Session>,
    mcp_proxy: Mutex<Option<LocalMcpProxy>>,
    state: Mutex<SessionState>,
    disposed: AtomicBool,
}

impl ManagedSession {
    pub fn new(
        session_id: String,
        workdir: PathBuf,
        owned_worktree: Option<PathBuf>,
        ephemeral_workdir: bool,
        oar_session: Arc<dyn oar::Session>,
        mcp_proxy: Option<LocalMcpProxy>,
    ) -> Self {
        Self {
            session_id,
            workdir,
            owned_worktree,
            ephemeral_workdir,
            oar_session,
            mcp_proxy: Mutex::new(mcp_proxy),
            state: Mutex::new(SessionState {
                ring: EventRingBuffer::new(EVENT_RING_CAPACITY),
                dedup: InputDeduplicator::new(INPUT_DEDUP_CAPACITY),
                pending_interactions: HashMap::new(),
            }),
            disposed: AtomicBool::new(false),
        }
    }

    pub fn mcp_url(&self) -> Option<String> {
        self.mcp_proxy.lock().as_ref().map(|p| p.url().to_string())
    }

    /// Records an OAR event in the ring buffer and immediately forwards it over the active WS (if connected).
    pub fn record_and_forward(&self, event: &oar::Event, transport: &TransportSlot) -> MachineSessionEvent {
        // Always lock `state` before calling `transport.send` so replay (`attach_and_replay`) never interleaves out of order.
        let mut state = self.state.lock();
        match &event.kind {
            EventKind::InteractionRequested { request_id, options, .. } => {
                state.pending_interactions.insert(request_id.clone(), options.clone());
            }
            EventKind::InteractionResolved { request_id, .. } => {
                state.pending_interactions.remove(request_id);
            }
            EventKind::SessionEnded => {
                state.pending_interactions.clear();
            }
            _ => {}
        }
        let wire = state.ring.push(&self.session_id, event);
        transport.send(MachineWireFrame::MachineSessionEvent(wire.clone()));
        wire
    }

    /// Replays every buffered event with `seq > after_seq` atomically onto `transport` in exact order.
    pub fn attach_and_replay(&self, after_seq: u64, transport: &TransportSlot) -> usize {
        let state = self.state.lock();
        let missed = state.ring.replay_after(after_seq);
        let count = missed.len();
        for ev in missed {
            transport.send(MachineWireFrame::MachineSessionEvent(ev));
        }
        count
    }

    /// Executes `MachineSessionInput` idempotently by `input_id` and builds the correlated `MachineSessionAck`.
    pub async fn handle_input(&self, req: &MachineSessionInput, worktrees: &WorktreeManager) -> MachineSessionAck {
        if let Some(previous) = self.state.lock().dedup.get(&req.input_id).cloned() {
            return MachineSessionAck {
                request_id: req.request_id.clone(),
                session_id: req.session_id.clone(),
                input_id: req.input_id.clone(),
                ok: previous.ok,
                error: previous.error,
            };
        }

        let result: Result<(), String> = match req.kind {
            MachineInputKind::Prompt => {
                let text = req.text.clone().unwrap_or_default();
                self.oar_session.prompt(vec![ContentBlock::Text(text)]).await.map_err(|e| e.to_string())
            }
            MachineInputKind::Steer => {
                let text = req.text.clone().unwrap_or_default();
                self.oar_session.steer(vec![ContentBlock::Text(text)]).await.map_err(|e| e.to_string())
            }
            MachineInputKind::Queue => {
                let text = req.text.clone().unwrap_or_default();
                self.oar_session.queue(vec![ContentBlock::Text(text)]).await.map_err(|e| e.to_string())
            }
            MachineInputKind::Abort => self.oar_session.abort().await.map_err(|e| e.to_string()),
            MachineInputKind::SetConfig => self
                .oar_session
                .set_config(req.model.as_deref(), req.effort.as_deref(), None)
                .await
                .map_err(|e| e.to_string()),
            MachineInputKind::Dispose => {
                self.dispose_async(worktrees).await;
                Ok(())
            }
        };

        let outcome = match result {
            Ok(()) => InputOutcome { ok: true, error: None },
            Err(err) => InputOutcome { ok: false, error: Some(err) },
        };
        self.state.lock().dedup.record(req.input_id.clone(), outcome.clone());

        MachineSessionAck {
            request_id: req.request_id.clone(),
            session_id: req.session_id.clone(),
            input_id: req.input_id.clone(),
            ok: outcome.ok,
            error: outcome.error,
        }
    }

    /// Forwards a permission or interaction response to the live OAR `Session`.
    pub async fn handle_respond(&self, req: &MachineSessionRespond) -> MachineSessionAck {
        let interaction_options = self.state.lock().pending_interactions.get(&req.target_id).cloned();

        let result = if let Some(options) = interaction_options {
            let decision = build_interaction_decision(req.allow, req.answer.as_deref(), &options);
            self.oar_session.respond_interaction(&req.target_id, decision).await.map_err(|e| e.to_string())
        } else {
            let decision = if req.allow {
                PermissionDecision::AllowOnce
            } else {
                PermissionDecision::Deny { message: req.answer.clone() }
            };
            match self.oar_session.respond_permission(&req.target_id, decision).await {
                Ok(()) => Ok(()),
                Err(perm_err) if req.answer.is_some() => {
                    let decision = build_interaction_decision(req.allow, req.answer.as_deref(), &[]);
                    self.oar_session
                        .respond_interaction(&req.target_id, decision)
                        .await
                        .map_err(|_| perm_err.to_string())
                }
                Err(err) => Err(err.to_string()),
            }
        };

        match result {
            Ok(()) => MachineSessionAck {
                request_id: req.request_id.clone(),
                session_id: req.session_id.clone(),
                input_id: req.target_id.clone(),
                ok: true,
                error: None,
            },
            Err(err) => MachineSessionAck {
                request_id: req.request_id.clone(),
                session_id: req.session_id.clone(),
                input_id: req.target_id.clone(),
                ok: false,
                error: Some(err),
            },
        }
    }

    pub async fn dispose_async(&self, worktrees: &WorktreeManager) {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.oar_session.dispose().await;
        if let Some(proxy) = self.mcp_proxy.lock().take() {
            proxy.shutdown();
        }
        if self.ephemeral_workdir
            && let Some(wt) = &self.owned_worktree
        {
            let _ = worktrees.cleanup_worktree(wt);
        }
    }

    pub fn dispose(&self, worktrees: &WorktreeManager) {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.oar_session.signal_dispose();
        if let Some(proxy) = self.mcp_proxy.lock().take() {
            proxy.shutdown();
        }
        if self.ephemeral_workdir
            && let Some(wt) = &self.owned_worktree
        {
            let _ = worktrees.cleanup_worktree(wt);
        }
    }
}

fn build_interaction_decision(allow: bool, answer: Option<&str>, options: &[InteractionOption]) -> InteractionDecision {
    if !allow {
        return InteractionDecision::Cancel;
    }
    let Some(raw) = answer.map(str::trim).filter(|s| !s.is_empty()) else {
        return InteractionDecision::Cancel;
    };
    if options.iter().any(|opt| opt.id == raw) {
        InteractionDecision::Select { option_id: raw.to_string() }
    } else {
        InteractionDecision::Custom { text: raw.to_string() }
    }
}
