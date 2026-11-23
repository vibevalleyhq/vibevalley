use std::sync::Arc;

use super::Sessions;
use crate::modules::work::ledger::Step;

#[derive(Clone)]
pub enum News {
    Step { session: String, cwd: String, step: Step },
}

pub(super) type Listener = Arc<dyn Fn(&News) + Send + Sync>;

impl Sessions {
    pub fn on_news(&self, listener: impl Fn(&News) + Send + Sync + 'static) {
        self.0.listeners.lock().push(Arc::new(listener));
    }

    pub(super) fn announce(&self, news: News) {
        let listeners = self.0.listeners.lock().clone();
        for listener in listeners {
            listener(&news);
        }
    }

    pub(super) fn record(&self, session: &str, step: Step) {
        let cwd = self.session(session).and_then(|s| s.cwd).unwrap_or_default();
        self.announce(News::Step {
            session: session.into(),
            cwd,
            step,
        });
    }
}
