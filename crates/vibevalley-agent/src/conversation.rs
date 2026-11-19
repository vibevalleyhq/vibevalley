//! A durable conversation: every input, answer, tool call and tool result is
//! appended to a JSONL transcript before it is shown, so a turn cut short by
//! a crash or a quit is finished on the next start. This is what VibeValley
//! gets from pi-durable (`docs/subsystems/brain.md`): one conversation per
//! session, write before display, resume the unfinished turn, tools that
//! change things are not replayed, compaction when the prompt grows.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::model::{ChatRequest, Delta, Message, ModelClient, Role, ToolCall, Usage};
use crate::tool::{Tool, ToolOutput};
use crate::{BrainError, Result};

/// One line of the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "entry", rename_all = "snake_case")]
pub enum Entry {
    TurnStarted {
        input: String,
    },
    Message {
        message: Message,
        usage: Option<Usage>,
    },
    /// Written right before a tool runs; a call with this and no result was
    /// cut off while running.
    ToolStarted {
        id: String,
    },
    /// Everything before it is replaced by `summary` when the transcript is
    /// read back.
    Compacted {
        summary: String,
    },
    TurnFinished {
        outcome: TurnOutcome,
        usage: Usage,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    Aborted,
    Failed,
    /// Hit the step limit.
    TooLong,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BrainEvent {
    TurnStarted { input: String, resumed: bool },
    Text(String),
    Reasoning(String),
    ToolStarted { id: String, name: String, arguments: String },
    ToolFinished { id: String, output: ToolOutput },
    Compacted,
    TurnFinished { outcome: TurnOutcome, usage: Usage, text: String },
    Error(String),
}

/// The fixed parts of a conversation.
pub struct Brain {
    pub client: Arc<dyn ModelClient>,
    pub model: String,
    pub effort: Option<String>,
    pub system: String,
    pub tools: Vec<Box<dyn Tool>>,
    /// Compact when a request's prompt reaches this many tokens.
    pub compact_at: u64,
    /// Model requests per turn before giving up.
    pub max_steps: usize,
}

impl Brain {
    pub fn new(client: Arc<dyn ModelClient>, model: impl Into<String>, system: impl Into<String>) -> Brain {
        Brain {
            client,
            model: model.into(),
            effort: None,
            system: system.into(),
            tools: Vec::new(),
            compact_at: 120_000,
            max_steps: 200,
        }
    }

    fn tool(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.iter().map(|t| t.as_ref()).find(|t| t.spec().name == name)
    }
}

pub struct TurnAbort {
    state: Mutex<TurnSignal>,
}

struct TurnSignal {
    sender: Option<flume::Sender<()>>,
    receiver: flume::Receiver<()>,
}

impl TurnSignal {
    fn open() -> Self {
        let (sender, receiver) = flume::bounded(0);
        Self {
            sender: Some(sender),
            receiver,
        }
    }
}

impl TurnAbort {
    pub fn abort(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).sender.take();
    }

    fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.sender.is_none() {
            *state = TurnSignal::open();
        }
    }

    fn signal(&self) -> flume::Receiver<()> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).receiver.clone()
    }
}

pub struct Conversation {
    brain: Brain,
    path: PathBuf,
    file: File,
    entries: Vec<Entry>,
    abort: Arc<TurnAbort>,
}

const COMPACT_PROMPT: &str = "Summarize the conversation so far for yourself, so that you can continue the work \
    without it: the goal, decisions made, what was done (files, commands, results), what is left, and anything the \
    user asked you to remember. Be complete but brief. Reply with the summary only.";

