//! A server for building views without the real one.
//!
//! Backed by a `RwLock<SliceBundle>` plus 6 independent [`SliceFeed`]s.
//! [`FakeServer::from_dir`] reads `state.json` (a [`SliceBundle`]) and
//! `responses.json` (`{ "<op>": <data> }`, or a whole envelope when the value
//! has a `bizCode`). Views drive it with calls too:
//!
//! - `fake.setBundle` / `fake.setState` `{ bundle | state }` swaps the bundle,
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
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, OpsSlice, SessionsSlice, SliceBundle, SliceKind};

use crate::slice_feed::{SliceFeed, SliceSubscription};
use crate::transport::api::{BizCode, CallerContext, ClientIdentity, Envelope, LiveEvent, Server, refusal};

struct FakeFeeds {
    board: SliceFeed<BoardSlice>,
    sessions: SliceFeed<SessionsSlice>,
    collab: SliceFeed<CollabSlice>,
    inbox: SliceFeed<InboxSlice>,
    ops: SliceFeed<OpsSlice>,
    farm: SliceFeed<FarmFrame>,
}

impl FakeFeeds {
    fn new(bundle: &SliceBundle) -> Self {
        Self {
            board: SliceFeed::new("slice:board", bundle.board.clone()),
            sessions: SliceFeed::new("slice:sessions", bundle.sessions.clone()),
            collab: SliceFeed::new("slice:collab", bundle.collab.clone()),
            inbox: SliceFeed::new("slice:inbox", bundle.inbox.clone()),
            ops: SliceFeed::new("slice:ops", bundle.ops.clone()),
            farm: SliceFeed::new("slice:farm", bundle.farm.clone()),
        }
    }

    fn replace_and_publish(&self, bundle: &SliceBundle) -> usize {
        self.board.replace(bundle.board.clone());
        self.sessions.replace(bundle.sessions.clone());
        self.collab.replace(bundle.collab.clone());
        self.inbox.replace(bundle.inbox.clone());
        self.ops.replace(bundle.ops.clone());
        self.farm.replace(bundle.farm.clone());
        self.board.publish_forced()
            + self.sessions.publish_forced()
            + self.collab.publish_forced()
            + self.inbox.publish_forced()
            + self.ops.publish_forced()
            + self.farm.publish_forced()
    }
}

#[derive(Default)]
struct Inner {
    responses: HashMap<String, Value>,
    calls: Vec<(String, Value)>,
    last_client: Option<ClientIdentity>,
    subs: HashMap<u64, (String, flume::Sender<Value>)>,
    next_sub: u64,
}

#[derive(Clone)]
pub struct FakeServer {
    bundle: Arc<RwLock<SliceBundle>>,
    feeds: Arc<FakeFeeds>,
    live: broadcast::Sender<LiveEvent>,
    inner: Arc<Mutex<Inner>>,
}

impl Default for FakeServer {
    fn default() -> Self {
        Self::new()
    }
}

/// VibeValley's empty [`SliceBundle`] at `seq`.
pub fn empty_bundle(seq: i64) -> SliceBundle {
    vibevalley_core::slice_bundle(&vibevalley_core::empty_space_state(), vec![], seq)
}

impl FakeServer {
    pub fn new() -> FakeServer {
        Self::from_bundle(empty_bundle(0))
    }

