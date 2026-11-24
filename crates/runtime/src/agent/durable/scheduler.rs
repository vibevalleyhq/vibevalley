use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::telemetry::TelemetryEvent;
use super::{Error, Read, Result, Signal, Store, Task, TaskStatus, Tx, WaitMode};
use crate::BoxFuture;

const WOKEN: &str = "__durable_woken_signal";

type Phase = Arc<dyn Fn(TaskContext) -> BoxFuture<'static, Result<Transition>> + Send + Sync>;

pub enum Transition {
    Next {
        phase: String,
        checkpoint: Option<Value>,
    },
    Sleep {
        phase: String,
        checkpoint: Option<Value>,
        until_ms: Option<i64>,
        signal: Option<String>,
    },
    Wait {
        phase: String,
        checkpoint: Option<Value>,
        mode: WaitMode,
        children: Vec<String>,
    },
    Complete(Value),
    Fail(String),
}

#[derive(Clone)]
pub struct TaskContext {
    pub task: Task,
    pub store: Store,
    pub signal: Option<Signal>,
    pub children: Vec<Task>,
    cancel: CancellationToken,
}

impl TaskContext {
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    async fn live_task(&self, tx: &Read<'_>) -> Result<Task> {
        let task = tx.task_async(&self.task.id).await?;
        if self.is_cancelled() || task.status != TaskStatus::Running {
            return Err(Error::Invalid("phase is no longer running".into()));
        }
        Ok(task)
    }

    pub async fn checkpoint(&self, data: &Value) -> Result<()> {
        let data = data.clone();
        let tc = self.clone();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = tc.live_task(tx).await?;
                    task.checkpoint = data;
                    task.restart_count = 0;
                    let phase = task.phase_name.clone();
                    let task_id = task.id.clone();
                    let at_ms = tx.now_ms;
                    tx.update_task_async(&task).await?;
                    tx.record_telemetry(TelemetryEvent::Checkpoint { task_id, phase, at_ms });
                    Ok(())
                })
            })
            .await
    }

    pub async fn memo<F, Fut>(&self, key: &str, compute: F) -> Result<Value>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        if key == WOKEN {
            return Err(Error::Invalid("reserved memo key".into()));
        }
        let key_owned = key.to_owned();
        let tc = self.clone();
        if let Some(value) = self
            .store
            .read_async(move |r| Box::pin(async move { Ok(tc.live_task(r).await?.memo.get(&key_owned).cloned()) }))
            .await?
        {
            return Ok(value);
        }
        let value = compute().await?;
        let key_owned = key.to_owned();
        let tc = self.clone();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = tc.live_task(tx).await?;
                    if let Some(prev) = task.memo.get(&key_owned) {
                        return Ok(prev.clone());
                    }
                    task.memo
                        .as_object_mut()
                        .ok_or_else(|| Error::Invalid("task memo must be an object".into()))?
                        .insert(key_owned, value.clone());
                    tx.update_task_async(&task).await?;
                    Ok(value)
                })
            })
            .await
    }

    pub async fn spawn_child(&self, mut task: Task) -> Result<(Task, bool)> {
        task.owner_task_id = self.task.id.clone();
        if task.conversation_id.is_empty() {
            task.conversation_id.clone_from(&self.task.conversation_id);
        }
        let tc = self.clone();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    tc.live_task(tx).await?;
                    tx.create_task_async(task).await
                })
            })
            .await
    }
}

struct Runtime {
    active: HashMap<String, CancellationToken>,
    handlers: HashMap<(String, String), Phase>,
    started: bool,
}

struct Engine {
    store: Store,
    rt: Mutex<Runtime>,
    /// Serializes `dispatch`, `recover`, and `abort` so `rt.active` stays consistent with durable state.
    dispatch_lock: AsyncMutex<()>,
    idle: Notify,
    max_workers: usize,
    wake: Notify,
    shutdown: CancellationToken,
}

