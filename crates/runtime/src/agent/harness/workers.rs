use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::BoxFuture;
use crate::agent::core::engine::{ATTACHED_SIGNAL, BrainProvider};
use crate::agent::core::events::{AgentEvent, Brain};
use crate::agent::durable::{Error, Result, Store};

pub const ATTACHED: &str = ATTACHED_SIGNAL;

pub fn worker_conversation(session: &str) -> String {
    format!("worker:{session}")
}

pub type Observer = Arc<dyn Fn(AgentEvent) + Send + Sync>;

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

    pub fn brain(&self, conv: &str) -> Option<Arc<Brain>> {
        self.0.lock().unwrap().get(conv).map(|w| w.brain.clone())
    }

    pub fn observe(&self, conv: &str, event: AgentEvent) {
        let on = self.0.lock().unwrap().get(conv).map(|w| w.on.clone());
        if let Some(on) = on {
            on(event);
        }
    }
}

pub struct WorkersOnly;

impl BrainProvider for WorkersOnly {
    fn resolve_brain<'a>(&'a self, _conversation: &'a str, _provider: &'a str) -> BoxFuture<'a, Result<Option<Arc<Brain>>>> {
        Box::pin(std::future::ready(Err(Error::Invalid("no orchestrator in standalone worker runtime".into()))))
    }
}

pub(super) struct HarnessBrainProvider {
    pub(super) store: Store,
    pub(super) workers: Workers,
    pub(super) external: Arc<dyn BrainProvider>,
}

impl HarnessBrainProvider {
    async fn ancestor_worker_conv(&self, conv: &str) -> Result<Option<String>> {
        let conv = conv.to_owned();
        self.store
            .read_async(move |tx| {
                Box::pin(async move {
                    let mut cur = conv;
                    let mut seen = HashSet::new();
                    for _ in 0..8 {
                        if !seen.insert(cur.clone()) {
                            break;
                        }
                        let Ok(record) = tx.conversation_async(&cur).await else {
                            break;
                        };
                        if record.owner_task_id.is_empty() {
                            break;
                        }
                        let Ok(owner_task) = tx.task_async(&record.owner_task_id).await else {
                            break;
                        };
                        if owner_task.conversation_id.starts_with("worker:") {
                            return Ok(Some(owner_task.conversation_id));
                        }
                        cur = owner_task.conversation_id;
                    }
                    Ok(None)
                })
            })
            .await
    }
}

impl BrainProvider for HarnessBrainProvider {
    fn resolve_brain<'a>(&'a self, conv: &'a str, provider: &'a str) -> BoxFuture<'a, Result<Option<Arc<Brain>>>> {
        Box::pin(async move {
            if conv.starts_with("worker:") {
                return Ok(self.workers.brain(conv));
            }
            match self.external.resolve_brain(conv, provider).await {
                Ok(Some(brain)) => Ok(Some(brain)),
                Ok(None) => Ok(None),
                Err(err) => {
                    if let Some(worker_conv) = self.ancestor_worker_conv(conv).await? {
                        return Ok(self.workers.brain(&worker_conv));
                    }
                    Err(err)
                }
            }
        })
    }

    fn observe(&self, conv: &str, task: &str, event: AgentEvent) {
        if conv.starts_with("worker:") {
            self.workers.observe(conv, event);
        } else {
            self.external.observe(conv, task, event);
        }
    }
}
