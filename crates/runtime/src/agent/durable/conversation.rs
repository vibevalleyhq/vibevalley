use std::collections::HashSet;

use serde_json::{Value, json};

use super::telemetry::TelemetryEvent;
use super::{Compaction, Conversation, Entry, Error, Read, Result, Submission, SubmissionStatus, Tx, id};

impl Read<'_> {
    pub async fn conversation_async(&self, id: &str) -> Result<Conversation> {
        self.ops.conversation_async(id).await?.ok_or_else(|| Error::Missing(id.into()))
    }

    pub async fn conversations_async(&self) -> Result<Vec<Conversation>> {
        self.ops.conversations_async().await
    }

    pub async fn conversations_by_owner_task_async(&self, id: &str) -> Result<Vec<Conversation>> {
        self.ops.conversations_by_owner_task_async(id).await
    }

    pub async fn entries_async(&self, id: &str, from: i64) -> Result<Vec<Entry>> {
        self.ops.entries_from_async(id, from.max(1)).await
    }

    pub async fn visible_entries_async(&self, id: &str) -> Result<Vec<Entry>> {
        let mut current = self.conversation_async(id).await?;
        let mut limit = current.next_seq - 1;
        let head = current.head_seq;
        let mut chain = vec![];
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current.id.clone()) {
                return Err(Error::Invalid("conversation fork cycle".into()));
            }
            let segment = self.ops.entries_within_async(&current.id, head, limit).await?;
            chain.push(segment);
            if current.parent_id.is_empty() {
                break;
            }
            limit = limit.min(current.fork_entry_seq);
            current = self.conversation_async(&current.parent_id).await?;
        }
        finalize_visible_entries(chain)
    }

    pub async fn submission_async(&self, id: &str) -> Result<Submission> {
        self.ops.submission_async(id).await?.ok_or_else(|| Error::Missing(id.into()))
    }

    pub async fn submission_by_request_async(&self, conv: &str, request: &str) -> Result<Option<Submission>> {
        self.ops.submission_by_request_async(conv, request).await
    }

    pub async fn submissions_async(&self, conv: &str) -> Result<Vec<Submission>> {
        self.ops.submissions_async(conv).await
    }
}

fn finalize_visible_entries(chain: Vec<Vec<Entry>>) -> Result<Vec<Entry>> {
    let mut entries: Vec<_> = chain.into_iter().rev().flatten().collect();
    if let Some(at) = entries.iter().rposition(|e| e.kind == "pi.reset") {
        entries.drain(..=at);
    }
    if let Some(at) = entries.iter().rposition(|e| e.kind == "pi.compaction") {
        let summary = entries.remove(at);
        let cut = summary.payload["cutSeq"]
            .as_i64()
            .ok_or_else(|| Error::Invalid("invalid compaction cut".into()))?;
        entries.retain(|e| e.kind != "pi.compaction" && e.seq > cut);
        entries.insert(0, summary);
    }
    Ok(entries)
}

