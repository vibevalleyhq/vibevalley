//! Metadata-only durable telemetry aligned with `pi-durable`'s `DURABLE_TELEMETRY_SCHEMA`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{Error, Result};

/// Structured metadata-only telemetry events emitted by durable commits and scheduler phases.
/// Never carries prompt text, tool arguments, or model/tool output payloads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TelemetryEvent {
    #[serde(rename = "pi.durable.submit", rename_all = "camelCase")]
    Submit {
        conversation_id: String,
        request_id: String,
        submission_id: String,
        status: String,
        deduplicated: bool,
        duration_ms: i64,
        at_ms: i64,
    },
    #[serde(rename = "pi.durable.phase", rename_all = "camelCase")]
    Phase {
        task_id: String,
        conversation_id: String,
        kind: String,
        phase: String,
        attempt: u32,
        resumed: bool,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<String>,
        duration_ms: i64,
        at_ms: i64,
    },
    #[serde(rename = "pi.durable.entry", rename_all = "camelCase")]
    Entry {
        conversation_id: String,
        seq: i64,
        kind: String,
        at_ms: i64,
    },
    #[serde(rename = "pi.durable.submission", rename_all = "camelCase")]
    Submission {
        conversation_id: String,
        submission_id: String,
        status: String,
        at_ms: i64,
    },
    #[serde(rename = "pi.durable.checkpoint", rename_all = "camelCase")]
    Checkpoint { task_id: String, phase: String, at_ms: i64 },
}

impl TelemetryEvent {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::Submit { .. } => "pi.durable.submit",
            Self::Phase { .. } => "pi.durable.phase",
            Self::Entry { .. } => "pi.durable.entry",
            Self::Submission { .. } => "pi.durable.submission",
            Self::Checkpoint { .. } => "pi.durable.checkpoint",
        }
    }
}

pub trait TelemetrySink: Send + Sync {
    fn record(&self, event: &TelemetryEvent);
}

#[derive(Default)]
pub struct NoopTelemetrySink;

impl TelemetrySink for NoopTelemetrySink {
    fn record(&self, _event: &TelemetryEvent) {}
}

#[derive(Default)]
pub struct MemoryTelemetrySink {
    events: Mutex<Vec<TelemetryEvent>>,
}

impl MemoryTelemetrySink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<TelemetryEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
}

impl TelemetrySink for MemoryTelemetrySink {
    fn record(&self, event: &TelemetryEvent) {
        self.events.lock().unwrap().push(event.clone());
    }
}

pub struct JsonlTelemetrySink {
    file: Mutex<File>,
}

impl JsonlTelemetrySink {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(|e| Error::Invalid(format!("create telemetry dir {}: {e}", parent.display())))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| Error::Invalid(format!("open telemetry {}: {e}", path.display())))?;
        Ok(Self { file: Mutex::new(file) })
    }
}

impl TelemetrySink for JsonlTelemetrySink {
    fn record(&self, event: &TelemetryEvent) {
        let Ok(line) = serde_json::to_string(event) else {
            return;
        };
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.write_all(b"\n");
            let _ = file.flush();
        }
    }
}

/// Reads metadata telemetry events from a `telemetry.jsonl` file.
/// Missing files return empty; an incomplete torn trailing line is ignored gracefully.
pub fn read_telemetry_jsonl(path: &Path) -> Result<Vec<TelemetryEvent>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|e| Error::Invalid(format!("read telemetry {}: {e}", path.display())))?;
    let mut events = Vec::new();
    let chunks: Vec<&[u8]> = bytes.split_inclusive(|&b| b == b'\n').collect();
    let last_idx = chunks.len().saturating_sub(1);
    for (idx, chunk) in chunks.into_iter().enumerate() {
        let is_tail = idx == last_idx;
        if !chunk.ends_with(b"\n") && is_tail {
            // Incomplete trailing line before flush/newline.
            if let Ok(text) = std::str::from_utf8(chunk)
                && !text.trim().is_empty()
                && let Ok(ev) = serde_json::from_str::<TelemetryEvent>(text.trim())
            {
                events.push(ev);
            }
            break;
        }
        let Ok(text) = std::str::from_utf8(chunk) else {
            if is_tail {
                break;
            }
            return Err(Error::Invalid(format!("invalid UTF-8 in telemetry line {}", idx + 1)));
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<TelemetryEvent>(trimmed) {
            Ok(ev) => events.push(ev),
            Err(err) if is_tail => {
                let _ = err;
                break;
            }
            Err(err) => return Err(err.into()),
        }
    }
    Ok(events)
}
