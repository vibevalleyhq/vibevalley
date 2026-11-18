use crate::{
    AgentError, ContentBlock, ControlAction, ControlOutcome, Event, PermissionDecision, Registry, Result, Session, SessionOptions, SessionStatus, core::lock,
    voyage::Record,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

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
    pub fn with_limits(registry: Arc<Registry>, max_depth: usize, max_concurrent: usize, current_depth: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            registry,
            max_depth,
            max_concurrent,
            current_depth,
            slots: Mutex::new(Slots::default()),
        })
    }
    pub fn active(&self) -> usize {
        lock(&self.slots).active.len()
    }
    pub fn spawn(self: &Arc<Self>, runtime: &str, mut options: SessionOptions) -> Result<Arc<dyn Session>> {
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
            let mut slots = lock(&self.slots);
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
        let inner = match runtime.open(options) {
            Ok(session) => session,
            Err(error) => {
                lock(&self.slots).active.remove(&slot);
                return Err(error);
            }
        };
        {
            let mut slots = lock(&self.slots);
            if slots.closed {
                drop(slots);
                inner.dispose();
                return Err(AgentError::Rejected("pool_closed: child pool closed during launch".into()));
            }
            slots.active.insert(slot, Some(inner.clone()));
        }
        Ok(Arc::new(Child {
            pool: Arc::downgrade(self),
            slot,
            inner,
        }))
    }
    pub fn close(&self) {
        let children = {
            let mut slots = lock(&self.slots);
            slots.closed = true;
            std::mem::take(&mut slots.active)
        };
        for child in children.into_values().flatten() {
            child.dispose();
        }
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        self.close();
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
            lock(&pool.slots).active.remove(&self.slot);
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        self.dispose();
    }
}
impl Session for Child {
    fn id(&self) -> String {
        self.inner.id()
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
    fn events(&self) -> flume::Receiver<Event> {
        self.inner.events()
    }
    fn events_with_history(&self) -> flume::Receiver<Event> {
        self.inner.events_with_history()
    }
    fn records(&self) -> Vec<Record> {
        self.inner.records()
    }
    fn subscribe_records(&self, after: Option<u64>) -> flume::Receiver<Record> {
        self.inner.subscribe_records(after)
    }
    fn control(&self, op: ControlAction, arg: &str, id: &str, span: &str) -> Result<ControlOutcome> {
        self.inner.control(op, arg, id, span)
    }
    fn prompt(&self, c: Vec<ContentBlock>) -> Result<()> {
        self.inner.prompt(c)
    }
    fn steer(&self, c: Vec<ContentBlock>) -> Result<()> {
        self.inner.steer(c)
    }
    fn queue(&self, c: Vec<ContentBlock>) -> Result<()> {
        self.inner.queue(c)
    }
    fn abort(&self) -> Result<()> {
        self.inner.abort()
    }
    fn respond_permission(&self, r: &str, d: PermissionDecision) -> Result<()> {
        self.inner.respond_permission(r, d)
    }
    fn wait(&self) -> Result<()> {
        let result = self.inner.wait();
        self.release();
        result
    }
    fn dispose(&self) {
        self.inner.dispose();
        self.release();
    }
}
