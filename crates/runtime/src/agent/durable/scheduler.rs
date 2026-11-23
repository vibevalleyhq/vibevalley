use super::telemetry::TelemetryEvent;
use super::{Error, Read, Result, Signal, Store, Task, TaskStatus, Tx, WaitMode};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio_util::sync::{CancellationToken, DropGuard};

const WOKEN: &str = "__durable_woken_signal";
type Phase = Arc<dyn Fn(&TaskContext) -> Result<Transition> + Send + Sync>;
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

pub struct TaskContext {
    pub task: Task,
    pub store: Store,
    pub signal: Option<Signal>,
    pub children: Vec<Task>,
    cancel: CancellationToken,
    done: CancellationToken,
    _done_guard: DropGuard,
    stopped: OnceLock<flume::Receiver<()>>,
}
impl TaskContext {
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }
    /// Disconnection wakes a phase blocked on an external model or tool.
    pub fn cancellation(&self) -> flume::Receiver<()> {
        self.stopped
            .get_or_init(|| {
                let (tx, rx) = flume::bounded(0);
                if self.cancel.is_cancelled() {
                    drop(tx);
                } else {
                    let cancel = self.cancel.clone();
                    let done = self.done.clone();
                    crate::rt::spawn(async move {
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => {}
                            _ = done.cancelled() => {}
                        }
                        drop(tx);
                    });
                }
                rx
            })
            .clone()
    }
    fn live_task(&self, tx: &Read<'_>) -> Result<Task> {
        let task = tx.task(&self.task.id)?;
        if self.is_cancelled() || task.status != TaskStatus::Running {
            return Err(Error::Invalid("phase is no longer running".into()));
        }
        Ok(task)
    }
    pub fn checkpoint(&self, data: &Value) -> Result<()> {
        self.store.write(|tx| {
            let mut task = self.live_task(tx)?;
            task.checkpoint = data.clone();
            task.restart_count = 0;
            let phase = task.phase_name.clone();
            let task_id = task.id.clone();
            let at_ms = tx.now_ms;
            tx.update_task(&task)?;
            tx.record_telemetry(TelemetryEvent::Checkpoint { task_id, phase, at_ms });
            Ok(())
        })
    }
    pub fn memo(&self, key: &str, compute: impl FnOnce() -> Result<Value>) -> Result<Value> {
        if key == WOKEN {
            return Err(Error::Invalid("reserved memo key".into()));
        }
        if let Some(value) = self.store.read(|r| Ok(self.live_task(r)?.memo.get(key).cloned()))? {
            return Ok(value);
        }
        let value = compute()?;
        self.store.write(|tx| {
            let mut task = self.live_task(tx)?;
            if let Some(prev) = task.memo.get(key) {
                return Ok(prev.clone());
            }
            task.memo
                .as_object_mut()
                .ok_or_else(|| Error::Invalid("task memo must be an object".into()))?
                .insert(key.into(), value.clone());
            tx.update_task(&task)?;
            Ok(value)
        })
    }
    pub fn spawn_child(&self, mut task: Task) -> Result<(Task, bool)> {
        task.owner_task_id = self.task.id.clone();
        if task.conversation_id.is_empty() {
            task.conversation_id.clone_from(&self.task.conversation_id);
        }
        self.store.write(|tx| {
            self.live_task(tx)?;
            tx.create_task(task)
        })
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
    idle: Condvar,
    max_workers: usize,
    wake: flume::Sender<()>,
    shutdown: CancellationToken,
}
struct Owner {
    engine: Arc<Engine>,
    coordinator: Mutex<Option<JoinHandle<()>>>,
}
impl Owner {
    fn close(&self) {
        let e = &self.engine;
        {
            let _rt = e.rt.lock().unwrap();
            e.shutdown.cancel();
        }
        let _ = e.wake.try_send(());
        if let Some(thread) = self.coordinator.lock().unwrap().take() {
            let _ = thread.join();
        }
        let _guard = e.idle.wait_while(e.rt.lock().unwrap(), |r| !r.active.is_empty()).unwrap();
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Clone)]
pub struct Scheduler(Arc<Owner>);
impl Scheduler {
    pub fn new(store: Store, max_workers: usize) -> Self {
        let changes = store.subscribe_tasks().expect("scheduler requires an open durable store");
        let (wake, control) = flume::bounded(1);
        let engine = Arc::new(Engine {
            store,
            rt: Mutex::new(Runtime {
                active: HashMap::new(),
                handlers: HashMap::new(),
                started: false,
            }),
            idle: Condvar::new(),
            max_workers: if max_workers == 0 { 32 } else { max_workers },
            wake,
            shutdown: CancellationToken::new(),
        });
        let e = Arc::clone(&engine);
        let thread = thread::Builder::new()
            .name("durable-scheduler".into())
            .spawn(move || run_scheduler(e, changes, control))
            .expect("start durable scheduler");
        Self(Arc::new(Owner {
            engine,
            coordinator: Mutex::new(Some(thread)),
        }))
    }
    pub fn store(&self) -> &Store {
        &self.0.engine.store
    }
    pub fn register(&self, kind: &str, phase: &str, handler: impl Fn(&TaskContext) -> Result<Transition> + Send + Sync + 'static) {
        self.0.engine.rt.lock().unwrap().handlers.insert((kind.into(), phase.into()), Arc::new(handler));
    }
    pub fn start(&self, task: Task) -> Result<(Task, bool)> {
        let e = &self.0.engine;
        let mut rt = e.rt.lock().unwrap();
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let result = e.store.write(|tx| tx.create_task(task))?;
        rt.started = true;
        let _ = e.wake.try_send(());
        Ok(result)
    }
    pub fn send_signal(&self, id: &str, name: &str, key: Option<&str>, payload: &Value) -> Result<(Signal, bool)> {
        self.store().write(|tx| {
            let signal = tx.send_signal(id, name, key, payload)?;
            if let Ok(mut task) = tx.task(id)
                && task.status == TaskStatus::Sleeping
            {
                wake_sleep(tx, &mut task)?;
            }
            Ok(signal)
        })
    }
    pub fn recover(&self) -> Result<()> {
        let e = &self.0.engine;
        let mut rt = e.rt.lock().unwrap();
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let mut aborts = vec![];
        e.store.write(|tx|{
            for t in tx.active_tasks()? {
                if rt.active.contains_key(&t.id){continue;}
                let mut t=tx.task(&t.id)?;
                match t.status {
                    TaskStatus::Running|TaskStatus::Completing=>{
                        if !t.is_model_task{
                            t.restart_count=t.restart_count.saturating_add(1);
                            if t.restart_count>=t.restart_limit{
                                tx.update_task(&t)?;
                                aborts.extend(abort_tree(tx,&t.id,"restart_limit")?);
                                tx.alert(Some(&t.conversation_id),&json!({"kind":"restart_limit","taskId":t.id,"conversationId":t.conversation_id,"title":"Task restart limit tripped","message":format!("task {} crashed {} times without advancing checkpoint",t.id,t.restart_count),"createdAtMs":tx.now_ms}))?;
                                continue;
                            }
                        }
                        t.status=TaskStatus::Pending;tx.update_task(&t)?;
                    }
                    TaskStatus::Sleeping=>{wake_sleep(tx,&mut t)?;}
                    TaskStatus::Waiting=>{wake_children(tx,&mut t)?;}
                    _=>{}
                }
            } Ok(())
        })?;
        rt.started = true;
        record_abort(&mut rt, aborts);
        let _ = e.wake.try_send(());
        Ok(())
    }
    pub fn abort(&self, id: &str) -> Result<()> {
        let e = &self.0.engine;
        let mut rt = e.rt.lock().unwrap();
        if e.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let order = e.store.write(|tx| abort_tree(tx, id, "aborted"))?;
        record_abort(&mut rt, order);
        Ok(())
    }
    pub fn wake(&self) {
        let _ = self.0.engine.wake.try_send(());
    }
    pub fn active_workers(&self) -> usize {
        self.0.engine.rt.lock().unwrap().active.len()
    }
    pub async fn wait_until_done(&self, id: &str, cancel: &CancellationToken) -> Result<Task> {
        let changes = self.store().subscribe_tasks()?;
        let id_owned = id.to_owned();
        loop {
            let store = self.store().clone();
            let task_id = id_owned.clone();
            let t = tokio::task::spawn_blocking(move || store.read(|r| r.task(&task_id)))
                .await
                .map_err(|_| Error::Closed)??;
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
                msg = changes.recv_async() => {
                    if msg.is_err() {
                        return Err(Error::Closed);
                    }
                }
            }
        }
    }
    pub fn wait(&self, id: &str, timeout: Duration) -> Result<Task> {
        let never = CancellationToken::new();
        crate::rt::block_on(async {
            tokio::time::timeout(timeout, self.wait_until_done(id, &never))
                .await
                .map_err(|_| Error::Timeout)?
        })
    }
    pub fn close(&self) {
        self.0.close();
    }
}

