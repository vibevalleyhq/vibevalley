//! The JSONL record stream: one writer (`SessionOptions::record_to`) and one
//! reader (`read_record`).
//!
//! # Format and compatibility with oar
//!
//! Files are written as oar's `oar-voyage/3` log (oar: `packages/oar/src/voyage.ts`,
//! `docs/spec/record-stream.md`):
//!
//! - line 1: `{"kind":"header","format":"oar-voyage/3","runtime","model"?,"cwd","sessionId","startedAt","recorder"}`
//! - then one `{"kind":"record","record":<RawEvent>}` per event, where the
//!   record carries oar's envelope (`sessionId`, `agentPath`, `seq`,
//!   `receivedAt`) and is one of oar's three kinds: `frame`, `request`,
//!   `response`
//! - last: `{"kind":"end","at","reason"}`; a log without it was cut short.
//!
//! Compatible: the line and envelope shapes; the header; `request` records
//! for prompts (`toRuntime`, body `prompt`) and for permission requests and
//! questions (`toApp`, body `native`); `response` records for permission
//! answers (`answered`) and the session end (`exited`); and the `events`
//! array of each `frame`, which uses oar's event vocabulary (`text_delta`,
//! `reasoning`, `tool_call_started`, `tool_call_ended`, `usage`, `model`,
//! `turn_ended`), so an oar consumer that reads `events` sees the run.
//!
//! Not compatible:
//! - One record is one VibeValley event, not one native frame. A frame's `native`
//!   is the VibeValley `EventKind` as JSON and its `type` is `vibevalley/<kind>`; the
//!   vendor's wire frame is not kept. oar tools that re-project from `native`
//!   get nothing from it.
//! - `request` / `response` lines carry an extra top-level `vibevalley` key (the
//!   `EventKind`), which oar ignores and `read_record` reads back losslessly.
//! - oar's `open`/`opened` lifecycle pair, `accepted`/`rejected` control
//!   responses, `spanId`, and the session-graph records are not written.
//!   `FileChanged` and `Error` have no oar event and appear as frames with
//!   empty `events`.
//! - A file that already has content is appended to (resume into the same
//!   file), so it can hold several header..end segments; oar writes one.
//!
//! Reading a log written by oar itself works but is lossy: its `events` are
//! mapped back to `EventKind`s, several events of one oar frame share a
//! `seq` there so they are renumbered, and kinds without an VibeValley
//! counterpart are skipped.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::core::now_ms;
use crate::{AgentError, Event, EventKind, PermissionDecision, Result, StopReason, Usage};

pub const FORMAT: &str = "oar-voyage/3";
const RECORDER: &str = concat!("vibevalley-oar/", env!("CARGO_PKG_VERSION"));

/// The first line of a record file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHeader {
    pub format: String,
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub cwd: PathBuf,
    pub session_id: String,
    pub started_at: u64,
    pub recorder: String,
}

/// Opens (creating, appending) the record file; adapters call this before
/// they start anything, so a bad path fails the open.
pub(crate) fn open_file(path: Option<&Path>) -> Result<Option<File>> {
    let Some(path) = path else { return Ok(None) };
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(Some)
        .map_err(|e| AgentError::Io(format!("record file {}: {e}", path.display())))
}

pub(crate) struct Recorder {
    file: File,
    /// Written with the first event, so an open that fails leaves no trace.
    header: Option<Value>,
}

impl Recorder {
    pub(crate) fn start(file: Option<File>, runtime: &str, session_id: &str, cwd: &Path, model: Option<&str>) -> Option<Self> {
        let header = RecordHeader {
            format: FORMAT.into(),
            runtime: runtime.into(),
            model: model.map(str::to_string),
            cwd: cwd.to_path_buf(),
            session_id: session_id.into(),
            started_at: now_ms(),
            recorder: RECORDER.into(),
        };
        let mut line = serde_json::to_value(&header).ok()?;
        line.as_object_mut()?.insert("kind".into(), json!("header"));
        Some(Self {
            file: file?,
            header: Some(line),
        })
    }

    fn line(&mut self, value: &Value) -> std::io::Result<()> {
        let mut text = value.to_string();
        text.push('\n');
        // One write per line: whatever was recorded survives a crash, in order.
        self.file.write_all(text.as_bytes())
    }

    pub(crate) fn write(&mut self, session_id: &str, event: &Event) -> std::io::Result<()> {
        if let Some(header) = self.header.take() {
            self.line(&header)?;
        }
        self.line(&record_line(session_id, event))
    }

    pub(crate) fn end(&mut self, reason: &str) {
        if self.header.is_some() {
            return;
        }
        let _ = self.line(&json!({ "kind": "end", "at": now_ms(), "reason": reason }));
    }
}

