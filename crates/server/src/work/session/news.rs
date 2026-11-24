use std::sync::Arc;

use super::SessionStore;
use crate::work::ledger::Step;

#[derive(Clone)]
pub enum News {
    Step { session: String, cwd: String, step: Step },
}

pub(super) type Listener = Arc<dyn Fn(&News) + Send + Sync>;

impl SessionStore {
    pub fn on_news(&self, listener: impl Fn(&News) + Send + Sync + 'static) {
        self.0.listeners.lock().push(Arc::new(listener));
    }

    pub(super) fn announce(&self, news: News) {
        let listeners = self.0.listeners.lock().clone();
        for listener in listeners {
            listener(&news);
        }
    }

    pub(super) async fn record_async(&self, session: &str, step: Step) {
        let cwd = self.session_async(session).await.and_then(|s| s.cwd).unwrap_or_default();
        if let Some(tr) = &self.0.trajectories {
            tr.step_async(session, &cwd, step.clone()).await;
        }
        if !self.0.listeners.lock().is_empty() {
            self.announce(News::Step {
                session: session.into(),
                cwd,
                step,
            });
        }
    }
}