    pub fn from_bundle(bundle: SliceBundle) -> FakeServer {
        let feeds = Arc::new(FakeFeeds::new(&bundle));
        let (live, _rx) = broadcast::channel(512);
        FakeServer {
            bundle: Arc::new(RwLock::new(bundle)),
            feeds,
            live,
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    /// Reads `state.json` (a [`SliceBundle`]) and `responses.json` from `dir` when present.
    pub fn from_dir(dir: &Path) -> Result<FakeServer, String> {
        let bundle = match std::fs::read_to_string(dir.join("state.json")) {
            Ok(text) => serde_json::from_str::<SliceBundle>(&text).map_err(|e| format!("state.json: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => empty_bundle(0),
            Err(e) => return Err(format!("state.json: {e}")),
        };
        let fake = FakeServer::from_bundle(bundle);
        match std::fs::read_to_string(dir.join("responses.json")) {
            Ok(text) => {
                let value: Value = serde_json::from_str(&text).map_err(|e| format!("responses.json: {e}"))?;
                if let Value::Object(map) = value {
                    fake.inner.lock().responses.extend(map);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("responses.json: {e}")),
        }
        Ok(fake)
    }

    /// Replaces the backing [`SliceBundle`] and notifies every slice watcher.
    /// Returns the total number of active slice watchers notified.
    pub fn swap_bundle(&self, bundle: SliceBundle) -> usize {
        *self.bundle.write() = bundle.clone();
        self.feeds.replace_and_publish(&bundle)
    }

    pub fn bundle_now(&self) -> SliceBundle {
        self.bundle.read().clone()
    }

    pub fn slice_watchers(&self, slice: SliceKind) -> usize {
        match slice {
            SliceKind::Board => self.feeds.board.watcher_count(),
            SliceKind::Sessions => self.feeds.sessions.watcher_count(),
            SliceKind::Collab => self.feeds.collab.watcher_count(),
            SliceKind::Inbox => self.feeds.inbox.watcher_count(),
            SliceKind::Ops => self.feeds.ops.watcher_count(),
            SliceKind::Farm => self.feeds.farm.watcher_count(),
        }
    }

    pub fn push_live(&self, event: LiveEvent) {
        let _ = self.live.send(event);
    }

    pub fn live_watchers(&self) -> usize {
        self.live.receiver_count()
    }

    pub fn emit(&self, name: &str, event: Value) {
        for (n, tx) in self.inner.lock().subs.values() {
            if n == name {
                let _ = tx.send(event.clone());
            }
        }
    }

    /// Ends every subscription of `name` (drops its sender).
    pub fn end(&self, name: &str) {
        self.inner.lock().subs.retain(|_, (n, _)| n != name);
    }

    pub fn respond(&self, op: &str, data: Value) {
        self.inner.lock().responses.insert(op.to_string(), data);
    }

    pub fn calls(&self) -> Vec<(String, Value)> {
        self.inner.lock().calls.clone()
    }

    pub fn last_client(&self) -> Option<ClientIdentity> {
        self.inner.lock().last_client.clone()
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().subs.len()
    }
}

impl Server for FakeServer {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::local(), op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        {
            let mut inner = self.inner.lock();
            inner.calls.push((op.to_string(), payload.clone()));
            if let Some(client) = &ctx.client {
                inner.last_client = Some(client.clone());
            }
        }
        let name = |key: &str| payload[key].as_str().unwrap_or_default().to_string();
        match op {
            "health" => Envelope::ok(json!({ "ok": true, "version": "fake" })),
            "fake.setBundle" | "fake.setState" => {
                let raw = if payload.get("bundle").is_some() {
                    payload["bundle"].clone()
                } else {
                    payload["state"].clone()
                };
                match serde_json::from_value::<SliceBundle>(raw) {
                    Ok(mut bundle) => {
                        let next_seq = self.bundle_now().seq + 1;
                        if bundle.seq <= self.bundle_now().seq {
                            bundle.seq = next_seq;
                            bundle.board.seq = next_seq;
                            bundle.sessions.seq = next_seq;
                            bundle.collab.seq = next_seq;
                            bundle.inbox.seq = next_seq;
                            bundle.ops.seq = next_seq;
                            bundle.farm.seq = next_seq;
                        }
                        self.swap_bundle(bundle);
                        Envelope::void()
                    }
                    Err(e) => refusal(BizCode::InvalidInput, format!("not a SliceBundle: {e}")),
                }
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
            _ => match self.inner.lock().responses.get(op).cloned() {
                Some(v) if v.get("bizCode").is_some() => {
                    serde_json::from_value(v).unwrap_or_else(|e| refusal(BizCode::InternalError, format!("bad canned envelope for {op}: {e}")))
                }
                Some(v) => Envelope::ok(v),
                None => refusal(BizCode::RouteNotFound, format!("the fake server has no answer for {op}")),
            },
        }
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        match slice {
            SliceKind::Board => self.feeds.board.snapshot().wire().clone(),
            SliceKind::Sessions => self.feeds.sessions.snapshot().wire().clone(),
            SliceKind::Collab => self.feeds.collab.snapshot().wire().clone(),
            SliceKind::Inbox => self.feeds.inbox.snapshot().wire().clone(),
            SliceKind::Ops => self.feeds.ops.snapshot().wire().clone(),
            SliceKind::Farm => self.feeds.farm.snapshot().wire().clone(),
        }
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        match slice {
            SliceKind::Board => self.feeds.board.watch_since(after_seq, None, stop, receive),
            SliceKind::Sessions => self.feeds.sessions.watch_since(after_seq, None, stop, receive),
            SliceKind::Collab => self.feeds.collab.watch_since(after_seq, None, stop, receive),
            SliceKind::Inbox => self.feeds.inbox.watch_since(after_seq, None, stop, receive),
            SliceKind::Ops => self.feeds.ops.watch_since(after_seq, None, stop, receive),
            SliceKind::Farm => self.feeds.farm.watch_since(after_seq, None, stop, receive),
        }
    }

    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        Some(match slice {
            SliceKind::Board => SliceSubscription::Board(self.feeds.board.subscribe()),
            SliceKind::Sessions => SliceSubscription::Sessions(self.feeds.sessions.subscribe()),
            SliceKind::Collab => SliceSubscription::Collab(self.feeds.collab.subscribe()),
            SliceKind::Inbox => SliceSubscription::Inbox(self.feeds.inbox.subscribe()),
            SliceKind::Ops => SliceSubscription::Ops(self.feeds.ops.subscribe()),
            SliceKind::Farm => SliceSubscription::Farm {
                rx: self.feeds.farm.subscribe(),
                strip_initial_effects: false,
            },
        })
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        crate::bridge_live_receiver(self.live.subscribe(), CancellationToken::new())
    }

    fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
        Some(self.live.subscribe())
    }

    fn subscribe(&self, name: &str, _payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        if name == "fake.refuse" {
            return Err(refusal(BizCode::ChannelNotFound, "no such channel"));
        }
        let (tx, rx) = flume::unbounded();
        let mut inner = self.inner.lock();
        inner.next_sub += 1;
        let id = inner.next_sub;
        inner.subs.insert(id, (name.to_string(), tx));
        Ok((id, rx))
    }

    fn unsubscribe(&self, id: u64) {
        self.inner.lock().subs.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_farm_fixture_is_a_complete_slice_bundle() {
        let bundle: SliceBundle = serde_json::from_str(include_str!("../../../fixtures/farm/state.json")).unwrap();
        for issue in &bundle.board.issues {
            if issue.status == vibevalley_protocol::IssueStatus::InProgress {
                let session = issue.latest_session_id().expect("a working issue has a worker execution");
                assert!(bundle.sessions.sessions.iter().any(|worker| &worker.id == session));
            }
        }
        let responses: Value = serde_json::from_str(include_str!("../../../fixtures/farm/responses.json")).unwrap();
        let _: vibevalley_protocol::AchievementList = serde_json::from_value(responses["game.achievement.list"].clone()).unwrap();
    }

    #[test]
    fn canned_answers_and_driving_calls() {
        let fake = FakeServer::new();
        assert_eq!(fake.call("issue.list", json!({})).biz_code, 100005);
        fake.call("fake.respond", json!({ "op": "issue.list", "data": [1, 2] }));
        assert_eq!(fake.call("issue.list", json!({})).data, Some(json!([1, 2])));
        fake.respond("issue.create", json!({ "bizCode": 300002, "message": "no" }));
        assert_eq!(fake.call("issue.create", json!({})).biz_code, 300002);
        fake.call("fake.setBundle", json!({ "bundle": empty_bundle(0) }));
        assert_eq!(fake.bundle_now().seq, 1);
        assert_eq!(fake.slice_snapshot(SliceKind::Board)["seq"], 1);
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
        let mut bundle = empty_bundle(7);
        bundle.board.issues.push(vibevalley_protocol::Issue::new("i1", 1, "Demo", 1));
        std::fs::write(dir.join("state.json"), serde_json::to_string(&bundle).unwrap()).unwrap();
        std::fs::write(dir.join("responses.json"), r#"{"repo.list": [{"id": "r"}]}"#).unwrap();
        let fake = FakeServer::from_dir(&dir).unwrap();
        assert_eq!(fake.slice_snapshot(SliceKind::Board)["issues"][0]["id"], "i1");
        assert_eq!(fake.call("repo.list", Value::Null).data.unwrap()[0]["id"], "r");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
