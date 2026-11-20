//! Crash-safe JSONL directory `StorageBackend` with commit markers, typed sidecars,
//! torn-line truncation/rollback on recovery, and `{ read_only: true }` snapshot inspection.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::live::LiveHub;
use super::memory::{JournalOp, MemoryRead, MemoryState, MemoryTx};
use super::{StorageBackend, StorageRead, WriteCallback};
use crate::durable::{CommitStats, Document, DocumentEvent, Error, Result, now_ms};

const COMMITS_FILE: &str = "commits.jsonl";
const META_FILE: &str = "meta.jsonl";
const DOCS_FILE: &str = "docs.jsonl";
const TASKS_FILE: &str = "tasks.jsonl";
const LOCK_FILE: &str = ".lock";
const CONVERSATIONS_DIR: &str = "conversations";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JsonlOptions {
    pub fsync: bool,
    pub read_only: bool,
}

impl Default for JsonlOptions {
    fn default() -> Self {
        Self { fsync: true, read_only: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitRecord {
    tx: u64,
    at_ms: i64,
    op_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarLine {
    tx: u64,
    op_seq: usize,
    #[serde(flatten)]
    op: JournalOp,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DiskStamp {
    commits_len: u64,
    commits_modified: Option<SystemTime>,
}

struct JsonlState {
    mem: MemoryState,
    next_tx_id: u64,
    stamp: DiskStamp,
    open_files: HashMap<PathBuf, File>,
}

struct JsonlInner {
    dir: PathBuf,
    opts: JsonlOptions,
    state: Mutex<JsonlState>,
    lock_file: Mutex<Option<File>>,
    hub: LiveHub,
}

impl Drop for JsonlInner {
    fn drop(&mut self) {
        if !self.hub.is_closed() && !self.opts.read_only {
            let _ = flush_jsonl(self, self.hub.now_ms(), true);
        }
        if let Ok(mut guard) = self.lock_file.lock() {
            guard.take();
        }
    }
}

#[derive(Clone)]
pub struct JsonlStorage(Arc<JsonlInner>);

impl JsonlStorage {
    pub fn open(dir: &Path) -> Result<Self> {
        Self::open_with_clock(dir, JsonlOptions::default(), now_ms)
    }

    pub fn open_read_only(dir: &Path) -> Result<Self> {
        Self::open_with_clock(dir, JsonlOptions { fsync: false, read_only: true }, now_ms)
    }

    pub fn open_with_options(dir: &Path, opts: JsonlOptions) -> Result<Self> {
        Self::open_with_clock(dir, opts, now_ms)
    }

    pub fn open_with_clock(dir: &Path, opts: JsonlOptions, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let dir = dir.to_path_buf();
        let lock_file = if opts.read_only {
            if !dir.is_dir() {
                return Err(Error::Invalid(format!("jsonl storage directory does not exist: {}", dir.display())));
            }
            None
        } else {
            fs::create_dir_all(dir.join(CONVERSATIONS_DIR)).map_err(|e| Error::Invalid(format!("create jsonl dir: {e}")))?;
            let lock_path = dir.join(LOCK_FILE);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&lock_path)
                .map_err(|e| Error::Invalid(format!("open jsonl lock {}: {e}", lock_path.display())))?;
            file.try_lock()
                .map_err(|e| Error::Invalid(format!("jsonl storage {} is already locked by another writer: {e}", dir.display())))?;
            Some(file)
        };

        let (mem, next_tx_id, stamp) = load_and_maybe_repair(&dir, opts)?;
        Ok(Self(Arc::new(JsonlInner {
            dir,
            opts,
            state: Mutex::new(JsonlState {
                mem,
                next_tx_id,
                stamp,
                open_files: HashMap::new(),
            }),
            lock_file: Mutex::new(lock_file),
            hub: LiveHub::new(Arc::new(clock)),
        })))
    }
}

fn encode_conv_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for b in id.bytes() {
        if matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.') {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn target_sidecar(dir: &Path, op: &JournalOp) -> PathBuf {
    match op {
        JournalOp::InsertEntry { entry } => dir.join(CONVERSATIONS_DIR).join(format!("{}.jsonl", encode_conv_id(&entry.conversation_id))),
        JournalOp::PutDocument { .. } | JournalOp::DeleteDocument { .. } => dir.join(DOCS_FILE),
        JournalOp::InsertTask { .. } | JournalOp::UpdateTask { .. } | JournalOp::InsertSignal { .. } | JournalOp::ConsumeSignal { .. } => dir.join(TASKS_FILE),
        JournalOp::InsertConversation { .. }
        | JournalOp::AdvanceSequence { .. }
        | JournalOp::SetHead { .. }
        | JournalOp::ResetHead { .. }
        | JournalOp::InsertSubmission { .. }
        | JournalOp::SetSubmissionStatus { .. }
        | JournalOp::SettleSubmission { .. } => dir.join(META_FILE),
    }
}

fn read_disk_stamp(dir: &Path) -> DiskStamp {
    let path = dir.join(COMMITS_FILE);
    match fs::metadata(path) {
        Ok(meta) => DiskStamp {
            commits_len: meta.len(),
            commits_modified: meta.modified().ok(),
        },
        Err(_) => DiskStamp::default(),
    }
}

struct ParsedLines<T> {
    items: Vec<(T, usize, String)>,
    had_torn_tail: bool,
}

fn parse_jsonl_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<ParsedLines<T>> {
    if !path.is_file() {
        return Ok(ParsedLines {
            items: Vec::new(),
            had_torn_tail: false,
        });
    }
    let bytes = fs::read(path).map_err(|e| Error::Invalid(format!("read {}: {e}", path.display())))?;
    let mut items = Vec::new();
    let mut pos = 0usize;
    let mut had_torn_tail = false;
    for chunk in bytes.split_inclusive(|&b| b == b'\n') {
        if !chunk.ends_with(b"\n") {
            had_torn_tail = true;
            break;
        }
        let Ok(text) = std::str::from_utf8(chunk) else {
            had_torn_tail = true;
            break;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            pos += chunk.len();
            continue;
        }
        match serde_json::from_str::<T>(trimmed) {
            Ok(item) => {
                pos += chunk.len();
                items.push((item, pos, trimmed.to_owned()));
            }
            Err(_) => {
                had_torn_tail = true;
                break;
            }
        }
    }
    Ok(ParsedLines { items, had_torn_tail })
}

fn collect_sidecar_paths(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = vec![dir.join(META_FILE), dir.join(DOCS_FILE), dir.join(TASKS_FILE)];
    let conv_dir = dir.join(CONVERSATIONS_DIR);
    if conv_dir.is_dir() {
        let mut conv_files = Vec::new();
        for entry in fs::read_dir(&conv_dir).map_err(|e| Error::Invalid(format!("read {}: {e}", conv_dir.display())))? {
            let entry = entry.map_err(|e| Error::Invalid(format!("read dir entry: {e}")))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") && path.is_file() {
                conv_files.push(path);
            }
        }
        conv_files.sort();
        files.extend(conv_files);
    }
    Ok(files)
}

fn write_atomic(path: &Path, lines: &[&str], fsync: bool) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Invalid("invalid sidecar path".into()))?;
    let tmp = path.with_file_name(format!(".{file_name}.repair.tmp"));
    {
        let mut out = File::create(&tmp).map_err(|e| Error::Invalid(format!("create {}: {e}", tmp.display())))?;
        for line in lines {
            out.write_all(line.as_bytes()).map_err(|e| Error::Invalid(e.to_string()))?;
            out.write_all(b"\n").map_err(|e| Error::Invalid(e.to_string()))?;
        }
        out.flush().map_err(|e| Error::Invalid(e.to_string()))?;
        if fsync {
            out.sync_data().map_err(|e| Error::Invalid(e.to_string()))?;
        }
    }
    fs::rename(&tmp, path).map_err(|e| Error::Invalid(format!("rename {} -> {}: {e}", tmp.display(), path.display())))?;
    Ok(())
}

fn load_and_maybe_repair(dir: &Path, opts: JsonlOptions) -> Result<(MemoryState, u64, DiskStamp)> {
    let commits_path = dir.join(COMMITS_FILE);
    let parsed_commits = parse_jsonl_file::<CommitRecord>(&commits_path)?;

    let sidecar_paths = collect_sidecar_paths(dir)?;
    let mut sidecars = Vec::with_capacity(sidecar_paths.len());
    let mut counts: HashMap<u64, usize> = HashMap::new();
    for path in sidecar_paths {
        let parsed = parse_jsonl_file::<SidecarLine>(&path)?;
        for (line, _, _) in &parsed.items {
            *counts.entry(line.tx).or_default() += 1;
        }
        sidecars.push((path, parsed));
    }

    let mut committed: BTreeMap<u64, CommitRecord> = BTreeMap::new();
    let mut commit_valid_bytes = 0usize;
    let mut commit_needs_truncate = parsed_commits.had_torn_tail;
    for (rec, end_offset, _) in &parsed_commits.items {
        if counts.get(&rec.tx).copied().unwrap_or(0) == rec.op_count {
            committed.insert(rec.tx, rec.clone());
            commit_valid_bytes = *end_offset;
        } else {
            // An incomplete commit marker stops prefix replay; strip anything beyond it on writable open.
            commit_needs_truncate = true;
            break;
        }
    }
    let committed_set: HashSet<u64> = committed.keys().copied().collect();

    if !opts.read_only {
        if commit_needs_truncate && commits_path.is_file() {
            let f = OpenOptions::new()
                .write(true)
                .open(&commits_path)
                .map_err(|e| Error::Invalid(format!("open {} for repair: {e}", commits_path.display())))?;
            f.set_len(commit_valid_bytes as u64)
                .map_err(|e| Error::Invalid(format!("truncate {}: {e}", commits_path.display())))?;
            if opts.fsync {
                f.sync_data().map_err(|e| Error::Invalid(e.to_string()))?;
            }
        }
        for (path, parsed) in &sidecars {
            let has_uncommitted = parsed.items.iter().any(|(l, _, _)| !committed_set.contains(&l.tx));
            if (parsed.had_torn_tail || has_uncommitted) && path.is_file() {
                let kept: Vec<&str> = parsed
                    .items
                    .iter()
                    .filter(|(l, _, _)| committed_set.contains(&l.tx))
                    .map(|(_, _, raw)| raw.as_str())
                    .collect();
                write_atomic(path, &kept, opts.fsync)?;
            }
        }
    }

    let mut ops_to_replay: Vec<SidecarLine> = Vec::new();
    for (_, parsed) in sidecars {
        for (line, _, _) in parsed.items {
            if committed_set.contains(&line.tx) {
                ops_to_replay.push(line);
            }
        }
    }
    ops_to_replay.sort_by_key(|l| (l.tx, l.op_seq));

    let mut mem = MemoryState::default();
    for line in &ops_to_replay {
        mem.apply_op(&line.op)?;
    }
    let next_tx_id = committed.keys().next_back().copied().unwrap_or(0) + 1;
    let stamp = read_disk_stamp(dir);
    Ok((mem, next_tx_id, stamp))
}

fn open_cached_append<'a>(open_files: &'a mut HashMap<PathBuf, File>, path: &Path) -> Result<&'a mut File> {
    if !open_files.contains_key(path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::Commit(e.to_string()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| Error::Commit(format!("open {}: {e}", path.display())))?;
        open_files.insert(path.to_path_buf(), file);
    }
    Ok(open_files.get_mut(path).expect("inserted above"))
}

