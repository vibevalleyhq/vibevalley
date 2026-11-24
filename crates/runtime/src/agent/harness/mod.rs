//! Layer 4 runtime harness: extension registration, crash stand-in recovery,
//! and worker pools.

pub mod registry;
pub mod standin;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::BoxFuture;
use crate::agent::ai::types::ToolSpec;
use crate::agent::compaction::Compactor;
use crate::agent::core::engine::{ATTACHED_SIGNAL, BrainProvider, Engine, KIND, Request};
use crate::agent::core::events::{AgentEvent, Brain};
use crate::agent::core::extension::Extension;
use crate::agent::core::pipeline::PromptSection;
use crate::agent::durable::{
    Entry, Error, JsonlOptions, Result, Scheduler, Store, Submission, SubmissionStatus, Task, TaskGraph, TaskStatus, TelemetrySink, Tx,
};
use crate::agent::resources::prompts::assemble_system_prompt;

pub use registry::ExtensionRegistry;
pub use standin::{StandIn, StandInRecovery, StandInTool};

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

struct HarnessBrainProvider {
    store: Store,
    workers: Workers,
    external: Arc<dyn BrainProvider>,
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

#[derive(Clone)]
pub struct Harness {
    store: Store,
    scheduler: Scheduler,
    engine: Arc<Engine>,
    registry: Arc<Mutex<ExtensionRegistry>>,
    workers: Workers,
}

impl Harness {
    pub async fn open(path: &Path, provider: Arc<dyn BrainProvider>) -> Result<Self> {
        let store = Store::open(path).await?;
        Ok(Self::from_store(store, provider))
    }

    pub fn open_jsonl(dir: &Path, provider: Arc<dyn BrainProvider>) -> Result<Self> {
        let store = Store::jsonl(dir)?;
        Ok(Self::from_store(store, provider))
    }

    pub fn open_jsonl_with_options(dir: &Path, opts: JsonlOptions, provider: Arc<dyn BrainProvider>) -> Result<Self> {
        let store = Store::jsonl_with_options(dir, opts)?;
        Ok(Self::from_store(store, provider))
    }

    pub fn memory(provider: Arc<dyn BrainProvider>) -> Result<Self> {
        let store = Store::memory()?;
        Ok(Self::from_store(store, provider))
    }

    pub fn workers_only(store: Store) -> Self {
        Self::from_store(store, Arc::new(WorkersOnly))
    }

    pub fn from_store(store: Store, provider: Arc<dyn BrainProvider>) -> Self {
        let workers = Workers::default();
        let composite = Arc::new(HarnessBrainProvider {
            store: store.clone(),
            workers: workers.clone(),
            external: provider,
        });
        let scheduler = Scheduler::new(store.clone(), 0);
        let engine = Arc::new(Engine::new(store.clone(), composite));
        engine.register(&scheduler);
        Self {
            store,
            scheduler,
            engine,
            registry: Arc::new(Mutex::new(ExtensionRegistry::new())),
            workers,
        }
    }

    pub fn with_compactor(self, compactor: Compactor) -> Self {
        self.engine.set_compactor(compactor);
        self
    }

    pub fn with_telemetry(self, sink: Arc<dyn TelemetrySink>) -> Self {
        self.store.set_telemetry(sink);
        self
    }

    pub fn set_telemetry(&self, sink: Arc<dyn TelemetrySink>) {
        self.store.set_telemetry(sink);
    }

    pub async fn task_graph(&self, root_conversation_id: Option<&str>) -> Result<TaskGraph> {
        self.store.task_graph(root_conversation_id).await
    }

    pub async fn recover(&self) -> Result<()> {
        self.scheduler.recover().await
    }

    pub fn register_extension(&self, ext: Arc<dyn Extension>) {
        let runner = {
            let mut reg = self.registry.lock().unwrap();
            ext.register_phases(&self.scheduler, &self.engine);
            reg.register(ext);
            reg.runner()
        };
        self.engine.set_extensions(runner);
    }

    pub fn extension_names(&self) -> Vec<String> {
        self.registry.lock().unwrap().extensions().iter().map(|e| e.name().to_owned()).collect()
    }

    pub fn with_experiments(
        &self,
        flags: &crate::agent::experiments::ExperimentFlags,
        oar: Option<(Arc<crate::oar::Registry>, crate::agent::extensions::oar::OarPolicy)>,
    ) -> &Self {
        crate::agent::experiments::mount_experiments(self, flags, oar);
        self
    }

