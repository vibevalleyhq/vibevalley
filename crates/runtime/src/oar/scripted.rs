//! A runtime with no binary and no login: it replays a script. For tests and
//! for building UI against every event kind without spending quota.
//!
//! ```no_run
//! use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
//! use vibevalley_runtime::oar::{ContentBlock, EventKind, Runtime, SessionOptions};
//!
//! # async fn example() {
//! let runtime = ScriptedRuntime::new("scripted", Script::new().turn(vec![Step::text("hi {prompt}")]));
//! let session = runtime.open(SessionOptions { cwd: std::env::temp_dir(), ..Default::default() }).await.unwrap();
//! let mut events = session.events();
//! session.prompt(vec![ContentBlock::Text("there".into())]).await.unwrap();
//! let mut text = None;
//! while let Some(e) = events.recv().await {
//!     if let EventKind::TextDelta { text: t } = e.kind {
//!         text = Some(t);
//!         break;
//!     }
//! }
//! assert_eq!(text.as_deref(), Some("hi there"));
//! # }
//! ```

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::BoxFuture;

use crate::oar::core::{CoreSession, Driver, SessionCore, check_cwd, render_text};
use crate::oar::record::{self, Recorder};
use crate::oar::{
    AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, McpServer, ModelInfo, PermissionDecision, Result, Runtime, Session,
    SessionOptions, StopReason, Usage,
};

#[derive(Debug, Clone)]
pub enum Step {
    /// A root-agent event. `{prompt}` inside text deltas becomes the prompt.
    Emit(EventKind),
    /// An event from a subagent (`agent_path`).
    EmitFrom(Vec<String>, EventKind),
    Sleep(Duration),
    /// Emits `PermissionRequested` and waits for `respond_permission`. When
    /// the answer is a denial, `denied` runs and the rest of the turn is
    /// skipped.
    Permission {
        request_id: String,
        tool: String,
        input: serde_json::Value,
        summary: String,
        denied: Vec<Step>,
    },
}

impl Step {
    pub fn text(text: impl Into<String>) -> Self {
        Step::Emit(EventKind::TextDelta { text: text.into() })
    }

    pub fn thinking(text: impl Into<String>) -> Self {
        Step::Emit(EventKind::ThinkingDelta { text: text.into() })
    }

    pub fn sleep_ms(ms: u64) -> Self {
        Step::Sleep(Duration::from_millis(ms))
    }

    pub fn finish(reason: StopReason) -> Self {
        Step::Emit(EventKind::TurnFinished {
            reason,
            usage: Usage::default(),
        })
    }
}

/// What a computed turn is given: the prompt, which turn of the session it
/// is, and how the session was opened.
pub struct TurnAsk {
    pub prompt: String,
    pub turn: usize,
    pub cwd: PathBuf,
    pub append_system_prompt: Option<String>,
    /// The MCP servers the session was opened with: a stand-in agent calls their tools as a real one would.
    pub mcp_servers: Vec<McpServer>,
}

/// A turn computed when it is asked (tests' stand-in agents): its steps, or
/// the error that fails it. It runs on the turn's own thread.
pub type ComputedTurn = Arc<dyn Fn(&TurnAsk) -> std::result::Result<Vec<Step>, String> + Send + Sync>;

/// One step list per turn; the last list repeats for further prompts. A turn
/// whose steps do not end it is ended with `StopReason::Completed`.
#[derive(Clone, Default)]
pub struct Script {
    turns: Vec<Vec<Step>>,
    computed: Option<ComputedTurn>,
}

impl std::fmt::Debug for Script {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Script")
            .field("turns", &self.turns)
            .field("computed", &self.computed.is_some())
            .finish()
    }
}

impl Script {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn turn(mut self, steps: Vec<Step>) -> Self {
        self.turns.push(steps);
        self
    }

    /// Every turn computed by `turn` when it is asked.
    pub fn computed(turn: ComputedTurn) -> Self {
        Self {
            turns: vec![],
            computed: Some(turn),
        }
    }

    /// Every prompt is answered with its own text.
    pub fn echo() -> Self {
        Self::new().turn(vec![Step::text("{prompt}")])
    }

