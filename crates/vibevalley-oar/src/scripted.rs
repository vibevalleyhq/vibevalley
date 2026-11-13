//! A runtime with no binary and no login: it replays a script. For tests and
//! for building UI against every event kind without spending quota.
//!
//! ```
//! use vibevalley_oar::scripted::{Script, ScriptedRuntime, Step};
//! use vibevalley_oar::{ContentBlock, EventKind, Runtime, SessionOptions};
//!
//! let runtime = ScriptedRuntime::new("scripted", Script::new().turn(vec![Step::text("hi {prompt}")]));
//! let session = runtime.open(SessionOptions { cwd: std::env::temp_dir(), ..Default::default() }).unwrap();
//! let events = session.events();
//! session.prompt(vec![ContentBlock::Text("there".into())]).unwrap();
//! let text = events.iter().find_map(|e| match e.kind {
//!     EventKind::TextDelta { text } => Some(text),
//!     _ => None,
//! });
//! assert_eq!(text.as_deref(), Some("hi there"));
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::core::{CoreSession, Driver, SessionCore, check_cwd, render_text};
use crate::record::{self, Recorder};
use crate::{
    AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, ModelInfo, PermissionDecision, Result, Runtime, Session, SessionOptions,
    StopReason, Usage,
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

struct TurnControl {
    abort: AtomicBool,
    answer: flume::Receiver<PermissionDecision>,
}

struct ScriptedDriver {
    core: Arc<SessionCore>,
    script: Script,
    /// The session's folder and appended system prompt, for computed turns.
    opened: (PathBuf, Option<String>),
    turn_index: AtomicUsize,
    current: Mutex<Option<Arc<TurnControl>>>,
    answers: flume::Sender<PermissionDecision>,
    answers_rx: flume::Receiver<PermissionDecision>,
}

enum Flow {
    Continue,
    EndTurn,
    Finished,
    Aborted,
}

fn run_steps(core: &SessionCore, control: &TurnControl, steps: &[Step], prompt: &str) -> Flow {
    for step in steps {
        if control.abort.load(Ordering::SeqCst) {
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
                let until = std::time::Instant::now() + *duration;
                while std::time::Instant::now() < until {
                    if control.abort.load(Ordering::SeqCst) {
                        return Flow::Aborted;
                    }
                    std::thread::sleep(Duration::from_millis(5).min(*duration));
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
                let decision = loop {
                    if control.abort.load(Ordering::SeqCst) {
                        return Flow::Aborted;
                    }
                    match control.answer.recv_timeout(Duration::from_millis(10)) {
                        Ok(decision) => break decision,
                        Err(flume::RecvTimeoutError::Timeout) => {}
                        Err(flume::RecvTimeoutError::Disconnected) => return Flow::Aborted,
                    }
                };
                if matches!(decision, PermissionDecision::Deny { .. }) {
                    return match run_steps(core, control, denied, prompt) {
                        Flow::Continue => Flow::EndTurn,
                        other => other,
                    };
                }
            }
        }
    }
    Flow::Continue
}

impl Driver for ScriptedDriver {
    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        let index = self.turn_index.fetch_add(1, Ordering::SeqCst);
        let steps = self.script.turns.get(index).or_else(|| self.script.turns.last()).cloned().unwrap_or_default();
        let computed = self.script.computed.clone();
        let opened = self.opened.clone();
        while self.answers_rx.try_recv().is_ok() {}
        let control = Arc::new(TurnControl {
            abort: AtomicBool::new(false),
            answer: self.answers_rx.clone(),
        });
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = Some(control.clone());
        let core = self.core.clone();
        let prompt = render_text(&content);
        std::thread::Builder::new()
            .name("vibevalley-agent-scripted".into())
            .spawn(move || {
                let steps = match &computed {
                    None => steps,
                    Some(turn) => match turn(&TurnAsk {
                        prompt: prompt.clone(),
                        turn: index,
                        cwd: opened.0.clone(),
                        append_system_prompt: opened.1.clone(),
                    }) {
                        Ok(steps) => steps,
                        Err(message) => {
                            core.emit_root(EventKind::Error { message });
                            core.emit_root(EventKind::TurnFinished {
                                reason: StopReason::Error,
                                usage: Usage::default(),
                            });
                            return;
                        }
                    },
                };
                let reason = match run_steps(&core, &control, &steps, &prompt) {
                    Flow::Finished => return,
                    Flow::Aborted => StopReason::Aborted,
                    Flow::Continue | Flow::EndTurn => StopReason::Completed,
                };
                core.emit_root(EventKind::TurnFinished {
                    reason,
                    usage: Usage::default(),
                });
            })
            .map_err(|e| AgentError::Io(e.to_string()))?;
        Ok(())
    }

    fn steer(&self, _content: Vec<ContentBlock>) -> Result<()> {
        Ok(())
    }

    fn abort(&self) -> Result<()> {
        if let Some(control) = self.current.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            control.abort.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    fn respond_permission(&self, _request_id: &str, decision: &PermissionDecision) -> Result<()> {
        self.answers.send(decision.clone()).map_err(|e| AgentError::Io(e.to_string()))
    }

    fn dispose(&self) {
        let _ = self.abort();
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
        self.capabilities.clone()
    }

    fn installation(&self) -> Installation {
        Installation::Available {
            version: Some(env!("CARGO_PKG_VERSION").into()),
            path: PathBuf::from("(built in)"),
        }
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Ok(self.models.clone())
    }

    /// Refuses `resume` (unless the capability was granted) and a model that
    /// is not in `list_models`. `append_system_prompt`, `env` and
    /// `permission_mode` are accepted and have no effect: a replay has no
    /// model to instruct and asks exactly where its script says.
    fn open(&self, opts: SessionOptions) -> Result<Arc<dyn Session>> {
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
        let (answers, answers_rx) = flume::unbounded();
        let driver = ScriptedDriver {
            core: core.clone(),
            script: self.script.clone(),
            opened: (opts.cwd.clone(), opts.append_system_prompt.clone()),
            turn_index: AtomicUsize::new(0),
            current: Mutex::new(None),
            answers,
            answers_rx,
        };
        Ok(CoreSession::new(core, driver, self.capabilities.clone()))
    }
}
