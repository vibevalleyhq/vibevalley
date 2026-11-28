use crate::BoxFuture;
use crate::{
    AgentError, ContentBlock, ControlAction, ControlOutcome, Event, PermissionDecision, Registry, Result, Session, SessionOptions, SessionStatus, TurnOptions,
    voyage::Record,
};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
use tokio::sync::mpsc;

const DEPTH: &str = "OAR_SUBAGENT_DEPTH";
pub struct Pool {
    registry: Arc<Registry>,
    max_depth: usize,
    max_concurrent: usize,
    current_depth: Option<usize>,
    slots: Mutex<Slots>,
}
#[derive(Default)]
struct Slots {
    closed: bool,
    next: u64,
    active: HashMap<u64, Option<Arc<dyn Session>>>,
}

pub fn parse_depth(text: &str) -> Result<usize> {
    let s = text.trim();
    if s.is_empty() {
        return Ok(0);
    }
    s.parse().map_err(|_| AgentError::Rejected(format!("invalid_depth: invalid {DEPTH} value")))
}

impl Pool {
    pub fn new(registry: Arc<Registry>) -> Arc<Self> {
        Self::with_limits(registry, 1, 4, None)
    }
    pub fn with_limits(registry: Arc<Registry>, max_depth: i32, max_concurrent: i32, current_depth: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            registry,
            max_depth: if max_depth == 0 { 1 } else { max_depth.max(0) as usize },
            max_concurrent: if max_concurrent <= 0 { 4 } else { max_concurrent as usize },
            current_depth,
            slots: Mutex::new(Slots::default()),
        })
    }
    pub fn active(&self) -> usize {
        self.slots.lock().active.len()
    }
    pub async fn spawn(self: &Arc<Self>, runtime: &str, mut options: SessionOptions) -> Result<Arc<dyn Session>> {
        let runtime = self.registry.require(runtime)?;
        let depth = match self.current_depth {
            Some(depth) => depth,
            None => {
                let configured = options
                    .base_env
                    .as_ref()
                    .and_then(|env| env.iter().rev().find(|(k, _)| k == DEPTH))
                    .map(|(_, v)| v.clone());
                parse_depth(&configured.or_else(|| std::env::var(DEPTH).ok()).unwrap_or_default())?
            }
        };
        if depth >= self.max_depth {
            return Err(AgentError::Rejected(format!("depth_limit: reached nesting level {depth}")));
        }
        let slot = {
            let mut slots = self.slots.lock();
            if slots.closed {
                return Err(AgentError::Rejected("pool_closed: child pool closed".into()));
            }
            if slots.active.len() >= self.max_concurrent {
                return Err(AgentError::Rejected("concurrency_limit: all child slots occupied".into()));
            }
            let slot = slots.next;
            slots.next += 1;
            slots.active.insert(slot, None);
            slot
        };
        options.env.retain(|(key, _)| key != DEPTH);
        options.env.push((DEPTH.into(), (depth + 1).to_string()));
        let inner = match runtime.open(options).await {
            Ok(session) => session,
            Err(error) => {
                self.slots.lock().active.remove(&slot);
                return Err(error);
            }
        };
        let closed = {
            let mut slots = self.slots.lock();
            if slots.closed {
                true
            } else {
                slots.active.insert(slot, Some(inner.clone()));
                false
            }
        };
        if closed {
            inner.dispose().await;
            return Err(AgentError::Rejected("pool_closed: child pool closed during launch".into()));
        }
        Ok(Arc::new(Child {
            pool: Arc::downgrade(self),
            slot,
            inner,
        }))
    }
    pub async fn close(&self) {
        let children = {
            let mut slots = self.slots.lock();
            slots.closed = true;
            std::mem::take(&mut slots.active)
        };
        for child in children.into_values().flatten() {
            child.dispose().await;
        }
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        let children = {
            let mut slots = self.slots.lock();
            slots.closed = true;
            std::mem::take(&mut slots.active)
        };
        for child in children.into_values().flatten() {
            child.signal_dispose();
        }
    }
}

struct Child {
    pool: Weak<Pool>,
    slot: u64,
    inner: Arc<dyn Session>,
}
impl Child {
    fn release(&self) {
        if let Some(pool) = self.pool.upgrade() {
            pool.slots.lock().active.remove(&self.slot);
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        self.inner.signal_dispose();
        self.release();
    }
}
impl Session for Child {
    fn id(&self) -> String {
        self.inner.id()
    }
    fn read_subagent<'a>(&'a self, thread_id: &'a str, turn_id: Option<&'a str>) -> BoxFuture<'a, Result<crate::SubagentSnapshot>> {
        self.inner.read_subagent(thread_id, turn_id)
    }
    fn swarm_snapshot(&self) -> Option<crate::SwarmSnapshot> {
        self.inner.swarm_snapshot()
    }
    fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<crate::ChildTranscriptStep> {
        self.inner.read_child_transcript(conversation_id, limit)
    }
    fn runtime_id(&self) -> &str {
        self.inner.runtime_id()
    }
    fn resume_id(&self) -> Option<String> {
        self.inner.resume_id()
    }
    fn status(&self) -> SessionStatus {
        self.inner.status()
    }
    fn events(&self) -> mpsc::Receiver<Event> {
        self.inner.events()
    }
    fn events_with_history(&self) -> mpsc::Receiver<Event> {
        self.inner.events_with_history()
    }
    fn records(&self) -> Vec<Record> {
        self.inner.records()
    }
    fn subscribe_records(&self, after: Option<u64>) -> mpsc::Receiver<Record> {
        self.inner.subscribe_records(after)
    }
    fn control<'a>(&'a self, op: ControlAction, arg: &'a str, id: &'a str, span: &'a str) -> BoxFuture<'a, Result<ControlOutcome>> {
        self.inner.control(op, arg, id, span)
    }
    fn control_with<'a>(&'a self, op: ControlAction, arg: &'a str, id: &'a str, span: &'a str, opts: TurnOptions) -> BoxFuture<'a, Result<ControlOutcome>> {
        self.inner.control_with(op, arg, id, span, opts)
    }
    fn prompt(&self, c: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        self.inner.prompt(c)
    }
    fn prompt_with(&self, c: Vec<ContentBlock>, opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        self.inner.prompt_with(c, opts)
    }
    fn steer(&self, c: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        self.inner.steer(c)
    }
    fn queue(&self, c: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        self.inner.queue(c)
    }
    fn queue_with(&self, c: Vec<ContentBlock>, opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        self.inner.queue_with(c, opts)
    }
    fn abort(&self) -> BoxFuture<'_, Result<()>> {
        self.inner.abort()
    }
    fn respond_permission<'a>(&'a self, r: &'a str, d: PermissionDecision) -> BoxFuture<'a, Result<()>> {
        self.inner.respond_permission(r, d)
    }
    fn wait(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let result = self.inner.wait().await;
            self.release();
            result
        })
    }
    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner.dispose().await;
            self.release();
        })
    }
    fn signal_dispose(&self) {
        self.inner.signal_dispose();
        self.release();
    }
}
