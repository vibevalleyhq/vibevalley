use serde_json::json;

use crate::compaction::{Compactor, Level};
use crate::core::doc::{CONVERSATION_SCOPE, DocSpec, StandInDoc};
use crate::core::engine::{KIND, Request};
use crate::core::inbox::{self, WhenBusy};
use crate::durable::{DocumentEvent, Entry, Result, Submission, SubmissionStatus, Task, TaskStatus};
use crate::harness::Harness;

#[derive(Clone)]
pub struct ConversationHandle {
    conversation_id: String,
    harness: Harness,
}

impl ConversationHandle {
    pub fn new(conversation_id: impl Into<String>, harness: Harness) -> Self {
        Self {
            conversation_id: conversation_id.into(),
            harness,
        }
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn prompt(&self, provider: &str, request_id: &str, prompt: &str, system: &str) -> Result<(Submission, Task, bool)> {
        self.prompt_with(Request {
            conversation: &self.conversation_id,
            provider,
            request_id,
            prompt,
            source: "user",
            system,
            when_busy: WhenBusy::Reject,
            ..Default::default()
        })
    }

    pub fn prompt_with<'a>(&'a self, mut req: Request<'a>) -> Result<(Submission, Task, bool)> {
        req.conversation = &self.conversation_id;
        self.harness.submit(req)
    }

    pub fn steer(&self, request_id: &str, text: &str) -> Result<(Submission, bool)> {
        self.harness
            .store()
            .write(|tx| inbox::submit_steer(tx, &self.conversation_id, request_id, text))
    }

    pub fn follow_up(&self, request_id: &str, text: &str) -> Result<(Submission, bool)> {
        self.harness
            .store()
            .write(|tx| inbox::submit_follow_up(tx, &self.conversation_id, request_id, text, None))
    }

    pub fn compact(&self, level: Level, cut_seq: Option<i64>) -> Result<Option<Entry>> {
        Compactor::deterministic(self.harness.store().clone()).compact(&self.conversation_id, level, cut_seq)
    }

    pub fn fork(&self, new_conversation_id: &str, at_seq: i64, provider: &str) -> Result<ConversationHandle> {
        let forked = self.harness.store().write(|tx| {
            let child = tx.fork_conversation(&self.conversation_id, new_conversation_id, "", provider, at_seq)?;
            if let Some(standin) = tx.document(CONVERSATION_SCOPE, &self.conversation_id, StandInDoc::KIND)? {
                tx.put_document(CONVERSATION_SCOPE, &child.id, StandInDoc::KIND, &standin.state)?;
            }
            Ok(child)
        })?;
        Ok(ConversationHandle::new(forked.id, self.harness.clone()))
    }

    pub fn abort(&self) -> Result<Vec<String>> {
        let (task_ids, tree_ids) = self.harness.store().read(|r| {
            let roots: Vec<String> = r
                .tasks_by_conversation(&self.conversation_id)?
                .into_iter()
                .filter(|t| t.kind == KIND && t.status != TaskStatus::Terminal)
                .map(|t| t.id)
                .collect();
            let mut tree = Vec::new();
            let mut stack = roots.clone();
            while let Some(next) = stack.pop() {
                if !tree.contains(&next) {
                    tree.push(next.clone());
                    for child in r.children(&next)? {
                        stack.push(child.id);
                    }
                }
            }
            Ok((roots, tree))
        })?;
        for id in &task_ids {
            self.harness.scheduler().abort(id)?;
        }
        self.harness.engine().extensions_snapshot().notify_task_aborted(&tree_ids);
        self.harness.store().write(|tx| {
            for sub in tx.submissions(&self.conversation_id)? {
                if matches!(sub.status, SubmissionStatus::Queued | SubmissionStatus::Placed) {
                    tx.settle(&sub.id, SubmissionStatus::Unanswered, &json!({ "error": "aborted" }))?;
                }
            }
            Ok(())
        })?;
        Ok(task_ids)
    }

    pub fn entries(&self) -> Result<Vec<Entry>> {
        self.harness.entries(&self.conversation_id)
    }

    pub fn all_entries(&self) -> Result<Vec<Entry>> {
        self.harness.store().read(|r| r.entries(&self.conversation_id, 1))
    }

    pub fn watch(&self) -> Result<flume::Receiver<DocumentEvent>> {
        self.harness.store().subscribe_documents()
    }
}
