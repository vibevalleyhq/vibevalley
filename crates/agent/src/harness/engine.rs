use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;

use serde_json::json;

use crate::ai::types::ToolSpec;
use crate::compaction::Compactor;
use crate::core::engine::{BrainProvider, Engine, KIND, Request};
use crate::core::events::Brain;
use crate::core::extension::Extension;
use crate::core::pipeline::PromptSection;
use crate::durable::{Entry, JsonlOptions, Result, Scheduler, Store, Submission, SubmissionStatus, Task, TaskGraph, TaskStatus, TelemetrySink, Tx};
use crate::resources::prompts::assemble_system_prompt;
use vibevalley_oar::BoxFuture;

use super::registry::ExtensionRegistry;
use super::standin::StandIn;
use super::workers::{ATTACHED, HarnessBrainProvider, Observer, Workers, WorkersOnly};

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
            let mut reg = self.registry.lock();
            ext.register_phases(&self.scheduler, &self.engine);
            reg.register(ext);
            reg.runner()
        };
        self.engine.set_extensions(runner);
    }

    pub fn extension_names(&self) -> Vec<String> {
        self.registry.lock().extensions().iter().map(|e| e.name().to_owned()).collect()
    }

    pub fn with_experiments(
        &self,
        flags: &crate::experiments::ExperimentFlags,
        oar: Option<(Arc<vibevalley_oar::Registry>, crate::extensions::oar::OarPolicy)>,
    ) -> &Self {
        crate::experiments::mount_experiments(self, flags, oar);
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
            let reg = self.registry.lock();
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
        let active_sections = self.registry.lock().sections();
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
