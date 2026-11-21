//! Pure Rust in-memory `StorageBackend` implementation (`MemoryStorage`).
//! Also provides the deterministic `MemoryState` / `MemoryTx` model shared with `JsonlStorage`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::live::{DocKey, LiveHub};
use super::{StorageBackend, StorageRead, StorageWrite, WriteCallback};
use crate::agent::durable::{
    CommitStats, Conversation, Document, DocumentEvent, Entry, Error, Result, Signal, Submission, SubmissionStatus, Task, TaskStatus, now_ms,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum JournalOp {
    PutDocument {
        scope_kind: String,
        scope_id: String,
        doc_kind: String,
        rev: i64,
        state: Value,
        updated_at_ms: i64,
    },
    DeleteDocument {
        scope_kind: String,
        scope_id: String,
        doc_kind: String,
    },
    InsertConversation {
        conversation: Conversation,
    },
    AdvanceSequence {
        conversation_id: String,
        next_seq: i64,
        updated_at_ms: i64,
    },
    InsertEntry {
        entry: Entry,
    },
    SetHead {
        conversation_id: String,
        head_seq: i64,
    },
    ResetHead {
        conversation_id: String,
        head_seq: i64,
    },
    InsertSubmission {
        submission: Submission,
    },
    SetSubmissionStatus {
        id: String,
        status: SubmissionStatus,
        updated_at_ms: i64,
    },
    SettleSubmission {
        id: String,
        status: SubmissionStatus,
        result: Value,
        updated_at_ms: i64,
    },
    InsertTask {
        task: Task,
    },
    UpdateTask {
        task: Task,
    },
    InsertSignal {
        insert_seq: u64,
        signal: Signal,
    },
    ConsumeSignal {
        id: String,
        consumed_at_ms: i64,
    },
}

#[derive(Clone, Debug)]
pub(crate) enum UndoOp {
    RestoreDocument {
        key: DocKey,
        prev: Option<Box<Document>>,
    },
    RemoveConversation {
        id: String,
    },
    RestoreConversationSeq {
        id: String,
        next_seq: i64,
        updated_at_ms: i64,
    },
    RemoveEntry {
        conversation_id: String,
        seq: i64,
    },
    RestoreHead {
        conversation_id: String,
        head_seq: i64,
    },
    RemoveSubmission {
        id: String,
        req_key: (String, String),
    },
    RestoreSubmissionStatus {
        id: String,
        status: SubmissionStatus,
        updated_at_ms: i64,
    },
    RestoreSubmission {
        id: String,
        status: SubmissionStatus,
        result: Value,
        updated_at_ms: i64,
    },
    RemoveTask {
        id: String,
        dedup_key: Option<(String, String)>,
    },
    RestoreTask {
        id: String,
        prev: Box<Task>,
    },
    PopSignal {
        id: String,
        insert_seq: u64,
        prev_next_signal_seq: u64,
        task_id: String,
        signal_name: String,
        signal_key: Option<(String, String, String)>,
    },
    UnconsumeSignal {
        idx: usize,
        insert_seq: u64,
        task_id: String,
        signal_name: String,
        prev_consumed: bool,
        prev_consumed_at_ms: i64,
    },
}

#[derive(Clone, Default)]
pub(crate) struct MemoryState {
    pub(crate) conversations: HashMap<String, Conversation>,
    pub(crate) entries: HashMap<String, BTreeMap<i64, Entry>>,
    pub(crate) documents: HashMap<DocKey, Document>,
    pub(crate) submissions: HashMap<String, Submission>,
    pub(crate) submission_by_req: HashMap<(String, String), String>,
    pub(crate) tasks: HashMap<String, Task>,
    pub(crate) task_by_dedup: HashMap<(String, String), String>,
    pub(crate) signals: Vec<(u64, Signal)>,
    pub(crate) signal_by_id: HashMap<String, usize>,
    pub(crate) signal_by_key: HashMap<(String, String, String), usize>,
    pub(crate) pending_signals: HashMap<(String, String), BTreeSet<(u64, usize)>>,
    pub(crate) next_signal_seq: u64,
}

impl MemoryState {
    pub(crate) fn apply_op(&mut self, op: &JournalOp) -> Result<()> {
        self.apply_op_inner(op, None)
    }

    pub(crate) fn apply_op_with_undo(&mut self, op: &JournalOp, undo: &mut Vec<UndoOp>) -> Result<()> {
        self.apply_op_inner(op, Some(undo))
    }

    pub(crate) fn rollback(&mut self, mut undo: Vec<UndoOp>) {
        while let Some(entry) = undo.pop() {
            match entry {
                UndoOp::RestoreDocument { key, prev } => match prev {
                    Some(doc) => {
                        self.documents.insert(key, *doc);
                    }
                    None => {
                        self.documents.remove(&key);
                    }
                },
                UndoOp::RemoveConversation { id } => {
                    self.conversations.remove(&id);
                }
                UndoOp::RestoreConversationSeq { id, next_seq, updated_at_ms } => {
                    if let Some(conv) = self.conversations.get_mut(&id) {
                        conv.next_seq = next_seq;
                        conv.updated_at_ms = updated_at_ms;
                    }
                }
                UndoOp::RemoveEntry { conversation_id, seq } => {
                    if let Some(map) = self.entries.get_mut(&conversation_id) {
                        map.remove(&seq);
                        if map.is_empty() {
                            self.entries.remove(&conversation_id);
                        }
                    }
                }
                UndoOp::RestoreHead { conversation_id, head_seq } => {
                    if let Some(conv) = self.conversations.get_mut(&conversation_id) {
                        conv.head_seq = head_seq;
                    }
                }
                UndoOp::RemoveSubmission { id, req_key } => {
                    self.submissions.remove(&id);
                    self.submission_by_req.remove(&req_key);
                }
                UndoOp::RestoreSubmissionStatus { id, status, updated_at_ms } => {
                    if let Some(sub) = self.submissions.get_mut(&id) {
                        sub.status = status;
                        sub.updated_at_ms = updated_at_ms;
                    }
                }
                UndoOp::RestoreSubmission {
                    id,
                    status,
                    result,
                    updated_at_ms,
                } => {
                    if let Some(sub) = self.submissions.get_mut(&id) {
                        sub.status = status;
                        sub.result = result;
                        sub.updated_at_ms = updated_at_ms;
                    }
                }
                UndoOp::RemoveTask { id, dedup_key } => {
                    self.tasks.remove(&id);
                    if let Some(dk) = dedup_key {
                        self.task_by_dedup.remove(&dk);
                    }
                }
                UndoOp::RestoreTask { id, prev } => {
                    self.tasks.insert(id, *prev);
                }
                UndoOp::PopSignal {
                    id,
                    insert_seq,
                    prev_next_signal_seq,
                    task_id,
                    signal_name,
                    signal_key,
                } => {
                    let expected_idx = self.signals.len().saturating_sub(1);
                    self.signals.pop();
                    self.signal_by_id.remove(&id);
                    if let Some(sk) = signal_key {
                        self.signal_by_key.remove(&sk);
                    }
                    let pending_key = (task_id, signal_name);
                    if let Some(set) = self.pending_signals.get_mut(&pending_key) {
                        set.remove(&(insert_seq, expected_idx));
                        if set.is_empty() {
                            self.pending_signals.remove(&pending_key);
                        }
                    }
                    self.next_signal_seq = prev_next_signal_seq;
                }
                UndoOp::UnconsumeSignal {
                    idx,
                    insert_seq,
                    task_id,
                    signal_name,
                    prev_consumed,
                    prev_consumed_at_ms,
                } => {
                    if let Some((_, sig)) = self.signals.get_mut(idx) {
                        sig.consumed = prev_consumed;
                        sig.consumed_at_ms = prev_consumed_at_ms;
                        if !prev_consumed {
                            self.pending_signals.entry((task_id, signal_name)).or_default().insert((insert_seq, idx));
                        }
                    }
                }
            }
        }
    }

    fn apply_op_inner(&mut self, op: &JournalOp, undo: Option<&mut Vec<UndoOp>>) -> Result<()> {
        match op {
            JournalOp::PutDocument {
                scope_kind,
                scope_id,
                doc_kind,
                rev,
                state,
                updated_at_ms,
            } => {
                let key = (scope_kind.clone(), scope_id.clone(), doc_kind.clone());
                let prev = self.documents.insert(
                    key.clone(),
                    Document {
                        scope_kind: scope_kind.clone(),
                        scope_id: scope_id.clone(),
                        doc_kind: doc_kind.clone(),
                        rev: *rev,
                        state: state.clone(),
                        updated_at_ms: *updated_at_ms,
                    },
                );
                if let Some(log) = undo {
                    log.push(UndoOp::RestoreDocument { key, prev: prev.map(Box::new) });
                }
            }
            JournalOp::DeleteDocument {
                scope_kind,
                scope_id,
                doc_kind,
            } => {
                let key = (scope_kind.clone(), scope_id.clone(), doc_kind.clone());
                if let Some(prev) = self.documents.remove(&key)
                    && let Some(log) = undo
                {
                    log.push(UndoOp::RestoreDocument {
                        key,
                        prev: Some(Box::new(prev)),
                    });
                }
            }
            JournalOp::InsertConversation { conversation } => {
                if self.conversations.contains_key(&conversation.id) {
                    return Err(Error::Commit(format!("duplicate conversation {}", conversation.id)));
                }
                self.conversations.insert(conversation.id.clone(), conversation.clone());
                if let Some(log) = undo {
                    log.push(UndoOp::RemoveConversation { id: conversation.id.clone() });
                }
            }
            JournalOp::AdvanceSequence {
                conversation_id,
                next_seq,
                updated_at_ms,
            } => {
                let conv = self
                    .conversations
                    .get_mut(conversation_id)
                    .ok_or_else(|| Error::Missing(conversation_id.clone()))?;
                if let Some(log) = undo {
                    log.push(UndoOp::RestoreConversationSeq {
                        id: conversation_id.clone(),
                        next_seq: conv.next_seq,
                        updated_at_ms: conv.updated_at_ms,
                    });
                }
                conv.next_seq = *next_seq;
                conv.updated_at_ms = *updated_at_ms;
            }
            JournalOp::InsertEntry { entry } => {
                let map = self.entries.entry(entry.conversation_id.clone()).or_default();
                if map.contains_key(&entry.seq) {
                    return Err(Error::Commit(format!("duplicate entry {}:{}", entry.conversation_id, entry.seq)));
                }
                map.insert(entry.seq, entry.clone());
                if let Some(log) = undo {
                    log.push(UndoOp::RemoveEntry {
                        conversation_id: entry.conversation_id.clone(),
                        seq: entry.seq,
                    });
                }
            }
            JournalOp::SetHead { conversation_id, head_seq } | JournalOp::ResetHead { conversation_id, head_seq } => {
                if let Some(conv) = self.conversations.get_mut(conversation_id) {
                    if let Some(log) = undo {
                        log.push(UndoOp::RestoreHead {
                            conversation_id: conversation_id.clone(),
                            head_seq: conv.head_seq,
                        });
                    }
                    conv.head_seq = *head_seq;
                }
            }
            JournalOp::InsertSubmission { submission } => {
                if self.submissions.contains_key(&submission.id) {
                    return Err(Error::Commit(format!("duplicate submission {}", submission.id)));
                }
                let req_key = (submission.conversation_id.clone(), submission.request_id.clone());
                if self.submission_by_req.contains_key(&req_key) {
                    return Err(Error::Commit(format!(
                        "duplicate submission request {}:{}",
                        submission.conversation_id, submission.request_id
                    )));
                }
                self.submission_by_req.insert(req_key.clone(), submission.id.clone());
                self.submissions.insert(submission.id.clone(), submission.clone());
                if let Some(log) = undo {
                    log.push(UndoOp::RemoveSubmission {
                        id: submission.id.clone(),
                        req_key,
                    });
                }
            }
            JournalOp::SetSubmissionStatus { id, status, updated_at_ms } => {
                if let Some(sub) = self.submissions.get_mut(id) {
                    if let Some(log) = undo {
                        log.push(UndoOp::RestoreSubmissionStatus {
                            id: id.clone(),
                            status: sub.status,
                            updated_at_ms: sub.updated_at_ms,
                        });
                    }
                    sub.status = *status;
                    sub.updated_at_ms = *updated_at_ms;
                }
            }
            JournalOp::SettleSubmission {
                id,
                status,
                result,
                updated_at_ms,
            } => {
                if let Some(sub) = self.submissions.get_mut(id) {
                    let prev_result = std::mem::replace(&mut sub.result, result.clone());
                    if let Some(log) = undo {
                        log.push(UndoOp::RestoreSubmission {
                            id: id.clone(),
                            status: sub.status,
                            result: prev_result,
                            updated_at_ms: sub.updated_at_ms,
                        });
                    }
                    sub.status = *status;
                    sub.updated_at_ms = *updated_at_ms;
                }
            }
            JournalOp::InsertTask { task } => {
                if self.tasks.contains_key(&task.id) {
                    return Err(Error::Commit(format!("duplicate task {}", task.id)));
                }
                let dedup_key = if task.dedup_key.is_empty() {
                    None
                } else {
                    let dk = (task.owner_task_id.clone(), task.dedup_key.clone());
                    if self.task_by_dedup.contains_key(&dk) {
                        return Err(Error::Commit(format!("duplicate task dedup {}:{}", task.owner_task_id, task.dedup_key)));
                    }
                    self.task_by_dedup.insert(dk.clone(), task.id.clone());
                    Some(dk)
                };
                self.tasks.insert(task.id.clone(), task.clone());
                if let Some(log) = undo {
                    log.push(UndoOp::RemoveTask {
                        id: task.id.clone(),
                        dedup_key,
                    });
                }
            }
            JournalOp::UpdateTask { task } => {
                if let Some(existing) = self.tasks.get_mut(&task.id) {
                    if let Some(log) = undo {
                        log.push(UndoOp::RestoreTask {
                            id: task.id.clone(),
                            prev: Box::new(existing.clone()),
                        });
                    }
                    existing.status = task.status;
                    existing.terminal_reason = task.terminal_reason.clone();
                    existing.restart_count = task.restart_count;
                    existing.restart_limit = task.restart_limit;
                    existing.phase_name = task.phase_name.clone();
                    existing.checkpoint = task.checkpoint.clone();
                    existing.wake_until_ms = task.wake_until_ms;
                    existing.wait_mode = task.wait_mode;
                    existing.wait_task_ids = task.wait_task_ids.clone();
                    existing.wait_signal_name = task.wait_signal_name.clone();
                    existing.memo = task.memo.clone();
                    existing.result = task.result.clone();
                    existing.error_text = task.error_text.clone();
                    existing.updated_at_ms = task.updated_at_ms;
                }
            }
            JournalOp::InsertSignal { insert_seq, signal } => {
                if self.signal_by_id.contains_key(&signal.id) {
                    return Err(Error::Commit(format!("duplicate signal {}", signal.id)));
                }
                let signal_key = if signal.signal_key.is_empty() {
                    None
                } else {
                    let sk = (signal.task_id.clone(), signal.signal_name.clone(), signal.signal_key.clone());
                    if self.signal_by_key.contains_key(&sk) {
                        return Err(Error::Commit(format!("duplicate signal key {sk:?}")));
                    }
                    Some(sk)
                };
                let prev_next_signal_seq = self.next_signal_seq;
                self.next_signal_seq = self.next_signal_seq.max(*insert_seq);
                let idx = self.signals.len();
                if let Some(sk) = &signal_key {
                    self.signal_by_key.insert(sk.clone(), idx);
                }
                self.signal_by_id.insert(signal.id.clone(), idx);
                if !signal.consumed {
                    self.pending_signals
                        .entry((signal.task_id.clone(), signal.signal_name.clone()))
                        .or_default()
                        .insert((*insert_seq, idx));
                }
                self.signals.push((*insert_seq, signal.clone()));
                if let Some(log) = undo {
                    log.push(UndoOp::PopSignal {
                        id: signal.id.clone(),
                        insert_seq: *insert_seq,
                        prev_next_signal_seq,
                        task_id: signal.task_id.clone(),
                        signal_name: signal.signal_name.clone(),
                        signal_key,
                    });
                }
            }
            JournalOp::ConsumeSignal { id, consumed_at_ms } => {
                if let Some(&idx) = self.signal_by_id.get(id)
                    && let Some((insert_seq, sig)) = self.signals.get_mut(idx)
                {
                    let seq = *insert_seq;
                    let prev_consumed = sig.consumed;
                    let prev_consumed_at_ms = sig.consumed_at_ms;
                    let task_id = sig.task_id.clone();
                    let signal_name = sig.signal_name.clone();
                    sig.consumed = true;
                    sig.consumed_at_ms = *consumed_at_ms;
                    if !prev_consumed {
                        let key = (task_id.clone(), signal_name.clone());
                        if let Some(set) = self.pending_signals.get_mut(&key) {
                            set.remove(&(seq, idx));
                            if set.is_empty() {
                                self.pending_signals.remove(&key);
                            }
                        }
                    }
                    if let Some(log) = undo {
                        log.push(UndoOp::UnconsumeSignal {
                            idx,
                            insert_seq: seq,
                            task_id,
                            signal_name,
                            prev_consumed,
                            prev_consumed_at_ms,
                        });
                    }
                }
            }
        }
        Ok(())
    }
}

pub(crate) struct MemoryRead<'a>(pub(crate) &'a MemoryState);