    pub async fn attach_worker(&self, conv: &str, brain: Arc<Brain>, on: Observer) -> Result<()> {
        self.workers.attach(conv, brain, on)?;
        let conv_read = conv.to_owned();
        let targets: Vec<String> = self
            .store
            .read_async(move |tx| {
                Box::pin(async move {
                    Ok(tx
                        .tasks_by_conversation_async(&conv_read)
                        .await?
                        .into_iter()
                        .filter(|t| {
                            t.status != TaskStatus::Terminal
                                && (t.status == TaskStatus::Running || (t.status == TaskStatus::Sleeping && t.wait_signal_name == ATTACHED))
                        })
                        .map(|t| t.id)
                        .collect())
                })
            })
            .await?;
        for task_id in targets {
            let _ = self.scheduler.send_signal(&task_id, ATTACHED, None, &json!(true)).await;
        }
        Ok(())
    }

    pub async fn abort_conversation(&self, conv: &str) -> Result<Vec<String>> {
        let conv_read = conv.to_owned();
        let (task_ids, tree_ids) = self
            .store
            .read_async(move |r| {
                Box::pin(async move {
                    let roots: Vec<String> = r
                        .tasks_by_conversation_async(&conv_read)
                        .await?
                        .into_iter()
                        .filter(|t| t.kind == KIND && t.status != TaskStatus::Terminal)
                        .map(|t| t.id)
                        .collect();
                    let mut tree = Vec::new();
                    let mut stack = roots.clone();
                    while let Some(next) = stack.pop() {
                        if !tree.contains(&next) {
                            tree.push(next.clone());
                            for child in r.children_async(&next).await? {
                                stack.push(child.id);
                            }
                        }
                    }
                    Ok((roots, tree))
                })
            })
            .await?;
        for id in &task_ids {
            self.scheduler.abort(id).await?;
        }
        self.engine.extensions_snapshot().notify_task_aborted(&tree_ids);
        let conv_write = conv.to_owned();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    for sub in tx.submissions_async(&conv_write).await? {
                        if matches!(sub.status, SubmissionStatus::Queued | SubmissionStatus::Placed) {
                            tx.settle_async(&sub.id, SubmissionStatus::Unanswered, &json!({ "error": "aborted" })).await?;
                        }
                    }
                    Ok(())
                })
            })
            .await?;
        Ok(task_ids)
    }

    pub async fn submit(&self, r: Request<'_>) -> Result<(Submission, Task, bool)> {
        self.submit_with(r, |_, _| Box::pin(std::future::ready(Ok(())))).await
    }

    pub async fn submit_with<F>(&self, r: Request<'_>, placed: F) -> Result<(Submission, Task, bool)>
    where
        F: for<'a, 'b> FnOnce(&'a mut Tx<'b>, &'a Task) -> BoxFuture<'a, Result<()>> + Send + 'static,
    {
        let (sections, tool_specs): (Vec<PromptSection>, Vec<ToolSpec>) = {
            let reg = self.registry.lock().unwrap();
            (reg.sections(), reg.tool_specs())
        };
        let assembled = if sections.is_empty() {
            r.system.to_owned()
        } else {
            assemble_system_prompt(r.system, &sections)
        };
        let conv = r.conversation.to_owned();
        let effective = Request { system: &assembled, ..r };

        self.engine
            .submit_with(effective, move |tx, task| {
                Box::pin(async move {
                    if !sections.is_empty() || !tool_specs.is_empty() {
                        StandIn::save(tx, &conv, &sections, &tool_specs).await?;
                    }
                    placed(tx, task).await
                })
            })
            .await
    }

    pub async fn reconcile_sections(&self, conv: &str) -> Result<Vec<PromptSection>> {
        let active_sections = self.registry.lock().unwrap().sections();
        let conv = conv.to_owned();
        let recovery = self
            .store
            .read_async(move |r| Box::pin(async move { StandIn::reconcile(r, &conv, &active_sections, &[]).await }))
            .await?;
        Ok(recovery.missing_sections)
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn workers(&self) -> &Workers {
        &self.workers
    }

    pub async fn entries(&self, conv: &str) -> Result<Vec<Entry>> {
        let conv = conv.to_owned();
        self.store
            .read_async(move |r| Box::pin(async move { r.visible_entries_async(&conv).await }))
            .await
    }

    pub async fn close(&self) {
        self.scheduler.close().await;
    }
}

#[derive(Clone)]
pub struct SharedExecution {
    pub harness: Harness,
    pub scheduler: Scheduler,
}

impl SharedExecution {
    pub fn new(harness: Harness) -> Self {
        let scheduler = harness.scheduler().clone();
        Self { harness, scheduler }
    }

    pub fn store(&self) -> &Store {
        self.harness.store()
    }

    pub fn workers(&self) -> &Workers {
        self.harness.workers()
    }

    pub async fn entries(&self, conv: &str) -> Result<Vec<Entry>> {
        self.harness.entries(conv).await
    }

    pub async fn recover(&self) -> Result<()> {
        self.harness.recover().await
    }
}

pub fn generation_kind() -> &'static str {
    KIND
}
