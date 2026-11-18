use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use vibevalley_agent::{
    Brain, BrainEvent,
    generation::{
        Request,
        workers::{SharedExecution, worker_conversation},
    },
    price::{charge_usd, deepseek_price},
};
use vibevalley_durable::{Error as StoreError, SubmissionStatus, Task, TaskStatus};

use crate::core::{CoreSession, Driver, SessionCore, render_text};
use crate::{AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, PermissionDecision, Result, Session, StopReason, Usage};

pub(crate) struct WorkerDriver {
    execution: SharedExecution,
    conversation: String,
    brain: Arc<Brain>,
    core: Arc<SessionCore>,
    active: Arc<Mutex<Option<String>>>,
}

impl WorkerDriver {
    pub(crate) fn open(
        execution: SharedExecution,
        session: &str,
        brain: Brain,
        core: Arc<SessionCore>,
        cwd: PathBuf,
        caps: Capabilities,
    ) -> Result<Arc<dyn Session>> {
        let conversation = worker_conversation(session);
        let mut commands = HashMap::new();
        let sink = core.clone();
        let observer = move |event| match event {
            BrainEvent::Text(text) => sink.emit_root(EventKind::TextDelta { text }),
            BrainEvent::Reasoning(text) => sink.emit_root(EventKind::ThinkingDelta { text }),
            BrainEvent::ToolStarted { id, name, arguments } => {
                let input: Value = serde_json::from_str(&arguments).unwrap_or(Value::String(arguments));
                commands.insert(id.clone(), (name.clone(), input.clone()));
                sink.emit_root(EventKind::ToolCallStarted { id, name, input });
            }
            BrainEvent::ToolFinished { id, output } => {
                let ok = !output.is_error;
                sink.emit_root(EventKind::ToolCallFinished {
                    id: id.clone(),
                    ok,
                    output: output.text,
                });
                if let Some((tool, input)) = commands.remove(&id)
                    && ok
                    && matches!(tool.as_str(), "write" | "edit")
                    && let Some(path) = input["path"].as_str()
                {
                    sink.emit_root(EventKind::FileChanged {
                        path: cwd.join(path),
                        change: if tool == "write" { FileChangeKind::Created } else { FileChangeKind::Modified },
                    });
                }
            }
            BrainEvent::Error(message) => sink.emit_root(EventKind::Error { message }),
            _ => (),
        };
        let observer = Mutex::new(observer);
        let brain = Arc::new(brain);
        execution
            .generation
            .store
            .write(|tx| {
                match tx.conversation(&conversation) {
                    Err(StoreError::Missing(_)) => {
                        tx.create_conversation(&conversation, &brain.model)?;
                    }
                    Ok(_) => (),
                    Err(e) => return Err(e),
                }
                Ok(())
            })
            .map_err(failed)?;
        execution
            .generation
            .workers
            .attach(&conversation, brain.clone(), Arc::new(move |e| observer.lock().unwrap()(e)))
            .map_err(failed)?;
        let driver = Self {
            execution,
            conversation,
            brain,
            core: core.clone(),
            active: Default::default(),
        };
        let unfinished = driver
            .execution
            .generation
            .store
            .read(|tx| {
                Ok(tx
                    .tasks_by_conversation(&driver.conversation)?
                    .into_iter()
                    .find(|t| t.status != TaskStatus::Terminal))
            })
            .map_err(failed)?;
        if let Some(task) = unfinished {
            let prompt = task.checkpoint["prompt"].as_str().unwrap_or_default();
            core.begin_turn(prompt)?;
            driver
                .execution
                .scheduler
                .send_signal(&task.id, vibevalley_agent::generation::workers::ATTACHED, None, &Value::Null)
                .map_err(failed)?;
            driver.follow(task)?;
        }
        Ok(CoreSession::new(core, driver, caps))
    }
    fn follow(&self, task: Task) -> Result<()> {
        let shared = self.execution.clone();
        let core = self.core.clone();
        let active = self.active.clone();
        let model = self.brain.model.clone();
        *active.lock().unwrap() = Some(task.id.clone());
        thread::Builder::new()
            .name(format!("oar-{}", task.id))
            .spawn(move || {
                let result = shared.scheduler.wait(&task.id, Duration::from_secs(60 * 60 * 24 * 365));
                let mut guard = active.lock().unwrap();
                if guard.as_deref() != Some(&task.id) {
                    return;
                }
                *guard = None;
                drop(guard);
                let result = match result {
                    Ok(done) => done,
                    Err(StoreError::Closed) => return,
                    Err(e) => {
                        core.emit_root(EventKind::Error { message: e.to_string() });
                        core.emit_root(EventKind::TurnFinished {
                            reason: StopReason::Error,
                            usage: Usage::default(),
                        });
                        return;
                    }
                };
                if result.terminal_reason == "completed" {
                    let usage: vibevalley_agent::Usage = serde_json::from_value(result.result["usage"].clone()).unwrap_or_default();
                    core.emit_root(EventKind::TurnFinished {
                        reason: StopReason::Completed,
                        usage: Usage {
                            input_tokens: Some(usage.input),
                            output_tokens: Some(usage.output),
                            cost_usd: deepseek_price(&model).map(|p| charge_usd(p, usage)),
                        },
                    });
                } else {
                    if !result.error_text.is_empty() {
                        core.emit_root(EventKind::Error {
                            message: result.error_text.clone(),
                        });
                    }
                    if let Some(sub) = task.checkpoint["submission"].as_str() {
                        let _ = shared.generation.store.write(|tx| {
                            tx.settle(
                                sub,
                                SubmissionStatus::Unanswered,
                                &serde_json::json!({"reason":result.terminal_reason,"error":result.error_text}),
                            )
                        });
                    }
                    core.emit_root(EventKind::TurnFinished {
                        reason: if result.terminal_reason == "aborted" {
                            StopReason::Aborted
                        } else {
                            StopReason::Error
                        },
                        usage: Usage::default(),
                    });
                }
            })
            .map_err(|e| AgentError::Io(e.to_string()))?;
        Ok(())
    }
}
impl Driver for WorkerDriver {
    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        let prompt = render_text(&content);
        let (_, task, _) = self
            .execution
            .generation
            .submit(Request {
                conversation: &self.conversation,
                provider: &self.brain.model,
                request_id: &uuid::Uuid::now_v7().to_string(),
                prompt: &prompt,
                source: "agent",
                system: &self.brain.system,
                ..Request::default()
            })
            .map_err(failed)?;
        self.follow(task)
    }
    fn steer(&self, _: Vec<ContentBlock>) -> Result<()> {
        Err(AgentError::Unsupported {
            option: "steer".into(),
            reason: "the vibevalley runtime queues instead".into(),
        })
    }
    fn abort(&self) -> Result<()> {
        if let Some(id) = self.active.lock().unwrap().as_deref() {
            self.execution.scheduler.abort(id).map_err(failed)?;
        }
        Ok(())
    }
    fn respond_permission(&self, id: &str, decision: &PermissionDecision) -> Result<()> {
        let task = self
            .active
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Rejected("no_active_turn".into()))?;
        let (approved, reason) = match decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => (true, String::new()),
            PermissionDecision::Deny { message } => (false, message.clone().unwrap_or_default()),
        };
        vibevalley_agent::generation::governance::resolve(
            &self.execution.generation.store,
            &self.execution.scheduler,
            &self.conversation,
            &task,
            vibevalley_agent::generation::governance::Decision {
                tool_call_id: id.into(),
                approved,
                reason,
            },
        )
        .map_err(failed)
    }
    fn dispose(&self) {
        let _ = self.abort();
        self.execution.generation.workers.detach(&self.conversation);
    }
}
fn failed(e: StoreError) -> AgentError {
    AgentError::Io(e.to_string())
}