impl StorageRead for MemoryRead<'_> {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        Ok(self.0.documents.get(&(scope.into(), id.into(), kind.into())).cloned())
    }

    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        let mut docs: Vec<_> = self
            .0
            .documents
            .iter()
            .filter(|((sk, _, dk), _)| sk == scope && dk == kind)
            .map(|(_, d)| d.clone())
            .collect();
        docs.sort_by(|a, b| a.scope_id.cmp(&b.scope_id));
        Ok(docs)
    }

    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        let mut docs: Vec<_> = self
            .0
            .documents
            .iter()
            .filter(|((sk, si, _), _)| sk == scope && si == id)
            .map(|(_, d)| d.clone())
            .collect();
        docs.sort_by(|a, b| a.doc_kind.cmp(&b.doc_kind));
        Ok(docs)
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        Ok(self.0.conversations.get(id).cloned())
    }

    fn conversations(&self) -> Result<Vec<Conversation>> {
        let mut out: Vec<_> = self.0.conversations.values().cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>> {
        let mut out: Vec<_> = self.0.conversations.values().filter(|c| c.owner_task_id == owner_task_id).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
        let Some(map) = self.0.entries.get(conv) else {
            return Ok(Vec::new());
        };
        Ok(map.range(from_seq..).map(|(_, e)| e.clone()).collect())
    }

    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
        if last_seq < first_seq {
            return Ok(Vec::new());
        }
        let Some(map) = self.0.entries.get(conv) else {
            return Ok(Vec::new());
        };
        Ok(map.range(first_seq..=last_seq).map(|(_, e)| e.clone()).collect())
    }

    fn submission(&self, id: &str) -> Result<Option<Submission>> {
        Ok(self.0.submissions.get(id).cloned())
    }

    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>> {
        let Some(id) = self.0.submission_by_req.get(&(conv.into(), request_id.into())) else {
            return Ok(None);
        };
        Ok(self.0.submissions.get(id).cloned())
    }

    fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        let mut out: Vec<_> = self.0.submissions.values().filter(|s| s.conversation_id == conv).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn task(&self, id: &str) -> Result<Option<Task>> {
        Ok(self.0.tasks.get(id).cloned())
    }

    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        if key.is_empty() {
            return Ok(None);
        }
        let Some(id) = self.0.task_by_dedup.get(&(owner.into(), key.into())) else {
            return Ok(None);
        };
        Ok(self.0.tasks.get(id).cloned())
    }

    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>> {
        let mut out: Vec<_> = self.0.tasks.values().filter(|t| t.conversation_id == conv).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn children(&self, owner: &str) -> Result<Vec<Task>> {
        let mut out: Vec<_> = self.0.tasks.values().filter(|t| t.owner_task_id == owner).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        let mut out: Vec<_> = self.0.tasks.values().filter(|t| t.status == status).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn active_tasks(&self) -> Result<Vec<Task>> {
        let mut out: Vec<_> = self.0.tasks.values().filter(|t| t.status != TaskStatus::Terminal).cloned().collect();
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        let mut out: Vec<_> = self
            .0
            .signals
            .iter()
            .filter(|(_, s)| s.task_id == task_id && (!s.consumed || include_consumed))
            .collect();
        out.sort_by_key(|(seq, _)| *seq);
        Ok(out.into_iter().map(|(_, s)| s.clone()).collect())
    }

    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
        if key.is_empty() {
            return Ok(None);
        }
        Ok(self
            .0
            .signal_by_key
            .get(&(task_id.into(), name.into(), key.into()))
            .and_then(|&idx| self.0.signals.get(idx))
            .map(|(_, s)| s.clone()))
    }
}