fn persist_journal_ops(dir: &Path, tx_id: u64, now: i64, ops: &[JournalOp], fsync: bool, open_files: &mut HashMap<PathBuf, File>) -> Result<()> {
    if ops.is_empty() {
        return Ok(());
    }
    let mut by_file: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
    for (op_seq, op) in ops.iter().enumerate() {
        let path = target_sidecar(dir, op);
        let line = serde_json::to_string(&SidecarLine {
            tx: tx_id,
            op_seq,
            op: op.clone(),
        })?;
        by_file.entry(path).or_default().push(line);
    }

    for (path, lines) in by_file {
        let mut buf = String::new();
        for line in lines {
            buf.push_str(&line);
            buf.push('\n');
        }
        let f = open_cached_append(open_files, &path)?;
        f.write_all(buf.as_bytes()).map_err(|e| Error::Commit(e.to_string()))?;
        f.flush().map_err(|e| Error::Commit(e.to_string()))?;
        if fsync {
            f.sync_data().map_err(|e| Error::Commit(e.to_string()))?;
        }
    }

    let commits_path = dir.join(COMMITS_FILE);
    let mut marker = serde_json::to_string(&CommitRecord {
        tx: tx_id,
        at_ms: now,
        op_count: ops.len(),
    })?;
    marker.push('\n');
    let marker_file = open_cached_append(open_files, &commits_path)?;
    marker_file.write_all(marker.as_bytes()).map_err(|e| Error::Commit(e.to_string()))?;
    marker_file.flush().map_err(|e| Error::Commit(e.to_string()))?;
    if fsync {
        marker_file.sync_data().map_err(|e| Error::Commit(e.to_string()))?;
    }
    Ok(())
}