impl Tx<'_> {
    pub async fn create_conversation_async(&mut self, conv: &str, provider: &str) -> Result<Conversation> {
        self.create_owned_conversation_async(conv, provider, "").await
    }

    pub async fn create_owned_conversation_async(&mut self, conv: &str, provider: &str, owner_task_id: &str) -> Result<Conversation> {
        let id = if conv.is_empty() { id() } else { conv.to_owned() };
        let record = Conversation {
            id: id.clone(),
            owner_task_id: owner_task_id.into(),
            parent_id: String::new(),
            fork_entry_seq: 0,
            head_seq: 1,
            next_seq: 1,
            provider_affinity: provider.into(),
            metadata: json!({}),
            created_at_ms: self.now_ms,
            updated_at_ms: self.now_ms,
        };
        self.write.insert_conversation_async(&record).await?;
        self.conversation_async(&id).await
    }

    pub async fn fork_conversation_async(&mut self, parent: &str, child: &str, owner: &str, provider: &str, seq: i64) -> Result<Conversation> {
        let p = self.conversation_async(parent).await?;
        if seq < 0 || seq >= p.next_seq {
            return Err(Error::Invalid(format!("fork sequence {seq} outside conversation {parent}")));
        }
        let head = if seq >= p.head_seq - 1 { p.head_seq } else { 1 };
        let child_id = if child.is_empty() { id() } else { child.to_owned() };
        let provider = if provider.is_empty() { &p.provider_affinity } else { provider };
        let record = Conversation {
            id: child_id.clone(),
            owner_task_id: owner.into(),
            parent_id: parent.into(),
            fork_entry_seq: seq,
            head_seq: head,
            next_seq: seq + 1,
            provider_affinity: provider.into(),
            metadata: json!({}),
            created_at_ms: self.now_ms,
            updated_at_ms: self.now_ms,
        };
        self.write.insert_conversation_async(&record).await?;
        self.conversation_async(&child_id).await
    }

    pub async fn append_entry_async(&mut self, conv: &str, kind: &str, payload: &Value) -> Result<Entry> {
        if kind.is_empty() {
            return Err(Error::Invalid("empty entry kind".into()));
        }
        let next_seq = self
            .write
            .advance_sequence_async(conv, self.now_ms)
            .await?
            .ok_or_else(|| Error::Missing(conv.into()))?;
        let seq = next_seq - 1;
        let entry = Entry {
            conversation_id: conv.into(),
            seq,
            kind: kind.into(),
            payload: payload.clone(),
            created_at_ms: self.now_ms,
        };
        self.write.insert_entry_async(&entry).await?;
        self.record_telemetry(TelemetryEvent::Entry {
            conversation_id: conv.into(),
            seq,
            kind: kind.into(),
            at_ms: self.now_ms,
        });
        Ok(entry)
    }

    pub async fn compact_async(&mut self, conv: &str, request: Compaction<'_>) -> Result<Option<Entry>> {
        let Compaction {
            level,
            base_head,
            from,
            cut,
            summary,
            token_count,
        } = request;
        let c = self.conversation_async(conv).await?;
        if cut < 1 || cut >= c.next_seq {
            return Err(Error::Invalid(format!("compaction cut {cut} outside conversation {conv}")));
        }
        if (base_head > 0 && c.head_seq > base_head) || cut < c.head_seq {
            return Ok(None);
        }
        let e = self
            .append_entry_async(
                conv,
                "pi.compaction",
                &json!({"level":level,"baseHeadSeq":base_head,"fromSeq":from,"cutSeq":cut,"summary":summary,"tokenCount":token_count}),
            )
            .await?;
        self.write.set_head_async(conv, cut + 1).await?;
        Ok(Some(e))
    }

    pub async fn reset_async(&mut self, conv: &str, payload: &Value) -> Result<Entry> {
        let e = self.append_entry_async(conv, "pi.reset", payload).await?;
        self.write.reset_head_async(conv).await?;
        Ok(e)
    }

    pub async fn submit_async(&mut self, conv: &str, request: &str, kind: &str, payload: &Value, notify: Option<&str>) -> Result<(Submission, bool)> {
        if conv.is_empty() || request.is_empty() {
            return Err(Error::Invalid("submission needs a conversation and request ID".into()));
        }
        if let Some(previous) = self.submission_by_request_async(conv, request).await? {
            return Ok((previous, true));
        }
        let id = id();
        let sub = Submission {
            id: id.clone(),
            conversation_id: conv.into(),
            request_id: request.into(),
            kind: if kind.is_empty() { "prompt" } else { kind }.into(),
            status: SubmissionStatus::Queued,
            payload: payload.clone(),
            notify_task_id: notify.unwrap_or_default().into(),
            result: json!({}),
            created_at_ms: self.now_ms,
            updated_at_ms: self.now_ms,
        };
        self.write.insert_submission_async(&sub).await?;
        let saved = self.submission_async(&id).await?;
        self.record_telemetry(TelemetryEvent::Submission {
            conversation_id: conv.into(),
            submission_id: saved.id.clone(),
            status: saved.status.as_str().into(),
            at_ms: self.now_ms,
        });
        Ok((saved, false))
    }

    pub async fn set_submission_status_async(&mut self, id: &str, status: SubmissionStatus) -> Result<Submission> {
        self.write.set_submission_status_async(id, status, self.now_ms).await?;
        self.submission_async(id).await
    }

    pub async fn settle_async(&mut self, id: &str, status: SubmissionStatus, result: &Value) -> Result<Submission> {
        if !matches!(status, SubmissionStatus::Done | SubmissionStatus::Unanswered) {
            return Err(Error::Invalid("settlement requires done or unanswered".into()));
        }
        let prior = self.submission_async(id).await?;
        if matches!(prior.status, SubmissionStatus::Done | SubmissionStatus::Unanswered) {
            return Ok(prior);
        }
        self.write.settle_submission_async(id, status, result, self.now_ms).await?;
        let sub = self.submission_async(id).await?;
        self.record_telemetry(TelemetryEvent::Submission {
            conversation_id: sub.conversation_id.clone(),
            submission_id: sub.id.clone(),
            status: sub.status.as_str().into(),
            at_ms: self.now_ms,
        });
        if !sub.notify_task_id.is_empty() {
            self.send_signal_async(
                &sub.notify_task_id,
                "pi.submission_settled",
                Some(id),
                &json!({"submissionId":id,"conversationId":sub.conversation_id,"requestId":sub.request_id,"status":status,"result":result}),
            )
            .await?;
        }
        Ok(sub)
    }
}