pub(crate) struct MemoryTx<'a> {
    pub(crate) state: RefCell<&'a mut MemoryState>,
    pub(crate) undo: RefCell<Vec<UndoOp>>,
    pub(crate) ops: RefCell<Vec<JournalOp>>,
    record_ops: bool,
}

impl<'a> MemoryTx<'a> {
    pub(crate) fn new(state: &'a mut MemoryState, record_ops: bool) -> Self {
        Self {
            state: RefCell::new(state),
            undo: RefCell::new(Vec::new()),
            ops: RefCell::new(Vec::new()),
            record_ops,
        }
    }

    fn record(&self, op: JournalOp) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let mut undo = self.undo.borrow_mut();
        state.apply_op_with_undo(&op, &mut undo)?;
        if self.record_ops {
            self.ops.borrow_mut().push(op);
        }
        Ok(())
    }

    pub(crate) fn rollback(self) {
        let state = self.state.into_inner();
        state.rollback(self.undo.into_inner());
    }

    pub(crate) fn into_parts(self) -> (Vec<JournalOp>, Vec<UndoOp>) {
        (self.ops.into_inner(), self.undo.into_inner())
    }
}

impl StorageRead for MemoryTx<'_> {
    fn document(&self, scope: &str, id: &str, kind: &str) -> Result<Option<Document>> {
        MemoryRead(&self.state.borrow()).document(scope, id, kind)
    }
    fn documents_by_kind(&self, scope: &str, kind: &str) -> Result<Vec<Document>> {
        MemoryRead(&self.state.borrow()).documents_by_kind(scope, kind)
    }
    fn documents_by_scope(&self, scope: &str, id: &str) -> Result<Vec<Document>> {
        MemoryRead(&self.state.borrow()).documents_by_scope(scope, id)
    }
    fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        MemoryRead(&self.state.borrow()).conversation(id)
    }
    fn conversations(&self) -> Result<Vec<Conversation>> {
        MemoryRead(&self.state.borrow()).conversations()
    }
    fn conversations_by_owner_task(&self, owner_task_id: &str) -> Result<Vec<Conversation>> {
        MemoryRead(&self.state.borrow()).conversations_by_owner_task(owner_task_id)
    }
    fn entries_from(&self, conv: &str, from_seq: i64) -> Result<Vec<Entry>> {
        MemoryRead(&self.state.borrow()).entries_from(conv, from_seq)
    }
    fn entries_within(&self, conv: &str, first_seq: i64, last_seq: i64) -> Result<Vec<Entry>> {
        MemoryRead(&self.state.borrow()).entries_within(conv, first_seq, last_seq)
    }
    fn submission(&self, id: &str) -> Result<Option<Submission>> {
        MemoryRead(&self.state.borrow()).submission(id)
    }
    fn submission_by_request(&self, conv: &str, request_id: &str) -> Result<Option<Submission>> {
        MemoryRead(&self.state.borrow()).submission_by_request(conv, request_id)
    }
    fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        MemoryRead(&self.state.borrow()).submissions(conv)
    }
    fn task(&self, id: &str) -> Result<Option<Task>> {
        MemoryRead(&self.state.borrow()).task(id)
    }
    fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        MemoryRead(&self.state.borrow()).task_by_dedup(owner, key)
    }
    fn tasks_by_conversation(&self, conv: &str) -> Result<Vec<Task>> {
        MemoryRead(&self.state.borrow()).tasks_by_conversation(conv)
    }
    fn children(&self, owner: &str) -> Result<Vec<Task>> {
        MemoryRead(&self.state.borrow()).children(owner)
    }
    fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        MemoryRead(&self.state.borrow()).tasks_by_status(status)
    }
    fn active_tasks(&self) -> Result<Vec<Task>> {
        MemoryRead(&self.state.borrow()).active_tasks()
    }
    fn signals(&self, task_id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        MemoryRead(&self.state.borrow()).signals(task_id, include_consumed)
    }
    fn signal_by_key(&self, task_id: &str, name: &str, key: &str) -> Result<Option<Signal>> {
        MemoryRead(&self.state.borrow()).signal_by_key(task_id, name, key)
    }
}