    /// A tour of every event kind: thinking, text, a tool call behind a
    /// permission request, a file change, a subagent, usage; the second
    /// prompt gets a question.
    pub fn demo() -> Self {
        let input = json!({ "file_path": "notes.txt", "content": "hello" });
        Self::new()
            .turn(vec![
                Step::thinking("The user wants: {prompt}. "),
                Step::sleep_ms(150),
                Step::thinking("I will write a file."),
                Step::text("I'll create "),
                Step::sleep_ms(100),
                Step::text("`notes.txt`.\n"),
                Step::Emit(EventKind::ToolCallStarted {
                    id: "tool-1".into(),
                    name: "Write".into(),
                    input: input.clone(),
                }),
                Step::Permission {
                    request_id: "perm-1".into(),
                    tool: "Write".into(),
                    input,
                    summary: "Write notes.txt".into(),
                    denied: vec![
                        Step::Emit(EventKind::ToolCallFinished {
                            id: "tool-1".into(),
                            ok: false,
                            output: "permission denied".into(),
                        }),
                        Step::text("I did not write the file."),
                    ],
                },
                Step::sleep_ms(150),
                Step::Emit(EventKind::ToolCallFinished {
                    id: "tool-1".into(),
                    ok: true,
                    output: "File created".into(),
                }),
                Step::Emit(EventKind::FileChanged {
                    path: PathBuf::from("notes.txt"),
                    change: FileChangeKind::Created,
                }),
                Step::Emit(EventKind::ToolCallStarted {
                    id: "task-1".into(),
                    name: "Task".into(),
                    input: json!({ "description": "review the note" }),
                }),
                Step::EmitFrom(
                    vec!["task-1".into()],
                    EventKind::TextDelta {
                        text: "The note looks fine.".into(),
                    },
                ),
                Step::Emit(EventKind::ToolCallFinished {
                    id: "task-1".into(),
                    ok: true,
                    output: "The note looks fine.".into(),
                }),
                Step::text("Done."),
                Step::Emit(EventKind::TurnFinished {
                    reason: StopReason::Completed,
                    usage: Usage {
                        input_tokens: Some(1200),
                        output_tokens: Some(85),
                        cost_usd: Some(0.0042),
                        ..Default::default()
                    },
                }),
            ])
            .turn(vec![
                Step::text("Before I continue: "),
                Step::Emit(EventKind::Question {
                    text: "Which file should I change next?".into(),
                }),
            ])
    }
}

pub struct ScriptedRuntime {
    id: String,
    display_name: String,
    script: Script,
    capabilities: Capabilities,
    models: Vec<ModelInfo>,
    opened: AtomicUsize,
}

impl ScriptedRuntime {
    pub fn new(id: impl Into<String>, script: Script) -> Self {
        Self {
            id: id.into(),
            display_name: "Scripted (testing)".into(),
            script,
            capabilities: Capabilities {
                resume: false,
                steer: true,
                queue: true,
                permission_requests: true,
                model_selection: true,
                subagents: true,
                usage: true,
                config_options: false,
            },
            models: vec![
                ModelInfo::new("scripted-small", "Scripted Small"),
                ModelInfo::new("scripted-large", "Scripted Large"),
            ],
            opened: AtomicUsize::new(0),
        }
    }

    /// The `scripted` runtime `default_runtimes()` registers.
    pub fn demo() -> Self {
        Self::new("scripted", Script::demo())
    }

    /// Narrows what the runtime claims, to exercise refusals.
    pub fn with_capabilities(mut self, capabilities: Capabilities) -> Self {
        self.capabilities = capabilities;
        self
    }
}

/// The refusals that follow from `Capabilities` alone.
pub(crate) fn refuse_by_capabilities(runtime: &str, capabilities: &Capabilities, opts: &SessionOptions) -> Result<()> {
    if opts.resume.is_some() && !capabilities.resume {
        return Err(AgentError::Unsupported {
            option: "resume".into(),
            reason: format!("{runtime} cannot resume a session"),
        });
    }
    if opts.model.is_some() && !capabilities.model_selection {
        return Err(AgentError::Unsupported {
            option: "model".into(),
            reason: format!("{runtime} cannot select a model"),
        });
    }
    Ok(())
}