struct Owner {
    engine: Arc<Engine>,
    coordinator: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Owner {
    fn signal_shutdown(&self) -> Option<tokio::task::JoinHandle<()>> {
        let e = &self.engine;
        {
            let rt = e.rt.lock().unwrap();
            e.shutdown.cancel();
            for cancel in rt.active.values() {
                cancel.cancel();
            }
        }
        e.wake.notify_one();
        self.coordinator.lock().unwrap().take()
    }

    async fn close_async(&self) {
        if let Some(handle) = self.signal_shutdown() {
            let _ = handle.await;
        }
        wait_idle(&self.engine).await;
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if let Some(handle) = self.signal_shutdown() {
            handle.abort();
        }
    }
}

async fn wait_idle(e: &Engine) {
    loop {
        let notified = e.idle.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if e.rt.lock().unwrap().active.is_empty() {
            return;
        }
        notified.await;
    }
}

#[derive(Clone)]
pub struct Scheduler(Arc<Owner>);

impl Scheduler {
    pub fn new(store: Store, max_workers: usize) -> Self {
        let changes = store.subscribe_tasks().expect("scheduler requires an open durable store");
        let engine = Arc::new(Engine {
            store,
            rt: Mutex::new(Runtime {
                active: HashMap::new(),
                handlers: HashMap::new(),
                started: false,
            }),
            dispatch_lock: AsyncMutex::new(()),
            idle: Notify::new(),
            max_workers: if max_workers == 0 { 32 } else { max_workers },
            wake: Notify::new(),
            shutdown: CancellationToken::new(),
        });
        let handle = crate::rt::current_or_global_handle();
        let e = Arc::clone(&engine);
        let coordinator = handle.spawn(run_scheduler(e, changes));
        Self(Arc::new(Owner {
            engine,
            coordinator: Mutex::new(Some(coordinator)),
        }))
    }

    pub fn store(&self) -> &Store {
        &self.0.engine.store
    }