impl StorageWrite for MemoryTx<'_> {
    fn put_document(&self, scope: &str, id: &str, kind: &str, state: &Value, now_ms: i64) -> Result<i64> {
        let rev = self
            .state
            .borrow()
            .documents
            .get(&(scope.into(), id.into(), kind.into()))
            .map_or(1, |d| d.rev + 1);
        self.record(JournalOp::PutDocument {
            scope_kind: scope.into(),
            scope_id: id.into(),
            doc_kind: kind.into(),
            rev,
            state: state.clone(),
            updated_at_ms: now_ms,
        })?;
        Ok(rev)
    }

    fn delete_document(&self, scope: &str, id: &str, kind: &str) -> Result<()> {
        if self.state.borrow().documents.contains_key(&(scope.into(), id.into(), kind.into())) {
            self.record(JournalOp::DeleteDocument {
                scope_kind: scope.into(),
                scope_id: id.into(),
                doc_kind: kind.into(),
            })?;
        }
        Ok(())
    }

    fn insert_conversation(&self, conv: &Conversation) -> Result<()> {
        self.record(JournalOp::InsertConversation { conversation: conv.clone() })
    }

    fn advance_sequence(&self, conv: &str, now_ms: i64) -> Result<Option<i64>> {
        let Some(next_seq) = self.state.borrow().conversations.get(conv).map(|c| c.next_seq + 1) else {
            return Ok(None);
        };
        self.record(JournalOp::AdvanceSequence {
            conversation_id: conv.into(),
            next_seq,
            updated_at_ms: now_ms,
        })?;
        Ok(Some(next_seq))
    }

    fn insert_entry(&self, entry: &Entry) -> Result<()> {
        self.record(JournalOp::InsertEntry { entry: entry.clone() })
    }

    fn set_head(&self, conv: &str, head_seq: i64) -> Result<()> {
        if self.state.borrow().conversations.contains_key(conv) {
            self.record(JournalOp::SetHead {
                conversation_id: conv.into(),
                head_seq,
            })?;
        }
        Ok(())
    }

    fn reset_head(&self, conv: &str) -> Result<()> {
        let Some(head_seq) = self.state.borrow().conversations.get(conv).map(|c| c.next_seq) else {
            return Ok(());
        };
        self.record(JournalOp::ResetHead {
            conversation_id: conv.into(),
            head_seq,
        })
    }

    fn insert_submission(&self, sub: &Submission) -> Result<()> {
        self.record(JournalOp::InsertSubmission { submission: sub.clone() })
    }

    fn set_submission_status(&self, id: &str, status: SubmissionStatus, now_ms: i64) -> Result<()> {
        if self.state.borrow().submissions.contains_key(id) {
            self.record(JournalOp::SetSubmissionStatus {
                id: id.into(),
                status,
                updated_at_ms: now_ms,
            })?;
        }
        Ok(())
    }

    fn settle_submission(&self, id: &str, status: SubmissionStatus, result: &Value, now_ms: i64) -> Result<()> {
        if self.state.borrow().submissions.contains_key(id) {
            self.record(JournalOp::SettleSubmission {
                id: id.into(),
                status,
                result: result.clone(),
                updated_at_ms: now_ms,
            })?;
        }
        Ok(())
    }

    fn insert_task(&self, task: &Task) -> Result<()> {
        self.record(JournalOp::InsertTask { task: task.clone() })
    }

    fn update_task(&self, task: &Task, now_ms: i64) -> Result<bool> {
        if !self.state.borrow().tasks.contains_key(&task.id) {
            return Ok(false);
        }
        let mut updated = task.clone();
        updated.updated_at_ms = now_ms;
        self.record(JournalOp::UpdateTask { task: updated })?;
        Ok(true)
    }

    fn insert_signal(&self, signal: &Signal) -> Result<Signal> {
        let insert_seq = self.state.borrow().next_signal_seq + 1;
        self.record(JournalOp::InsertSignal {
            insert_seq,
            signal: signal.clone(),
        })?;
        Ok(signal.clone())
    }

    fn consume_first_signal(&self, task_id: &str, name: &str, now_ms: i64) -> Result<Option<Signal>> {
        let candidate_id = {
            let state = self.state.borrow();
            state
                .pending_signals
                .get(&(task_id.to_owned(), name.to_owned()))
                .and_then(|pending| pending.first().copied())
                .and_then(|(_, idx)| state.signals.get(idx))
                .map(|(_, s)| s.id.clone())
        };
        let Some(id) = candidate_id else {
            return Ok(None);
        };
        self.record(JournalOp::ConsumeSignal {
            id: id.clone(),
            consumed_at_ms: now_ms,
        })?;
        let state = self.state.borrow();
        Ok(state.signal_by_id.get(&id).and_then(|&idx| state.signals.get(idx)).map(|(_, s)| s.clone()))
    }
}