struct ScriptedDriver {
    core: Arc<SessionCore>,
    script: Script,
    /// The session's folder and appended system prompt, for computed turns.
    opened: (PathBuf, Option<String>, Vec<McpServer>),
    turn_index: AtomicUsize,
    session_cancel: CancellationToken,
    _cancel_guard: DropGuard,
    current: Mutex<Option<CancellationToken>>,
    answers: mpsc::UnboundedSender<PermissionDecision>,
    answers_rx: Arc<AsyncMutex<mpsc::UnboundedReceiver<PermissionDecision>>>,
}

enum Flow {
    Continue,
    EndTurn,
    Finished,
    Aborted,
}

fn run_steps<'a>(
    core: &'a SessionCore,
    cancel: &'a CancellationToken,
    answer: &'a mut mpsc::UnboundedReceiver<PermissionDecision>,
    steps: &'a [Step],
    prompt: &'a str,
) -> Pin<Box<dyn Future<Output = Flow> + Send + 'a>> {
    Box::pin(async move {
        if cancel.is_cancelled() {
            return Flow::Aborted;
        }
        for step in steps {
            if cancel.is_cancelled() {
                return Flow::Aborted;
            }
            match step {
                Step::Emit(kind) | Step::EmitFrom(_, kind) => {
                    let path = match step {
                        Step::EmitFrom(path, _) => path.clone(),
                        _ => Vec::new(),
                    };
                    let kind = match kind {
                        EventKind::TextDelta { text } => EventKind::TextDelta {
                            text: text.replace("{prompt}", prompt),
                        },
                        EventKind::ThinkingDelta { text } => EventKind::ThinkingDelta {
                            text: text.replace("{prompt}", prompt),
                        },
                        other => other.clone(),
                    };
                    let finished = path.is_empty() && matches!(kind, EventKind::TurnFinished { .. });
                    core.emit(path, kind);
                    if finished {
                        return Flow::Finished;
                    }
                }
                Step::Sleep(duration) => {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Flow::Aborted,
                        _ = tokio::time::sleep(*duration) => {}
                    }
                }
                Step::Permission {
                    request_id,
                    tool,
                    input,
                    summary,
                    denied,
                } => {
                    core.emit_root(EventKind::PermissionRequested {
                        request_id: request_id.clone(),
                        tool: tool.clone(),
                        input: input.clone(),
                        summary: summary.clone(),
                    });
                    let decision = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Flow::Aborted,
                        res = answer.recv() => match res {
                            Some(decision) => decision,
                            None => return Flow::Aborted,
                        },
                    };
                    if matches!(decision, PermissionDecision::Deny { .. }) {
                        return match run_steps(core, cancel, answer, denied, prompt).await {
                            Flow::Continue => Flow::EndTurn,
                            other => other,
                        };
                    }
                }
            }
        }
        Flow::Continue
    })
}