impl Conversation {
    /// Opens (or creates) the conversation stored at `path`.
    pub fn open(path: impl Into<PathBuf>, brain: Brain) -> Result<Conversation> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let mut file = OpenOptions::new().create(true).read(true).append(true).open(&path).map_err(io)?;
        let (entries, committed, newline) = read_transcript(&file)?;
        if committed != file.metadata().map_err(io)?.len() {
            file.set_len(committed).map_err(io)?;
            file.sync_data().map_err(io)?;
        } else if !newline {
            file.write_all(b"\n").map_err(io)?;
        }
        Ok(Conversation {
            brain,
            path,
            file,
            entries,
            abort: Arc::new(TurnAbort {
                state: Mutex::new(TurnSignal::open()),
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Stops a running turn and wakes tools waiting on its cancellation signal.
    pub fn abort_handle(&self) -> Arc<TurnAbort> {
        self.abort.clone()
    }

    /// The input of a turn that started and never finished.
    pub fn unfinished_turn(&self) -> Option<String> {
        let start = self.entries.iter().rposition(|e| matches!(e, Entry::TurnStarted { .. }))?;
        if self.entries[start..].iter().any(|e| matches!(e, Entry::TurnFinished { .. })) {
            return None;
        }
        match &self.entries[start] {
            Entry::TurnStarted { input } => Some(input.clone()),
            _ => None,
        }
    }

    fn append(&mut self, entry: Entry) -> Result<()> {
        let line = serde_json::to_string(&entry).map_err(|e| BrainError::Store(e.to_string()))?;
        writeln!(self.file, "{line}").map_err(io)?;
        self.file.sync_data().map_err(io)?;
        self.entries.push(entry);
        Ok(())
    }

    /// The messages the model sees: the system prompt, the latest summary,
    /// then everything after it.
    fn messages(&self) -> Vec<Message> {
        let from = self.entries.iter().rposition(|e| matches!(e, Entry::Compacted { .. }));
        let mut out = vec![Message::system(&self.brain.system)];
        let mut tail = &self.entries[..];
        if let Some(i) = from {
            if let Entry::Compacted { summary } = &self.entries[i] {
                out.push(Message::user(format!("Summary of the conversation before this point:\n\n{summary}")));
            }
            tail = &self.entries[i + 1..];
        }
        for e in tail {
            match e {
                Entry::TurnStarted { input } if !input.is_empty() => out.push(Message::user(input)),
                Entry::Message { message, .. } => out.push(message.clone()),
                _ => {}
            }
        }
        out
    }

    /// Runs one turn on `input`.
    pub fn send(&mut self, input: &str, on: &mut dyn FnMut(BrainEvent)) -> Result<TurnOutcome> {
        if self.unfinished_turn().is_some() {
            return Err(BrainError::Busy);
        }
        self.abort.reset();
        self.append(Entry::TurnStarted { input: input.to_string() })?;
        on(BrainEvent::TurnStarted {
            input: input.to_string(),
            resumed: false,
        });
        self.run(on)
    }

    /// Finishes a turn the last process left unfinished. `None` when there
    /// is none.
    pub fn resume(&mut self, on: &mut dyn FnMut(BrainEvent)) -> Option<Result<TurnOutcome>> {
        let input = self.unfinished_turn()?;
        self.abort.reset();
        on(BrainEvent::TurnStarted { input, resumed: true });
        // Tool calls cut off mid-run: read-only ones run again; the others
        // tell the model they were interrupted, so it checks before retrying.
        let start = self.entries.iter().rposition(|e| matches!(e, Entry::TurnStarted { .. }))?;
        let turn = &self.entries[start..];
        if let Some(Entry::Message { message, .. }) = turn.last()
            && message.role == Role::Assistant
            && message.tool_calls.is_empty()
        {
            let mut usage = Usage::default();
            for entry in turn {
                if let Entry::Message { usage: Some(billed), .. } = entry {
                    usage.add(*billed);
                }
            }
            let text = message.content.clone().unwrap_or_default();
            return Some(self.finish(TurnOutcome::Completed, usage, text, on));
        }
        let results = self.pending_tool_calls(start);
        for (call, started) in results {
            let rerun = self.brain.tool(&call.name).map(|tool| tool.replay_safe() || !started);
            let output = match rerun {
                Some(true) => {
                    if let Err(e) = self.append(Entry::ToolStarted { id: call.id.clone() }) {
                        return Some(Err(e));
                    }
                    match self.brain.tool(&call.name) {
                        Some(tool) => run_tool(tool, &call, &self.abort),
                        None => ToolOutput::error(format!("unknown tool `{}`", call.name)),
                    }
                }
                Some(false) => ToolOutput::error("interrupted: the process stopped while this ran. Check what it did before running it again."),
                None => ToolOutput::error(format!("unknown tool `{}`", call.name)),
            };
            if let Err(e) = self.append(Entry::Message {
                message: Message::tool(&call.id, output_text(&output)),
                usage: None,
            }) {
                return Some(Err(e));
            }
            on(BrainEvent::ToolFinished { id: call.id, output });
        }
        Some(self.run(on))
    }

    /// Calls of the last assistant message with no result yet, and whether
    /// each had started.
    fn pending_tool_calls(&self, start: usize) -> Vec<(ToolCall, bool)> {
        let turn = &self.entries[start..];
        let Some(at) = turn
            .iter()
            .rposition(|e| matches!(e, Entry::Message { message, .. } if message.role == Role::Assistant))
        else {
            return vec![];
        };
        let Entry::Message { message, .. } = &turn[at] else { return vec![] };
        let after = &turn[at + 1..];
        let answered: Vec<&str> = after
            .iter()
            .filter_map(|e| match e {
                Entry::Message { message, .. } => message.tool_call_id.as_deref(),
                _ => None,
            })
            .collect();
        let started: Vec<&str> = after
            .iter()
            .filter_map(|e| match e {
                Entry::ToolStarted { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        message
            .tool_calls
            .iter()
            .filter(|c| !answered.contains(&c.id.as_str()))
            .map(|c| (c.clone(), started.contains(&c.id.as_str())))
            .collect()
    }

    fn run(&mut self, on: &mut dyn FnMut(BrainEvent)) -> Result<TurnOutcome> {
        let mut usage = Usage::default();
        let mut text = String::new();
        let mut last_prompt = 0u64;
        let mut steps = 0;
        for entry in self.entries.iter().rev().take_while(|e| !matches!(e, Entry::TurnStarted { .. })) {
            if let Entry::Message { message, usage: Some(billed) } = entry {
                if steps == 0 {
                    last_prompt = billed.input;
                    text = message.content.clone().unwrap_or_default();
                }
                steps += 1;
                usage.add(*billed);
            }
        }
        for _ in steps..self.brain.max_steps {
            if self.abort.signal().is_disconnected() {
                return self.finish(TurnOutcome::Aborted, usage, text, on);
            }
            if last_prompt >= self.brain.compact_at {
                self.compact(on)?;
            }
            let request = ChatRequest {
                model: self.brain.model.clone(),
                messages: self.messages(),
                tools: self.brain.tools.iter().map(|t| t.spec()).collect(),
                effort: self.brain.effort.clone(),
            };
            let completion = match self.brain.client.complete(&request, &mut |d| match d {
                Delta::Text(t) => on(BrainEvent::Text(t)),
                Delta::Reasoning(r) => on(BrainEvent::Reasoning(r)),
            }) {
                Ok(c) => c,
                Err(e) => {
                    on(BrainEvent::Error(e.to_string()));
                    return self.finish(TurnOutcome::Failed, usage, text, on);
                }
            };
            usage.add(completion.usage);
            last_prompt = completion.usage.input;
            if let Some(t) = &completion.message.content {
                text = t.clone();
            }
            let calls = completion.message.tool_calls.clone();
            self.append(Entry::Message {
                message: completion.message,
                usage: Some(completion.usage),
            })?;
            if calls.is_empty() {
                return self.finish(TurnOutcome::Completed, usage, text, on);
            }
            // Calls run one after another, in the order the model gave.
            for call in &calls {
                let output = if self.abort.signal().is_disconnected() {
                    ToolOutput::error("aborted by the user")
                } else {
                    self.append(Entry::ToolStarted { id: call.id.clone() })?;
                    on(BrainEvent::ToolStarted {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    });
                    match self.brain.tool(&call.name) {
                        Some(tool) => run_tool(tool, call, &self.abort),
                        None => ToolOutput::error(format!("unknown tool `{}`", call.name)),
                    }
                };
                self.append(Entry::Message {
                    message: Message::tool(&call.id, output_text(&output)),
                    usage: None,
                })?;
                on(BrainEvent::ToolFinished { id: call.id.clone(), output });
            }
        }
        self.finish(TurnOutcome::TooLong, usage, text, on)
    }

    fn finish(&mut self, outcome: TurnOutcome, usage: Usage, text: String, on: &mut dyn FnMut(BrainEvent)) -> Result<TurnOutcome> {
        self.append(Entry::TurnFinished { outcome, usage })?;
        on(BrainEvent::TurnFinished { outcome, usage, text });
        Ok(outcome)
    }

    /// Replaces the history before the current turn with a summary.
    pub fn compact(&mut self, on: &mut dyn FnMut(BrainEvent)) -> Result<()> {
        let mut messages = self.messages();
        // A conversation ending on tool calls with no results cannot be
        // summarized as is; summarize up to its last complete exchange.
        while messages.last().is_some_and(|m| m.role == Role::Assistant && !m.tool_calls.is_empty()) {
            messages.pop();
        }
        messages.push(Message::user(COMPACT_PROMPT));
        let request = ChatRequest {
            model: self.brain.model.clone(),
            messages,
            tools: vec![],
            effort: None,
        };
        let summary = self.brain.client.complete(&request, &mut |_| {})?.message.content.unwrap_or_default();
        // The current turn's input is kept after the summary so the model
        // still sees what it is doing now.
        let current = self.unfinished_turn();
        self.append(Entry::Compacted { summary })?;
        if let Some(input) = current {
            self.append(Entry::TurnStarted { input })?;
        }
        on(BrainEvent::Compacted);
        Ok(())
    }
}

fn run_tool(tool: &dyn Tool, call: &ToolCall, abort: &TurnAbort) -> ToolOutput {
    let args = if call.arguments.trim().is_empty() {
        Ok(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::from_str(&call.arguments)
    };
    match args {
        Ok(args) => tool.execute_cancellable(&args, &abort.signal()),
        Err(e) => ToolOutput::error(format!("arguments are not valid JSON: {e}")),
    }
}

fn output_text(output: &ToolOutput) -> String {
    if output.is_error {
        format!("ERROR: {}", output.text)
    } else {
        output.text.clone()
    }
}

/// The transcript stored at `path`, oldest first; empty when there is none.
pub fn read_entries(path: &Path) -> Result<Vec<Entry>> {
    match File::open(path) {
        Ok(file) => read_transcript(&file).map(|(entries, _, _)| entries),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(io(e)),
    }
}

// A terminated, invalid record is corruption. Only an unterminated tail can
// be discarded before appending again.
fn read_transcript(file: &File) -> Result<(Vec<Entry>, u64, bool)> {
    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut bytes = Vec::new();
    let mut committed = 0;
    let mut newline = true;
    loop {
        bytes.clear();
        let len = reader.read_until(b'\n', &mut bytes).map_err(io)?;
        if len == 0 {
            break;
        }
        newline = bytes.ends_with(b"\n");
        if !bytes.iter().all(u8::is_ascii_whitespace) {
            match serde_json::from_slice(&bytes) {
                Ok(entry) => entries.push(entry),
                Err(_) if !newline => break,
                Err(e) => return Err(BrainError::Store(format!("transcript at byte {committed}: {e}"))),
            }
        }
        committed += len as u64;
    }
    Ok((entries, committed, newline))
}

fn io(e: std::io::Error) -> BrainError {
    BrainError::Store(e.to_string())
}
