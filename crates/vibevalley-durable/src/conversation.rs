use crate::{Compaction, Conversation, Entry, Error, Read, Result, Submission, SubmissionStatus, Tx, id};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};
use std::collections::HashSet;

fn conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get("id")?,
        owner_task_id: row.get("owner_task_id")?,
        parent_id: row.get("parent_id")?,
        fork_entry_seq: row.get("fork_entry_seq")?,
        head_seq: row.get("head_seq")?,
        next_seq: row.get("next_seq")?,
        provider_affinity: row.get("provider_affinity")?,
        metadata: row.get("metadata_json")?,
        created_at_ms: row.get("created_at_ms")?,
        updated_at_ms: row.get("updated_at_ms")?,
    })
}
fn entry(r: &Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        conversation_id: r.get("conversation_id")?,
        seq: r.get("seq")?,
        kind: r.get("kind")?,
        payload: r.get("payload_json")?,
        created_at_ms: r.get("created_at_ms")?,
    })
}
fn submission(r: &Row<'_>) -> rusqlite::Result<Submission> {
    Ok(Submission {
        id: r.get("id")?,
        conversation_id: r.get("conversation_id")?,
        request_id: r.get("request_id")?,
        kind: r.get("kind")?,
        status: r.get("status")?,
        payload: r.get("payload_json")?,
        notify_task_id: r.get("notify_task_id")?,
        result: r.get("result_json")?,
        created_at_ms: r.get("created_at_ms")?,
        updated_at_ms: r.get("updated_at_ms")?,
    })
}

impl Read<'_> {
    pub fn conversation(&self, id: &str) -> Result<Conversation> {
        self.conn
            .query_row("SELECT * FROM durable_conversation WHERE id=?", [id], conversation)
            .optional()?
            .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn conversations_by_owner_task(&self, id: &str) -> Result<Vec<Conversation>> {
        let mut q = self
            .conn
            .prepare("SELECT * FROM durable_conversation WHERE owner_task_id=? ORDER BY created_at_ms,id")?;
        Ok(q.query_map([id], conversation)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn entries(&self, id: &str, from: i64) -> Result<Vec<Entry>> {
        let mut q = self
            .conn
            .prepare("SELECT * FROM durable_entry WHERE conversation_id=? AND seq>=? ORDER BY seq")?;
        Ok(q.query_map(params![id, from.max(1)], entry)?.collect::<rusqlite::Result<Vec<_>>>()?)
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
            let mut q = self
                .conn
                .prepare("SELECT * FROM durable_entry WHERE conversation_id=? AND seq BETWEEN ? AND ? ORDER BY seq")?;
            let segment = q.query_map(params![current.id, head, limit], entry)?.collect::<rusqlite::Result<Vec<_>>>()?;
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
        self.conn
            .query_row("SELECT * FROM durable_submission WHERE id=?", [id], submission)
            .optional()?
            .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn submission_by_request(&self, conv: &str, request: &str) -> Result<Option<Submission>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM durable_submission WHERE conversation_id=? AND request_id=?",
                params![conv, request],
                submission,
            )
            .optional()?)
    }
    pub fn submissions(&self, conv: &str) -> Result<Vec<Submission>> {
        let mut q = self
            .conn
            .prepare("SELECT * FROM durable_submission WHERE conversation_id=? ORDER BY created_at_ms,id")?;
        Ok(q.query_map([conv], submission)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

impl Tx<'_> {
    pub fn create_conversation(&mut self, conv: &str, provider: &str) -> Result<Conversation> {
        let id = if conv.is_empty() { id() } else { conv.to_owned() };
        self.conn.execute(
            "INSERT INTO durable_conversation(id,provider_affinity,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?3)",
            params![id, provider, self.now_ms],
        )?;
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
        self.conn.execute("INSERT INTO durable_conversation(id,owner_task_id,parent_id,fork_entry_seq,head_seq,next_seq,provider_affinity,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",params![child,owner,parent,seq,head,seq+1,provider,self.now_ms])?;
        self.conversation(&child)
    }
    pub fn append_entry(&mut self, conv: &str, kind: &str, payload: &Value) -> Result<Entry> {
        if kind.is_empty() {
            return Err(Error::Invalid("empty entry kind".into()));
        }
        let seq: i64 = self
            .conn
            .query_row(
                "UPDATE durable_conversation SET next_seq=next_seq+1,updated_at_ms=? WHERE id=? RETURNING next_seq-1",
                params![self.now_ms, conv],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::Missing(conv.into()))?;
        self.conn.execute(
            "INSERT INTO durable_entry(conversation_id,seq,kind,payload_json,created_at_ms) VALUES (?,?,?,?,?)",
            params![conv, seq, kind, payload.to_string(), self.now_ms],
        )?;
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
        self.conn
            .execute("UPDATE durable_conversation SET head_seq=? WHERE id=?", params![cut + 1, conv])?;
        Ok(Some(e))
    }
    pub fn reset(&mut self, conv: &str, payload: &Value) -> Result<Entry> {
        let e = self.append_entry(conv, "pi.reset", payload)?;
        self.conn.execute("UPDATE durable_conversation SET head_seq=next_seq WHERE id=?", [conv])?;
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
        self.conn.execute("INSERT INTO durable_submission(id,conversation_id,request_id,kind,status,payload_json,notify_task_id,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,'queued',?5,?6,?7,?7)",params![id,conv,request,if kind.is_empty(){"prompt"}else{kind},payload.to_string(),notify.unwrap_or(""),self.now_ms])?;
        Ok((self.submission(&id)?, false))
    }
    pub fn set_submission_status(&mut self, id: &str, status: SubmissionStatus) -> Result<Submission> {
        self.conn.execute(
            "UPDATE durable_submission SET status=?,updated_at_ms=? WHERE id=?",
            params![status, self.now_ms, id],
        )?;
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
        self.conn.execute(
            "UPDATE durable_submission SET status=?,result_json=?,updated_at_ms=? WHERE id=?",
            params![status, result.to_string(), self.now_ms, id],
        )?;
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