impl Driver for ScriptedDriver {
    fn start_turn(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let index = self.turn_index.fetch_add(1, Ordering::SeqCst);
            let steps = self.script.turns.get(index).or_else(|| self.script.turns.last()).cloned().unwrap_or_default();
            let computed = self.script.computed.clone();
            let opened = self.opened.clone();
            {
                let mut rx = self.answers_rx.lock().await;
                while rx.try_recv().is_ok() {}
            }
            let cancel = self.session_cancel.child_token();
            *self.current.lock() = Some(cancel.clone());
            let answers_rx = Arc::clone(&self.answers_rx);
            let core = self.core.clone();
            let prompt = render_text(&content);
            crate::rt::current_or_global_handle().spawn(async move {
                let steps = match computed {
                    None => steps,
                    Some(turn) => {
                        // Computed test callbacks may perform blocking git/HTTP work (e.g. `reqwest::blocking`).
                        let ask = TurnAsk {
                            prompt: prompt.clone(),
                            turn: index,
                            cwd: opened.0,
                            append_system_prompt: opened.1,
                            mcp_servers: opened.2,
                        };
                        match tokio::task::spawn_blocking(move || turn(&ask)).await {
                            Ok(Ok(steps)) => steps,
                            Ok(Err(message)) => {
                                core.emit_root(EventKind::Error { message });
                                core.emit_root(EventKind::TurnFinished {
                                    reason: StopReason::Error,
                                    usage: Usage::default(),
                                });
                                return;
                            }
                            Err(err) => {
                                core.emit_root(EventKind::Error {
                                    message: format!("scripted turn panicked: {err}"),
                                });
                                core.emit_root(EventKind::TurnFinished {
                                    reason: StopReason::Error,
                                    usage: Usage::default(),
                                });
                                return;
                            }
                        }
                    }
                };
                let mut answer = answers_rx.lock().await;
                let reason = match run_steps(&core, &cancel, &mut answer, &steps, &prompt).await {
                    Flow::Finished => return,
                    Flow::Aborted => StopReason::Aborted,
                    Flow::Continue | Flow::EndTurn => StopReason::Completed,
                };
                drop(answer);
                core.emit_root(EventKind::TurnFinished {
                    reason,
                    usage: Usage::default(),
                });
            });
            Ok(())
        })
    }

    fn steer(&self, _content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn abort(&self) -> BoxFuture<'_, Result<()>> {
        if let Some(cancel) = self.current.lock().as_ref() {
            cancel.cancel();
        }
        Box::pin(async { Ok(()) })
    }

    fn respond_permission<'a>(&'a self, _request_id: &'a str, decision: &'a PermissionDecision) -> BoxFuture<'a, Result<()>> {
        let res = self.answers.send(decision.clone()).map_err(|e| AgentError::Io(e.to_string()));
        Box::pin(async move { res })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        self.signal_dispose();
        Box::pin(async {})
    }

    fn signal_dispose(&self) {
        self.session_cancel.cancel();
        if let Some(cancel) = self.current.lock().as_ref() {
            cancel.cancel();
        }
    }
}