    pub fn register<F, Fut>(&self, kind: &str, phase: &str, handler: F)
    where
        F: Fn(TaskContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Transition>> + Send + 'static,
    {
        let boxed: Phase = Arc::new(move |tc| Box::pin(handler(tc)));
        self.0.engine.rt.lock().unwrap().handlers.insert((kind.into(), phase.into()), boxed);
    }

    pub async fn start(&self, task: Task) -> Result<(Task, bool)> {
        let e = &self.0.engine;
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let result = e.store.write_async(move |tx| Box::pin(async move { tx.create_task_async(task).await })).await?;
        e.rt.lock().unwrap().started = true;
        e.wake.notify_one();
        Ok(result)
    }

    pub async fn send_signal(&self, id: &str, name: &str, key: Option<&str>, payload: &Value) -> Result<(Signal, bool)> {
        let id = id.to_owned();
        let name = name.to_owned();
        let key = key.map(str::to_owned);
        let payload = payload.clone();
        self.store()
            .write_async(move |tx| {
                Box::pin(async move {
                    let signal = tx.send_signal_async(&id, &name, key.as_deref(), &payload).await?;
                    if let Ok(mut task) = tx.task_async(&id).await
                        && task.status == TaskStatus::Sleeping
                    {
                        wake_sleep(tx, &mut task).await?;
                    }
                    Ok(signal)
                })
            })
            .await
    }

    pub async fn recover(&self) -> Result<()> {
        let e = &self.0.engine;
        let _guard = e.dispatch_lock.lock().await;
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let active_ids: HashSet<String> = e.rt.lock().unwrap().active.keys().cloned().collect();
        let aborts = e
            .store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut aborts = vec![];
                    for t in tx.active_tasks_async().await? {
                        if active_ids.contains(&t.id) {
                            continue;
                        }
                        let mut t = tx.task_async(&t.id).await?;
                        match t.status {
                            TaskStatus::Running | TaskStatus::Completing => {
                                if !t.is_model_task {
                                    t.restart_count = t.restart_count.saturating_add(1);
                                    if t.restart_count >= t.restart_limit {
                                        tx.update_task_async(&t).await?;
                                        aborts.extend(abort_tree(tx, &t.id, "restart_limit").await?);
                                        tx.alert_async(
                                            Some(&t.conversation_id),
                                            &json!({
                                                "kind": "restart_limit",
                                                "taskId": t.id,
                                                "conversationId": t.conversation_id,
                                                "title": "Task restart limit tripped",
                                                "message": format!("task {} crashed {} times without advancing checkpoint", t.id, t.restart_count),
                                                "createdAtMs": tx.now_ms
                                            }),
                                        )
                                        .await?;
                                        continue;
                                    }
                                }
                                t.status = TaskStatus::Pending;
                                tx.update_task_async(&t).await?;
                            }
                            TaskStatus::Sleeping => {
                                wake_sleep(tx, &mut t).await?;
                            }
                            TaskStatus::Waiting => {
                                wake_children(tx, &mut t).await?;
                            }
                            _ => {}
                        }
                    }
                    Ok(aborts)
                })
            })
            .await?;
        {
            let mut rt = e.rt.lock().unwrap();
            rt.started = true;
            record_abort(&mut rt, aborts);
        }
        e.wake.notify_one();
        Ok(())
    }

    pub async fn abort(&self, id: &str) -> Result<()> {
        let e = &self.0.engine;
        let _guard = e.dispatch_lock.lock().await;
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let id = id.to_owned();
        let order = e
            .store
            .write_async(move |tx| Box::pin(async move { abort_tree(tx, &id, "aborted").await }))
            .await?;
        let mut rt = e.rt.lock().unwrap();
        record_abort(&mut rt, order);
        Ok(())
    }

    pub fn wake(&self) {
        self.0.engine.wake.notify_one();
    }

    pub fn active_workers(&self) -> usize {
        self.0.engine.rt.lock().unwrap().active.len()
    }

    pub async fn wait_until_done(&self, id: &str, cancel: &CancellationToken) -> Result<Task> {
        let mut changes = self.store().subscribe_tasks()?;
        let id_owned = id.to_owned();
        loop {
            let task_id = id_owned.clone();
            let t = self.store().read_async(move |r| Box::pin(async move { r.task_async(&task_id).await })).await?;
            if t.status == TaskStatus::Terminal {
                return Ok(t);
            }
            if self.0.engine.shutdown.is_cancelled() || cancel.is_cancelled() {
                return Err(Error::Closed);
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::Closed),
                _ = self.0.engine.shutdown.cancelled() => return Err(Error::Closed),
                msg = changes.recv() => {
                    if msg.is_none() {
                        return Err(Error::Closed);
                    }
                }
            }
        }
    }

    pub async fn wait(&self, id: &str, timeout: Duration) -> Result<Task> {
        let never = CancellationToken::new();
        tokio::time::timeout(timeout, self.wait_until_done(id, &never))
            .await
            .map_err(|_| Error::Timeout)?
    }

    pub async fn close(&self) {
        self.0.close_async().await;
    }
}

fn record_abort(rt: &mut Runtime, ids: Vec<String>) {
    for id in ids {
        if let Some(cancel) = rt.active.get(&id) {
            cancel.cancel();
        }
    }
}

async fn abort_tree(tx: &mut Tx<'_>, id: &str, reason: &str) -> Result<Vec<String>> {
    let mut stack = vec![(id.to_owned(), false)];
    let mut order = vec![];
    let mut visited = HashSet::new();
    while let Some((next, post)) = stack.pop() {
        if !post {
            if visited.insert(next.clone()) {
                let children = tx.children_async(&next).await?;
                stack.push((next, true));
                stack.extend(children.into_iter().rev().map(|c| (c.id, false)));
            }
        } else {
            let mut task = tx.task_async(&next).await?;
            if task.status != TaskStatus::Terminal {
                task.status = TaskStatus::Terminal;
                task.terminal_reason = if next == id { reason.into() } else { "aborted".into() };
                task.wake_until_ms = 0;
                task.wait_signal_name.clear();
                tx.update_task_async(&task).await?;
                order.push(next);
            }
        }
    }
    Ok(order)
}

