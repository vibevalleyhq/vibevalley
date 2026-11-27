//! Who runs an issue's agent: the runtime asks a [`SessionDriver`] to turn an
//! assigned agent into an OAR runtime and its options. Standalone, an agent is
//! a runtime id ([`RuntimeDriver`]); the server injects profile-backed drivers
//! from `crate::agent` without creating any compile-time dependency on `agent/`.

use std::sync::Arc;

use vibevalley_protocol::{Deliverable, Issue, LOCAL_MACHINE_ID, Session};
use vibevalley_runtime::oar::{Installation, Registry, Runtime};

/// Execution modes for issue-bound helper sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Execution,
    Drafting,
    ReadOnlyAnswer,
    ReadOnlyReview,
    ReadOnlyCollaborator,
}

impl RunMode {
    /// Derives the run mode from a session and its bound issue.
    pub fn from_session_issue(session: &Session, issue: Option<&Issue>) -> Self {
        if session.is_refining() {
            Self::Drafting
        } else if session.is_readonly_issue_helper() {
            Self::ReadOnlyCollaborator
        } else if issue.is_some_and(|i| i.deliver == Deliverable::Answer) {
            Self::ReadOnlyAnswer
        } else {
            Self::Execution
        }
    }

    pub fn is_read_only(self) -> bool {
        matches!(self, Self::Drafting | Self::ReadOnlyAnswer | Self::ReadOnlyReview | Self::ReadOnlyCollaborator)
    }

    /// Returns `true` when this mode may mutate the worktree and must hold the single-writer hoe lock.
    pub fn needs_write_lock(self) -> bool {
        self == Self::Execution
    }

    pub fn as_doc_tag(self) -> Option<&'static str> {
        match self {
            Self::ReadOnlyReview => Some("review"),
            Self::ReadOnlyCollaborator => Some("collaborator"),
            Self::Execution | Self::Drafting | Self::ReadOnlyAnswer => None,
        }
    }

    pub fn from_doc_tag(tag: &str) -> Option<Self> {
        match tag {
            "review" => Some(Self::ReadOnlyReview),
            "collaborator" => Some(Self::ReadOnlyCollaborator),
            _ => None,
        }
    }

    pub fn label_zh(self) -> &'static str {
        match self {
            Self::Execution => "执行",
            Self::Drafting => "起草",
            Self::ReadOnlyAnswer => "只读问答",
            Self::ReadOnlyReview => "只读审查",
            Self::ReadOnlyCollaborator => "只读协同",
        }
    }
}

use crate::BoxFuture;
use crate::runtime::{Result, RuntimeError};

/// Where a profile's persona goes (VibeValley `personaMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Persona {
    /// Added to the system prompt (`append`).
    System(String),
    /// In place of the runtime's own system prompt (`replace`).
    Replace(String),
    /// Put before the first words of a session (`prompt`).
    Prompt(String),
}

/// Lightweight profile metadata exposed by [`SessionDriver::profile_info`] so
/// `runtime/` and `issue/` never import `crate::agent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfileInfo {
    pub id: String,
    pub code: String,
    pub name: String,
    pub enabled: bool,
    pub is_orchestrator: bool,
    pub is_external: bool,
}

/// What a session on an agent opens with.
pub struct Drive {
    /// The agent as the issue's assignment and the session name it.
    pub agent: String,
    pub runtime: Arc<dyn Runtime>,
    /// The runtime as the session names it (`Session.runtime`).
    pub runtime_id: String,
    /// Execution machine id (`"local"` or remote/sandbox machine id).
    pub machine_id: String,
    /// True when executing in-process on the control plane host.
    pub is_local: bool,
    /// What the session is called after: `<name> #<n>`.
    pub name: String,
    pub model: Option<String>,
    pub env: Vec<(String, String)>,
    pub persona: Option<Persona>,
    pub effort: Option<String>,
    pub mcp_servers: Vec<vibevalley_runtime::oar::McpServer>,
    pub disallowed_tools: Vec<String>,
}

impl Drive {
    pub(super) fn work_instructions(&self, rules: String, prompt: String) -> (Option<String>, String) {
        match self.runtime.id() {
            "kimi" | "codebuddy" => (None, format!("{rules}\n\n---\n\n{prompt}")),
            _ => (Some(rules), prompt),
        }
    }
}

pub trait SessionDriver: Send + Sync {
    /// Refuses an agent named on an issue that cannot be named.
    fn check(&self, agent: &str) -> Result<()>;

