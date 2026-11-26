use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{Value, json};

use super::antigravity;
use super::spec::AcpFlavor;
use crate::oar::core::{absolute, file_as_text, rejected, rejection};
use crate::oar::{ContentBlock, EventKind, FileChangeKind, Result, StopReason};

pub(super) fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(content_text).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(_) => match str_of(value, "type") {
            // A ToolCallContent wrapping a ContentBlock.
            Some("content") => value.get("content").and_then(content_text),
            Some("diff") | Some("terminal") => None,
            _ => str_of(value, "text").map(str::to_string),
        },
        _ => None,
    }
}

struct ToolState {
    started: bool,
    finished: bool,
    name: String,
    kind: String,
    input: Value,
    /// path → whether the diff creates the file.
    diffs: Vec<(PathBuf, bool)>,
    locations: Vec<PathBuf>,
}

/// `session/update` → events, as a pure fold (tests feed it fixtures).
#[derive(Default)]
pub(crate) struct Projector {
    flavor: AcpFlavor,
    tools: HashMap<String, ToolState>,
}

pub(super) fn is_empty_input(input: &Value) -> bool {
    match input {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

impl Projector {
    pub(crate) fn for_flavor(flavor: AcpFlavor) -> Self {
        Self { flavor, tools: HashMap::new() }
    }

    fn absorb(&mut self, update: &Value) -> Option<String> {
        let id = str_of(update, "toolCallId")?.to_string();
        let tool = self.tools.entry(id.clone()).or_insert_with(|| ToolState {
            started: false,
            finished: false,
            name: String::new(),
            kind: String::new(),
            input: Value::Null,
            diffs: Vec::new(),
            locations: Vec::new(),
        });
        // The opening title names the tool; later titles are progress text.
        if tool.name.is_empty()
            && let Some(title) = str_of(update, "title").filter(|t| !t.is_empty())
        {
            tool.name = title.to_string();
        }
        if let Some(kind) = str_of(update, "kind") {
            tool.kind = kind.to_string();
        }
        if let Some(input) = update.get("rawInput").filter(|input| !is_empty_input(input)) {
            tool.input = match self.flavor {
                AcpFlavor::Generic => input.clone(),
                AcpFlavor::Antigravity => {
                    let kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                    antigravity::normalize_tool_input(input, kind)
                }
            };
        }
        for item in update.get("content").and_then(Value::as_array).into_iter().flatten() {
            if str_of(item, "type") == Some("diff")
                && let Some(path) = str_of(item, "path")
            {
                let created = item.get("oldText").is_none_or(Value::is_null);
                let path = PathBuf::from(path);
                if !tool.diffs.iter().any(|(known, _)| known == &path) {
                    tool.diffs.push((path, created));
                }
            }
        }
        for location in update.get("locations").and_then(Value::as_array).into_iter().flatten() {
            if let Some(path) = str_of(location, "path") {
                let path = PathBuf::from(path);
                if !tool.locations.contains(&path) {
                    tool.locations.push(path);
                }
            }
        }
        Some(id)
    }

    fn start(&mut self, id: &str, out: &mut Vec<EventKind>) {
        let Some(tool) = self.tools.get_mut(id) else { return };
        if tool.started {
            return;
        }
        tool.started = true;
        let name = if !tool.name.is_empty() {
            tool.name.clone()
        } else if !tool.kind.is_empty() {
            tool.kind.clone()
        } else {
            "tool".to_string()
        };
        let input = match self.flavor {
            AcpFlavor::Generic => tool.input.clone(),
            AcpFlavor::Antigravity => {
                let kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                antigravity::normalize_tool_input(&tool.input, kind)
            }
        };
        out.push(EventKind::ToolCallStarted {
            id: id.to_string(),
            name,
            input,
        });
    }

    /// Makes sure a tool call the agent asks permission for has been announced.
    pub(crate) fn permission_tool(&mut self, tool_call: &Value) -> Vec<EventKind> {
        let mut out = Vec::new();
        if let Some(id) = self.absorb(tool_call) {
            self.start(&id, &mut out);
        }
        out
    }

    pub(crate) fn update(&mut self, update: &Value) -> Vec<EventKind> {
        let mut out = Vec::new();
        let text = || update.get("content").and_then(content_text).filter(|t| !t.is_empty());
        match str_of(update, "sessionUpdate").unwrap_or_default() {
            "agent_message_chunk" => {
                if let Some(text) = text() {
                    out.push(EventKind::TextDelta { text });
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = text() {
                    out.push(EventKind::ThinkingDelta { text });
                }
            }
            kind @ ("tool_call" | "tool_call_update") => {
                let Some(id) = self.absorb(update) else { return out };
                let status = str_of(update, "status").unwrap_or_default();
                let terminal = matches!(status, "completed" | "failed" | "cancelled");
                // Agents often open a call before its arguments exist
                // (opencode: `rawInput: {}`); the start waits one update for them.
                let hold = kind == "tool_call" && !terminal && status != "in_progress" && self.tools.get(&id).is_some_and(|t| is_empty_input(&t.input));
                if !hold {
                    self.start(&id, &mut out);
                }
                let Some(tool) = self.tools.get_mut(&id) else { return out };
                if terminal && !tool.finished {
                    tool.finished = true;
                    let ok = status == "completed";
                    let tool_kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                    let output = match self.flavor {
                        AcpFlavor::Generic => update
                            .get("content")
                            .and_then(content_text)
                            .or_else(|| match update.get("rawOutput") {
                                Some(Value::String(text)) => Some(text.clone()),
                                Some(Value::Null) | None => None,
                                Some(raw) => str_of(raw, "output").map(str::to_string).or_else(|| Some(raw.to_string())),
                            })
                            .unwrap_or_else(|| status.to_string()),
                        AcpFlavor::Antigravity => update
                            .get("content")
                            .and_then(content_text)
                            .map(|t| antigravity::normalize_tool_text(&t, tool_kind))
                            .or_else(|| update.get("rawOutput").and_then(|raw| antigravity::normalize_tool_output(raw, tool_kind)))
                            .unwrap_or_else(|| status.to_string()),
                    };
                    out.push(EventKind::ToolCallFinished { id: id.clone(), ok, output });
                    if ok {
                        if !tool.diffs.is_empty() {
                            for (path, created) in &tool.diffs {
                                let change = if *created { FileChangeKind::Created } else { FileChangeKind::Modified };
                                out.push(EventKind::FileChanged { path: path.clone(), change });
                            }
                        } else if matches!(tool.kind.as_str(), "edit" | "delete") {
                            let change = if tool.kind == "delete" {
                                FileChangeKind::Deleted
                            } else {
                                FileChangeKind::Modified
                            };
                            for path in &tool.locations {
                                out.push(EventKind::FileChanged {
                                    path: path.clone(),
                                    change: change.clone(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        out
    }
}

pub(super) fn stop_reason(reply: &Value) -> (StopReason, Option<String>) {
    match str_of(reply, "stopReason") {
        Some("end_turn") => (StopReason::Completed, None),
        Some("cancelled") => (StopReason::Aborted, None),
        Some("max_turn_requests") => (StopReason::MaxTurns, None),
        Some("max_tokens") => (StopReason::Error, Some("the model ran out of output tokens".into())),
        Some("refusal") => (StopReason::Error, Some("the model refused to continue".into())),
        other => (StopReason::Error, Some(format!("unknown stop reason {other:?}"))),
    }
}

pub(super) fn prompt_blocks(cwd: &Path, image_input: bool, content: &[ContentBlock]) -> Result<Vec<Value>> {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => Ok(json!({ "type": "text", "text": text })),
            ContentBlock::File { path, lines: None } => {
                let full = absolute(cwd, path);
                let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                Ok(json!({ "type": "resource_link", "name": name, "uri": format!("file://{}", full.display()) }))
            }
            ContentBlock::File { path, lines } => Ok(json!({ "type": "text", "text": file_as_text(cwd, path, *lines)? })),
            ContentBlock::Image { path } => {
                let full = absolute(cwd, path);
                if !image_input {
                    return Err(rejected(rejection::UNSUPPORTED, "this agent does not take image input"));
                }
                let mime = match full.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
                    Some("png") => "image/png",
                    Some("jpg" | "jpeg") => "image/jpeg",
                    Some("gif") => "image/gif",
                    Some("webp") => "image/webp",
                    _ => return Err(rejected(rejection::UNSUPPORTED, format!("{}: unknown image type", full.display()))),
                };
                let bytes = std::fs::read(&full).map_err(|e| rejected(rejection::UNSUPPORTED, format!("cannot read {}: {e}", full.display())))?;
                Ok(json!({
                    "type": "image",
                    "mimeType": mime,
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }))
            }
        })
        .collect()
}
