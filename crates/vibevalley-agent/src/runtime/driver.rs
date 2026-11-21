use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use vibevalley_oar::core::{CoreSession, Driver, SessionCore, render_text};
use vibevalley_oar::{
    AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, PermissionDecision, PermissionMode, Result, Session, StopReason, SubagentStatus, Usage,
};

use crate::ai::models::{charge_usd, deepseek_price};
use crate::core::doc::{CONVERSATION_SCOPE, GovernanceDoc, OarSessionDoc, OarSessionState, read_doc_opt, write_doc};
use crate::core::engine::{KIND as GENERATION_KIND, Request};
use crate::core::events::{AgentEvent, Brain, TurnOutcome};
use crate::core::inbox::{WhenBusy, submit_steer};
use crate::durable::{Error as StoreError, SubmissionStatus, Task, TaskStatus};
use crate::extensions::governance::{Decision, resolve};
use crate::harness::{SharedExecution, worker_conversation};

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
        permission_mode: PermissionMode,
        caps: Capabilities,
    ) -> Result<Arc<dyn Session>> {
        let conversation = worker_conversation(session);
        let mut commands: HashMap<String, (String, Value)> = HashMap::new();
        let sink = core.clone();
        let observer_cwd = cwd.clone();
        let observer = move |event| match event {
            AgentEvent::TextDelta { delta } => sink.emit_root(EventKind::TextDelta { text: delta }),
            AgentEvent::ReasoningDelta { delta } => sink.emit_root(EventKind::ThinkingDelta { text: delta }),
            AgentEvent::ToolStart { id, name, arguments } => {
                let input: Value = serde_json::from_str(&arguments).unwrap_or(Value::String(arguments));
                commands.insert(id.clone(), (name.clone(), input.clone()));
                sink.emit_root(EventKind::ToolCallStarted { id, name, input });
            }
            AgentEvent::ToolEnd { id, name: _, output } => {
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
                        path: observer_cwd.join(path),
                        change: if tool == "write" { FileChangeKind::Created } else { FileChangeKind::Modified },
                    });
                }
            }
            AgentEvent::PermissionRequested {
                task_id: _,
                tool_call_id,
                tool_name,
                arguments,
                reason,
            } => {
                let input: Value = serde_json::from_str(&arguments).unwrap_or(Value::String(arguments));
                sink.emit_root(EventKind::PermissionRequested {
                    request_id: tool_call_id,
                    tool: tool_name,
                    input,
                    summary: reason,
                });
            }
            AgentEvent::SubagentSpawned {
                parent_conversation_id,
                child_conversation_id,
                task_id: _,
                label,
                brief,
            } => {
                sink.emit_root(EventKind::SubagentSpawned {
                    parent_thread_id: parent_conversation_id,
                    thread_id: child_conversation_id,
                    task: (!brief.is_empty()).then_some(brief),
                    agent_name: (!label.is_empty()).then_some(label),
                });
            }
            AgentEvent::SubagentStatusChanged {
                child_conversation_id,
                task_id,
                status,
                message,
            } => {
                sink.emit_root(EventKind::SubagentStatusChanged {
                    thread_id: child_conversation_id,
                    turn_id: (!task_id.is_empty()).then_some(task_id),
                    status: map_subagent_status(&status),
                    message: (!message.is_empty()).then_some(message),
                });
            }
            AgentEvent::Error { message } => sink.emit_root(EventKind::Error { message }),
            AgentEvent::AgentStart
            | AgentEvent::TurnStart { .. }
            | AgentEvent::ToolUpdate { .. }
            | AgentEvent::Compacted { .. }
            | AgentEvent::TurnEnd { .. } => {}
            AgentEvent::AgentEnd {
                outcome: TurnOutcome::TooLong, ..
            } => {}
            AgentEvent::AgentEnd { .. } => {}
        };
        let observer = Mutex::new(observer);
        let brain = Arc::new(brain);

        execution
            .store()
            .write(|tx| {
                match tx.conversation(&conversation) {
                    Err(StoreError::Missing(_)) => {
                        tx.create_conversation(&conversation, &brain.model)?;
                    }
                    Ok(_) => (),
                    Err(e) => return Err(e),
                }
                write_doc::<OarSessionDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    &conversation,
                    &OarSessionState {
                        runtime_id: "vibevalley".into(),
                        vendor_session_id: session.into(),
                        cwd: cwd.display().to_string(),
                        permission_mode: permission_mode_str(permission_mode).into(),
                        status: "open".into(),
                    },
                )?;
                Ok(())
            })
            .map_err(failed)?;

        let (unfinished, pending_approvals) = execution
            .store()
            .read(|tx| {
                let task = tx
                    .tasks_by_conversation(&conversation)?
                    .into_iter()
                    .find(|t| t.kind == GENERATION_KIND && t.status != TaskStatus::Terminal);
                let gov = read_doc_opt::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conversation)?;
                let approvals: Vec<_> = gov.map(|g| g.pending_permissions.into_values().collect()).unwrap_or_default();
                Ok((task, approvals))
            })
            .map_err(failed)?;

        // Register the resumed turn in `SessionCore` before `attach_worker` wakes any sleeping task
        // so resumed stream/permission events strictly follow `TurnStarted`.
        if let Some(ref task) = unfinished {
            let prompt = task.checkpoint["prompt"].as_str().unwrap_or_default();
            core.begin_turn(prompt)?;
            for pending in pending_approvals {
                core.emit_root(EventKind::PermissionRequested {
                    request_id: pending.tool_call_id,
                    tool: pending.tool_name,
                    input: pending.args_json,
                    summary: pending.evaluation.reason,
                });
            }
        }

        execution
            .harness
            .attach_worker(&conversation, brain.clone(), Arc::new(move |e| observer.lock().unwrap()(e)))
            .map_err(failed)?;

        let driver = Self {
            execution,
            conversation,
            brain,
            core,
            active: Default::default(),
        };
        if let Some(task) = unfinished {
            driver.follow(task)?;
        }
        Ok(CoreSession::new(driver.core.clone(), driver, caps))
    }

    fn follow(&self, task: Task) -> Result<()> {
        let shared = self.execution.clone();
        let core = self.core.clone();
        let active = self.active.clone();
        let model = self.brain.model.clone();
        *active.lock().unwrap() = Some(task.id.clone());
        std::thread::Builder::new()
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
                    let usage: crate::ai::types::Usage = serde_json::from_value(result.result["usage"].clone()).unwrap_or_default();
                    let reason = if result.result["maxIterationsReached"] == true {
                        let verdict = &result.result["rubricVerdict"];
                        let unmet = verdict["unmetItems"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ");
                        core.emit_root(EventKind::Error {
                            message: format!(
                                "{}{}{}",
                                verdict["summary"].as_str().unwrap_or_default(),
                                if unmet.is_empty() { "" } else { ": " },
                                unmet
                            ),
                        });
                        StopReason::MaxTurns
                    } else {
                        StopReason::Completed
                    };
                    core.emit_root(EventKind::TurnFinished {
                        reason,
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
                        let _ = shared.store().write(|tx| {
                            tx.settle(
                                sub,
                                SubmissionStatus::Unanswered,
                                &serde_json::json!({ "reason": result.terminal_reason, "error": result.error_text }),
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
        let span = self.core.span_id();
        let key = if span.starts_with("work:") { span } else { uuid::Uuid::now_v7().to_string() };
        let (_, task, _) = self
            .execution
            .harness
            .submit(Request {
                conversation: &self.conversation,
                provider: &self.brain.model,
                request_id: &key,
                prompt: &prompt,
                source: "agent",
                system: &self.brain.system,
                when_busy: WhenBusy::Reject,
                ..Default::default()
            })
            .map_err(failed)?;
        self.follow(task)
    }

    fn steer(&self, content: Vec<ContentBlock>) -> Result<()> {
        let prompt = render_text(&content);
        let key = uuid::Uuid::now_v7().to_string();
        self.execution
            .store()
            .write(|tx| submit_steer(tx, &self.conversation, &key, &prompt))
            .map_err(failed)?;
        Ok(())
    }

    fn abort(&self) -> Result<()> {
        if let Some(id) = self.active.lock().unwrap().as_deref() {
            self.execution.scheduler.abort(id).map_err(failed)?;
        }
        Ok(())
    }

    fn respond_permission(&self, id: &str, decision: &PermissionDecision) -> Result<()> {
        let task = self
            .execution
            .store()
            .read(|tx| {
                let gov = read_doc_opt::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &self.conversation)?;
                Ok(gov.and_then(|g| g.pending_permissions.into_values().find(|p| p.tool_call_id == id).map(|p| p.task_id)))
            })
            .map_err(failed)?
            .or_else(|| self.active.lock().unwrap().clone())
            .ok_or_else(|| AgentError::Rejected(format!("unknown_request: {id}")))?;
        let (approved, reason) = match decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => (true, String::new()),
            PermissionDecision::Deny { message } => (false, message.clone().unwrap_or_default()),
        };
        resolve(
            self.execution.store(),
            &self.execution.scheduler,
            &self.conversation,
            &task,
            Decision {
                tool_call_id: id.into(),
                approved,
                reason,
            },
        )
        .map_err(failed)
    }

    fn dispose(&self) {
        let _ = self.abort();
        self.execution.workers().detach(&self.conversation);
    }
}

fn permission_mode_str(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "ask",
        PermissionMode::AcceptEdits => "accept_edits",
        PermissionMode::Bypass => "bypass",
        PermissionMode::Plan => "plan",
    }
}

fn map_subagent_status(status: &str) -> SubagentStatus {
    match status {
        "pending_init" => SubagentStatus::PendingInit,
        "running" => SubagentStatus::Running,
        "interrupted" => SubagentStatus::Interrupted,
        "completed" => SubagentStatus::Completed,
        "errored" => SubagentStatus::Errored,
        "shutdown" => SubagentStatus::Shutdown,
        _ => SubagentStatus::NotFound,
    }
}

fn failed(e: StoreError) -> AgentError {
    AgentError::Io(e.to_string())
}