async fn wake_sleep(tx: &mut Tx<'_>, t: &mut Task) -> Result<bool> {
    let sig = if t.wait_signal_name.is_empty() {
        None
    } else {
        tx.consume_first_signal_async(&t.id, &t.wait_signal_name).await?
    };
    if sig.is_none() && (t.wake_until_ms <= 0 || t.wake_until_ms > tx.now_ms) {
        return Ok(false);
    }
    if let Some(s) = sig {
        t.memo
            .as_object_mut()
            .ok_or_else(|| Error::Invalid("task memo must be an object".into()))?
            .insert(WOKEN.into(), serde_json::to_value(s)?);
    }
    t.status = TaskStatus::Pending;
    t.wake_until_ms = 0;
    t.wait_signal_name.clear();
    tx.update_task_async(t).await?;
    Ok(true)
}

async fn wake_children(tx: &mut Tx<'_>, t: &mut Task) -> Result<bool> {
    let mut completed = 0;
    let mut failed = 0;
    for id in &t.wait_task_ids {
        match tx.task_async(id).await {
            Ok(c) if c.status == TaskStatus::Terminal => {
                if c.terminal_reason == "completed" {
                    completed += 1;
                } else {
                    failed += 1;
                }
            }
            Err(Error::Missing(_)) => failed += 1,
            Err(e) => return Err(e),
            _ => {}
        }
    }
    let all = completed + failed == t.wait_task_ids.len();
    let ready = match t.wait_mode {
        Some(WaitMode::Any) => completed > 0 || all,
        Some(WaitMode::FailFast) => failed > 0 || all,
        Some(WaitMode::AllSettled) => all,
        None => return Err(Error::Invalid("missing wait mode".into())),
    };
    if ready {
        t.status = TaskStatus::Pending;
        tx.update_task_async(t).await?;
    }
    Ok(ready)
}

enum DispatchStep {
    Wait(Option<Duration>),
    Stop,
}

