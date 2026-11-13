//! Folds an agent's event stream into a compact, append-only transcript.
//! Only the last item ever changes (streamed text grows in place), so a
//! reader can stay in sync by re-reading from its last known index.

use std::path::PathBuf;

use vibevalley_oar::{Event, EventKind, FileChangeKind, PermissionDecision, StopReason, Usage};

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User(String),
    Assistant(String),
    Thinking(String),
    ToolCall { id: String, name: String, input: String },
    ToolResult { id: String, ok: bool, output: String },
    FileChanged { path: PathBuf, change: FileChangeKind },
    PermissionAsked { request_id: String, tool: String, summary: String },
    PermissionAnswered { request_id: String, decision: PermissionDecision },
    Question(String),
    TurnEnd { reason: StopReason, usage: Usage },
    Error(String),
    Ended,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Empty for the root agent.
    pub agent_path: Vec<String>,
    pub at_ms: u64,
    pub item: Item,
}

#[derive(Debug, Default, Clone)]
pub struct Transcript {
    entries: Vec<Entry>,
}

const TOOL_INPUT_PREVIEW: usize = 400;
const TOOL_OUTPUT_PREVIEW: usize = 4000;

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// One-line rendering of a tool's JSON input, preferring the fields a human
/// recognizes.
pub fn summarize_input(input: &serde_json::Value) -> String {
    let preferred = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"];
    if let Some(obj) = input.as_object() {
        for key in preferred {
            if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                return clip(v, TOOL_INPUT_PREVIEW);
            }
        }
    }
    match input {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => clip(s, TOOL_INPUT_PREVIEW),
        other => clip(&other.to_string(), TOOL_INPUT_PREVIEW),
    }
}

impl Transcript {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Entries from `from` on (clamped).
    pub fn since(&self, from: usize) -> &[Entry] {
        &self.entries[from.min(self.entries.len())..]
    }

    pub fn from_events(events: &[Event]) -> Transcript {
        let mut t = Transcript::default();
        events.iter().for_each(|e| t.apply(e));
        t
    }

    pub fn apply(&mut self, event: &Event) {
        let item = match &event.kind {
            EventKind::SessionStarted { .. } => return,
            EventKind::TurnStarted { prompt } => Item::User(prompt.clone()),
            EventKind::TextDelta { text } => {
                if let Some(Entry {
                    agent_path,
                    item: Item::Assistant(existing),
                    ..
                }) = self.entries.last_mut()
                    && *agent_path == event.agent_path
                {
                    existing.push_str(text);
                    return;
                }
                Item::Assistant(text.clone())
            }
            EventKind::ThinkingDelta { text } => {
                if let Some(Entry {
                    agent_path,
                    item: Item::Thinking(existing),
                    ..
                }) = self.entries.last_mut()
                    && *agent_path == event.agent_path
                {
                    existing.push_str(text);
                    return;
                }
                Item::Thinking(text.clone())
            }
            EventKind::ToolCallStarted { id, name, input } => Item::ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: summarize_input(input),
            },
            EventKind::ToolCallFinished { id, ok, output } => Item::ToolResult {
                id: id.clone(),
                ok: *ok,
                output: clip(output, TOOL_OUTPUT_PREVIEW),
            },
            EventKind::FileChanged { path, change } => Item::FileChanged {
                path: path.clone(),
                change: change.clone(),
            },
            EventKind::PermissionRequested { request_id, tool, summary, .. } => Item::PermissionAsked {
                request_id: request_id.clone(),
                tool: tool.clone(),
                summary: summary.clone(),
            },
            EventKind::PermissionResolved { request_id, decision } => Item::PermissionAnswered {
                request_id: request_id.clone(),
                decision: decision.clone(),
            },
            EventKind::Question { text } => Item::Question(text.clone()),
            EventKind::TurnFinished { reason, usage } => Item::TurnEnd {
                reason: reason.clone(),
                usage: usage.clone(),
            },
            EventKind::Error { message } => Item::Error(message.clone()),
            EventKind::SessionEnded => Item::Ended,
        };
        self.entries.push(Entry {
            agent_path: event.agent_path.clone(),
            at_ms: event.at_ms,
            item,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64, kind: EventKind) -> Event {
        Event {
            seq,
            agent_path: Vec::new(),
            at_ms: seq,
            kind,
        }
    }

    #[test]
    fn deltas_merge_and_only_the_tail_changes() {
        let mut t = Transcript::default();
        t.apply(&ev(1, EventKind::TurnStarted { prompt: "hi".into() }));
        t.apply(&ev(2, EventKind::ThinkingDelta { text: "hm".into() }));
        t.apply(&ev(3, EventKind::ThinkingDelta { text: "m".into() }));
        t.apply(&ev(4, EventKind::TextDelta { text: "Hel".into() }));
        let before = t.len();
        t.apply(&ev(5, EventKind::TextDelta { text: "lo".into() }));
        assert_eq!(t.len(), before);
        assert_eq!(
            t.entries().iter().map(|e| e.item.clone()).collect::<Vec<_>>(),
            vec![Item::User("hi".into()), Item::Thinking("hmm".into()), Item::Assistant("Hello".into())]
        );
        assert_eq!(t.since(2).len(), 1);
        assert!(t.since(99).is_empty());
    }

    #[test]
    fn subagent_text_does_not_merge_into_root_text() {
        let mut t = Transcript::default();
        t.apply(&ev(1, EventKind::TextDelta { text: "root".into() }));
        let mut sub = ev(2, EventKind::TextDelta { text: "sub".into() });
        sub.agent_path = vec!["explorer".into()];
        t.apply(&sub);
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn tool_input_is_summarized_and_output_clipped() {
        let mut t = Transcript::default();
        t.apply(&ev(
            1,
            EventKind::ToolCallStarted {
                id: "1".into(),
                name: "Bash".into(),
                input: serde_json::json!({"command": "cargo test", "timeout": 5}),
            },
        ));
        t.apply(&ev(
            2,
            EventKind::ToolCallFinished {
                id: "1".into(),
                ok: true,
                output: "界".repeat(5000),
            },
        ));
        assert_eq!(
            t.entries()[0].item,
            Item::ToolCall {
                id: "1".into(),
                name: "Bash".into(),
                input: "cargo test".into()
            }
        );
        let Item::ToolResult { output, .. } = &t.entries()[1].item else { panic!() };
        assert!(output.len() <= TOOL_OUTPUT_PREVIEW + 4 && output.ends_with('…'));
        assert_eq!(summarize_input(&serde_json::json!({"a": 1})), r#"{"a":1}"#);
    }
}