fn flush_jsonl(inner: &JsonlInner, now: i64, force: bool) -> Result<()> {
    if inner.opts.read_only {
        return Ok(());
    }
    let disk_batch = inner.hub.drain_due(now, force, |keys| {
        let state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut revs = HashMap::new();
        for key in keys {
            revs.insert(key.clone(), state.mem.documents.get(key).map_or(0, |d| d.rev));
        }
        Ok(revs)
    })?;
    if disk_batch.is_empty() {
        return Ok(());
    }
    let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
    let tx_id = state.next_tx_id;
    let JsonlState {
        mem, next_tx_id, open_files, ..
    } = &mut *state;
    let mut undo = Vec::new();
    let mut ops = Vec::with_capacity(disk_batch.len());
    let mut events = Vec::with_capacity(disk_batch.len());
    let mut keys = Vec::with_capacity(disk_batch.len());
    for (key, value) in disk_batch {
        let rev = mem.documents.get(&key).map_or(1, |d| d.rev + 1);
        let op = JournalOp::PutDocument {
            scope_kind: key.0.clone(),
            scope_id: key.1.clone(),
            doc_kind: key.2.clone(),
            rev,
            state: value.clone(),
            updated_at_ms: now,
        };
        if let Err(err) = mem.apply_op_with_undo(&op, &mut undo) {
            mem.rollback(undo);
            return Err(err);
        }
        ops.push(op);
        let doc = Document {
            scope_kind: key.0.clone(),
            scope_id: key.1.clone(),
            doc_kind: key.2.clone(),
            rev,
            state: value,
            updated_at_ms: now,
        };
        events.push(DocumentEvent {
            document: doc,
            durable: true,
            retired: false,
        });
        keys.push(key);
    }
    if let Err(err) = persist_journal_ops(&inner.dir, tx_id, now, &ops, inner.opts.fsync, open_files) {
        mem.rollback(undo);
        return Err(err);
    }
    *next_tx_id = tx_id + 1;
    inner.hub.complete_disk_flush(&keys, events);
    Ok(())
}