fn record_abort(rt: &mut Runtime, ids: Vec<String>) {
    for id in ids {
        if let Some(cancel) = rt.active.get(&id) {
            cancel.cancel();
        }
    }
}
fn abort_tree(tx: &mut Tx<'_>, id: &str, reason: &str) -> Result<Vec<String>> {
    let mut stack = vec![(id.to_owned(), false)];
    let mut order = vec![];
    let mut visited = HashSet::new();
    while let Some((next, post)) = stack.pop() {
        if !post {
            if visited.insert(next.clone()) {
                let children = tx.children(&next)?;
                stack.push((next, true));
                stack.extend(children.into_iter().rev().map(|c| (c.id, false)));
            }
        } else {
            let mut task = tx.task(&next)?;
            if task.status != TaskStatus::Terminal {
                task.status = TaskStatus::Terminal;
                task.terminal_reason = if next == id { reason.into() } else { "aborted".into() };
                task.wake_until_ms = 0;
                task.wait_signal_name.clear();
                tx.update_task(&task)?;
                order.push(next);
            }
        }
    }
    Ok(order)
}
fn wake_sleep(tx: &mut Tx<'_>, t: &mut Task) -> Result<bool> {
    let sig = if t.wait_signal_name.is_empty() {
        None
    } else {
        tx.consume_first_signal(&t.id, &t.wait_signal_name)?
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
    tx.update_task(t)?;
    Ok(true)
}
fn wake_children(tx: &mut Tx<'_>, t: &mut Task) -> Result<bool> {
    let mut completed = 0;
    let mut failed = 0;
    for id in &t.wait_task_ids {
        match tx.task(id) {
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
        tx.update_task(t)?;
    }
    Ok(ready)
}

fn run_scheduler(e: Arc<Engine>, changes: flume::Receiver<()>, control: flume::Receiver<()>) {
    loop {
        let timeout = {
            let mut rt = e.rt.lock().unwrap();
            if e.shutdown.is_cancelled() {
                break;
            }
            if rt.started {
                match dispatch(&e, &mut rt) {
                    Ok(t) => t,
                    Err(Error::Closed) => break,
                    Err(err) => {
                        eprintln!("durable dispatch: {err}");
                        Some(Duration::from_millis(100))
                    }
                }
            } else {
                None
            }
        };
        let select = flume::Selector::new().recv(&changes, |r| r).recv(&control, |r| r);
        match timeout {
            Some(d) => {
                if let Ok(Err(_)) = select.wait_timeout(d) {
                    break;
                }
            }
            None => {
                if select.wait().is_err() {
                    break;
                }
            }
        }
    }
}

fn dispatch(e: &Arc<Engine>, rt: &mut Runtime) -> Result<Option<Duration>> {
    let capacity = e.max_workers.saturating_sub(rt.active.len());
    let mut claimed = vec![];
    let mut nearest: Option<i64> = None;
    e.store.write(|tx| {
        for mut task in tx.active_tasks()? {
            if rt.active.contains_key(&task.id) {
                continue;
            }
            match task.status {
                TaskStatus::Sleeping => {
                    if !wake_sleep(tx, &mut task)? && task.wake_until_ms > 0 {
                        nearest = Some(nearest.map_or(task.wake_until_ms, |n| n.min(task.wake_until_ms)));
                    }
                }
                TaskStatus::Waiting => {
                    wake_children(tx, &mut task)?;
                }
                _ => {}
            }
            if task.status != TaskStatus::Pending || claimed.len() >= capacity {
                continue;
            }
            task.status = TaskStatus::Running;
            tx.update_task(&task)?;
            let signal = task.memo.get(WOKEN).map(|v| serde_json::from_value(v.clone())).transpose()?;
            let mut children = vec![];
            for id in &task.wait_task_ids {
                match tx.task(id) {
                    Ok(t) => children.push(t),
                    Err(Error::Missing(_)) => {}
                    Err(e) => return Err(e),
                }
            }
            claimed.push((task, signal, children));
        }
        Ok(())
    })?;
    for (task, signal, children) in claimed {
        let cancel = e.shutdown.child_token();
        let done = CancellationToken::new();
        let done_guard = done.clone().drop_guard();
        rt.active.insert(task.id.clone(), cancel.clone());
        let handler = rt.handlers.get(&(task.kind.clone(), task.phase_name.clone())).cloned();
        let engine = e.clone();
        let tc = TaskContext {
            task,
            signal,
            children,
            store: e.store.clone(),
            cancel,
            done,
            _done_guard: done_guard,
            stopped: OnceLock::new(),
        };
        thread::spawn(move || {
            let started_ms = engine.store.now_ms();
            let attempt = tc.task.restart_count.saturating_add(1);
            let resumed = tc.task.restart_count > 0 || !tc.task.checkpoint.is_null();
            let has_handler = handler.is_some();
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match handler {
                Some(handler) => handler(&tc),
                None => Err(Error::Invalid(format!("unregistered phase {}/{}", tc.task.kind, tc.task.phase_name))),
            }));
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
            let mut rt = engine.rt.lock().unwrap();
            if !engine.shutdown.is_cancelled() && !tc.is_cancelled() {
                match engine.store.write(|tx| advance(tx, &tc.task.id, outcome)) {
                    Ok(order) => {
                        if !order.is_empty() && final_outcome != "fail" {
                            final_outcome = "aborted".into();
                        }
                        record_abort(&mut rt, order);
                    }
                    Err(err) => {
                        final_outcome = "fail".into();
                        error_kind = Some("advance_failed".into());
                        eprintln!("durable phase {}: {err}", tc.task.id);
                    }
                }
            } else if tc.is_cancelled() {
                final_outcome = "cancelled".into();
            }
            rt.active.remove(&tc.task.id);
            engine.idle.notify_all();
            let _ = engine.wake.try_send(());
            drop(rt);

            let at_ms = engine.store.now_ms();
            engine.store.emit_telemetry(TelemetryEvent::Phase {
                task_id: tc.task.id.clone(),
                conversation_id: tc.task.conversation_id.clone(),
                kind: tc.task.kind.clone(),
                phase: tc.task.phase_name.clone(),
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

fn advance(tx: &mut Tx<'_>, id: &str, outcome: Transition) -> Result<Vec<String>> {
    let mut t = tx.task(id)?;
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
            tx.update_task(&t)?;
            return Ok(vec![]);
        }
        Transition::Fail(err) => {
            t.error_text = err;
            tx.update_task(&t)?;
            return abort_tree(tx, id, "failed");
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
    tx.update_task(&t)?;
    match t.status {
        TaskStatus::Sleeping => {
            wake_sleep(tx, &mut t)?;
        }
        TaskStatus::Waiting => {
            wake_children(tx, &mut t)?;
        }
        _ => {}
    }
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn settle_immediately_wakes_sleeping_task_without_polling() -> Result<()> {
        let store = Store::memory()?;
        let scheduler = Scheduler::new(store.clone(), 4);
        scheduler.register("waiter", "wait", |tc| {
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
        let sub_id = store.write(|tx| {
            tx.create_conversation("child-conv", "mock")?;
            let (sub, _) = tx.submit("child-conv", "req-1", "prompt", &json!({"text":"hi"}), Some(&parent.id))?;
            Ok(sub.id)
        })?;
        scheduler.start(parent)?;

        // Wait until parent has transitioned into Sleeping on pi.submission_settled.
        let changes = store.subscribe_tasks()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while store.read(|r| r.task("parent-waiter"))?.status != TaskStatus::Sleeping {
            assert!(Instant::now() < deadline, "parent failed to reach Sleeping");
            let _ = changes.recv_timeout(Duration::from_millis(50));
        }

        // Settle child submission directly via tx.settle (no Scheduler::send_signal).
        let t0 = Instant::now();
        store.write(|tx| tx.settle(&sub_id, super::super::SubmissionStatus::Done, &json!({"ok": 1})))?;
        let done = scheduler.wait("parent-waiter", Duration::from_secs(2))?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result, json!({"woken": true}));
        assert!(t0.elapsed() < Duration::from_secs(1), "wakeup took too long: {:?}", t0.elapsed());
        Ok(())
    }

    #[test]
    fn settle_before_sleep_wakes_task_immediately_upon_sleeping() -> Result<()> {
        let store = Store::memory()?;
        let scheduler = Scheduler::new(store.clone(), 4);
        let (tx_ready, rx_ready) = flume::bounded(1);
        let (tx_go, rx_go) = flume::bounded(1);
        scheduler.register("waiter", "wait", move |tc| {
            if tc.signal.as_ref().is_some_and(|s| s.signal_name == "pi.submission_settled") {
                return Ok(Transition::Complete(json!({"woken": true})));
            }
            let _ = tx_ready.send(());
            let _ = rx_go.recv();
            Ok(Transition::Sleep {
                phase: "wait".into(),
                checkpoint: None,
                until_ms: None,
                signal: Some("pi.submission_settled".into()),
            })
        });

        let mut parent = Task::new("waiter", "wait");
        parent.id = "parent-early".into();
        let sub_id = store.write(|tx| {
            tx.create_conversation("child-early", "mock")?;
            let (sub, _) = tx.submit("child-early", "req-early", "prompt", &json!({"text":"hi"}), Some(&parent.id))?;
            Ok(sub.id)
        })?;
        scheduler.start(parent)?;
        rx_ready.recv_timeout(Duration::from_secs(2)).expect("task started");

        // Settle child BEFORE parent returns Transition::Sleep.
        store.write(|tx| tx.settle(&sub_id, super::super::SubmissionStatus::Done, &json!({"ok": 1})))?;
        let _ = tx_go.send(());

        let done = scheduler.wait("parent-early", Duration::from_secs(2))?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result, json!({"woken": true}));
        Ok(())
    }

    #[test]
    fn abort_tree_terminates_children_before_parent() -> Result<()> {
        let store = Store::memory()?;
        store.write(|tx| {
            for (id, owner) in [("root", ""), ("child", "root"), ("grandchild", "child")] {
                let mut t = Task::new("work", "run");
                t.id = id.into();
                t.owner_task_id = owner.into();
                t.status = TaskStatus::Running;
                tx.create_task(t)?;
            }
            Ok(())
        })?;
        let order = store.write(|tx| abort_tree(tx, "root", "restart_limit"))?;
        assert_eq!(order, ["grandchild", "child", "root"]);
        store.read(|r| {
            assert_eq!(r.task("root")?.terminal_reason, "restart_limit");
            assert_eq!(r.task("child")?.terminal_reason, "aborted");
            assert_eq!(r.task("grandchild")?.terminal_reason, "aborted");
            Ok(())
        })
    }
}
