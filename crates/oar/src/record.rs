use std::fs::{File, OpenOptions};
use std::io::{BufReader, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::voyage::{Header, Reader, Record, Writer, now_ms};
use crate::{AgentError, Event, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHeader {
    pub format: String,
    pub runtime: String,
    pub model: Option<String>,
    pub cwd: PathBuf,
    pub session_id: String,
    pub started_at: u64,
    pub recorder: String,
}

pub struct RecordFile {
    path: PathBuf,
    file: File,
    last: Option<u64>,
    has_header: bool,
}

pub fn open_file(path: Option<&Path>) -> Result<Option<RecordFile>> {
    let Some(path) = path else { return Ok(None) };
    let mut file = OpenOptions::new()
        .create(true)
        .mode(0o600)
        .read(true)
        .append(true)
        .open(path)
        .map_err(|e| AgentError::Io(format!("{}: {e}", path.display())))?;
    let has_header = file.metadata().map_err(|e| AgentError::Io(e.to_string()))?.len() != 0;
    let mut last = None;
    if has_header {
        let mut reader = Reader::new(BufReader::new(&file))?;
        while let Some(r) = reader.read()? {
            last = Some(r.seq);
        }
        file.seek(SeekFrom::End(0)).map_err(|e| AgentError::Io(e.to_string()))?;
    }
    Ok(Some(RecordFile {
        path: path.to_path_buf(),
        file,
        last,
        has_header,
    }))
}

pub struct Recorder {
    path: PathBuf,
    file: Option<RecordFile>,
    writer: Option<Writer<File>>,
    header: Header,
    base: u64,
}
impl Recorder {
    pub fn start(file: Option<RecordFile>, runtime: &str, session_id: &str, cwd: &Path, model: Option<&str>) -> Option<Self> {
        let file = file?;
        let path = file.path.clone();
        let base = file.last.map_or(0, |s| s + 1);
        let mut header = Header::new(runtime, session_id, now_ms());
        header.metadata.insert("cwd".into(), cwd.to_string_lossy().into_owned());
        if let Some(model) = model {
            header.metadata.insert("model".into(), model.into());
        }
        header
            .metadata
            .insert("recorder".into(), concat!("vibevalley-oar/", env!("CARGO_PKG_VERSION")).into());
        Some(Self {
            path,
            file: Some(file),
            writer: None,
            header,
            base,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn base(&self) -> u64 {
        self.base
    }
    pub fn write(&mut self, rec: &Record) -> Result<()> {
        if let Some(file) = self.file.take() {
            self.writer = Some(if file.has_header {
                Writer::from_existing(file.file, file.last)
            } else {
                Writer::new(file.file, self.header.clone())?
            });
        }
        let mut persisted = rec.clone();
        persisted.seq += self.base;
        persisted.trace_id = crate::voyage::normalize_trace_id(persisted.trace_id);
        self.writer.as_mut().expect("opened recorder").write(&persisted)
    }
}

pub(crate) fn read_session_records(path: &Path, base: u64, count: u64) -> Vec<Record> {
    if count == 0 {
        return Vec::new();
    }
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(mut reader) = Reader::new(BufReader::new(file)) else {
        return Vec::new();
    };
    let end = base.saturating_add(count);
    let mut out = Vec::new();
    while let Ok(Some(mut rec)) = reader.read() {
        if rec.seq >= base && rec.seq < end {
            rec.seq -= base;
            out.push(rec);
        }
    }
    out
}

pub fn read_record_with_header(path: &Path) -> Result<(Option<RecordHeader>, Vec<Event>)> {
    let file = File::open(path).map_err(|e| AgentError::Io(e.to_string()))?;
    let mut reader = Reader::new(BufReader::new(file))?;
    let mut events = vec![];
    while let Some(row) = reader.read()? {
        events.extend(row.native_events);
    }
    let h = reader.header;
    Ok((
        Some(RecordHeader {
            format: h.format,
            runtime: h.runtime,
            model: h.metadata.get("model").cloned(),
            cwd: PathBuf::from(h.metadata.get("cwd").cloned().unwrap_or_default()),
            session_id: h.session_id,
            started_at: h.created_at,
            recorder: h.metadata.get("recorder").cloned().unwrap_or_default(),
        }),
        events,
    ))
}
