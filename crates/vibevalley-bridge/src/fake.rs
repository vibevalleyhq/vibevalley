//! A server for building views without the real one.
//!
//! State starts as VibeValley's empty farm frame (`frameAt(0)` in
//! `apps/web/src/infra/testing.ts`). [`FakeServer::from_dir`] reads
//! `state.json` (a `StateFrame`) and `responses.json` (`{ "<op>": <data> }`,
//! or a whole envelope when the value has a `bizCode`). Views drive it with
//! calls too:
//!
//! - `fake.setState` `{ state }` replaces the frame (its `seq` goes up),
//! - `fake.live` `{ event }` sends a `LiveEvent`,
//! - `fake.emit` `{ name, event }` / `fake.end` `{ name }` drive subscriptions,
//! - `fake.respond` `{ op, data }` sets a canned answer,
//! - `fake.calls` lists the calls received so far.
//!
//! `health` answers ok; other ops answer their canned response or
//! `RouteNotFound`. Subscriptions of any name are accepted except
//! `fake.refuse` (refused with `ChannelNotFound`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::{BizCode, Envelope, LiveEvent, Server, refusal};

#[derive(Default)]
struct Inner {
    state: Value,
    responses: HashMap<String, Value>,
    calls: Vec<(String, Value)>,
    state_txs: Vec<flume::Sender<Value>>,
    live_txs: Vec<flume::Sender<LiveEvent>>,
    subs: HashMap<u64, (String, flume::Sender<Value>)>,
    next_sub: u64,
}

#[derive(Clone)]
pub struct FakeServer {
    inner: Arc<Mutex<Inner>>,
}

impl Default for FakeServer {
    fn default() -> Self {
        Self::new()
    }
}

/// VibeValley's empty farm frame at `seq`.
pub fn empty_frame(seq: u64) -> Value {
    json!({
        "seq": seq,
        "state": { "call": "idle", "callReason": "", "sessions": [], "issues": [], "crons": [], "connectors": [], "machines": [] },
        "inbox": [],
        "effects": [],
        "view": { "level": { "level": 1, "xp": 0, "need": 100 }, "plots": {}, "plays": {}, "achievements": [] },
    })
}

