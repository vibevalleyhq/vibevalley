//! The JSONL record stream: one writer (`SessionOptions::record_to`) and one
//! reader (`read_record`). Each line is a typed `RecordLine` (`header`,
//! `event`, `end`), written one per syscall so crashes leave valid prefixes
//! and resuming into the same file appends another `header..end` segment.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::now_ms;
use crate::{AgentError, Event, Result};

const FORMAT: &str = "vibevalley-oar/1";
const RECORDER: &str = concat!("vibevalley-oar/", env!("CARGO_PKG_VERSION"));

/// The first line of a record segment.
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

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RecordLine<'a> {
    Header(RecordHeader),
    Event { event: std::borrow::Cow<'a, Event> },
    End { at: u64, reason: &'a str },
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
    header: Option<RecordHeader>,
}

impl Recorder {
    pub(crate) fn start(file: Option<File>, runtime: &str, session_id: &str, cwd: &Path, model: Option<&str>) -> Option<Self> {
        Some(Self {
            file: file?,
            header: Some(RecordHeader {
                format: FORMAT.into(),
                runtime: runtime.into(),
                model: model.map(str::to_string),
                cwd: cwd.to_path_buf(),
                session_id: session_id.into(),
                started_at: now_ms(),
                recorder: RECORDER.into(),
            }),
        })
    }

    fn line(&mut self, line: &RecordLine<'_>) -> std::io::Result<()> {
        let mut text = serde_json::to_string(line).map_err(std::io::Error::other)?;
        text.push('\n');
        // One write per line: whatever was recorded survives a crash, in order.
        self.file.write_all(text.as_bytes())
    }

    pub(crate) fn write(&mut self, event: &Event) -> std::io::Result<()> {
        if let Some(header) = self.header.take() {
            self.line(&RecordLine::Header(header))?;
        }
        self.line(&RecordLine::Event {
            event: std::borrow::Cow::Borrowed(event),
        })
    }

    pub(crate) fn end(&mut self, reason: &str) {
        if self.header.is_some() {
            return;
        }
        let _ = self.line(&RecordLine::End { at: now_ms(), reason });
    }
}

/// Like `read_record`, with the file's (first) header.
pub fn read_record_with_header(path: &Path) -> Result<(Option<RecordHeader>, Vec<Event>)> {
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum OwnedLine {
        Header(RecordHeader),
        Event {
            event: Event,
        },
        End {
            #[allow(dead_code)]
            at: u64,
            #[allow(dead_code)]
            reason: String,
        },
    }

    let file = File::open(path).map_err(|e| AgentError::Io(format!("{}: {e}", path.display())))?;
    let mut header = None;
    let mut events = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|e| AgentError::Io(format!("{}: {e}", path.display())))?;
        if line.trim().is_empty() {
            continue;
        }
        let parsed: OwnedLine =
            serde_json::from_str(&line).map_err(|e| AgentError::Protocol(format!("{}:{}: invalid record line: {e}", path.display(), index + 1)))?;
        match parsed {
            OwnedLine::Header(h) => {
                if header.is_none() {
                    header = Some(h);
                }
            }
            OwnedLine::Event { event } => events.push(event),
            OwnedLine::End { .. } => {}
        }
    }
    Ok((header, events))
}
