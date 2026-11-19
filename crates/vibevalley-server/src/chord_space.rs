use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{Value, json};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    watch::Document,
};

pub(crate) struct Space {
    document: Document,
    observer: Mutex<Option<(flume::Sender<()>, std::thread::JoinHandle<()>)>>,
}

#[derive(Default)]
struct Projection {
    alerts: BTreeMap<(String, String), Vec<Value>>,
    approvals: BTreeMap<String, Vec<Value>>,
    revisions: BTreeMap<(String, String, String), i64>,
}

impl Space {
    pub fn new() -> Self {
        Self {
            document: Document::new(Snapshot::new(json!({"rev":1,"inbox":[],"approvals":[]}))),
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
        let mut projection = Projection::default();
        for doc in initial {
            projection.apply_doc(&doc, false);
        }
        publish(&document, projection.governance(), false);
        let (stop, shutdown) = flume::bounded(0);
        let handle = std::thread::Builder::new()
            .name("chord-governance".into())
            .spawn(move || {
                while let Some(event) = flume::Selector::new().recv(&shutdown, |_| None).recv(&events, Result::ok).wait() {
                    if !matches!(event.document.doc_kind.as_str(), "pi.governance" | "pi.inbox" | "pi.live") {
                        continue;
                    }
                    let live = event.document.doc_kind == "pi.live";
                    if projection.apply_doc(&event.document, event.retired) {
                        publish(&document, if live { BTreeMap::new() } else { projection.governance() }, live);
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
}
impl Drop for Space {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Projection {
    fn governance(&self) -> BTreeMap<&'static str, Value> {
        BTreeMap::from([
            ("inbox", Value::Array(self.alerts.values().flatten().cloned().collect())),
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
