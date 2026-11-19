use crate::{Compaction, Conversation, Entry, Error, Read, Result, Submission, SubmissionStatus, Tx, id};
use crate::{queries as q, sqlite::optional};
use serde_json::{Value, json};
use std::collections::HashSet;

impl TryFrom<q::GetConversationRow> for Conversation {
    type Error = Error;
    fn try_from(r: q::GetConversationRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            owner_task_id: r.owner_task_id,
            parent_id: r.parent_id,
            fork_entry_seq: r.fork_entry_seq,
            head_seq: r.head_seq,
            next_seq: r.next_seq,
            provider_affinity: r.provider_affinity,
            metadata: serde_json::from_str(&r.metadata_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}
impl TryFrom<q::EntriesFromRow> for Entry {
    type Error = Error;
    fn try_from(r: q::EntriesFromRow) -> Result<Self> {
        Ok(Self {
            conversation_id: r.conversation_id,
            seq: r.seq,
            kind: r.kind,
            payload: serde_json::from_str(&r.payload_json)?,
            created_at_ms: r.created_at_ms,
        })
    }
}
impl TryFrom<q::GetSubmissionRow> for Submission {
    type Error = Error;
    fn try_from(r: q::GetSubmissionRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            request_id: r.request_id,
            kind: r.kind,
            status: r.status.parse()?,
            payload: serde_json::from_str(&r.payload_json)?,
            notify_task_id: r.notify_task_id,
            result: serde_json::from_str(&r.result_json)?,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}
impl Read<'_> {
    pub fn conversation(&self, id: &str) -> Result<Conversation> {
        optional(
            self.conn
                .query(async |db| q::get_conversation(db, q::GetConversationParams { id: id.into() }).await),
        )?
        .map(TryInto::try_into)
        .transpose()?
        .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn conversations_by_owner_task(&self, id: &str) -> Result<Vec<Conversation>> {
        self.conn
            .query(async |db| q::conversations_by_owner(db, q::ConversationsByOwnerParams { owner_task_id: id.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    pub fn entries(&self, id: &str, from: i64) -> Result<Vec<Entry>> {
        self.conn
            .query(async |db| {
                q::entries_from(
                    db,
                    q::EntriesFromParams {
                        conversation_id: id.into(),
                        seq: from.max(1),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
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
            let segment: Vec<Entry> = self
                .conn
                .query(async |db| {
                    q::entries_within(
                        db,
                        q::EntriesWithinParams {
                            conversation_id: current.id.clone(),
                            first_seq: head,
                            last_seq: limit,
                        },
                    )
                    .await
                })?
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?;
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
        optional(
            self.conn
                .query(async |db| q::get_submission(db, q::GetSubmissionParams { id: id.into() }).await),
        )?
        .map(TryInto::try_into)
        .transpose()?
        .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn submission_by_request(&self, conv: &str, request: &str) -> Result<Option<Submission>> {
        optional(self.conn.query(async |db| {
            q::submission_by_request(
                db,
                q::SubmissionByRequestParams {
                    conversation_id: conv.into(),
                    request_id: request.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }
    pub fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        self.conn
            .query(async |db| q::submissions(db, q::SubmissionsParams { conversation_id: conv.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
}
impl Tx<'_> {
    pub fn create_conversation(&mut self, conv: &str, provider: &str) -> Result<Conversation> {
        self.create_owned_conversation(conv, provider, "")
    }
    pub fn create_owned_conversation(&mut self, conv: &str, provider: &str, owner_task_id: &str) -> Result<Conversation> {
        let id = if conv.is_empty() { id() } else { conv.to_owned() };
        self.conn.query(async |db| {
            q::insert_conversation(
                db,
                q::InsertConversationParams {
                    id: id.clone(),
                    provider_affinity: provider.into(),
                    owner_task_id: owner_task_id.into(),
                    created_at_ms: self.now_ms,
                },
            )
            .await
        })?;
        self.conversation(&id)
    }
    pub fn fork_conversation(&mut self, parent: &str, child: &str, owner: &str, provider: &str, seq: i64) -> Result<Conversation> {
        let p = self.conversation(parent)?;
        if seq < 0 || seq >= p.next_seq {
            return Err(Error::Invalid(format!("fork sequence {seq} outside conversation {parent}")));
        }
        let head = if seq >= p.head_seq - 1 { p.head_seq } else { 1 };
        let child = if child.is_empty() { id() } else { child.to_owned() };
        let provider = if provider.is_empty() { &p.provider_affinity } else { provider };
        self.conn.query(async |db| {
            q::fork_conversation(
                db,
                q::ForkConversationParams {
                    id: child.clone(),
                    owner_task_id: owner.into(),
                    parent_id: parent.into(),
                    fork_entry_seq: seq,
                    head_seq: head,
                    next_seq: seq + 1,
                    provider_affinity: provider.into(),
                    created_at_ms: self.now_ms,
                },
            )
            .await
        })?;
        self.conversation(&child)
    }
    pub fn append_entry(&mut self, conv: &str, kind: &str, payload: &Value) -> Result<Entry> {
        if kind.is_empty() {
            return Err(Error::Invalid("empty entry kind".into()));
        }
        let seq = optional(self.conn.query(async |db| {
            q::advance_sequence(
                db,
                q::AdvanceSequenceParams {
                    updated_at_ms: self.now_ms,
                    id: conv.into(),
                },
            )
            .await
        }))?
        .ok_or_else(|| Error::Missing(conv.into()))?
        .next_seq
            - 1;
        self.conn.query(async |db| {
            q::insert_entry(
                db,
                q::InsertEntryParams {
                    conversation_id: conv.into(),
                    seq,
                    kind: kind.into(),
                    payload_json: payload.to_string(),
                    created_at_ms: self.now_ms,
                },
            )
            .await
        })?;
        Ok(Entry {
            conversation_id: conv.into(),
            seq,
            kind: kind.into(),
            payload: payload.clone(),
            created_at_ms: self.now_ms,
        })
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
        self.conn.query(async |db| {
            q::set_head(
                db,
                q::SetHeadParams {
                    head_seq: cut + 1,
                    id: conv.into(),
                },
            )
            .await
        })?;
        Ok(Some(e))
    }
    pub fn reset(&mut self, conv: &str, payload: &Value) -> Result<Entry> {
        let e = self.append_entry(conv, "pi.reset", payload)?;
        self.conn.query(async |db| q::reset_head(db, q::ResetHeadParams { id: conv.into() }).await)?;
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
        self.conn.query(async |db| {
            q::insert_submission(
                db,
                q::InsertSubmissionParams {
                    id: id.clone(),
                    conversation_id: conv.into(),
                    request_id: request.into(),
                    kind: if kind.is_empty() { "prompt" } else { kind }.into(),
                    payload_json: payload.to_string(),
                    notify_task_id: notify.unwrap_or_default().into(),
                    created_at_ms: self.now_ms,
                },
            )
            .await
        })?;
        Ok((self.submission(&id)?, false))
    }
    pub fn set_submission_status(&mut self, id: &str, status: SubmissionStatus) -> Result<Submission> {
        self.conn.query(async |db| {
            q::set_submission_status(
                db,
                q::SetSubmissionStatusParams {
                    status: status.as_str().into(),
                    updated_at_ms: self.now_ms,
                    id: id.into(),
                },
            )
            .await
        })?;
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
        self.conn.query(async |db| {
            q::settle_submission(
                db,
                q::SettleSubmissionParams {
                    status: status.as_str().into(),
                    result_json: result.to_string(),
                    updated_at_ms: self.now_ms,
                    id: id.into(),
                },
            )
            .await
        })?;
        let sub = self.submission(id)?;
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