struct MemoryInner {
    state: Mutex<MemoryState>,
    hub: LiveHub,
}

impl Drop for MemoryInner {
    fn drop(&mut self) {
        if !self.hub.is_closed() {
            let _ = flush_memory(&self.state, &self.hub, self.hub.now_ms(), true);
        }
    }
}

#[derive(Clone)]
pub struct MemoryStorage(Arc<MemoryInner>);

impl MemoryStorage {
    pub fn new() -> Self {
        Self::with_clock(now_ms)
    }

    pub fn with_clock(clock: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        Self(Arc::new(MemoryInner {
            state: Mutex::new(MemoryState::default()),
            hub: LiveHub::new(Arc::new(clock)),
        }))
    }
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

fn flush_memory(state_mutex: &Mutex<MemoryState>, hub: &LiveHub, now: i64, force: bool) -> Result<()> {
    let disk_batch = hub.drain_due(now, force, |keys| {
        let state = state_mutex.lock().unwrap_or_else(|e| e.into_inner());
        let mut revs = HashMap::new();
        for key in keys {
            revs.insert(key.clone(), state.documents.get(key).map_or(0, |d| d.rev));
        }
        Ok(revs)
    })?;
    if disk_batch.is_empty() {
        return Ok(());
    }
    let mut state = state_mutex.lock().unwrap_or_else(|e| e.into_inner());
    let mut events = Vec::with_capacity(disk_batch.len());
    let mut keys = Vec::with_capacity(disk_batch.len());
    for (key, value) in disk_batch {
        let rev = state.documents.get(&key).map_or(1, |d| d.rev + 1);
        let doc = Document {
            scope_kind: key.0.clone(),
            scope_id: key.1.clone(),
            doc_kind: key.2.clone(),
            rev,
            state: value,
            updated_at_ms: now,
        };
        state.documents.insert(key.clone(), doc.clone());
        events.push(DocumentEvent {
            document: doc,
            durable: true,
            retired: false,
        });
        keys.push(key);
    }
    hub.complete_disk_flush(&keys, events);
    Ok(())
}

impl StorageBackend for MemoryStorage {
    fn kind(&self) -> &'static str {
        "memory"
    }

    fn now_ms(&self) -> i64 {
        self.0.hub.now_ms()
    }

    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> Result<()>) -> Result<()> {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        f(&MemoryRead(&state))
    }

    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> Result<()> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        self.0.hub.record_request();
        let now = self.0.hub.now_ms();
        let staging = MemoryTx::new(&mut state, false);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&staging, &staging, None, now)));
        match outcome {
            Ok(Ok(write_outcome)) => {
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
                    if flush_memory(&inner.state, &inner.hub, now, false).is_err() {
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
        flush_memory(&self.0.state, &self.0.hub, self.0.hub.now_ms(), false)
    }

    fn flush_deferred(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        flush_memory(&self.0.state, &self.0.hub, self.0.hub.now_ms(), true)
    }

    fn live_document(&self, scope: &str, id: &str) -> Result<Option<Document>> {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.hub.is_closed() {
            return Err(Error::Closed);
        }
        self.0.hub.live_document(scope, id, &MemoryRead(&state))
    }

    fn close(&self) -> Result<()> {
        if self.0.hub.is_closed() {
            return Ok(());
        }
        flush_memory(&self.0.state, &self.0.hub, self.0.hub.now_ms(), true)?;
        self.0.hub.mark_closed();
        Ok(())
    }
}
