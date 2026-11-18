use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde_json::{Value, json};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    watch::Document,
};
use vibevalley_core::Transition;
use vibevalley_protocol::{Fact, InboxFrom, InboxKind, InboxTarget, Issue, IssueStatus, StateFrame};

pub(crate) struct Space {
    projection: std::sync::Arc<Mutex<Projection>>,
    document: Document,
    observer: Mutex<Option<(flume::Sender<()>, std::thread::JoinHandle<()>)>>,
}

#[derive(Default)]
struct Projection {
    issue_times: HashMap<String, i64>,
    mentions: Vec<Value>,
    alerts: BTreeMap<(String, String), Vec<Value>>,
    approvals: BTreeMap<String, Vec<Value>>,
    revisions: BTreeMap<(String, String, String), i64>,
}

impl Space {
    pub fn new(frame: &StateFrame) -> Self {
        let mut f = fields(frame, &HashMap::new());
        let state = Projection {
            mentions: f["inbox"].as_array().cloned().unwrap_or_default(),
            ..Default::default()
        };
        f.insert("rev", json!(1));
        f.insert("approvals", json!([]));
        f.insert("dreams", json!([]));
        Self {
            document: Document::new(Snapshot::new(json!(f))),
            projection: std::sync::Arc::new(Mutex::new(state)),
            observer: Default::default(),
        }
    }
    pub fn document(&self) -> Document {
        self.document.clone()
    }
    pub fn attach(&self, store: &vibevalley_durable::Store) -> vibevalley_durable::Result<()> {
        let events = store.subscribe_documents()?;
        let initial = store.read(|tx| {
            let mut docs = tx.documents_by_kind("conversation", "pi.governance")?;
            docs.extend(tx.documents_by_kind("conversation", "pi.inbox")?);
            docs.extend(tx.documents_by_kind("global", "pi.inbox")?);
            Ok(docs)
        })?;
        let document = self.document.clone();
        let projection = self.projection.clone();
        {
            let mut state = super::lock(&projection);
            for d in initial {
                state.apply_doc(&d, false);
            }
            publish(&document, state.governance(), false);
        }
        let (stop, shutdown) = flume::bounded(0);
        let handle = std::thread::Builder::new()
            .name("chord-governance".into())
            .spawn(move || {
                while let Some(event) = flume::Selector::new().recv(&shutdown, |_| None).recv(&events, Result::ok).wait() {
                    if !matches!(event.document.doc_kind.as_str(), "pi.governance" | "pi.inbox" | "pi.live") {
                        continue;
                    }
                    let mut state = super::lock(&projection);
                    let live = event.document.doc_kind == "pi.live";
                    if state.apply_doc(&event.document, event.retired) {
                        publish(&document, if live { BTreeMap::new() } else { state.governance() }, live);
                    }
                }
            })
            .map_err(|e| vibevalley_durable::Error::Invalid(e.to_string()))?;
        *super::lock(&self.observer) = Some((stop, handle));
        Ok(())
    }

    pub fn stop(&self) {
        if let Some((stop, thread)) = super::lock(&self.observer).take() {
            drop(stop);
            let _ = thread.join();
        }
    }

    pub fn update(&self, frame: &StateFrame, transitions: &[Transition]) {
        let mut p = super::lock(&self.projection);
        for transition in transitions {
            match &transition.fact {
                Fact::IssueChanged(f) => {
                    p.issue_times.insert(f.issue.id.clone(), f.at);
                }
                Fact::IssueRemoved(f) => {
                    p.issue_times.remove(&f.id);
                }
                _ => {}
            }
        }
        let mut f = fields(frame, &p.issue_times);
        p.mentions = f["inbox"].as_array().cloned().unwrap_or_default();
        f.insert("inbox", p.inbox());
        publish(&self.document, f, false);
    }
}
impl Drop for Space {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Projection {
    fn inbox(&self) -> Value {
        let mut entries = self.mentions.clone();
        entries.extend(self.alerts.values().flatten().cloned());
        Value::Array(entries)
    }
    fn governance(&self) -> BTreeMap<&'static str, Value> {
        BTreeMap::from([
            ("inbox", self.inbox()),
            ("approvals", Value::Array(self.approvals.values().flatten().cloned().collect())),
        ])
    }
    fn apply_doc(&mut self, d: &vibevalley_durable::Document, retired: bool) -> bool {
        let key = (d.scope_kind.clone(), d.scope_id.clone(), d.doc_kind.clone());
        if retired {
            if self.revisions.remove(&key).is_none() {
                return false;
            }
        } else {
            if self.revisions.get(&key).is_some_and(|prev| *prev >= d.rev) {
                return false;
            }
            self.revisions.insert(key, d.rev);
        }
        match d.doc_kind.as_str() {
            "pi.inbox" => {
                let key = (d.scope_kind.clone(), d.scope_id.clone());
                if retired {
                    self.alerts.remove(&key);
                } else {
                    let mut items = vec![];
                    for (n, alert) in d.state["items"].as_array().into_iter().flatten().enumerate() {
                        let text = |k: &str| alert[k].as_str().unwrap_or_default();
                        let kind = text("kind");
                        let task = text("taskId");
                        let at = alert["createdAtMs"].as_i64().unwrap_or_default();
                        let mut v = json!({"id":format!("durable:{kind}:{task}:{at}:{n}"),"kind":match kind{"permission_park"=>"approval","budget_reached"=>"budget_reached",_=>"mention"},"createdAtMs":at,"resolved":false,"title":text("title"),"summary":text("message")});
                        if !text("conversationId").is_empty() {
                            v["sessionId"] = json!(text("conversationId"))
                        }
                        items.push(v);
                    }
                    self.alerts.insert(key, items);
                }
            }
            "pi.governance" => {
                if retired {
                    self.approvals.remove(&d.scope_id);
                } else {
                    let approvals = d.state["pendingPermissions"]
                        .as_object()
                        .into_iter()
                        .flat_map(|m| m.values())
                        .map(|p| {
                            json!({
                                "taskId":p["taskId"],"sessionId":d.scope_id,"toolName":p["toolName"],"policy":p["evaluation"]["policy"],
                                "summary":p["evaluation"]["reason"],"requestedAtMs":p["requestedAtMs"]
                            })
                        })
                        .collect();
                    self.approvals.insert(d.scope_id.clone(), approvals);
                }
            }
            "pi.live" => {}
            _ => return false,
        }
        true
    }
}