impl Runtime for ScriptedRuntime {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    fn installation(&self) -> BoxFuture<'_, Installation> {
        Box::pin(async {
            Installation::Available {
                version: Some(env!("CARGO_PKG_VERSION").into()),
                path: PathBuf::from("(built in)"),
            }
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>> {
        let models = self.models.clone();
        Box::pin(async move { Ok(models) })
    }

    /// Refuses `resume` (unless the capability was granted) and a model that
    /// is not in `list_models`. `append_system_prompt`, `env` and
    /// `permission_mode` are accepted and have no effect: a replay has no
    /// model to instruct and asks exactly where its script says.
    fn open(&self, opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>> {
        Box::pin(async move {
            refuse_by_capabilities(&self.id, &self.capabilities, &opts)?;
            if let Some(model) = &opts.model
                && !self.models.iter().any(|m| &m.id == model)
            {
                return Err(AgentError::Unsupported {
                    option: "model".into(),
                    reason: format!("{} has no model `{model}`", self.id),
                });
            }
            check_cwd(&opts.cwd)?;
            let file = record::open_file(opts.record_to.as_deref())?;
            let session_id = opts
                .resume
                .clone()
                .unwrap_or_else(|| format!("scripted-{}", self.opened.fetch_add(1, Ordering::SeqCst) + 1));
            let recorder = Recorder::start(file, &self.id, &session_id, &opts.cwd, opts.model.as_deref());
            let core = SessionCore::new(&self.id, &session_id, recorder);
            core.emit_root(EventKind::SessionStarted {
                session_id,
                model: opts.model.clone(),
            });
            let (answers, answers_rx) = mpsc::unbounded_channel();
            let session_cancel = CancellationToken::new();
            let _cancel_guard = session_cancel.clone().drop_guard();
            let driver = ScriptedDriver {
                core: core.clone(),
                script: self.script.clone(),
                opened: (opts.cwd.clone(), opts.append_system_prompt.clone(), opts.mcp_servers.clone()),
                turn_index: AtomicUsize::new(0),
                session_cancel,
                _cancel_guard,
                current: Mutex::new(None),
                answers,
                answers_rx: Arc::new(AsyncMutex::new(answers_rx)),
            };
            Ok(CoreSession::new(core, driver, self.capabilities) as Arc<dyn Session>)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain_events(rx: &mut mpsc::UnboundedReceiver<crate::oar::Event>) -> Vec<crate::oar::Event> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn scripted_driver_delayed_turn_advances_on_virtual_clock() {
        let wall = std::time::Instant::now();
        let runtime = ScriptedRuntime::new(
            "scripted-delay",
            Script::new().turn(vec![Step::text("before "), Step::Sleep(Duration::from_secs(30)), Step::text("after")]),
        );
        let session = runtime
            .open(SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut events = session.events();
        session.prompt(vec![ContentBlock::Text("go".into())]).await.unwrap();

        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        let early = drain_events(&mut events);
        assert!(
            early.iter().any(|e| matches!(&e.kind, EventKind::TextDelta { text } if text == "before ")),
            "expected first delta before sleep: {early:?}"
        );
        assert!(
            !early.iter().any(|e| matches!(e.kind, EventKind::TurnFinished { .. })),
            "turn should still be sleeping at 29s: {early:?}"
        );

        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let tail = drain_events(&mut events);
        assert!(
            tail.iter().any(|e| matches!(&e.kind, EventKind::TextDelta { text } if text == "after")),
            "expected second delta after 30s: {tail:?}"
        );
        assert!(
            tail.iter().any(|e| matches!(
                e.kind,
                EventKind::TurnFinished {
                    reason: StopReason::Completed,
                    ..
                }
            )),
            "expected Completed TurnFinished: {tail:?}"
        );
        assert!(wall.elapsed() < Duration::from_secs(1), "virtual clock took {:?}", wall.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn scripted_driver_cancels_sleeping_turn_instantly() {
        let wall = std::time::Instant::now();
        let runtime = ScriptedRuntime::new(
            "scripted-cancel",
            Script::new().turn(vec![Step::Sleep(Duration::from_secs(600)), Step::text("unreachable")]),
        );
        let session = runtime
            .open(SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut events = session.events();
        session.prompt(vec![ContentBlock::Text("wait".into())]).await.unwrap();

        tokio::task::yield_now().await;
        session.abort().await.unwrap();
        let finished = tokio::time::timeout(Duration::from_millis(10), async {
            loop {
                let event = events.recv().await.unwrap();
                if let EventKind::TurnFinished { reason, .. } = event.kind {
                    return reason;
                }
            }
        })
        .await
        .expect("abort should finish sleeping turn immediately");
        assert_eq!(finished, StopReason::Aborted);
        assert!(wall.elapsed() < Duration::from_secs(1), "cancel took {:?}", wall.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn scripted_driver_cancels_permission_wait_instantly() {
        let wall = std::time::Instant::now();
        let runtime = ScriptedRuntime::new(
            "scripted-perm-cancel",
            Script::new().turn(vec![Step::Permission {
                request_id: "perm-1".into(),
                tool: "Bash".into(),
                input: json!({ "command": "echo hi" }),
                summary: "Run echo".into(),
                denied: vec![Step::text("denied")],
            }]),
        );
        let session = runtime
            .open(SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut events = session.events();
        session.prompt(vec![ContentBlock::Text("ask".into())]).await.unwrap();

        tokio::time::timeout(Duration::from_millis(10), async {
            loop {
                let event = events.recv().await.unwrap();
                if matches!(event.kind, EventKind::PermissionRequested { .. }) {
                    return;
                }
            }
        })
        .await
        .expect("permission request should arrive");

        session.abort().await.unwrap();
        let finished = tokio::time::timeout(Duration::from_millis(10), async {
            loop {
                let event = events.recv().await.unwrap();
                if let EventKind::TurnFinished { reason, .. } = event.kind {
                    return reason;
                }
            }
        })
        .await
        .expect("abort should finish permission wait immediately");
        assert_eq!(finished, StopReason::Aborted);
        assert!(wall.elapsed() < Duration::from_secs(1), "cancel took {:?}", wall.elapsed());
    }
}