impl FakeServer {
    pub fn new() -> FakeServer {
        let inner = Inner {
            state: empty_frame(0),
            ..Default::default()
        };
        FakeServer {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Reads `state.json` and `responses.json` from `dir` when present.
    pub fn from_dir(dir: &Path) -> Result<FakeServer, String> {
        let fake = FakeServer::new();
        let read = |name: &str| -> Result<Option<Value>, String> {
            match std::fs::read_to_string(dir.join(name)) {
                Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{name}: {e}")),
                Err(_) => Ok(None),
            }
        };
        if let Some(state) = read("state.json")? {
            fake.inner.lock().unwrap().state = state;
        }
        if let Some(Value::Object(map)) = read("responses.json")? {
            fake.inner.lock().unwrap().responses.extend(map);
        }
        Ok(fake)
    }

    /// Replaces the frame, `seq` one above the last. Returns how many
    /// watchers got it.
    pub fn set_state(&self, mut state: Value) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let seq = inner.state["seq"].as_u64().unwrap_or(0) + 1;
        if let Some(obj) = state.as_object_mut() {
            obj.insert("seq".into(), json!(seq));
        }
        inner.state = state.clone();
        inner.state_txs.retain(|tx| tx.send(state.clone()).is_ok());
        inner.state_txs.len()
    }

    pub fn state_now(&self) -> Value {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn push_live(&self, event: LiveEvent) {
        self.inner.lock().unwrap().live_txs.retain(|tx| tx.send(event.clone()).is_ok());
    }

    pub fn live_watchers(&self) -> usize {
        let mut inner = self.inner.lock().unwrap();
        inner.live_txs.retain(|tx| !tx.is_disconnected());
        inner.live_txs.len()
    }

    pub fn emit(&self, name: &str, event: Value) {
        for (n, tx) in self.inner.lock().unwrap().subs.values() {
            if n == name {
                let _ = tx.send(event.clone());
            }
        }
    }

    /// Ends every subscription of `name` (drops its sender).
    pub fn end(&self, name: &str) {
        self.inner.lock().unwrap().subs.retain(|_, (n, _)| n != name);
    }

    pub fn respond(&self, op: &str, data: Value) {
        self.inner.lock().unwrap().responses.insert(op.to_string(), data);
    }

    pub fn calls(&self) -> Vec<(String, Value)> {
        self.inner.lock().unwrap().calls.clone()
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().unwrap().subs.len()
    }
}

impl Server for FakeServer {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.inner.lock().unwrap().calls.push((op.to_string(), payload.clone()));
        let name = |key: &str| payload[key].as_str().unwrap_or_default().to_string();
        match op {
            "health" => Envelope::ok(json!({ "ok": true, "version": "fake" })),
            "fake.setState" => {
                self.set_state(payload["state"].clone());
                Envelope::void()
            }
            "fake.live" => match serde_json::from_value::<LiveEvent>(payload["event"].clone()) {
                Ok(event) => {
                    self.push_live(event);
                    Envelope::void()
                }
                Err(e) => refusal(BizCode::InvalidInput, format!("not a LiveEvent: {e}")),
            },
            "fake.emit" => {
                self.emit(&name("name"), payload["event"].clone());
                Envelope::void()
            }
            "fake.end" => {
                self.end(&name("name"));
                Envelope::void()
            }
            "fake.respond" => {
                self.respond(&name("op"), payload["data"].clone());
                Envelope::void()
            }
            "fake.calls" => Envelope::ok(json!(
                self.calls()
                    .into_iter()
                    .map(|(op, payload)| json!({ "op": op, "payload": payload }))
                    .collect::<Vec<_>>()
            )),
            _ => match self.inner.lock().unwrap().responses.get(op).cloned() {
                Some(v) if v.get("bizCode").is_some() => {
                    serde_json::from_value(v).unwrap_or_else(|e| refusal(BizCode::InternalError, format!("bad canned envelope for {op}: {e}")))
                }
                Some(v) => Envelope::ok(v),
                None => refusal(BizCode::RouteNotFound, format!("the fake server has no answer for {op}")),
            },
        }
    }

    fn state(&self) -> flume::Receiver<Value> {
        let (tx, rx) = flume::unbounded();
        let mut inner = self.inner.lock().unwrap();
        let _ = tx.send(inner.state.clone());
        inner.state_txs.push(tx);
        rx
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        let (tx, rx) = flume::unbounded();
        self.inner.lock().unwrap().live_txs.push(tx);
        rx
    }

    fn subscribe(&self, name: &str, _payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        if name == "fake.refuse" {
            return Err(refusal(BizCode::ChannelNotFound, "no such channel"));
        }
        let (tx, rx) = flume::unbounded();
        let mut inner = self.inner.lock().unwrap();
        inner.next_sub += 1;
        let id = inner.next_sub;
        inner.subs.insert(id, (name.to_string(), tx));
        Ok((id, rx))
    }

    fn unsubscribe(&self, id: u64) {
        self.inner.lock().unwrap().subs.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_farm_fixture_is_a_complete_state_frame() {
        let frame: vibevalley_protocol::StateFrame = serde_json::from_str(include_str!("../fixtures/farm/state.json")).unwrap();
        for issue in &frame.state.issues {
            if issue.status == vibevalley_protocol::IssueStatus::InProgress {
                let session = issue.latest_session_id().expect("a working issue has a worker execution");
                assert!(frame.state.sessions.iter().any(|worker| &worker.id == session));
            }
        }
    }

    #[test]
    fn canned_answers_and_driving_calls() {
        let fake = FakeServer::new();
        assert_eq!(fake.call("issue.list", json!({})).biz_code, 100005);
        fake.call("fake.respond", json!({ "op": "issue.list", "data": [1, 2] }));
        assert_eq!(fake.call("issue.list", json!({})).data, Some(json!([1, 2])));
        fake.respond("issue.create", json!({ "bizCode": 300002, "message": "no" }));
        assert_eq!(fake.call("issue.create", json!({})).biz_code, 300002);
        fake.call("fake.setState", json!({ "state": empty_frame(0) }));
        assert_eq!(fake.state_now()["seq"], 1);
        let live = fake.call("fake.live", json!({ "event": { "type": "notice", "at": 1, "level": "info", "text": "hi" } }));
        assert_eq!(live.biz_code, 0, "{live:?}");
        assert_eq!(fake.call("fake.live", json!({ "event": { "type": "bogus" } })).biz_code, 100001);
        let calls = fake.call("fake.calls", Value::Null).data.unwrap();
        assert_eq!(calls.as_array().unwrap().len(), 8, "fake.calls counts itself");
    }

    #[test]
    fn from_dir_reads_fixtures() {
        let dir = std::env::temp_dir().join(format!("vibevalley-bridge-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), r#"{"seq": 7, "state": {"issues": [{"id": "i1"}]}}"#).unwrap();
        std::fs::write(dir.join("responses.json"), r#"{"repo.list": [{"id": "r"}]}"#).unwrap();
        let fake = FakeServer::from_dir(&dir).unwrap();
        assert_eq!(fake.state().recv().unwrap()["state"]["issues"][0]["id"], "i1");
        assert_eq!(fake.call("repo.list", Value::Null).data.unwrap()[0]["id"], "r");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
