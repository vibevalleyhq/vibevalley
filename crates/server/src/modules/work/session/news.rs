use std::sync::Arc;

use vibevalley_protocol::IssueReportMemory;

use super::Sessions;
use crate::modules::work::ledger::{Step, lock};

#[derive(Clone)]
pub enum News {
    Step {
        session: String,
        cwd: String,
        step: Step,
    },
    Remember {
        agent: String,
        session: String,
        repo: String,
        memories: Vec<IssueReportMemory>,
    },
}

pub(super) type Listener = Arc<dyn Fn(&News) + Send + Sync>;

impl Sessions {
    pub fn on_news(&self, listener: impl Fn(&News) + Send + Sync + 'static) {
        lock(&self.0.listeners).push(Arc::new(listener));
    }

    pub(super) fn announce(&self, news: News) {
        let listeners = lock(&self.0.listeners).clone();
        for listener in listeners {
            listener(&news);
        }
    }

    pub(super) fn record(&self, session: &str, step: Step) {
        let cwd = self.session(session).and_then(|s| s.worktree).unwrap_or_default();
        self.announce(News::Step {
            session: session.into(),
            cwd,
            step,
        });
    }
}
