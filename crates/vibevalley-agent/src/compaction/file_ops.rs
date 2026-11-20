use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::durable::Entry;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOps {
    #[serde(default)]
    pub read: BTreeSet<String>,
    #[serde(default)]
    pub modified: BTreeSet<String>,
}

impl FileOps {
    pub fn merge(&mut self, other: FileOps) {
        self.read.extend(other.read);
        self.modified.extend(other.modified);
    }
}

fn call_args(call: &Value) -> Value {
    if let Some(args) = call.get("argsJson")
        && args.is_object()
    {
        return args.clone();
    }
    for key in ["rawArguments", "arguments"] {
        if let Some(raw) = call.get(key).and_then(Value::as_str)
            && let Ok(parsed) = serde_json::from_str::<Value>(raw)
        {
            return parsed;
        }
    }
    Value::Null
}

fn parse_rendered_file_ops(summary: &str, ops: &mut FileOps) {
    let Some(start) = summary.find("<file_ops>") else { return };
    let rest = &summary[start + "<file_ops>".len()..];
    let body = rest.split("</file_ops>").next().unwrap_or(rest);
    enum Section {
        None,
        Read,
        Modified,
    }
    let mut section = Section::None;
    for raw in body.lines() {
        let line = raw.trim();
        if line == "read:" {
            section = Section::Read;
        } else if line == "modified:" {
            section = Section::Modified;
        } else if let Some(path) = line.strip_prefix("- ").map(str::trim).filter(|p| !p.is_empty()) {
            match section {
                Section::Read => {
                    ops.read.insert(path.to_owned());
                }
                Section::Modified => {
                    ops.modified.insert(path.to_owned());
                }
                Section::None => {}
            }
        }
    }
}

/// Extracts tracked read (`read`, `grep`, `find`) and modified (`write`, `edit`)
/// file paths from durable entries, merging prior `pi.compaction` records.
pub fn extract_file_ops(entries: &[Entry]) -> FileOps {
    let mut ops = FileOps::default();
    for entry in entries {
        match entry.kind.as_str() {
            "pi.compaction" => {
                if let Some(prior) = entry.payload.get("fileOps")
                    && let Ok(decoded) = serde_json::from_value::<FileOps>(prior.clone())
                {
                    ops.merge(decoded);
                }
                if let Some(summary) = entry.payload.get("summary").and_then(Value::as_str) {
                    parse_rendered_file_ops(summary, &mut ops);
                }
            }
            "pi.assistant" => {
                for call in entry.payload["toolCalls"].as_array().into_iter().flatten() {
                    let name = call["toolName"].as_str().or_else(|| call["name"].as_str()).unwrap_or_default();
                    let args = call_args(call);
                    let path = args.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty());
                    let Some(path) = path else { continue };
                    match name {
                        "read" | "grep" | "find" => {
                            ops.read.insert(path.to_owned());
                        }
                        "write" | "edit" => {
                            ops.modified.insert(path.to_owned());
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    ops
}

pub fn render_file_ops(ops: &FileOps) -> String {
    if ops.read.is_empty() && ops.modified.is_empty() {
        return String::new();
    }
    let mut out = String::from("<file_ops>\n");
    if !ops.read.is_empty() {
        out.push_str("read:\n");
        for path in &ops.read {
            out.push_str(&format!("- {path}\n"));
        }
    }
    if !ops.modified.is_empty() {
        out.push_str("modified:\n");
        for path in &ops.modified {
            out.push_str(&format!("- {path}\n"));
        }
    }
    out.push_str("</file_ops>");
    out
}