fn kind_name(kind: &EventKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn outcome(reason: &StopReason) -> Value {
    match reason {
        StopReason::Completed => json!({ "kind": "completed" }),
        StopReason::Aborted => json!({ "kind": "aborted" }),
        StopReason::MaxTurns => json!({ "kind": "failed", "failure": "limit_reached", "reason": "max turns" }),
        StopReason::Error => json!({ "kind": "failed", "failure": "unknown", "reason": "error" }),
    }
}

/// The oar events a frame for this kind carries (oar's `RuntimeEventBody`).
fn oar_events(kind: &EventKind) -> Vec<Value> {
    match kind {
        EventKind::SessionStarted { model: Some(model), .. } => vec![json!({ "kind": "model", "model": model })],
        EventKind::TextDelta { text } => vec![json!({ "kind": "text_delta", "text": text })],
        EventKind::ThinkingDelta { text } => {
            vec![json!({ "kind": "reasoning", "content": { "kind": "text", "text": text } })]
        }
        EventKind::ToolCallStarted { id, name, input } => {
            vec![json!({ "kind": "tool_call_started", "callId": id, "tool": name, "input": input.to_string() })]
        }
        EventKind::ToolCallFinished { id, ok, output } => vec![json!({
            "kind": "tool_call_ended",
            "callId": id,
            "content": [{ "type": "text", "text": output }],
            "result": if *ok { "ok" } else { "failed" },
        })],
        EventKind::TurnFinished { reason, usage } => {
            let mut events = Vec::new();
            if let (Some(input), Some(output)) = (usage.input_tokens, usage.output_tokens) {
                events.push(json!({ "kind": "usage", "usage": { "tokens": { "input": input, "output": output } } }));
            }
            events.push(json!({ "kind": "turn_ended", "outcome": outcome(reason) }));
            events
        }
        _ => Vec::new(),
    }
}

pub(crate) fn record_line(session_id: &str, event: &Event) -> Value {
    let native = serde_json::to_value(&event.kind).unwrap_or(Value::Null);
    let mut record = json!({
        "sessionId": session_id,
        "agentPath": event.agent_path,
        "seq": event.seq,
        "receivedAt": event.at_ms,
    });
    let fields = record.as_object_mut().expect("object literal");
    let mut set = |key: &str, value: Value| {
        fields.insert(key.to_string(), value);
    };
    let mut control = true;
    match &event.kind {
        EventKind::TurnStarted { prompt } => {
            set("kind", json!("request"));
            set("id", json!(format!("turn-{}", event.seq)));
            set("direction", json!("toRuntime"));
            set("body", json!({ "kind": "prompt", "input": prompt }));
        }
        EventKind::PermissionRequested {
            request_id,
            tool,
            input,
            summary,
        } => {
            set("kind", json!("request"));
            set("id", json!(request_id));
            set("direction", json!("toApp"));
            set(
                "body",
                json!({ "kind": "native", "type": "permission", "native": { "tool": tool, "input": input, "summary": summary } }),
            );
        }
        EventKind::Question { text } => {
            set("kind", json!("request"));
            set("id", json!(format!("question-{}", event.seq)));
            set("direction", json!("toApp"));
            set("body", json!({ "kind": "native", "type": "question", "native": { "text": text } }));
        }
        EventKind::PermissionResolved { request_id, decision } => {
            set("kind", json!("response"));
            set("requestId", json!(request_id));
            set("body", json!({ "kind": "answered", "native": decision }));
        }
        EventKind::SessionEnded => {
            set("kind", json!("response"));
            set("requestId", json!(""));
            set("body", json!({ "kind": "exited", "code": null }));
        }
        kind => {
            control = false;
            set("kind", json!("frame"));
            set(
                "body",
                json!({ "type": format!("vibevalley/{}", kind_name(kind)), "native": native, "events": oar_events(kind) }),
            );
        }
    }
    if control {
        json!({ "kind": "record", "record": record, "vibevalley": native })
    } else {
        json!({ "kind": "record", "record": record })
    }
}

fn envelope(record: &Value) -> (u64, Vec<String>, u64) {
    let seq = record.get("seq").and_then(Value::as_u64).unwrap_or(0);
    let path = record
        .get("agentPath")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let at = record.get("receivedAt").and_then(Value::as_u64).unwrap_or(0);
    (seq, path, at)
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A record oar wrote itself, read through its `events` projection.
fn foreign_kinds(record: &Value, usage: &mut Usage) -> Vec<EventKind> {
    let body = record.get("body").cloned().unwrap_or(Value::Null);
    let body_kind = body.get("kind").and_then(Value::as_str).unwrap_or_default();
    match record.get("kind").and_then(Value::as_str) {
        Some("request") => match (record.get("direction").and_then(Value::as_str), body_kind) {
            (Some("toRuntime"), "prompt") => vec![EventKind::TurnStarted {
                prompt: text_of(&body, "input"),
            }],
            (Some("toApp"), _) => vec![EventKind::PermissionRequested {
                request_id: text_of(record, "id"),
                tool: text_of(&body, "type"),
                input: body.get("native").cloned().unwrap_or(Value::Null),
                summary: text_of(&body, "type"),
            }],
            _ => Vec::new(),
        },
        Some("response") => match body_kind {
            "answered" => vec![EventKind::PermissionResolved {
                request_id: text_of(record, "requestId"),
                decision: PermissionDecision::AllowOnce,
            }],
            "exited" => vec![EventKind::SessionEnded],
            _ => Vec::new(),
        },
        Some("frame") => {
            let events = body.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut kinds = Vec::new();
            for event in events {
                match event.get("kind").and_then(Value::as_str).unwrap_or_default() {
                    "text_delta" => kinds.push(EventKind::TextDelta { text: text_of(&event, "text") }),
                    "reasoning" => {
                        if let Some(text) = event.pointer("/content/text").and_then(Value::as_str) {
                            kinds.push(EventKind::ThinkingDelta { text: text.to_string() });
                        }
                    }
                    "tool_call_started" => {
                        let raw = text_of(&event, "input");
                        kinds.push(EventKind::ToolCallStarted {
                            id: text_of(&event, "callId"),
                            name: text_of(&event, "tool"),
                            input: serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
                        });
                    }
                    "tool_call_ended" => {
                        let output = event
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        kinds.push(EventKind::ToolCallFinished {
                            id: text_of(&event, "callId"),
                            ok: event.get("result").and_then(Value::as_str) != Some("failed"),
                            output,
                        });
                    }
                    "usage" => {
                        if let Some(tokens) = event.pointer("/usage/tokens") {
                            usage.input_tokens = tokens.get("input").and_then(Value::as_u64);
                            usage.output_tokens = tokens.get("output").and_then(Value::as_u64);
                        }
                    }
                    "turn_ended" => {
                        let reason = match event.pointer("/outcome/kind").and_then(Value::as_str) {
                            Some("completed") => StopReason::Completed,
                            Some("aborted") => StopReason::Aborted,
                            _ => StopReason::Error,
                        };
                        if let Some(message) = event.pointer("/outcome/reason").and_then(Value::as_str) {
                            kinds.push(EventKind::Error { message: message.to_string() });
                        }
                        kinds.push(EventKind::TurnFinished { reason, usage: usage.clone() });
                    }
                    _ => {}
                }
            }
            kinds
        }
        _ => Vec::new(),
    }
}

/// Like `read_record`, with the file's (first) header.
pub fn read_record_with_header(path: &Path) -> Result<(Option<RecordHeader>, Vec<Event>)> {
    let file = File::open(path).map_err(|e| AgentError::Io(format!("{}: {e}", path.display())))?;
    let mut header = None;
    let mut events: Vec<Event> = Vec::new();
    let mut foreign = false;
    let mut usage = Usage::default();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|e| AgentError::Io(format!("{}: {e}", path.display())))?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|e| AgentError::Protocol(format!("{}:{}: not JSON: {e}", path.display(), index + 1)))?;
        match value.get("kind").and_then(Value::as_str) {
            Some("header") => {
                if header.is_none() {
                    header = serde_json::from_value(value).ok();
                }
            }
            Some("record") => {
                let record = value.get("record").cloned().unwrap_or(Value::Null);
                let (seq, agent_path, at_ms) = envelope(&record);
                let own = value.get("vibevalley").cloned().or_else(|| {
                    let body = record.get("body")?;
                    body.get("type")?.as_str()?.starts_with("vibevalley/").then(|| body.get("native").cloned())?
                });
                if let Some(own) = own {
                    let kind: EventKind =
                        serde_json::from_value(own).map_err(|e| AgentError::Protocol(format!("{}:{}: unknown event: {e}", path.display(), index + 1)))?;
                    events.push(Event { seq, agent_path, at_ms, kind });
                } else {
                    foreign = true;
                    for kind in foreign_kinds(&record, &mut usage) {
                        events.push(Event {
                            seq,
                            agent_path: agent_path.clone(),
                            at_ms,
                            kind,
                        });
                    }
                }
            }
            Some("end") => {}
            other => {
                return Err(AgentError::Protocol(format!(
                    "{}:{}: unexpected line kind {other:?}",
                    path.display(),
                    index + 1
                )));
            }
        }
    }
    if foreign {
        for (index, event) in events.iter_mut().enumerate() {
            event.seq = index as u64;
        }
    }
    Ok((header, events))
}