// Both frame folds and durable notifications hold the same projection lock
// through revision selection and commit.
fn publish(document: &Document, fields: BTreeMap<&'static str, Value>, force: bool) {
    let (rev, snapshot, _) = document.state();
    let mut ops = vec![];
    for (field, next) in fields {
        let path = vec![field.to_owned()];
        let prev = snapshot.get(&path).expect("published space field");
        if prev == next {
            continue;
        }
        let a = prev.as_array().expect("space collection");
        let b = next.as_array().expect("space collection");
        if b.len() > a.len() && b.starts_with(a) {
            ops.push(Op::Splice(path, a.len(), 0, b[a.len()..].to_vec()));
        } else if a.len() == b.len() {
            for (i, (was, item)) in a.iter().zip(b).enumerate() {
                if was != item {
                    ops.push(Op::Replace(vec![field.into(), i.to_string()], item.clone()))
                }
            }
        } else {
            ops.push(Op::Replace(path, next));
        }
    }
    if !force && ops.is_empty() {
        return;
    }
    document
        .mutate(|d| {
            d.apply(Op::Replace(vec!["rev".into()], json!(rev + 1)))?;
            for op in ops {
                d.apply(op)?
            }
            Ok(())
        })
        .expect("valid projection fields");
}

fn fields(frame: &StateFrame, times: &HashMap<String, i64>) -> BTreeMap<&'static str, Value> {
    let issues: Vec<_> = frame.state.issues.iter().map(|i| issue_view(i, times.get(&i.id).copied())).collect();
    let inbox: Vec<_> = frame
        .inbox
        .iter()
        .filter(|item| item.kind == InboxKind::Mention)
        .map(|item| {
            let mut entry = json!({"id":item.id, "kind":"mention", "title":item.words.title, "summary":item.text, "resolved":false, "createdAtMs":item.at});
            if let InboxTarget::Issue(target) = &item.target {
                entry["issueId"] = json!(target.id);
            }
            if let InboxFrom::Session(from) = &item.from {
                entry["sessionId"] = json!(from.id);
            }
            entry
        })
        .collect();
    let mut machines: Vec<_> = frame.state.machines.iter().filter(|m| m.online).map(|m| &m.id).collect();
    machines.sort_unstable();
    BTreeMap::from([("issues", json!(issues)), ("inbox", json!(inbox)), ("onlineMachines", json!(machines))])
}

fn issue_view(issue: &Issue, updated_at: Option<i64>) -> Value {
    let status = match issue.status {
        IssueStatus::Backlog => "draft",
        IssueStatus::Todo => "queued",
        IssueStatus::InProgress => "in_progress",
        IssueStatus::InReview => "review",
        IssueStatus::Done => "done",
        IssueStatus::Canceled => "canceled",
    };
    let at = updated_at
        .or(issue.closed_at)
        .or(issue.reviewed_at)
        .or(issue.queued_at)
        .unwrap_or(issue.created_at);
    let mut view = json!({"id":issue.id, "title":issue.title, "status":status, "repoId":issue.repo.as_deref().unwrap_or_default(), "updatedAtMs":at});
    if let Some(agent) = issue.assigned_agent() {
        view["assigneeId"] = json!(agent);
    }
    if let Some(session) = issue.latest_session_id() {
        view["sessionId"] = json!(session);
    }
    view
}
