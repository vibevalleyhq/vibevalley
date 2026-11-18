use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const ATTACHED: &str = "runtime.attached";

pub fn worker_conversation(session: &str) -> String {
    format!("worker:{session}")
}

type Observer = Arc<dyn Fn(BrainEvent) + Send + Sync>;

#[derive(Clone)]
struct Worker {
    brain: Arc<Brain>,
    on: Observer,
}

#[derive(Clone, Default)]
pub struct Workers(Arc<Mutex<HashMap<String, Worker>>>);
impl Workers {
    pub fn attach(&self, conv: &str, brain: Arc<Brain>, on: Observer) -> Result<()> {
        if !conv.starts_with("worker:") {
            return Err(Error::Invalid("invalid worker conversation".into()));
        }
        let mut workers = self.0.lock().unwrap();
        if workers.contains_key(conv) {
            return Err(Error::Invalid("worker runtime already attached".into()));
        }
        workers.insert(conv.into(), Worker { brain, on });
        Ok(())
    }
    pub fn detach(&self, conv: &str) {
        self.0.lock().unwrap().remove(conv);
    }
    pub(super) fn brain(&self, conv: &str) -> Option<Arc<Brain>> {
        self.0.lock().unwrap().get(conv).map(|w| w.brain.clone())
    }
    pub(super) fn observe(&self, conv: &str, event: BrainEvent) {
        let on = self.0.lock().unwrap().get(conv).map(|w| w.on.clone());
        if let Some(on) = on {
            on(event);
        }
    }
}

#[derive(Clone)]
pub struct SharedExecution {
    pub generation: Generation,
    pub scheduler: Scheduler,
}

pub struct WorkersOnly;
impl Environment for WorkersOnly {
    fn brain(&self, _: &str, _: &str) -> Result<Arc<Brain>> {
        Err(Error::Invalid("no orchestrator in standalone worker runtime".into()))
    }
}