async fn run_scheduler(e: Arc<Engine>, mut changes: mpsc::Receiver<()>) {
    loop {
        let step = if e.shutdown.is_cancelled() {
            DispatchStep::Stop
        } else if !e.rt.lock().unwrap().started {
            DispatchStep::Wait(None)
        } else {
            match dispatch(&e).await {
                Ok(t) => DispatchStep::Wait(t),
                Err(Error::Closed) => DispatchStep::Stop,
                Err(err) => {
                    eprintln!("durable dispatch: {err}");
                    DispatchStep::Wait(Some(Duration::from_millis(100)))
                }
            }
        };
        let timeout = match step {
            DispatchStep::Wait(t) => t,
            DispatchStep::Stop => break,
        };
        if e.shutdown.is_cancelled() {
            break;
        }
        match timeout {
            Some(d) => {
                let deadline = tokio::time::Instant::now() + d;
                tokio::select! {
                    biased;
                    _ = e.shutdown.cancelled() => break,
                    _ = e.wake.notified() => {}
                    msg = changes.recv() => {
                        if msg.is_none() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {}
                }
            }
            None => {
                tokio::select! {
                    biased;
                    _ = e.shutdown.cancelled() => break,
                    _ = e.wake.notified() => {}
                    msg = changes.recv() => {
                        if msg.is_none() {
                            break;
                        }
                    }
                }
            }
        }
    }
}

async fn dispatch(e: &Arc<Engine>) -> Result<Option<Duration>> {
    let _guard = e.dispatch_lock.lock().await;
    let (active_ids, capacity) = {
        let rt = e.rt.lock().unwrap();
        let active_ids: HashSet<String> = rt.active.keys().cloned().collect();
        let capacity = e.max_workers.saturating_sub(active_ids.len());
        (active_ids, capacity)
    };
    let (claimed, nearest) = e
        .store
        .write_async(move |tx| {
            Box::pin(async move {
                let mut claimed = vec![];
                let mut nearest: Option<i64> = None;
                for mut task in tx.active_tasks_async().await? {
                    if active_ids.contains(&task.id) {
                        continue;
                    }
                    match task.status {
                        TaskStatus::Sleeping => {
                            if !wake_sleep(tx, &mut task).await? && task.wake_until_ms > 0 {
                                nearest = Some(nearest.map_or(task.wake_until_ms, |n| n.min(task.wake_until_ms)));
                            }
                        }
                        TaskStatus::Waiting => {
                            wake_children(tx, &mut task).await?;
                        }
                        _ => {}
                    }
                    if task.status != TaskStatus::Pending || claimed.len() >= capacity {
                        continue;
                    }
                    task.status = TaskStatus::Running;
                    tx.update_task_async(&task).await?;
                    let signal = task.memo.get(WOKEN).map(|v| serde_json::from_value(v.clone())).transpose()?;
                    let mut children = vec![];
                    for id in &task.wait_task_ids {
                        match tx.task_async(id).await {
                            Ok(t) => children.push(t),
                            Err(Error::Missing(_)) => {}
                            Err(e) => return Err(e),
                        }
                    }
                    claimed.push((task, signal, children));
                }
                Ok((claimed, nearest))
            })
        })
        .await?;

    let handle = crate::rt::current_or_global_handle();
    for (task, signal, children) in claimed {
        let cancel = e.shutdown.child_token();
        let handler = {
            let mut rt = e.rt.lock().unwrap();
            rt.active.insert(task.id.clone(), cancel.clone());
            rt.handlers.get(&(task.kind.clone(), task.phase_name.clone())).cloned()
        };
        let engine = Arc::clone(e);
        let tc = TaskContext {
            task,
            signal,
            children,
            store: e.store.clone(),
            cancel,
        };
        handle.spawn(async move {
            let started_ms = engine.store.now_ms();
            let attempt = tc.task.restart_count.saturating_add(1);
            let resumed = tc.task.restart_count > 0 || !tc.task.checkpoint.is_null();
            let has_handler = handler.is_some();
            let task_id = tc.task.id.clone();
            let conversation_id = tc.task.conversation_id.clone();
            let kind = tc.task.kind.clone();
            let phase_name = tc.task.phase_name.clone();
            let cancel_check = tc.cancel.clone();

            let caught = match handler {
                Some(handler) => {
                    let fut = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(tc)));
                    match fut {
                        Ok(f) => std::panic::AssertUnwindSafe(f).catch_unwind().await,
                        Err(panic) => Err(panic),
                    }
                }
                None => Ok(Err(Error::Invalid(format!("unregistered phase {kind}/{phase_name}")))),
            };

            let (outcome, outcome_label, mut error_kind) = match caught {
                Ok(Ok(tr)) => {
                    let (label, ek) = match &tr {
                        Transition::Next { .. } => ("next", None),
                        Transition::Sleep { .. } => ("sleep", None),
                        Transition::Wait { .. } => ("wait", None),
                        Transition::Complete(_) => ("complete", None),
                        Transition::Fail(_) => ("fail", Some("phase_failed".to_owned())),
                    };
                    (tr, label, ek)
                }
                Ok(Err(err)) => (
                    Transition::Fail(err.to_string()),
                    "fail",
                    Some(if has_handler { "phase_failed" } else { "unregistered_phase" }.to_owned()),
                ),
                Err(_) => (Transition::Fail("phase panicked".into()), "fail", Some("phase_panicked".to_owned())),
            };

            let mut final_outcome = outcome_label.to_owned();
            let aborted_order = if !engine.shutdown.is_cancelled() && !cancel_check.is_cancelled() {
                let tid = task_id.clone();
                match engine
                    .store
                    .write_async(move |tx| Box::pin(async move { advance(tx, &tid, outcome).await }))
                    .await
                {
                    Ok(order) => {
                        if !order.is_empty() && final_outcome != "fail" {
                            final_outcome = "aborted".into();
                        }
                        order
                    }
                    Err(err) => {
                        final_outcome = "fail".into();
                        error_kind = Some("advance_failed".into());
                        eprintln!("durable phase {task_id}: {err}");
                        vec![]
                    }
                }
            } else {
                if cancel_check.is_cancelled() {
                    final_outcome = "cancelled".into();
                }
                vec![]
            };

            {
                let mut rt = engine.rt.lock().unwrap();
                record_abort(&mut rt, aborted_order);
                rt.active.remove(&task_id);
                engine.idle.notify_waiters();
                engine.wake.notify_one();
            }

            let at_ms = engine.store.now_ms();
            engine.store.emit_telemetry(TelemetryEvent::Phase {
                task_id,
                conversation_id,
                kind,
                phase: phase_name,
                attempt,
                resumed,
                outcome: final_outcome,
                error_kind,
                duration_ms: (at_ms - started_ms).max(0),
                at_ms,
            });
        });
    }
    Ok(nearest.map(|until| Duration::from_millis((until - e.store.now_ms()).max(0) as u64)))
}

