//! Full-closure and `at_seq` sliced conversation extraction across `StorageBackend`s.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{Conversation, Document, Entry, Error, JsonlOptions, Read, Result, Signal, Store, Submission, SubmissionStatus, Task};
use crate::core::doc::{CONVERSATION_SCOPE, GovernanceState, TASK_SCOPE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExportOptions {
    pub at_seq: Option<i64>,
    pub include_children: bool,
    pub fsync: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            at_seq: None,
            include_children: true,
            fsync: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub root_conversation_id: String,
    pub at_seq: Option<i64>,
    pub conversations_exported: usize,
    pub entries_exported: usize,
    pub documents_exported: usize,
    pub tasks_exported: usize,
    pub signals_exported: usize,
    pub submissions_exported: usize,
}

struct CollectedBundle {
    conversations: Vec<Conversation>,
    entries: Vec<Entry>,
    documents: Vec<Document>,
    submissions: Vec<Submission>,
    tasks: Vec<Task>,
    signals: Vec<Signal>,
}

impl Store {
    pub fn export_conversation_to(&self, conv_id: &str, dest: &Store, opts: ExportOptions) -> Result<ExportManifest> {
        let bundle = self.read(|r| collect_bundle(r, conv_id, opts))?;

        let manifest = ExportManifest {
            root_conversation_id: conv_id.to_owned(),
            at_seq: opts.at_seq,
            conversations_exported: bundle.conversations.len(),
            entries_exported: bundle.entries.len(),
            documents_exported: bundle.documents.len(),
            tasks_exported: bundle.tasks.len(),
            signals_exported: bundle.signals.len(),
            submissions_exported: bundle.submissions.len(),
        };

        dest.write(|tx| {
            for conv in &bundle.conversations {
                tx.write.insert_conversation(conv)?;
            }
            for entry in &bundle.entries {
                tx.write.insert_entry(entry)?;
            }
            for doc in &bundle.documents {
                tx.write
                    .put_document(&doc.scope_kind, &doc.scope_id, &doc.doc_kind, &doc.state, doc.updated_at_ms)?;
            }
            for sub in &bundle.submissions {
                tx.write.insert_submission(sub)?;
                match sub.status {
                    SubmissionStatus::Queued => {}
                    SubmissionStatus::Placed => {
                        tx.write.set_submission_status(&sub.id, SubmissionStatus::Placed, sub.updated_at_ms)?;
                    }
                    SubmissionStatus::Done | SubmissionStatus::Unanswered => {
                        tx.write.settle_submission(&sub.id, sub.status, &sub.result, sub.updated_at_ms)?;
                    }
                }
            }
            for task in &bundle.tasks {
                tx.write.insert_task(task)?;
            }
            for sig in &bundle.signals {
                let _ = tx.write.insert_signal(sig)?;
                if sig.consumed {
                    let _ = tx.write.consume_first_signal(&sig.task_id, &sig.signal_name, sig.consumed_at_ms)?;
                }
            }
            Ok(())
        })?;

        Ok(manifest)
    }

    pub fn export_conversation_jsonl(&self, conv_id: &str, dest_dir: &Path, opts: ExportOptions) -> Result<ExportManifest> {
        let dest = Store::jsonl_with_options(
            dest_dir,
            JsonlOptions {
                fsync: opts.fsync,
                read_only: false,
            },
        )?;
        let manifest = self.export_conversation_to(conv_id, &dest, opts)?;
        dest.close()?;
        Ok(manifest)
    }
}

fn collect_bundle(r: &Read<'_>, conv_id: &str, opts: ExportOptions) -> Result<CollectedBundle> {
    let root = r.conversation(conv_id)?;
    if let Some(cut) = opts.at_seq
        && (cut < 0 || cut >= root.next_seq)
    {
        return Err(Error::Invalid(format!(
            "slice sequence {cut} outside conversation {conv_id} (next_seq={})",
            root.next_seq
        )));
    }

    let mut conv_map: HashMap<String, Conversation> = HashMap::new();
    let mut entry_keys: HashSet<(String, i64)> = HashSet::new();
    let mut entries: Vec<Entry> = Vec::new();
    let mut doc_keys: HashSet<(String, String, String)> = HashSet::new();
    let mut documents: Vec<Document> = Vec::new();
    let mut sub_map: HashMap<String, Submission> = HashMap::new();
    let mut task_map: HashMap<String, Task> = HashMap::new();
    let mut signals: Vec<Signal> = Vec::new();
    let mut signal_ids: HashSet<String> = HashSet::new();

    // 1. Collect ancestor lineage first so `visible_entries()` works identically in destination.
    let mut ancestor_chain: Vec<(Conversation, i64)> = Vec::new();
    let mut seen_ancestors = HashSet::from([root.id.clone()]);
    let mut cur = root.clone();
    let mut limit = opts.at_seq.unwrap_or(root.next_seq - 1);
    while !cur.parent_id.is_empty() {
        if !seen_ancestors.insert(cur.parent_id.clone()) {
            return Err(Error::Invalid("conversation fork cycle".into()));
        }
        limit = limit.min(cur.fork_entry_seq);
        let parent = r.conversation(&cur.parent_id)?;
        let capped_max = (parent.next_seq - 1).min(limit).max(0);
        ancestor_chain.push((parent.clone(), capped_max));
        cur = parent;
    }
    for (mut anc, max_seq) in ancestor_chain.into_iter().rev() {
        let anc_entries = if max_seq >= 1 {
            r.ops.entries_within(&anc.id, 1, max_seq)?
        } else {
            Vec::new()
        };
        if opts.at_seq.is_some() {
            anc.next_seq = max_seq + 1;
            anc.head_seq = if max_seq == 0 { 1 } else { anc.head_seq.min(max_seq) };
        }
        let anc_id = anc.id.clone();
        conv_map.entry(anc_id.clone()).or_insert(anc);
        for e in anc_entries {
            if entry_keys.insert((e.conversation_id.clone(), e.seq)) {
                entries.push(e);
            }
        }
        for doc in r.documents_by_scope(CONVERSATION_SCOPE, &anc_id)? {
            if should_skip_doc(&doc.doc_kind, opts.at_seq.is_some()) {
                continue;
            }
            let doc = sanitize_doc(doc, opts.at_seq.is_some())?;
            if doc_keys.insert((doc.scope_kind.clone(), doc.scope_id.clone(), doc.doc_kind.clone())) {
                documents.push(doc);
            }
        }
    }

    // 2. Sliced export (`at_seq = Some(cut)`): only root conversation up to `cut`, no in-flight tasks/subs.
    if let Some(cut) = opts.at_seq {
        let mut sliced_root = root.clone();
        sliced_root.next_seq = cut + 1;
        sliced_root.head_seq = if cut == 0 { 1 } else { root.head_seq.min(cut) };
        conv_map.insert(sliced_root.id.clone(), sliced_root);
        if cut >= 1 {
            for e in r.ops.entries_within(&root.id, 1, cut)? {
                if entry_keys.insert((e.conversation_id.clone(), e.seq)) {
                    entries.push(e);
                }
            }
        }
        for doc in r.documents_by_scope(CONVERSATION_SCOPE, &root.id)? {
            if should_skip_doc(&doc.doc_kind, true) {
                continue;
            }
            let doc = sanitize_doc(doc, true)?;
            if doc_keys.insert((doc.scope_kind.clone(), doc.scope_id.clone(), doc.doc_kind.clone())) {
                documents.push(doc);
            }
        }
    } else {
        // 3. Full closure export: conversations, entries, docs, submissions, tasks, signals, child subagents.
        let mut conv_queue = VecDeque::from([root]);
        while let Some(c) = conv_queue.pop_front() {
            let cid = c.id.clone();
            if conv_map.contains_key(&cid) {
                continue;
            }
            conv_map.insert(cid.clone(), c);
            for e in r.entries(&cid, 1)? {
                if entry_keys.insert((e.conversation_id.clone(), e.seq)) {
                    entries.push(e);
                }
            }
            for doc in r.documents_by_scope(CONVERSATION_SCOPE, &cid)? {
                if doc_keys.insert((doc.scope_kind.clone(), doc.scope_id.clone(), doc.doc_kind.clone())) {
                    documents.push(doc);
                }
            }
            for sub in r.submissions(&cid)? {
                sub_map.insert(sub.id.clone(), sub);
            }

            let mut task_queue = VecDeque::new();
            for t in r.tasks_by_conversation(&cid)? {
                let tid = t.id.clone();
                if !task_map.contains_key(&tid) {
                    task_queue.push_back(t);
                }
            }
            while let Some(t) = task_queue.pop_front() {
                let tid = t.id.clone();
                if task_map.contains_key(&tid) {
                    continue;
                }
                for child in r.children(&tid)? {
                    if !task_map.contains_key(&child.id) {
                        task_queue.push_back(child);
                    }
                }
                if opts.include_children {
                    for owned_conv in r.conversations_by_owner_task(&tid)? {
                        if !conv_map.contains_key(&owned_conv.id) {
                            conv_queue.push_back(owned_conv);
                        }
                    }
                }
                for doc in r.documents_by_scope(TASK_SCOPE, &tid)? {
                    if doc_keys.insert((doc.scope_kind.clone(), doc.scope_id.clone(), doc.doc_kind.clone())) {
                        documents.push(doc);
                    }
                }
                for sig in r.signals(&tid, true)? {
                    if signal_ids.insert(sig.id.clone()) {
                        signals.push(sig);
                    }
                }
                task_map.insert(tid, t);
            }
        }
    }

    let mut conversations: Vec<_> = conv_map.into_values().collect();
    // Parents must be created cleanly; sort by `(created_at_ms, id)` and topologically place parents first.
    conversations.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));

    entries.sort_by(|a, b| a.conversation_id.cmp(&b.conversation_id).then_with(|| a.seq.cmp(&b.seq)));
    documents.sort_by(|a, b| {
        a.scope_kind
            .cmp(&b.scope_kind)
            .then_with(|| a.scope_id.cmp(&b.scope_id))
            .then_with(|| a.doc_kind.cmp(&b.doc_kind))
    });
    let mut submissions: Vec<_> = sub_map.into_values().collect();
    submissions.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
    let mut tasks: Vec<_> = task_map.into_values().collect();
    tasks.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));

    Ok(CollectedBundle {
        conversations,
        entries,
        documents,
        submissions,
        tasks,
        signals,
    })
}

fn should_skip_doc(kind: &str, sliced: bool) -> bool {
    sliced && matches!(kind, "pi.live" | "pi.inbox" | "pi.verdict")
}

fn sanitize_doc(mut doc: Document, sliced: bool) -> Result<Document> {
    if sliced && doc.doc_kind == "pi.governance" {
        let mut gov: GovernanceState = serde_json::from_value(doc.state).unwrap_or_default();
        gov.pending_permissions.clear();
        gov.last_rubric_verdict = None;
        doc.state = serde_json::to_value(gov)?;
    }
    Ok(doc)
}