    /// What the agent runs `issue` on now; `None` is nobody assigned.
    fn drive<'a>(&'a self, agent: Option<&'a str>, issue: &'a Issue) -> BoxFuture<'a, Result<Drive>>;

    /// What a direct workspace session opens on, named by runtime id.
    fn drive_runtime<'a>(&'a self, runtime: &'a str, model: Option<&'a str>, effort: Option<&'a str>) -> BoxFuture<'a, Result<Drive>>;

    /// Who drafts `issue` (`refine`); the board assigns it when nobody is.
    fn drafter<'a>(&'a self, issue: &'a Issue) -> BoxFuture<'a, Result<Drive>> {
        self.drive(issue.assigned_agent(), issue)
    }

    /// Normalizes a user-provided agent name or id into its canonical profile key.
    fn resolve_agent_key(&self, agent: &str) -> String {
        agent.trim().to_string()
    }

    /// Looks up lightweight profile metadata without importing `crate::agent`.
    fn profile_info(&self, _id: &str) -> Option<AgentProfileInfo> {
        None
    }

    /// Returns the enabled non-orchestrator reviewer profile for automatic `in_review` gates, if any.
    fn reviewer_profile(&self) -> Option<AgentProfileInfo> {
        None
    }

    /// Resolves a `@<agent>` discussion mention token to an enabled non-orchestrator worker profile.
    fn resolve_mention_agent(&self, _token: &str) -> Option<AgentProfileInfo> {
        None
    }

    /// What the agent remembers for a round on `input`, set before the input; `""` is nothing.
    fn recall<'a>(&'a self, _agent: &'a str, _session: &'a str, _repo: &'a str, _input: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async { String::new() })
    }

    /// The rules a helper works an issue by (its appended system prompt).
    fn rules(&self, _place: &HelperPlace, deliver: Deliverable) -> String {
        super::report::instructions(deliver)
    }

    /// The rules a drafting session works by (`起草` mode, read-only).
    fn draft_rules(&self, _place: &HelperPlace) -> String {
        "你处于「起草」模式，只读查看代码与上下文以整理 VibeValley 工单草案；严禁修改、创建或提交任何文件，也不要调用写工具。".to_string()
    }

    /// The rules an automated readonly reviewer follows during `in_review`.
    fn review_rules(&self, place: &HelperPlace, issue_id: &str, issue_number: i64) -> String {
        format!(
            "你处于「只读审查」模式，正在自动审查工单 #{issue_number}（id={issue_id}，工作区={}）。\n\
             严禁修改、创建、删除或提交任何代码文件。\n\
             请先使用 `issue_get` 与 `issue_diff_get`（并按需只读查看工作区代码与测试）核对工单验收标准与当前改动：\n\
             - 若全部达标且无阻塞问题，调用 `issue_review(id=\"{issue_id}\", pass=true, text=\"...\")`。\n\
             - 若存在问题或未达标，列出具体可操作的 `findings` 并调用 `issue_review(id=\"{issue_id}\", pass=false, findings=[...], text=\"...\")` 打回修复。",
            place.cwd
        )
    }

    /// The rules a `@<agent>` readonly collaborator follows when invited into an issue discussion thread.
    fn collaborator_rules(&self, place: &HelperPlace, issue_id: &str, issue_number: i64) -> String {
        format!(
            "你处于「只读协同」模式，受邀就工单 #{issue_number}（id={issue_id}，工作区={}）参与只读评审或解答，不会抢占主工单执行会话。\n\
             严禁修改、创建、删除或提交任何文件，也不要修改工单状态。\n\
             请只读查看工单详情（`issue_get`）、改动（`issue_diff_get`）及相关源码后给出结论；完成后在讨论中回复或调用 `issue_report` 提交结论摘要。",
            place.cwd
        )
    }

    /// The rules a helper talks by in a channel, with no issue.
    fn talk_rules(&self, cwd: &str, channel: &str, id: &str) -> String {
        format!(
            "You are @{id}, talking with the user in {channel}. Your own folder is {cwd}; write files only there. Your last answer of a round is posted in the channel."
        )
    }
}

/// Where a helper works an issue, for its rules.
pub struct HelperPlace {
    pub repo: String,
    /// None: the repo's own folder, no branch of its own.
    pub branch: Option<String>,
    pub cwd: String,
    /// The helper's own id (`@w3`).
    pub id: String,
    pub pull_request: bool,
    /// The work root's AGENTS.md: rules for every repo on this machine.
    pub house: String,
}

/// An agent is a runtime id; nobody assigned runs `claude`.
pub struct RuntimeDriver {
    pub registry: Arc<Registry>,
    pub model: Option<String>,
}

impl SessionDriver for RuntimeDriver {
    fn check(&self, agent: &str) -> Result<()> {
        self.registry.require(agent).map(|_| ()).map_err(RuntimeError::from)
    }

    fn drive<'a>(&'a self, agent: Option<&'a str>, _issue: &'a Issue) -> BoxFuture<'a, Result<Drive>> {
        let agent = agent.filter(|a| !a.trim().is_empty()).unwrap_or("claude");
        self.drive_runtime(agent, None, None)
    }

    fn drive_runtime<'a>(&'a self, runtime_id: &'a str, model: Option<&'a str>, effort: Option<&'a str>) -> BoxFuture<'a, Result<Drive>> {
        Box::pin(async move {
            let runtime_id = runtime_id.trim();
            let runtime = self.registry.require(runtime_id)?;
            match runtime.installation().await {
                Installation::Available { .. } => {}
                Installation::LoginRequired { .. } => return Err(RuntimeError::Other(format!("{runtime_id} requires a local sign-in"))),
                Installation::NotInstalled => return Err(RuntimeError::Other(format!("{runtime_id} is not installed"))),
                Installation::Unusable { reason } => return Err(RuntimeError::Other(format!("{runtime_id} cannot be used: {reason}"))),
            }
            let wire_id = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id()).to_string();
            Ok(Drive {
                agent: wire_id.clone(),
                runtime_id: wire_id,
                machine_id: LOCAL_MACHINE_ID.to_string(),
                is_local: true,
                name: runtime.display_name().to_string(),
                runtime,
                model: model.map(str::trim).filter(|m| !m.is_empty()).map(String::from).or_else(|| self.model.clone()),
                env: vec![],
                persona: None,
                effort: effort.map(str::trim).filter(|e| !e.is_empty()).map(String::from),
                mcp_servers: vec![],
                disallowed_tools: vec![],
            })
        })
    }
}
