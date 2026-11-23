//! Projects durable runtime `pi.inbox` alerts into typed `InboxItem`s stored on
//! [`Hub`] so `InboxSlice` surfaces them immediately.

use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{InboxFrom, InboxFromRuntime, InboxItem, InboxKind, InboxTarget, InboxTargetRuntime, InboxWords};
use vibevalley_runtime::agent::durable;

use crate::Hub;

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
        hub.set_runtime_inbox(projection.items());
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
                    hub.set_runtime_inbox(projection.items());
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
            let mut items = vec![];
            for (n, alert) in d.state["items"].as_array().into_iter().flatten().enumerate() {
                let text_field = |k: &str| alert[k].as_str().unwrap_or_default();
                let raw_kind = text_field("kind");
                if raw_kind == "permission_park" {
                    continue;
                }
                let kind = if raw_kind == "budget_reached" {
                    InboxKind::BudgetReached
                } else {
                    InboxKind::Mention
                };
                let task_id = text_field("taskId").to_string();
                let session_id = {
                    let conv = text_field("conversationId");
                    (!conv.is_empty()).then(|| conv.to_string())
                };
                let at = alert["createdAtMs"].as_i64().unwrap_or_default();
                let title_field = text_field("title");
                let message_field = text_field("message");
                let body_text = if !message_field.is_empty() {
                    message_field.to_string()
                } else {
                    title_field.to_string()
                };
                let who = "runtime".to_string();
                let words = match kind {
                    InboxKind::BudgetReached => {
                        let title = if title_field.is_empty() {
                            "Session budget reached".to_string()
                        } else {
                            title_field.to_string()
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
                        let title = if title_field.is_empty() {
                            t("server.inbox.item.mention.title", &[("who", who.clone().into())])
                        } else {
                            title_field.to_string()
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
                    id: format!("durable:{raw_kind}:{task_id}:{at}:{n}"),
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
