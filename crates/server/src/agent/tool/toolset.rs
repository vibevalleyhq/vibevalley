//! Exhaustive mapping from farm tool operations to [`Toolset`] and
//! caller-role permission checks (secondary `can` narrowing).

use vibevalley_protocol::{Agent, Caller, Toolset, endpoint};

use super::registry::Who;

/// Which agent execution role invokes a farm tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Orchestrator,
    Helper,
}

impl Role {
    pub fn from_who(who: &Who) -> Self {
        match who {
            Who::Orchestrator(_) => Self::Orchestrator,
            Who::Helper(_) => Self::Helper,
        }
    }

    fn matches_caller(self, caller: Caller) -> bool {
        matches!((self, caller), (Self::Orchestrator, Caller::Orchestrator) | (Self::Helper, Caller::Session))
    }
}

/// Static toolset membership and role eligibility for a tool `op`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolAccess {
    pub toolset: Toolset,
    pub orchestrator: bool,
    pub helper: bool,
}

impl ToolAccess {
    const fn new(toolset: Toolset, orchestrator: bool, helper: bool) -> Self {
        Self { toolset, orchestrator, helper }
    }

    fn allows_role(self, role: Role) -> bool {
        match role {
            Role::Orchestrator => self.orchestrator,
            Role::Helper => self.helper,
        }
    }
}

/// Maps every farm tool `op` exhaustively to its [`Toolset`] and allowed agent roles.
pub fn access_of(op: &str) -> Option<ToolAccess> {
    use Toolset::{Artifact, Channel, Cron, Issue, Library, Media, Memory, Repo, Resource, Session};

    Some(match op {
        "issue.list" | "issue.get" => ToolAccess::new(Issue, true, true),
        "issue.create" | "issue.update" | "issue.status.update" | "issue.comment.create" | "issue.review" | "issue.diff.get" => {
            ToolAccess::new(Issue, true, false)
        }
        "issue.split" | "issue.report" | "issue.pr.submit" => ToolAccess::new(Issue, false, true),
        "session.list" => ToolAccess::new(Session, true, true),
        "session.stop" => ToolAccess::new(Session, true, false),
        "channel.message.list" => ToolAccess::new(Channel, true, true),
        "channel.message.send" | "channel.unread.list" => ToolAccess::new(Channel, false, true),
        "channel.list" | "channel.create" | "channel.update" => ToolAccess::new(Channel, true, false),
        "repo.list" => ToolAccess::new(Repo, true, false),
        "cron.create" | "cron.list" | "cron.delete" => ToolAccess::new(Cron, true, false),
        "resource.read" => ToolAccess::new(Resource, true, true),
        "memory.search" | "memory.create" => ToolAccess::new(Memory, true, true),
        "media.image.create"
        | "media.speech.create"
        | "media.dialogue.create"
        | "media.voiceDesign.create"
        | "media.understanding.start"
        | "media.job.get"
        | "media.job.list"
        | "media.job.cancel"
        | "media.job.download" => ToolAccess::new(Media, true, false),
        "library.item.list" | "library.item.add" => ToolAccess::new(Library, true, true),
        "artifact.list"
        | "artifact.get"
        | "artifact.content.get"
        | "artifact.create"
        | "artifact.version.create"
        | "artifact.file.list"
        | "artifact.file.get"
        | "artifact.file.write"
        | "artifact.file.delete"
        | "artifact.suggestion.list"
        | "artifact.suggestion.create"
        | "artifact.type.list"
        | "artifact.type.read" => ToolAccess::new(Artifact, true, true),
        _ => return None,
    })
}

/// Returns the [`Toolset`] owning `op`, if mapped.
pub fn toolset_of(op: &str) -> Option<Toolset> {
    access_of(op).map(|a| a.toolset)
}

/// Secondary protocol `can` narrowing: ensures an agent role can only invoke
/// tools allowed both by the farm tool table and the protocol `Endpoint.can` contract.
pub fn can_role(op: &str, role: Role) -> bool {
    let Some(access) = access_of(op) else {
        return false;
    };
    if !access.allows_role(role) {
        return false;
    }
    let Some(ep) = endpoint(op) else {
        // Agent-only tools (`resource.read`, `issue.report`, `issue.pr.submit`) have no HTTP endpoint.
        return true;
    };
    if ep.can.iter().any(|caller| role.matches_caller(*caller)) {
        return true;
    }
    // Helpers retain read-only access to `issue.list` and `issue.get` over `/mcp`.
    role == Role::Helper && matches!(op, "issue.list" | "issue.get")
}

/// Checks whether `agent` (if backed by a profile) is permitted to list or run
/// `op`/`tool_name` in `role`, enforcing `can_role`, `Agent.toolsets`, and `disallowed_tools`.
pub fn allows(agent: Option<&Agent>, op: &str, tool_name: &str, role: Role) -> bool {
    if !can_role(op, role) {
        return false;
    }
    let Some(ts) = toolset_of(op) else {
        return false;
    };
    let Some(profile) = agent else {
        return true;
    };
    if !profile.toolsets.contains(&ts) {
        return false;
    }
    !profile.disallowed_tools.iter().any(|blocked| blocked == tool_name || blocked == op)
}

/// Formats a refusal message in the model's language when a tool call is blocked.
pub fn denied_message(agent: Option<&Agent>, op: &str, tool_name: &str, role: Role) -> String {
    if !can_role(op, role) {
        return format!("没成：当前身份不能调用 {tool_name}");
    }
    if let (Some(profile), Some(ts)) = (agent, toolset_of(op))
        && !profile.toolsets.contains(&ts)
    {
        return format!("没成：当前角色没有开启 {} 工具集，不能调用 {tool_name}", ts.as_str());
    }
    format!("没成：{tool_name} 已被当前角色禁用")
}
