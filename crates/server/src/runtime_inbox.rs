//! Projects durable runtime `pi.inbox` alerts into typed `InboxItem`s folded
//! through [`Hub::apply`] via [`Fact::runtime_inbox_changed`].

use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{Fact, InboxFrom, InboxFromRuntime, InboxItem, InboxKind, InboxTarget, InboxTargetRuntime, InboxWords};
use vibevalley_runtime::agent::durable;

use crate::Hub;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInboxDoc {
    #[serde(default)]
    items: Vec<RuntimeInboxAlert>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInboxAlert {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    conversation_id: String,
    #[serde(default)]
    created_at_ms: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
}

pub(crate) struct RuntimeInboxObserver {
    observer: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

#[derive(Default)]
struct Projection {
    alerts: BTreeMap<(String, String), Vec<InboxItem>>,
    revisions: BTreeMap<(String, String, String), i64>,
}

impl RuntimeInboxObserver {
    pub fn new() -> Self {
        Self { observer: Default::default() }
    }

    pub fn attach(&self, store: &durable::Store, hub: &Arc<Hub>) -> durable::Result<()> {
        let events = store.subscribe_documents()?;
        let initial = store.read(|tx| {
            let mut docs = tx.documents_by_kind("conversation", "pi.inbox")?;
            docs.extend(tx.documents_by_kind("global", "pi.inbox")?);
            Ok(docs)
        })?;
        let mut projection = Projection::default();
        for doc in initial {
            projection.apply_doc(&doc, false);
        }
        let initial_items = projection.items();
        if !initial_items.is_empty() {
            hub.apply(vec![Fact::runtime_inbox_changed(crate::now(), initial_items)]);
        }
        let weak = Arc::downgrade(hub);
        let cancel = hub.child_token();
        let task_cancel = cancel.clone();
        let handle = hub.spawn_task(async move {
            loop {
                let event = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = events.recv_async() => match res {
                        Ok(event) => event,
                        Err(_) => return,
                    },
                };
                if event.document.doc_kind != "pi.inbox" {
                    continue;
                }
                if projection.apply_doc(&event.document, event.retired) {
                    let Some(hub) = weak.upgrade() else { return };
                    hub.apply(vec![Fact::runtime_inbox_changed(crate::now(), projection.items())]);
                }
            }
        });
        *self.observer.lock() = Some((cancel, handle));
        Ok(())
    }

    pub fn stop(&self) {
        if let Some((cancel, handle)) = self.observer.lock().take() {
            cancel.cancel();
            let _ = vibevalley_runtime::rt::block_on(handle);
        }
    }
}

impl Drop for RuntimeInboxObserver {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Projection {
    fn items(&self) -> Vec<InboxItem> {
        self.alerts.values().flatten().cloned().collect()
    }

    fn apply_doc(&mut self, d: &durable::Document, retired: bool) -> bool {
        if d.doc_kind != "pi.inbox" {
            return false;
        }
        let rev_key = (d.scope_kind.clone(), d.scope_id.clone(), d.doc_kind.clone());
        if retired {
            if self.revisions.remove(&rev_key).is_none() {
                return false;
            }
        } else {
            if self.revisions.get(&rev_key).is_some_and(|prev| *prev >= d.rev) {
                return false;
            }
            self.revisions.insert(rev_key, d.rev);
        }
        let scope_key = (d.scope_kind.clone(), d.scope_id.clone());
        if retired {
            self.alerts.remove(&scope_key);
        } else {
            let parsed: RuntimeInboxDoc = serde_json::from_value(d.state.clone()).unwrap_or_default();
            let mut items = vec![];
            for (n, alert) in parsed.items.into_iter().enumerate() {
                if alert.kind == "permission_park" {
                    continue;
                }
                let kind = if alert.kind == "budget_reached" {
                    InboxKind::BudgetReached
                } else {
                    InboxKind::Mention
                };
                let task_id = alert.task_id;
                let session_id = (!alert.conversation_id.is_empty()).then_some(alert.conversation_id);
                let at = alert.created_at_ms;
                let body_text = if !alert.message.is_empty() { alert.message } else { alert.title.clone() };
                let who = "runtime".to_string();
                let words = match kind {
                    InboxKind::BudgetReached => {
                        let title = if alert.title.is_empty() {
                            "Session budget reached".to_string()
                        } else {
                            alert.title
                        };
                        let tray = if body_text.is_empty() { title.clone() } else { body_text.clone() };
                        InboxWords {
                            label: "budget_reached".to_string(),
                            title,
                            body: body_text.clone(),
                            tray,
                        }
                    }
                    _ => {
                        let title = if alert.title.is_empty() {
                            t("server.inbox.item.mention.title", &[("who", who.clone().into())])
                        } else {
                            alert.title
                        };
                        InboxWords {
                            label: t("server.inbox.item.mention.label", &[]),
                            title,
                            body: body_text.clone(),
                            tray: String::new(),
                        }
                    }
                };
                items.push(InboxItem {
                    id: format!("durable:{}:{task_id}:{at}:{n}", alert.kind),
                    kind,
                    from: InboxFrom::Runtime(InboxFromRuntime {}),
                    who,
                    text: body_text,
                    at,
                    target: InboxTarget::Runtime(InboxTargetRuntime { task_id, session_id }),
                    words,
                });
            }
            self.alerts.insert(scope_key, items);
        }
        true
    }
}
