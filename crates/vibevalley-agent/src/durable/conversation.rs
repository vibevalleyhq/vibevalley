use std::collections::HashSet;

use serde_json::{Value, json};

use super::telemetry::TelemetryEvent;
use super::{Compaction, Conversation, Entry, Error, Read, Result, Submission, SubmissionStatus, Tx, id};

impl Read<'_> {
    pub fn conversation(&self, id: &str) -> Result<Conversation> {
        self.ops.conversation(id)?.ok_or_else(|| Error::Missing(id.into()))
    }

    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        self.ops.conversations()
    }

    pub fn conversations_by_owner_task(&self, id: &str) -> Result<Vec<Conversation>> {
        self.ops.conversations_by_owner_task(id)
    }

    pub fn entries(&self, id: &str, from: i64) -> Result<Vec<Entry>> {
        self.ops.entries_from(id, from.max(1))
    }

    pub fn visible_entries(&self, id: &str) -> Result<Vec<Entry>> {
        let mut current = self.conversation(id)?;
        let mut limit = current.next_seq - 1;
        let head = current.head_seq;
        let mut chain = vec![];
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current.id.clone()) {
                return Err(Error::Invalid("conversation fork cycle".into()));
            }
            let segment = self.ops.entries_within(&current.id, head, limit)?;
            chain.push(segment);
            if current.parent_id.is_empty() {
                break;
            }
            limit = limit.min(current.fork_entry_seq);
            current = self.conversation(&current.parent_id)?;
        }
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

    pub fn submission(&self, id: &str) -> Result<Submission> {
        self.ops.submission(id)?.ok_or_else(|| Error::Missing(id.into()))
    }

    pub fn submission_by_request(&self, conv: &str, request: &str) -> Result<Option<Submission>> {
        self.ops.submission_by_request(conv, request)
    }

    pub fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        self.ops.submissions(conv)
    }
}

impl Tx<'_> {
    pub fn create_conversation(&mut self, conv: &str, provider: &str) -> Result<Conversation> {
        self.create_owned_conversation(conv, provider, "")
    }

    pub fn create_owned_conversation(&mut self, conv: &str, provider: &str, owner_task_id: &str) -> Result<Conversation> {
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
        self.write.insert_conversation(&record)?;
        self.conversation(&id)
    }

    pub fn fork_conversation(&mut self, parent: &str, child: &str, owner: &str, provider: &str, seq: i64) -> Result<Conversation> {
        let p = self.conversation(parent)?;
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
        self.write.insert_conversation(&record)?;
        self.conversation(&child_id)
    }

    pub fn append_entry(&mut self, conv: &str, kind: &str, payload: &Value) -> Result<Entry> {
        if kind.is_empty() {
            return Err(Error::Invalid("empty entry kind".into()));
        }
        let next_seq = self.write.advance_sequence(conv, self.now_ms)?.ok_or_else(|| Error::Missing(conv.into()))?;
        let seq = next_seq - 1;
        let entry = Entry {
            conversation_id: conv.into(),
            seq,
            kind: kind.into(),
            payload: payload.clone(),
            created_at_ms: self.now_ms,
        };
        self.write.insert_entry(&entry)?;
        self.record_telemetry(TelemetryEvent::Entry {
            conversation_id: conv.into(),
            seq,
            kind: kind.into(),
            at_ms: self.now_ms,
        });
        Ok(entry)
    }

    pub fn compact(&mut self, conv: &str, request: Compaction<'_>) -> Result<Option<Entry>> {
        let Compaction {
            level,
            base_head,
            from,
            cut,
            summary,
            token_count,
        } = request;
        let c = self.conversation(conv)?;
        if cut < 1 || cut >= c.next_seq {
            return Err(Error::Invalid(format!("compaction cut {cut} outside conversation {conv}")));
        }
        if (base_head > 0 && c.head_seq > base_head) || cut < c.head_seq {
            return Ok(None);
        }
        let e = self.append_entry(
            conv,
            "pi.compaction",
            &json!({"level":level,"baseHeadSeq":base_head,"fromSeq":from,"cutSeq":cut,"summary":summary,"tokenCount":token_count}),
        )?;
        self.write.set_head(conv, cut + 1)?;
        Ok(Some(e))
    }

    pub fn reset(&mut self, conv: &str, payload: &Value) -> Result<Entry> {
        let e = self.append_entry(conv, "pi.reset", payload)?;
        self.write.reset_head(conv)?;
        Ok(e)
    }

    pub fn submit(&mut self, conv: &str, request: &str, kind: &str, payload: &Value, notify: Option<&str>) -> Result<(Submission, bool)> {
        if conv.is_empty() || request.is_empty() {
            return Err(Error::Invalid("submission needs a conversation and request ID".into()));
        }
        if let Some(previous) = self.submission_by_request(conv, request)? {
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
        self.write.insert_submission(&sub)?;
        let saved = self.submission(&id)?;
        self.record_telemetry(TelemetryEvent::Submission {
            conversation_id: conv.into(),
            submission_id: saved.id.clone(),
            status: saved.status.as_str().into(),
            at_ms: self.now_ms,
        });
        Ok((saved, false))
    }

    pub fn set_submission_status(&mut self, id: &str, status: SubmissionStatus) -> Result<Submission> {
        self.write.set_submission_status(id, status, self.now_ms)?;
        self.submission(id)
    }

    pub fn settle(&mut self, id: &str, status: SubmissionStatus, result: &Value) -> Result<Submission> {
        if !matches!(status, SubmissionStatus::Done | SubmissionStatus::Unanswered) {
            return Err(Error::Invalid("settlement requires done or unanswered".into()));
        }
        let prior = self.submission(id)?;
        if matches!(prior.status, SubmissionStatus::Done | SubmissionStatus::Unanswered) {
            return Ok(prior);
        }
        self.write.settle_submission(id, status, result, self.now_ms)?;
        let sub = self.submission(id)?;
        self.record_telemetry(TelemetryEvent::Submission {
            conversation_id: sub.conversation_id.clone(),
            submission_id: sub.id.clone(),
            status: sub.status.as_str().into(),
            at_ms: self.now_ms,
        });
        if !sub.notify_task_id.is_empty() {
            self.send_signal(
                &sub.notify_task_id,
                "pi.submission_settled",
                Some(id),
                &json!({"submissionId":id,"conversationId":sub.conversation_id,"requestId":sub.request_id,"status":status,"result":result}),
            )?;
        }
        Ok(sub)
    }
}
