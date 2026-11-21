use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::transport::chord::{
    delta::{Op, Snapshot},
    watch::Document,
};
use serde_json::{Value, json};

pub(crate) struct Space {
    document: Document,
    observer: Mutex<Option<(flume::Sender<()>, std::thread::JoinHandle<()>)>>,
}

#[derive(Default)]
struct Projection {
    alerts: BTreeMap<(String, String), Vec<Value>>,
    revisions: BTreeMap<(String, String, String), i64>,
}

impl Space {
    pub fn new() -> Self {
        Self {
            document: Document::new(Snapshot::new(json!({"rev":1,"inbox":[]}))),
            observer: Default::default(),
        }
    }
    pub fn document(&self) -> Document {
        self.document.clone()
    }
    pub fn attach(&self, store: &vibevalley_runtime::agent::durable::Store) -> vibevalley_runtime::agent::durable::Result<()> {
        let events = store.subscribe_documents()?;
        let initial = store.read(|tx| {
            let mut docs = tx.documents_by_kind("conversation", "pi.inbox")?;
            docs.extend(tx.documents_by_kind("global", "pi.inbox")?);
            Ok(docs)
        })?;
        let document = self.document.clone();
        let mut projection = Projection::default();
        for doc in initial {
            projection.apply_doc(&doc, false);
        }
        publish(&document, Some(projection.inbox()));
        let (stop, shutdown) = flume::bounded(0);
        let handle = std::thread::Builder::new()
            .name("chord-governance".into())
            .spawn(move || {
                while let Some(event) = flume::Selector::new().recv(&shutdown, |_| None).recv(&events, Result::ok).wait() {
                    if !matches!(event.document.doc_kind.as_str(), "pi.inbox" | "pi.live") {
                        continue;
                    }
                    let live = event.document.doc_kind == "pi.live";
                    if projection.apply_doc(&event.document, event.retired) {
                        publish(&document, (!live).then(|| projection.inbox()));
                    }
                }
            })
            .map_err(|e| vibevalley_runtime::agent::durable::Error::Invalid(e.to_string()))?;
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
    fn inbox(&self) -> Value {
        Value::Array(self.alerts.values().flatten().cloned().collect())
    }

    fn apply_doc(&mut self, d: &vibevalley_runtime::agent::durable::Document, retired: bool) -> bool {
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
                        if kind == "permission_park" {
                            continue;
                        }
                        let task = text("taskId");
                        let at = alert["createdAtMs"].as_i64().unwrap_or_default();
                        let mut v = json!({"id":format!("durable:{kind}:{task}:{at}:{n}"),"kind":match kind{"budget_reached"=>"budget_reached",_=>"mention"},"createdAtMs":at,"resolved":false,"title":text("title"),"summary":text("message")});
                        if !text("conversationId").is_empty() {
                            v["sessionId"] = json!(text("conversationId"))
                        }
                        items.push(v);
                    }
                    self.alerts.insert(key, items);
                }
            }
            "pi.live" => {}
            _ => return false,
        }
        true
    }
}

fn publish(document: &Document, inbox: Option<Value>) {
    let (rev, snapshot, _) = document.state();
    let path = vec!["inbox".into()];
    let mut ops = vec![Op::Replace(vec!["rev".into()], json!(rev + 1))];
    if let Some(next) = inbox {
        let prev = snapshot.get(&path).expect("inbox field");
        if prev == next {
            return;
        }
        let previous = prev.as_array().expect("inbox array");
        let entries = next.as_array().expect("inbox array");
        if entries.len() > previous.len() && entries.starts_with(previous) {
            ops.push(Op::Splice(path, previous.len(), 0, entries[previous.len()..].to_vec()));
        } else {
            ops.push(Op::Replace(path, next));
        }
    }
    document
        .mutate(|d| {
            for op in ops {
                d.apply(op)?;
            }
            Ok(())
        })
        .expect("valid inbox update");
}
