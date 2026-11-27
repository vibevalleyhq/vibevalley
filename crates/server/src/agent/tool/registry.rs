use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use vibevalley_protocol::{Issue, Session};

use crate::agent::mcp::Resource;
use crate::agent::memory::Memory;
use crate::agent::profile::{Profile, text};
use crate::artifact::Manager as ArtifactManager;
use crate::channel::Chat;
use crate::context::Context;
use crate::cron::Scheduler as CronScheduler;
use crate::issue::{Board, Pull};
use crate::repo::Repo;
use crate::runtime::Runtime;
use crate::storage::Storage;

/// A tool as the model sees it.
#[derive(Deserialize, Clone)]
pub struct Words {
    pub op: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Trigger provenance attached to an orchestrator turn for hard authorization checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteSource {
    User,
    Chat,
    Issue,
    Cron,
    Patrol,
    Call,
}

/// Where the orchestrator is answering now (`HostContext`).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Route {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub envelope: String,
    /// The helper the user picked in the composer.
    #[serde(default)]
    pub picked: String,
    /// User-authored words are in the batch.
    #[serde(default)]
    pub user: bool,
    /// Normalized source of the batch (`User` when any user input is present).
    #[serde(default)]
    pub source: Option<RouteSource>,
    /// Cron job id when triggered by a scheduled cron turn.
    #[serde(default)]
    pub cron_id: Option<String>,
}

/// Who calls a tool.
#[derive(Clone)]
pub enum Who {
    Orchestrator(Route),
    Helper(Box<Session>),
}

/// Typed tool dispatcher backed by `Context` (`ctx.service.*`) and domain services.
pub struct ToolRegistry {
    pub ctx: Arc<Context>,
    pub resource: Arc<Resource>,
    pub cron: Arc<CronScheduler>,
    pub profile: Arc<Profile>,
    pub memory: Arc<Memory>,
    pub issue: Arc<Board>,
    pub runtime: Arc<Runtime>,
    pub repo: Arc<Repo>,
    pub chat: Arc<Chat>,
    pub pull: Arc<Pull>,
    pub artifact: Arc<ArtifactManager>,
    pub storage: Arc<Storage>,
    pub repos_root: PathBuf,
}

impl ToolRegistry {
    /// An issue by id, `#n`, number, or the id or name of a helper on it.
    pub(super) async fn issue_async(&self, key: &str) -> Result<Issue, String> {
        let key = key.trim();
        let k = key.trim_start_matches('#');
        let issues = self.ctx.service.issue.all().await.map_err(|e| e.to_string())?;
        if let Some(found) = issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned() {
            return Ok(found);
        }
        let sessions = self.ctx.service.session.all().await.unwrap_or_default();
        if let Some(on) = sessions.iter().filter(|h| h.id == k || h.name == k).max_by_key(|h| h.hired_at)
            && let Some(found) = issues.into_iter().find(|i| Some(i.id.as_str()) == on.issue_id())
        {
            return Ok(found);
        }
        Err(text::no_issue(key))
    }

    pub(super) async fn worker_of_async(&self, issue: &Issue) -> Option<Session> {
        let last = issue.latest_session_id()?;
        self.ctx.service.session.get(last).await.ok().flatten()
    }

    pub(super) async fn who_of_async(&self, issue: &Issue) -> String {
        if let Some(w) = self.worker_of_async(issue).await {
            return w.name;
        }
        match issue.assigned_agent() {
            Some(vibevalley_protocol::DEFAULT_ORCHESTRATOR) => "助手".into(),
            Some(a) => self.profile.agent(a).map(|p| p.name).unwrap_or_default(),
            None => String::new(),
        }
    }

    async fn number_of_async(&self, session: &Session) -> Option<i64> {
        let issue_id = session.issue_id()?;
        self.ctx.service.issue.get(issue_id).await.ok().flatten().map(|i| i.number)
    }

    /// Every helper on the farm.
    pub async fn roster_async(&self) -> Vec<Session> {
        self.ctx
            .service
            .session
            .all()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(vibevalley_core::status::is_farm_worker)
            .collect()
    }

    pub async fn session_line_async(&self, h: &Session) -> String {
        text::session_line(h, self.ctx.now(), self.number_of_async(h).await)
    }

    pub async fn session_for_token_async(&self, token: &str) -> Option<Session> {
        let id = self.runtime.who(token)?;
        if let Some(saved) = self.ctx.service.session.get(&id).await.ok().flatten() {
            return Some(saved);
        }
        self.runtime.opening_session(&id)
    }
}

/// A string argument given and not blank.
pub(super) fn given(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}