async fn advance(tx: &mut Tx<'_>, id: &str, outcome: Transition) -> Result<Vec<String>> {
    let mut t = tx.task_async(id).await?;
    if t.status != TaskStatus::Running {
        return Ok(vec![]);
    }
    if let Some(m) = t.memo.as_object_mut() {
        m.remove(WOKEN);
    }
    t.wait_task_ids.clear();
    t.wait_mode = None;
    t.wait_signal_name.clear();
    t.wake_until_ms = 0;
    let (phase, checkpoint) = match outcome {
        Transition::Next { phase, checkpoint } => {
            t.status = TaskStatus::Pending;
            (phase, checkpoint)
        }
        Transition::Sleep {
            phase,
            checkpoint,
            until_ms,
            signal,
        } => {
            t.status = TaskStatus::Sleeping;
            t.wait_signal_name = signal.unwrap_or_default();
            t.wake_until_ms = until_ms.unwrap_or(0);
            (phase, checkpoint)
        }
        Transition::Wait {
            phase,
            checkpoint,
            mode,
            children,
        } => {
            t.status = TaskStatus::Waiting;
            t.wait_mode = Some(mode);
            t.wait_task_ids = children;
            (phase, checkpoint)
        }
        Transition::Complete(result) => {
            t.status = TaskStatus::Terminal;
            t.terminal_reason = "completed".into();
            t.result = result;
            t.error_text.clear();
            tx.update_task_async(&t).await?;
            return Ok(vec![]);
        }
        Transition::Fail(err) => {
            t.error_text = err;
            tx.update_task_async(&t).await?;
            return abort_tree(tx, id, "failed").await;
        }
    };
    if checkpoint.is_some() || (!phase.is_empty() && t.phase_name != phase) {
        t.restart_count = 0;
    }
    if !phase.is_empty() {
        t.phase_name = phase;
    }
    if let Some(data) = checkpoint {
        t.checkpoint = data;
    }
    tx.update_task_async(&t).await?;
    match t.status {
        TaskStatus::Sleeping => {
            wake_sleep(tx, &mut t).await?;
        }
        TaskStatus::Waiting => {
            wake_children(tx, &mut t).await?;
        }
        _ => {}
    }
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tokio::sync::Mutex as AsyncMutex;

    #[tokio::test]
    async fn settle_immediately_wakes_sleeping_task_without_polling() -> Result<()> {
        let store = Store::memory()?;
        let scheduler = Scheduler::new(store.clone(), 4);
        scheduler.register("waiter", "wait", |tc| async move {
            if tc.signal.as_ref().is_some_and(|s| s.signal_name == "pi.submission_settled") {
                return Ok(Transition::Complete(json!({"woken": true})));
            }
            Ok(Transition::Sleep {
                phase: "wait".into(),
                checkpoint: None,
                until_ms: None,
                signal: Some("pi.submission_settled".into()),
            })
        });

        let mut parent = Task::new("waiter", "wait");
        parent.id = "parent-waiter".into();
        let parent_id = parent.id.clone();
        let sub_id = store
            .write_async(move |tx| {
                Box::pin(async move {
                    tx.create_conversation_async("child-conv", "mock").await?;
                    let (sub, _) = tx
                        .submit_async("child-conv", "req-1", "prompt", &json!({"text":"hi"}), Some(&parent_id))
                        .await?;
                    Ok(sub.id)
                })
            })
            .await?;
        scheduler.start(parent).await?;

        let mut changes = store.subscribe_tasks()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while store.read_async(|r| Box::pin(async move { r.task_async("parent-waiter").await })).await?.status != TaskStatus::Sleeping {
            assert!(Instant::now() < deadline, "parent failed to reach Sleeping");
            let _ = tokio::time::timeout(Duration::from_millis(50), changes.recv()).await;
        }

        let t0 = Instant::now();
        store
            .write_async(move |tx| Box::pin(async move { tx.settle_async(&sub_id, super::super::SubmissionStatus::Done, &json!({"ok": 1})).await }))
            .await?;
        let done = scheduler.wait("parent-waiter", Duration::from_secs(2)).await?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result, json!({"woken": true}));
        assert!(t0.elapsed() < Duration::from_secs(1), "wakeup took too long: {:?}", t0.elapsed());
        scheduler.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn settle_before_sleep_wakes_task_immediately_upon_sleeping() -> Result<()> {
        let store = Store::memory()?;
        let scheduler = Scheduler::new(store.clone(), 4);
        let (tx_ready, mut rx_ready) = mpsc::unbounded_channel();
        let (tx_go, rx_go) = mpsc::unbounded_channel();
        let rx_go = Arc::new(AsyncMutex::new(rx_go));
        scheduler.register("waiter", "wait", move |tc| {
            let tx_ready = tx_ready.clone();
            let rx_go = Arc::clone(&rx_go);
            async move {
                if tc.signal.as_ref().is_some_and(|s| s.signal_name == "pi.submission_settled") {
                    return Ok(Transition::Complete(json!({"woken": true})));
                }
                let _ = tx_ready.send(());
                let _ = rx_go.lock().await.recv().await;
                Ok(Transition::Sleep {
                    phase: "wait".into(),
                    checkpoint: None,
                    until_ms: None,
                    signal: Some("pi.submission_settled".into()),
                })
            }
        });

        let mut parent = Task::new("waiter", "wait");
        parent.id = "parent-early".into();
        let parent_id = parent.id.clone();
        let sub_id = store
            .write_async(move |tx| {
                Box::pin(async move {
                    tx.create_conversation_async("child-early", "mock").await?;
                    let (sub, _) = tx
                        .submit_async("child-early", "req-early", "prompt", &json!({"text":"hi"}), Some(&parent_id))
                        .await?;
                    Ok(sub.id)
                })
            })
            .await?;
        scheduler.start(parent).await?;
        tokio::time::timeout(Duration::from_secs(2), rx_ready.recv())
            .await
            .expect("task started")
            .expect("channel open");

        store
            .write_async(move |tx| Box::pin(async move { tx.settle_async(&sub_id, super::super::SubmissionStatus::Done, &json!({"ok": 1})).await }))
            .await?;
        let _ = tx_go.send(());

        let done = scheduler.wait("parent-early", Duration::from_secs(2)).await?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result, json!({"woken": true}));
        scheduler.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn abort_tree_terminates_children_before_parent() -> Result<()> {
        let store = Store::memory()?;
        store
            .write_async(|tx| {
                Box::pin(async move {
                    for (id, owner) in [("root", ""), ("child", "root"), ("grandchild", "child")] {
                        let mut t = Task::new("work", "run");
                        t.id = id.into();
                        t.owner_task_id = owner.into();
                        t.status = TaskStatus::Running;
                        tx.create_task_async(t).await?;
                    }
                    Ok(())
                })
            })
            .await?;
        let order = store
            .write_async(|tx| Box::pin(async move { abort_tree(tx, "root", "restart_limit").await }))
            .await?;
        assert_eq!(order, ["grandchild", "child", "root"]);
        store
            .read_async(|r| {
                Box::pin(async move {
                    assert_eq!(r.task_async("root").await?.terminal_reason, "restart_limit");
                    assert_eq!(r.task_async("child").await?.terminal_reason, "aborted");
                    assert_eq!(r.task_async("grandchild").await?.terminal_reason, "aborted");
                    Ok(())
                })
            })
            .await
    }
}