impl StorageBackend for JsonlStorage {
    fn kind(&self) -> &'static str {
        "jsonl"
    }

    fn is_read_only(&self) -> bool {
        self.0.opts.read_only
    }

    fn now_ms(&self) -> i64 {
        self.0.hub.now_ms()
    }

    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        if self.0.opts.read_only {
            let current_stamp = read_disk_stamp(&self.0.dir);
            if current_stamp != state.stamp {
                let (mem, next_tx_id, new_stamp) = load_and_maybe_repair(&self.0.dir, self.0.opts)?;
                state.mem = mem;
                state.next_tx_id = next_tx_id;
                state.stamp = new_stamp;
            }
        }
        f(&MemoryRead(&state.mem))
    }

    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()> {
        if self.0.opts.read_only {
            return Err(Error::Invalid("jsonl storage is open read-only".into()));
        }
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        self.0.hub.record_request();
        let now = self.0.hub.now_ms();
        let staging = MemoryTx::new(&mut state.mem, true);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&staging, &staging, None, now)));
        match outcome {
            Ok(Ok(write_outcome)) => {
                let (ops, undo) = staging.into_parts();
                if !ops.is_empty() {
                    let tx_id = state.next_tx_id;
                    let JsonlState {
                        mem, next_tx_id, open_files, ..
                    } = &mut *state;
                    if let Err(err) = persist_journal_ops(&self.0.dir, tx_id, now, &ops, self.0.opts.fsync, open_files) {
                        mem.rollback(undo);
                        self.0.hub.record_failure();
                        return Err(err);
                    }
                    *next_tx_id = tx_id + 1;
                }
                self.0.hub.record_commit_and_publish(write_outcome.events, write_outcome.tasks_changed);
                Ok(())
            }
            Ok(Err(err)) => {
                staging.rollback();
                self.0.hub.record_failure();
                Err(err)
            }
            Err(panic) => {
                staging.rollback();
                self.0.hub.record_failure();
                drop(state);
                std::panic::resume_unwind(panic)
            }
        }
    }

    fn stats(&self) -> CommitStats {
        self.0.hub.stats()
    }

    fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        self.0.hub.subscribe_documents()
    }

    fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        self.0.hub.subscribe_tasks()
    }

    fn put_deferred(&self, scope: &str, id: &str, kind: &str, state: Value) -> Result<()> {
        if self.0.opts.read_only {
            return Err(Error::Invalid("jsonl storage is open read-only".into()));
        }
        let weak = Arc::downgrade(&self.0);
        self.0.hub.queue_deferred(scope, id, kind, state, move || {
            std::thread::spawn(move || {
                loop {
                    let Some(inner) = weak.upgrade() else {
                        return;
                    };
                    if inner.hub.is_closed() {
                        return;
                    }
                    let now = inner.hub.now_ms();
                    if flush_jsonl(&inner, now, false).is_err() {
                        inner.hub.reschedule_disk_on_error(now);
                    }
                    let Some(wait) = inner.hub.next_timer_wait(now) else {
                        return;
                    };
                    drop(inner);
                    std::thread::sleep(wait);
                }
            });
        })
    }

    fn flush_due(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        flush_jsonl(&self.0, self.0.hub.now_ms(), false)
    }

    fn flush_deferred(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        flush_jsonl(&self.0, self.0.hub.now_ms(), true)
    }

    fn live_document(&self, scope: &str, id: &str) -> Result<Option<Document>> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        if self.0.opts.read_only {
            let current_stamp = read_disk_stamp(&self.0.dir);
            if current_stamp != state.stamp {
                let (mem, next_tx_id, new_stamp) = load_and_maybe_repair(&self.0.dir, self.0.opts)?;
                state.mem = mem;
                state.next_tx_id = next_tx_id;
                state.stamp = new_stamp;
            }
        }
        self.0.hub.live_document(scope, id, &MemoryRead(&state.mem))
    }

    fn close(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Ok(());
        }
        if !self.0.opts.read_only {
            flush_jsonl(&self.0, self.0.hub.now_ms(), true)?;
        }
        self.0.hub.mark_closed();
        self.0.state.lock().unwrap_or_else(|e| e.into_inner()).open_files.clear();
        self.0.lock_file.lock().unwrap_or_else(|e| e.into_inner()).take();
        Ok(())
    }
}
