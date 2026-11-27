use crate::wire::{Caller, Endpoint, SubscriptionSpec};

mod t {
    pub use crate::contract::*;
}

/// Every endpoint, in VibeValley's order (`packages/protocol/src/api.ts`).
pub const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "agent.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<Agent>"),
    },
    Endpoint {
        op: "agent.validate",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AgentValidateRequest"),
        result: Some("Vec<AgentValidation>"),
    },
    Endpoint {
        op: "agent.create",
        module: "agent",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Agent"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.update",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Agent"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("agent.previewDelete"),
        input: Some("AgentDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "agent.previewDelete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "agent.template.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<AgentTemplate>"),
    },
    Endpoint {
        op: "agent.template.install",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateInstallInput"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.template.update",
        module: "agent",
        about: &["agent"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateUpdateInput"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.template.add",
        module: "agent",
        about: &["path"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateAddInput"),
        result: Some("AgentTemplate"),
    },
    Endpoint {
        op: "agent.template.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "skill.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<Skill>"),
    },
    Endpoint {
        op: "skill.create",
        module: "agent",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Skill"),
        result: Some("Skill"),
    },
    Endpoint {
        op: "skill.update",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Skill"),
        result: Some("Skill"),
    },
    Endpoint {
        op: "skill.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SkillDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "runtime.list",
        module: "runtime",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<RuntimeInfo>"),
    },
    Endpoint {
        op: "runtime.refresh",
        module: "runtime",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RuntimeRefreshInput"),
        result: Some("RuntimeInfo"),
    },
    Endpoint {
        op: "runtime.setting.update",
        module: "runtime",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RuntimeSettingUpdateInput"),
        result: Some("RuntimeInfo"),
    },
    Endpoint {
        op: "runtime.mcp.list",
        module: "runtime",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("McpListInput"),
        result: Some("McpListResult"),
    },
    Endpoint {
        op: "runtime.mcp.install",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpInstallInput"),
        result: Some("McpHostInfo"),
    },
    Endpoint {
        op: "runtime.mcp.uninstall",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpUninstallInput"),
        result: Some("McpHostInfo"),
    },
    Endpoint {
        op: "runtime.mcpServer.list",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("McpServerListInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.save",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerSaveInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.toggle",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerToggleInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "runtime.mcpServer.remove",
        module: "runtime",
        about: &["host"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("McpServerRemoveInput"),
        result: Some("McpServerListResult"),
    },
    Endpoint {
        op: "memory.list",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryListInput"),
        result: Some("MemoryList"),
    },
    Endpoint {
        op: "memory.recall",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryRecallInput"),
        result: Some("RecallPreview"),
    },
    Endpoint {
        op: "memory.create",
        module: "memory",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("MemoryCreateInput"),
        result: Some("Memory"),
    },
    Endpoint {
        op: "memory.search",
        module: "memory",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("MemorySearchInput"),
        result: Some("MemorySearch"),
    },
    Endpoint {
        op: "memory.delete",
        module: "memory",
        about: &["agent", "memory"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("memory.previewDelete"),
        input: Some("MemoryDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "memory.previewDelete",
        module: "memory",
        about: &["agent", "memory"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MemoryDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "repo.pr.submit",
        module: "repo",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SubmitBranch"),
        result: Some("BranchPublication"),
    },
    Endpoint {
        op: "github.get",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("GitHubStatus"),
    },
    Endpoint {
        op: "github.refresh",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("GitHubStatus"),
    },
    Endpoint {
        op: "repo.list",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<RepoSummary>"),
    },
    Endpoint {
        op: "repo.validate",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NewRepo"),
        result: Some("Validation"),
    },
    Endpoint {
        op: "repo.create",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NewRepo"),
        result: Some("RepoSummary"),
    },
    Endpoint {
        op: "repo.mount",
        module: "repo",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MountRepo"),
        result: Some("RepoSummary"),
    },
    Endpoint {
        op: "repo.unmount",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoUnmountInput"),
        result: None,
    },
    Endpoint {
        op: "repo.language.list",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoLanguageListInput"),
        result: Some("RepoLanguages"),
    },
    Endpoint {
        op: "repo.template.list",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoTemplateListInput"),
        result: Some("RepoTemplates"),
    },
    Endpoint {
        op: "repo.activity.get",
        module: "repo",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RepoActivityGetInput"),
        result: Some("RepoActivity"),
    },
    Endpoint {
        op: "session.stop",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("SessionStopInput"),
        result: None,
    },
    Endpoint {
        op: "session.list",
        module: "session",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("SessionListInput"),
        result: Some("Vec<Session>"),
    },
    Endpoint {
        op: "session.get",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionGetInput"),
        result: Some("Session"),
    },
    Endpoint {
        op: "session.event.list",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionEventListInput"),
        result: Some("SessionEventPage"),
    },
    Endpoint {
        op: "session.openWorkspace",
        module: "session",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionOpenWorkspaceInput"),
        result: Some("SessionWorkspace"),
    },
    Endpoint {
        op: "session.closeWorkspace",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionCloseWorkspaceInput"),
        result: None,
    },
    Endpoint {
        op: "session.send",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionSendInput"),
        result: Some("Session"),
    },
    Endpoint {
        op: "session.respondPermission",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRespondPermissionInput"),
        result: None,
    },
    Endpoint {
        op: "session.respondInteraction",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRespondInteractionInput"),
        result: None,
    },
    Endpoint {
        op: "session.setConfig",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionSetConfigInput"),
        result: Some("SessionWorkspace"),
    },
    Endpoint {
        op: "session.childTranscript",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionChildTranscriptInput"),
        result: Some("SessionChildTranscript"),
    },
    Endpoint {
        op: "session.compact",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionCompactInput"),
        result: Some("SessionCompactResult"),
    },
    Endpoint {
        op: "session.runCode",
        module: "session",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SessionRunCodeInput"),
        result: Some("SessionRunCodeResult"),
    },
    Endpoint {
        op: "issue.conversation.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueConversationGetInput"),
        result: Some("Option<String>"),
    },
    Endpoint {
        op: "issue.comment.create",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueCommentCreateInput"),
        result: Some("Applied"),
    },
    Endpoint {
        op: "issue.diff.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueDiffGetInput"),
        result: Some("Changes"),
    },
    Endpoint {
        op: "issue.history.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<IssueHistory>"),
    },
    Endpoint {
        op: "issue.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueFilter"),
        result: Some("Vec<Issue>"),
    },
    Endpoint {
        op: "issue.review",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueReviewInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.split",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: Some("IssueSplitInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "issue.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueGetInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.run.list",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueRunListInput"),
        result: Some("Vec<Run>"),
    },
    Endpoint {
        op: "issue.timeline.get",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueTimelineGetInput"),
        result: Some("IssueTimeline"),
    },
    Endpoint {
        op: "issue.create",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRequest"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.update",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueUpdateInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.delete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("issue.previewDelete"),
        input: Some("IssueDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "issue.previewDelete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "issue.status.update",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: Some("issue.status.previewUpdate"),
        input: Some("IssueStatusUpdateInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.status.previewUpdate",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueStatusUpdateInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "issue.refine",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRefineInput"),
        result: Some("Issue"),
    },
    Endpoint {
        op: "issue.retro.get",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueRetroGetInput"),
        result: Some("IssueRetroReport"),
    },
    Endpoint {
        op: "issue.digest.get",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("IssueDigestGetInput"),
        result: Some("MorningDigest"),
    },
    Endpoint {
        op: "issue.triage.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<BacklogTriageSuggestion>"),
    },
    Endpoint {
        op: "issue.triage.suggest",
        module: "issue",
        about: &["issueId"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("BacklogTriageSuggestInput"),
        result: Some("BacklogTriageSuggestion"),
    },
    Endpoint {
        op: "issue.triage.confirm",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("BacklogTriageConfirmInput"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.triage.dismiss",
        module: "issue",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("BacklogTriageDismissInput"),
        result: None,
    },
    Endpoint {
        op: "cron.create",
        module: "cron",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("CronRequest"),
        result: Some("Cron"),
    },
    Endpoint {
        op: "cron.list",
        module: "cron",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<Cron>"),
    },
    Endpoint {
        op: "cron.update",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("CronUpdateInput"),
        result: None,
    },
    Endpoint {
        op: "cron.delete",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: Some("cron.previewDelete"),
        input: Some("CronDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "cron.previewDelete",
        module: "cron",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("CronDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "channel.message.send",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: Some("SayRequest"),
        result: None,
    },
    Endpoint {
        op: "channel.create",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("ChannelRequest"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.update",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("ChannelUpdateInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.list",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ChannelMessageListInput"),
        result: Some("Vec<ChatMessage>"),
    },
    Endpoint {
        op: "channel.markRead",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMarkReadInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.update",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MessageEdit"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.message.delete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("channel.message.previewDelete"),
        input: Some("ChannelMessageDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.previewDelete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMessageDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "channel.message.search",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MessageSearch"),
        result: Some("Vec<MessageHit>"),
    },
    Endpoint {
        op: "channel.reaction.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ReactionSet"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.pin.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinSetInput"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.pin.list",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinListInput"),
        result: Some("Vec<ChatMessage>"),
    },
    Endpoint {
        op: "channel.thread.create",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelThreadCreateInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.archive.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OnSet"),
        result: None,
    },
    Endpoint {
        op: "channel.delete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("channel.previewDelete"),
        input: Some("ChannelPinListInput"),
        result: None,
    },
    Endpoint {
        op: "channel.previewDelete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinListInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "channel.direct.create",
        module: "channel",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelDirectCreateInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.notify.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NotifyRequest"),
        result: None,
    },
    Endpoint {
        op: "channel.markUnread",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMarkUnreadInput"),
        result: None,
    },
    Endpoint {
        op: "channel.list",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<Channel>"),
    },
    Endpoint {
        op: "channel.unread.list",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: None,
        result: Some("Vec<ChannelUnread>"),
    },
    Endpoint {
        op: "connector.login",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorLoginInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.verify",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorVerifyInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.logout",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorLogoutInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "connector.channel.set",
        module: "connector",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ConnectorChannelSetInput"),
        result: Some("ConnectorStatus"),
    },
    Endpoint {
        op: "media.dialogue.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaSpeakersRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.voiceDesign.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaVoiceDesignRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.clone.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaCloneRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.transcription.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaTranscriptionRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.audio.resume",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.audio.previewCleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.audio.cleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.audio.previewCleanup"),
        input: Some("MediaJobRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.input.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputRequest"),
        result: Some("MediaInput"),
    },
    Endpoint {
        op: "media.input.adopt",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputAdoptInput"),
        result: Some("MediaInput"),
    },
    Endpoint {
        op: "media.input.list",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("Vec<MediaInput>"),
    },
    Endpoint {
        op: "media.input.delete",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.input.previewDelete"),
        input: Some("MediaJobRequest"),
        result: None,
    },
    Endpoint {
        op: "media.input.previewDelete",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.image.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaImageRequest"),
        result: Some("MediaImageJob"),
    },
    Endpoint {
        op: "media.understanding.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaUnderstandingRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.understanding.authorize",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaUnderstandingAuthorizationRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.understanding.start",
        module: "media",
        about: &["id"],
        can: &[Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.speech.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaSpeechRequest"),
        result: Some("MediaSpeechJob"),
    },
    Endpoint {
        op: "media.speech.resume",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaSpeechJob"),
    },
    Endpoint {
        op: "media.understanding.cleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.job.get",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.cancel",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.previewRelease",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.job.release",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.job.previewRelease"),
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.download",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.list",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<MediaJob>"),
    },
    Endpoint {
        op: "library.item.list",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("LibraryListRequest"),
        result: Some("LibraryItems"),
    },
    Endpoint {
        op: "library.item.add",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("LibraryAddRequest"),
        result: Some("LibraryItem"),
    },
    Endpoint {
        op: "library.item.delete",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("library.item.previewDelete"),
        input: Some("LibraryItemDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "library.item.previewDelete",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("LibraryItemDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "voice.hear",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceHearInput"),
        result: None,
    },
    Endpoint {
        op: "voice.moss.verify",
        module: "voice",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("Validation"),
    },
    Endpoint {
        op: "voice.grant.create",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("VoiceGrant"),
    },
    Endpoint {
        op: "voice.call.start",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceCallStart"),
        result: Some("VoiceCall"),
    },
    Endpoint {
        op: "voice.call.stop",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceCall"),
        result: None,
    },
    Endpoint {
        op: "voice.call.hear",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceHeard"),
        result: None,
    },
    Endpoint {
        op: "voice.call.say",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceSaid"),
        result: None,
    },
    Endpoint {
        op: "voice.asr.start",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("VoiceAsrGrant"),
    },
    Endpoint {
        op: "voice.asr.stop",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceAsrStopInput"),
        result: None,
    },
    Endpoint {
        op: "voice.asr.transcribe",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceAsrTranscribeInput"),
        result: Some("VoiceAsrResult"),
    },
    Endpoint {
        op: "note.list",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteListRequest"),
        result: Some("Vec<Note>"),
    },
    Endpoint {
        op: "note.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteGetInput"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.content.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteReadRequest"),
        result: Some("NoteContent"),
    },
    Endpoint {
        op: "note.create",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.version.create",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteVersionRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.update",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteUpdateRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.delete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("note.previewDelete"),
        input: Some("NoteDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "note.previewDelete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "note.tree.move",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteTreeMoveRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.link.list",
        module: "note",
        about: &["entityId"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteLinkListRequest"),
        result: Some("NoteLinkListResult"),
    },
    Endpoint {
        op: "note.doc.view",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteDocViewRequest"),
        result: Some("DocView"),
    },
    Endpoint {
        op: "note.doc.appendBlock",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteDocAppendBlockRequest"),
        result: Some("DocView"),
    },
    Endpoint {
        op: "note.base.view",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("BaseViewRequest"),
        result: Some("BaseViewSnapshot"),
    },
    Endpoint {
        op: "note.base.upsertRow",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("BaseUpsertRowRequest"),
        result: Some("BaseViewSnapshot"),
    },
    Endpoint {
        op: "note.base.runAgentColumn",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("BaseRunAgentColumnRequest"),
        result: Some("BaseRunAgentColumnResult"),
    },
    Endpoint {
        op: "note.type.list",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: None,
        result: Some("Vec<NoteTypeInfo>"),
    },
    Endpoint {
        op: "note.type.read",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteTypeReadRequest"),
        result: Some("NoteTypeGuide"),
    },
    Endpoint {
        op: "note.file.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileListRequest"),
        result: Some("NoteFileListResult"),
    },
    Endpoint {
        op: "note.file.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileGetRequest"),
        result: Some("NoteFileContent"),
    },
    Endpoint {
        op: "note.file.write",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileWriteRequest"),
        result: Some("NoteFileWriteResult"),
    },
    Endpoint {
        op: "note.file.delete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileDeleteRequest"),
        result: Some("NoteFileDeleteResult"),
    },
    Endpoint {
        op: "note.suggestion.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteSuggestionListInput"),
        result: Some("Vec<Suggestion>"),
    },
    Endpoint {
        op: "note.suggestion.create",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteSuggestionCreateInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.suggestion.accept",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.suggestion.reject",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.presence.update",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NotePresenceUpdateRequest"),
        result: None,
    },
    Endpoint {
        op: "note.history.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryListRequest"),
        result: Some("Vec<NoteHistoryEntry>"),
    },
    Endpoint {
        op: "note.history.preview",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryPreviewRequest"),
        result: Some("NoteHistoryPreviewResult"),
    },
    Endpoint {
        op: "note.history.restore",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryRestoreRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.fork",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryForkRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.undoOrigin",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryUndoOriginRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.compact",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryCompactRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.collab.export",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteCollabExportRequest"),
        result: Some("NoteCollabExportResult"),
    },
    Endpoint {
        op: "note.collab.import",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteCollabImportRequest"),
        result: Some("NoteCollabImportResult"),
    },
    Endpoint {
        op: "note.cover.set",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteCoverSetRequest"),
        result: Some("NoteCover"),
    },
    Endpoint {
        op: "provider.get",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("ProviderStatus"),
    },
    Endpoint {
        op: "provider.update",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderUpdate"),
        result: Some("ProviderStatus"),
    },
    Endpoint {
        op: "provider.voice.list",
        module: "provider",
        about: &["connection"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderVoiceRequest"),
        result: Some("ProviderVoiceListing"),
    },
    Endpoint {
        op: "provider.model.list",
        module: "provider",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ProviderModelRequest"),
        result: Some("ProviderModelListing"),
    },
    Endpoint {
        op: "setting.get",
        module: "setting",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("SettingsStatus"),
    },
    Endpoint {
        op: "setting.validate",
        module: "setting",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("SettingsUpdate"),
        result: Some("Validation"),
    },
    Endpoint {
        op: "setting.update",
        module: "setting",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SettingsUpdate"),
        result: Some("SettingsStatus"),
    },
    Endpoint {
        op: "orchestrator.open",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: None,
    },
    Endpoint {
        op: "orchestrator.stop",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OrchestratorStopInput"),
        result: None,
    },
    Endpoint {
        op: "orchestrator.eval.create",
        module: "orchestrator",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OrchestratorEvalRequest"),
        result: Some("OrchestratorEval"),
    },
    Endpoint {
        op: "orchestrator.approval.list",
        module: "orchestrator",
        about: &["conversationId"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("OrchestratorApprovalListInput"),
        result: Some("Vec<OrchestratorApproval>"),
    },
    Endpoint {
        op: "orchestrator.approval.resolve",
        module: "orchestrator",
        about: &["conversationId", "taskId", "toolCallId"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("OrchestratorApprovalResolveInput"),
        result: None,
    },
    Endpoint {
        op: "attachment.create",
        module: "attachment",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AttachmentUpload"),
        result: Some("Attachment"),
    },
    Endpoint {
        op: "attachment.importPath",
        module: "attachment",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AttachmentImportPathInput"),
        result: Some("Attachment"),
    },
    Endpoint {
        op: "server.health.get",
        module: "core",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Health"),
    },
    Endpoint {
        op: "debug.snapshot",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("DebugSnapshot"),
    },
    Endpoint {
        op: "debug.timeline.list",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTimelineQuery"),
        result: Some("DebugTimelinePage"),
    },
    Endpoint {
        op: "debug.timeline.clear",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: None,
    },
    Endpoint {
        op: "debug.trajectory.list",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("Vec<DebugTrajectorySummary>"),
    },
    Endpoint {
        op: "debug.trajectory.get",
        module: "debug",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTrajectoryGetRequest"),
        result: Some("DebugTrajectoryDetail"),
    },
    Endpoint {
        op: "debug.trajectory.export",
        module: "debug",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugTrajectoryExportRequest"),
        result: Some("DebugTrajectoryExportResult"),
    },
    Endpoint {
        op: "debug.override.set",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("DebugOverrideConfig"),
        result: Some("DebugOverrideConfig"),
    },
    Endpoint {
        op: "debug.bundle.export",
        module: "debug",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("DebugBundleResult"),
    },
    Endpoint {
        op: "remote.status",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.enable",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RemoteEnableRequest"),
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.disable",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemoteStatus"),
    },
    Endpoint {
        op: "remote.pair.create",
        module: "remote",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("RemotePairCode"),
    },
    Endpoint {
        op: "remote.pair.exchange",
        module: "remote",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("RemotePairExchangeRequest"),
        result: Some("RemotePairExchangeResult"),
    },
    Endpoint {
        op: "remote.device.revoke",
        module: "remote",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("RemoteDeviceRevokeRequest"),
        result: None,
    },
    Endpoint {
        op: "remote.whoami",
        module: "remote",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("RemoteWhoami"),
    },
    Endpoint {
        op: "machine.list",
        module: "machine",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<MachineInfo>"),
    },
    Endpoint {
        op: "game.shop.list",
        module: "game",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("FarmShopView"),
    },
    Endpoint {
        op: "game.shop.buy",
        module: "game",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ShopPurchaseRequest"),
        result: Some("FarmShopView"),
    },
    Endpoint {
        op: "game.daily.list",
        module: "game",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("DailyTaskBoard"),
    },
];

/// Each endpoint as a type: its name, input and result.
pub mod ops {
    use super::t;
    use crate::wire::Op;

    pub struct AgentList;
    impl Op for AgentList {
        const NAME: &'static str = "agent.list";
        type Input = ();
        type Result = Vec<t::Agent>;
    }
    /// The issues of each profile as it would be dispatched now; a draft not saved yet too.
    pub struct AgentValidate;
    impl Op for AgentValidate {
        const NAME: &'static str = "agent.validate";
        type Input = t::AgentValidateRequest;
        type Result = Vec<t::AgentValidation>;
    }
    /// Create allocates an identity; callers with an existing identity use save.
    pub struct AgentCreate;
    impl Op for AgentCreate {
        const NAME: &'static str = "agent.create";
        type Input = t::Agent;
        type Result = t::Agent;
    }
    pub struct AgentUpdate;
    impl Op for AgentUpdate {
        const NAME: &'static str = "agent.update";
        type Input = t::Agent;
        type Result = t::Agent;
    }
    pub struct AgentDelete;
    impl Op for AgentDelete {
        const NAME: &'static str = "agent.delete";
        type Input = t::AgentDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct AgentPreviewDelete;
    impl Op for AgentPreviewDelete {
        const NAME: &'static str = "agent.previewDelete";
        type Input = t::AgentDeleteInput;
        type Result = t::Preview;
    }
    /// The templates a profile can be installed from: the built-in ones, then those added on this machine.
    pub struct AgentTemplateList;
    impl Op for AgentTemplateList {
        const NAME: &'static str = "agent.template.list";
        type Input = ();
        type Result = Vec<t::AgentTemplate>;
    }
    /// A new profile from a template; installing one again makes another.
    pub struct AgentTemplateInstall;
    impl Op for AgentTemplateInstall {
        const NAME: &'static str = "agent.template.install";
        type Input = t::AgentTemplateInstallInput;
        type Result = t::Agent;
    }
    /// A profile made again from its template's version now.
    pub struct AgentTemplateUpdate;
    impl Op for AgentTemplateUpdate {
        const NAME: &'static str = "agent.template.update";
        type Input = t::AgentTemplateUpdateInput;
        type Result = t::Agent;
    }
    /// A template folder on this machine copied in beside the built-in ones; nothing is installed.
    pub struct AgentTemplateAdd;
    impl Op for AgentTemplateAdd {
        const NAME: &'static str = "agent.template.add";
        type Input = t::AgentTemplateAddInput;
        type Result = t::AgentTemplate;
    }
    /// An added template gone; the profiles installed from it stay.
    pub struct AgentTemplateDelete;
    impl Op for AgentTemplateDelete {
        const NAME: &'static str = "agent.template.delete";
        type Input = t::AgentDeleteInput;
        type Result = ();
    }
    pub struct SkillList;
    impl Op for SkillList {
        const NAME: &'static str = "skill.list";
        type Input = ();
        type Result = Vec<t::Skill>;
    }
    /// Create allocates an identity; callers with an existing identity use save.
    pub struct SkillCreate;
    impl Op for SkillCreate {
        const NAME: &'static str = "skill.create";
        type Input = t::Skill;
        type Result = t::Skill;
    }
    pub struct SkillUpdate;
    impl Op for SkillUpdate {
        const NAME: &'static str = "skill.update";
        type Input = t::Skill;
        type Result = t::Skill;
    }
    pub struct SkillDelete;
    impl Op for SkillDelete {
        const NAME: &'static str = "skill.delete";
        type Input = t::SkillDeleteInput;
        type Result = ();
    }
    pub struct RuntimeList;
    impl Op for RuntimeList {
        const NAME: &'static str = "runtime.list";
        type Input = ();
        type Result = Vec<t::RuntimeInfo>;
    }
    pub struct RuntimeRefresh;
    impl Op for RuntimeRefresh {
        const NAME: &'static str = "runtime.refresh";
        type Input = t::RuntimeRefreshInput;
        type Result = t::RuntimeInfo;
    }
    pub struct RuntimeSettingUpdate;
    impl Op for RuntimeSettingUpdate {
        const NAME: &'static str = "runtime.setting.update";
        type Input = t::RuntimeSettingUpdateInput;
        type Result = t::RuntimeInfo;
    }
    pub struct RuntimeMcpList;
    impl Op for RuntimeMcpList {
        const NAME: &'static str = "runtime.mcp.list";
        type Input = t::McpListInput;
        type Result = t::McpListResult;
    }
    pub struct RuntimeMcpInstall;
    impl Op for RuntimeMcpInstall {
        const NAME: &'static str = "runtime.mcp.install";
        type Input = t::McpInstallInput;
        type Result = t::McpHostInfo;
    }
    pub struct RuntimeMcpUninstall;
    impl Op for RuntimeMcpUninstall {
        const NAME: &'static str = "runtime.mcp.uninstall";
        type Input = t::McpUninstallInput;
        type Result = t::McpHostInfo;
    }
    pub struct RuntimeMcpServerList;
    impl Op for RuntimeMcpServerList {
        const NAME: &'static str = "runtime.mcpServer.list";
        type Input = t::McpServerListInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerSave;
    impl Op for RuntimeMcpServerSave {
        const NAME: &'static str = "runtime.mcpServer.save";
        type Input = t::McpServerSaveInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerToggle;
    impl Op for RuntimeMcpServerToggle {
        const NAME: &'static str = "runtime.mcpServer.toggle";
        type Input = t::McpServerToggleInput;
        type Result = t::McpServerListResult;
    }
    pub struct RuntimeMcpServerRemove;
    impl Op for RuntimeMcpServerRemove {
        const NAME: &'static str = "runtime.mcpServer.remove";
        type Input = t::McpServerRemoveInput;
        type Result = t::McpServerListResult;
    }
    /// An agent's memories from the database and its configured sources.
    pub struct MemoryList;
    impl Op for MemoryList {
        const NAME: &'static str = "memory.list";
        type Input = t::MemoryListInput;
        type Result = t::MemoryList;
    }
    /// What the agent would recall for this repo and input.
    pub struct MemoryRecall;
    impl Op for MemoryRecall {
        const NAME: &'static str = "memory.recall";
        type Input = t::MemoryRecallInput;
        type Result = t::RecallPreview;
    }
    pub struct MemoryCreate;
    impl Op for MemoryCreate {
        const NAME: &'static str = "memory.create";
        type Input = t::MemoryCreateInput;
        type Result = t::Memory;
    }
    /// Memories whose words match, from every source the agent has; none named is every profile's.
    pub struct MemorySearch;
    impl Op for MemorySearch {
        const NAME: &'static str = "memory.search";
        type Input = t::MemorySearchInput;
        type Result = t::MemorySearch;
    }
    pub struct MemoryDelete;
    impl Op for MemoryDelete {
        const NAME: &'static str = "memory.delete";
        type Input = t::MemoryDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct MemoryPreviewDelete;
    impl Op for MemoryPreviewDelete {
        const NAME: &'static str = "memory.previewDelete";
        type Input = t::MemoryDeleteInput;
        type Result = t::Preview;
    }
    pub struct RepoPrSubmit;
    impl Op for RepoPrSubmit {
        const NAME: &'static str = "repo.pr.submit";
        type Input = t::SubmitBranch;
        type Result = t::BranchPublication;
    }
    pub struct GithubGet;
    impl Op for GithubGet {
        const NAME: &'static str = "github.get";
        type Input = ();
        type Result = t::GitHubStatus;
    }
    pub struct GithubRefresh;
    impl Op for GithubRefresh {
        const NAME: &'static str = "github.refresh";
        type Input = ();
        type Result = t::GitHubStatus;
    }
    pub struct RepoList;
    impl Op for RepoList {
        const NAME: &'static str = "repo.list";
        type Input = ();
        type Result = Vec<t::RepoSummary>;
    }
    /// The first thing Create would refuse in this repo, without making it.
    pub struct RepoValidate;
    impl Op for RepoValidate {
        const NAME: &'static str = "repo.validate";
        type Input = t::NewRepo;
        type Result = t::Validation;
    }
    pub struct RepoCreate;
    impl Op for RepoCreate {
        const NAME: &'static str = "repo.create";
        type Input = t::NewRepo;
        type Result = t::RepoSummary;
    }
    pub struct RepoMount;
    impl Op for RepoMount {
        const NAME: &'static str = "repo.mount";
        type Input = t::MountRepo;
        type Result = t::RepoSummary;
    }
    pub struct RepoUnmount;
    impl Op for RepoUnmount {
        const NAME: &'static str = "repo.unmount";
        type Input = t::RepoUnmountInput;
        type Result = ();
    }
    pub struct RepoLanguageList;
    impl Op for RepoLanguageList {
        const NAME: &'static str = "repo.language.list";
        type Input = t::RepoLanguageListInput;
        type Result = t::RepoLanguages;
    }
    pub struct RepoTemplateList;
    impl Op for RepoTemplateList {
        const NAME: &'static str = "repo.template.list";
        type Input = t::RepoTemplateListInput;
        type Result = t::RepoTemplates;
    }
    pub struct RepoActivityGet;
    impl Op for RepoActivityGet {
        const NAME: &'static str = "repo.activity.get";
        type Input = t::RepoActivityGetInput;
        type Result = t::RepoActivity;
    }
    /// Stops a session's turn; it stays, and a comment starts the next.
    pub struct SessionStop;
    impl Op for SessionStop {
        const NAME: &'static str = "session.stop";
        type Input = t::SessionStopInput;
        type Result = ();
    }
    pub struct SessionList;
    impl Op for SessionList {
        const NAME: &'static str = "session.list";
        type Input = t::SessionListInput;
        type Result = Vec<t::Session>;
    }
    pub struct SessionGet;
    impl Op for SessionGet {
        const NAME: &'static str = "session.get";
        type Input = t::SessionGetInput;
        type Result = t::Session;
    }
    /// Its log, oldest first. `run` narrows to one run; cursor fields page history.
    pub struct SessionEventList;
    impl Op for SessionEventList {
        const NAME: &'static str = "session.event.list";
        type Input = t::SessionEventListInput;
        type Result = t::SessionEventPage;
    }
    /// Opens or resumes a direct workspace chat session in a directory with no issue.
    pub struct SessionOpenWorkspace;
    impl Op for SessionOpenWorkspace {
        const NAME: &'static str = "session.openWorkspace";
        type Input = t::SessionOpenWorkspaceInput;
        type Result = t::SessionWorkspace;
    }
    /// Closes a direct workspace chat session, aborting any running turn without touching the project directory.
    pub struct SessionCloseWorkspace;
    impl Op for SessionCloseWorkspace {
        const NAME: &'static str = "session.closeWorkspace";
        type Input = t::SessionCloseWorkspaceInput;
        type Result = ();
    }
    /// Sends a user message to a workspace session (starts a turn when idle or steers when working).
    pub struct SessionSend;
    impl Op for SessionSend {
        const NAME: &'static str = "session.send";
        type Input = t::SessionSendInput;
        type Result = t::Session;
    }
    /// Answers a pending tool permission request for a session.
    pub struct SessionRespondPermission;
    impl Op for SessionRespondPermission {
        const NAME: &'static str = "session.respondPermission";
        type Input = t::SessionRespondPermissionInput;
        type Result = ();
    }
    /// Answers a pending interactive question from a session.
    pub struct SessionRespondInteraction;
    impl Op for SessionRespondInteraction {
        const NAME: &'static str = "session.respondInteraction";
        type Input = t::SessionRespondInteractionInput;
        type Result = ();
    }
    /// Updates model, effort, or permission mode on a workspace session.
    pub struct SessionSetConfig;
    impl Op for SessionSetConfig {
        const NAME: &'static str = "session.setConfig";
        type Input = t::SessionSetConfigInput;
        type Result = t::SessionWorkspace;
    }
    /// Reads bounded recent transcript steps for a child agent or swarm member.
    pub struct SessionChildTranscript;
    impl Op for SessionChildTranscript {
        const NAME: &'static str = "session.childTranscript";
        type Input = t::SessionChildTranscriptInput;
        type Result = t::SessionChildTranscript;
    }
    /// Manually triggers context compaction for a durable or runtime session.
    pub struct SessionCompact;
    impl Op for SessionCompact {
        const NAME: &'static str = "session.compact";
        type Input = t::SessionCompactInput;
        type Result = t::SessionCompactResult;
    }
    /// Executes a durable CodeMode JavaScript script in the session's tool context.
    pub struct SessionRunCode;
    impl Op for SessionRunCode {
        const NAME: &'static str = "session.runCode";
        type Input = t::SessionRunCodeInput;
        type Result = t::SessionRunCodeResult;
    }
    pub struct IssueConversationGet;
    impl Op for IssueConversationGet {
        const NAME: &'static str = "issue.conversation.get";
        type Input = t::IssueConversationGetInput;
        type Result = Option<String>;
    }
    /// To the issue's newest session, as the user: a comment is on the issue, not on one step. A closed issue is refused: reopen it.
    pub struct IssueCommentCreate;
    impl Op for IssueCommentCreate {
        const NAME: &'static str = "issue.comment.create";
        type Input = t::IssueCommentCreateInput;
        type Result = t::Applied;
    }
    pub struct IssueDiffGet;
    impl Op for IssueDiffGet {
        const NAME: &'static str = "issue.diff.get";
        type Input = t::IssueDiffGetInput;
        type Result = t::Changes;
    }
    /// One joined read of issues and their real sessions, including explicit missing records.
    pub struct IssueHistoryList;
    impl Op for IssueHistoryList {
        const NAME: &'static str = "issue.history.list";
        type Input = ();
        type Result = Vec<t::IssueHistory>;
    }
    /// The open issues by default, the newest first; the filter narrows them.
    pub struct IssueList;
    impl Op for IssueList {
        const NAME: &'static str = "issue.list";
        type Input = t::IssueFilter;
        type Result = Vec<t::Issue>;
    }
    /// A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done.
    pub struct IssueReview;
    impl Op for IssueReview {
        const NAME: &'static str = "issue.review";
        type Input = t::IssueReviewInput;
        type Result = t::Issue;
    }
    /// The issue becomes a parent issue and the split's issues its children, started at once.
    pub struct IssueSplit;
    impl Op for IssueSplit {
        const NAME: &'static str = "issue.split";
        type Input = t::IssueSplitInput;
        type Result = String;
    }
    pub struct IssueGet;
    impl Op for IssueGet {
        const NAME: &'static str = "issue.get";
        type Input = t::IssueGetInput;
        type Result = t::Issue;
    }
    pub struct IssueRunList;
    impl Op for IssueRunList {
        const NAME: &'static str = "issue.run.list";
        type Input = t::IssueRunListInput;
        type Result = Vec<t::Run>;
    }
    /// The issue's milestones, newest first, and what all its runs cost.
    pub struct IssueTimelineGet;
    impl Op for IssueTimelineGet {
        const NAME: &'static str = "issue.timeline.get";
        type Input = t::IssueTimelineGetInput;
        type Result = t::IssueTimeline;
    }
    pub struct IssueCreate;
    impl Op for IssueCreate {
        const NAME: &'static str = "issue.create";
        type Input = t::IssueRequest;
        type Result = t::AppliedIssue;
    }
    pub struct IssueUpdate;
    impl Op for IssueUpdate {
        const NAME: &'static str = "issue.update";
        type Input = t::IssueUpdateInput;
        type Result = t::AppliedIssue;
    }
    pub struct IssueDelete;
    impl Op for IssueDelete {
        const NAME: &'static str = "issue.delete";
        type Input = t::IssueDeleteInput;
        type Result = ();
    }
    /// What issue.delete would do, refused as it would be; nothing changes.
    pub struct IssuePreviewDelete;
    impl Op for IssuePreviewDelete {
        const NAME: &'static str = "issue.previewDelete";
        type Input = t::IssueDeleteInput;
        type Result = t::Preview;
    }
    /// Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is another round (the words are the findings.
    pub struct IssueStatusUpdate;
    impl Op for IssueStatusUpdate {
        const NAME: &'static str = "issue.status.update";
        type Input = t::IssueStatusUpdateInput;
        type Result = t::AppliedIssue;
    }
    /// What issue.status.update would do with the same body, refused as it would be; nothing changes.
    pub struct IssueStatusPreviewUpdate;
    impl Op for IssueStatusPreviewUpdate {
        const NAME: &'static str = "issue.status.previewUpdate";
        type Input = t::IssueStatusUpdateInput;
        type Result = t::Preview;
    }
    /// A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then leaves.
    pub struct IssueRefine;
    impl Op for IssueRefine {
        const NAME: &'static str = "issue.refine";
        type Input = t::IssueRefineInput;
        type Result = t::Issue;
    }
    /// Deterministic issue cycle-time and retro analytics for a time window.
    pub struct IssueRetroGet;
    impl Op for IssueRetroGet {
        const NAME: &'static str = "issue.retro.get";
        type Input = t::IssueRetroGetInput;
        type Result = t::IssueRetroReport;
    }
    /// Three-part morning digest combining overnight progress, repo health, and confirmable backlog triage.
    pub struct IssueDigestGet;
    impl Op for IssueDigestGet {
        const NAME: &'static str = "issue.digest.get";
        type Input = t::IssueDigestGetInput;
        type Result = t::MorningDigest;
    }
    /// Pending backlog triage suggestions awaiting explicit user confirmation.
    pub struct IssueTriageList;
    impl Op for IssueTriageList {
        const NAME: &'static str = "issue.triage.list";
        type Input = ();
        type Result = Vec<t::BacklogTriageSuggestion>;
    }
    /// Proposes a non-destructive triage suggestion for a backlog issue without overwriting its fields.
    pub struct IssueTriageSuggest;
    impl Op for IssueTriageSuggest {
        const NAME: &'static str = "issue.triage.suggest";
        type Input = t::BacklogTriageSuggestInput;
        type Result = t::BacklogTriageSuggestion;
    }
    /// Applies a pending backlog triage suggestion after explicit user click/confirmation.
    pub struct IssueTriageConfirm;
    impl Op for IssueTriageConfirm {
        const NAME: &'static str = "issue.triage.confirm";
        type Input = t::BacklogTriageConfirmInput;
        type Result = t::AppliedIssue;
    }
    /// Dismisses a pending backlog triage suggestion without modifying the issue.
    pub struct IssueTriageDismiss;
    impl Op for IssueTriageDismiss {
        const NAME: &'static str = "issue.triage.dismiss";
        type Input = t::BacklogTriageDismissInput;
        type Result = ();
    }
    pub struct CronCreate;
    impl Op for CronCreate {
        const NAME: &'static str = "cron.create";
        type Input = t::CronRequest;
        type Result = t::Cron;
    }
    pub struct CronList;
    impl Op for CronList {
        const NAME: &'static str = "cron.list";
        type Input = ();
        type Result = Vec<t::Cron>;
    }
    /// Only what the body gives changes.
    pub struct CronUpdate;
    impl Op for CronUpdate {
        const NAME: &'static str = "cron.update";
        type Input = t::CronUpdateInput;
        type Result = ();
    }
    pub struct CronDelete;
    impl Op for CronDelete {
        const NAME: &'static str = "cron.delete";
        type Input = t::CronDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct CronPreviewDelete;
    impl Op for CronPreviewDelete {
        const NAME: &'static str = "cron.previewDelete";
        type Input = t::CronDeleteInput;
        type Result = t::Preview;
    }
    pub struct ChannelMessageSend;
    impl Op for ChannelMessageSend {
        const NAME: &'static str = "channel.message.send";
        type Input = t::SayRequest;
        type Result = ();
    }
    pub struct ChannelCreate;
    impl Op for ChannelCreate {
        const NAME: &'static str = "channel.create";
        type Input = t::ChannelRequest;
        type Result = String;
    }
    pub struct ChannelUpdate;
    impl Op for ChannelUpdate {
        const NAME: &'static str = "channel.update";
        type Input = t::ChannelUpdateInput;
        type Result = ();
    }
    /// What deleteTask would do, refused as it would be; nothing changes.
    pub struct ChannelMessageList;
    impl Op for ChannelMessageList {
        const NAME: &'static str = "channel.message.list";
        type Input = t::ChannelMessageListInput;
        type Result = Vec<t::ChatMessage>;
    }
    pub struct ChannelMarkRead;
    impl Op for ChannelMarkRead {
        const NAME: &'static str = "channel.markRead";
        type Input = t::ChannelMarkReadInput;
        type Result = ();
    }
    /// The user's own words, changed; nobody is told again.
    pub struct ChannelMessageUpdate;
    impl Op for ChannelMessageUpdate {
        const NAME: &'static str = "channel.message.update";
        type Input = t::MessageEdit;
        type Result = t::ChatMessage;
    }
    /// Any message: its words go, its number stays, and what it still had to hand is dropped.
    pub struct ChannelMessageDelete;
    impl Op for ChannelMessageDelete {
        const NAME: &'static str = "channel.message.delete";
        type Input = t::ChannelMessageDeleteInput;
        type Result = ();
    }
    /// What channel.message.delete would do, refused as it would be; nothing changes.
    pub struct ChannelMessagePreviewDelete;
    impl Op for ChannelMessagePreviewDelete {
        const NAME: &'static str = "channel.message.previewDelete";
        type Input = t::ChannelMessageDeleteInput;
        type Result = t::Preview;
    }
    pub struct ChannelMessageSearch;
    impl Op for ChannelMessageSearch {
        const NAME: &'static str = "channel.message.search";
        type Input = t::MessageSearch;
        type Result = Vec<t::MessageHit>;
    }
    /// The user's reaction on or off; as it already is, nothing changes.
    pub struct ChannelReactionSet;
    impl Op for ChannelReactionSet {
        const NAME: &'static str = "channel.reaction.set";
        type Input = t::ReactionSet;
        type Result = t::ChatMessage;
    }
    /// The message pinned or not; as it already is, nothing changes.
    pub struct ChannelPinSet;
    impl Op for ChannelPinSet {
        const NAME: &'static str = "channel.pin.set";
        type Input = t::ChannelPinSetInput;
        type Result = t::ChatMessage;
    }
    /// A channel's pinned messages, newest pinned first.
    pub struct ChannelPinList;
    impl Op for ChannelPinList {
        const NAME: &'static str = "channel.pin.list";
        type Input = t::ChannelPinListInput;
        type Result = Vec<t::ChatMessage>;
    }
    /// The thread under a message, made if it has none: its id. requestKey: as IssueRequest's.
    pub struct ChannelThreadCreate;
    impl Op for ChannelThreadCreate {
        const NAME: &'static str = "channel.thread.create";
        type Input = t::ChannelThreadCreateInput;
        type Result = String;
    }
    /// Out of the sidebar and the thread lists (on), or back. its messages and address stay.
    pub struct ChannelArchiveSet;
    impl Op for ChannelArchiveSet {
        const NAME: &'static str = "channel.archive.set";
        type Input = t::OnSet;
        type Result = ();
    }
    /// A channel nothing points at any more, with its threads and messages.
    pub struct ChannelDelete;
    impl Op for ChannelDelete {
        const NAME: &'static str = "channel.delete";
        type Input = t::ChannelPinListInput;
        type Result = ();
    }
    /// What channel.delete would do, refused as it would be; nothing changes.
    pub struct ChannelPreviewDelete;
    impl Op for ChannelPreviewDelete {
        const NAME: &'static str = "channel.previewDelete";
        type Input = t::ChannelPinListInput;
        type Result = t::Preview;
    }
    /// The user's direct channel with a helper profile (or the orchestrator), made if there is none: its id.
    pub struct ChannelDirectCreate;
    impl Op for ChannelDirectCreate {
        const NAME: &'static str = "channel.direct.create";
        type Input = t::ChannelDirectCreateInput;
        type Result = String;
    }
    pub struct ChannelNotifySet;
    impl Op for ChannelNotifySet {
        const NAME: &'static str = "channel.notify.set";
        type Input = t::NotifyRequest;
        type Result = ();
    }
    /// The user's read moved back to just before this message.
    pub struct ChannelMarkUnread;
    impl Op for ChannelMarkUnread {
        const NAME: &'static str = "channel.markUnread";
        type Input = t::ChannelMarkUnreadInput;
        type Result = ();
    }
    /// Every channel and direct channel, the default first.
    pub struct ChannelList;
    impl Op for ChannelList {
        const NAME: &'static str = "channel.list";
        type Input = ();
        type Result = Vec<t::Channel>;
    }
    /// The places the caller has not read all of, the newest first.
    pub struct ChannelUnreadList;
    impl Op for ChannelUnreadList {
        const NAME: &'static str = "channel.unread.list";
        type Input = ();
        type Result = Vec<t::ChannelUnread>;
    }
    pub struct ConnectorLogin;
    impl Op for ConnectorLogin {
        const NAME: &'static str = "connector.login";
        type Input = t::ConnectorLoginInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorVerify;
    impl Op for ConnectorVerify {
        const NAME: &'static str = "connector.verify";
        type Input = t::ConnectorVerifyInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorLogout;
    impl Op for ConnectorLogout {
        const NAME: &'static str = "connector.logout";
        type Input = t::ConnectorLogoutInput;
        type Result = t::ConnectorStatus;
    }
    pub struct ConnectorChannelSet;
    impl Op for ConnectorChannelSet {
        const NAME: &'static str = "connector.channel.set";
        type Input = t::ConnectorChannelSetInput;
        type Result = t::ConnectorStatus;
    }
    pub struct MediaDialogueCreate;
    impl Op for MediaDialogueCreate {
        const NAME: &'static str = "media.dialogue.create";
        type Input = t::MediaSpeakersRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaVoiceDesignCreate;
    impl Op for MediaVoiceDesignCreate {
        const NAME: &'static str = "media.voiceDesign.create";
        type Input = t::MediaVoiceDesignRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaCloneCreate;
    impl Op for MediaCloneCreate {
        const NAME: &'static str = "media.clone.create";
        type Input = t::MediaCloneRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaTranscriptionCreate;
    impl Op for MediaTranscriptionCreate {
        const NAME: &'static str = "media.transcription.create";
        type Input = t::MediaTranscriptionRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaAudioResume;
    impl Op for MediaAudioResume {
        const NAME: &'static str = "media.audio.resume";
        type Input = t::MediaJobRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaAudioPreviewCleanup;
    impl Op for MediaAudioPreviewCleanup {
        const NAME: &'static str = "media.audio.previewCleanup";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaAudioCleanup;
    impl Op for MediaAudioCleanup {
        const NAME: &'static str = "media.audio.cleanup";
        type Input = t::MediaJobRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaInputCreate;
    impl Op for MediaInputCreate {
        const NAME: &'static str = "media.input.create";
        type Input = t::MediaInputRequest;
        type Result = t::MediaInput;
    }
    /// A kept attachment (a library item) taken as an input, checked as an upload is.
    pub struct MediaInputAdopt;
    impl Op for MediaInputAdopt {
        const NAME: &'static str = "media.input.adopt";
        type Input = t::MediaInputAdoptInput;
        type Result = t::MediaInput;
    }
    pub struct MediaInputList;
    impl Op for MediaInputList {
        const NAME: &'static str = "media.input.list";
        type Input = ();
        type Result = Vec<t::MediaInput>;
    }
    pub struct MediaInputDelete;
    impl Op for MediaInputDelete {
        const NAME: &'static str = "media.input.delete";
        type Input = t::MediaJobRequest;
        type Result = ();
    }
    pub struct MediaInputPreviewDelete;
    impl Op for MediaInputPreviewDelete {
        const NAME: &'static str = "media.input.previewDelete";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaImageCreate;
    impl Op for MediaImageCreate {
        const NAME: &'static str = "media.image.create";
        type Input = t::MediaImageRequest;
        type Result = t::MediaImageJob;
    }
    pub struct MediaUnderstandingCreate;
    impl Op for MediaUnderstandingCreate {
        const NAME: &'static str = "media.understanding.create";
        type Input = t::MediaUnderstandingRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaUnderstandingAuthorize;
    impl Op for MediaUnderstandingAuthorize {
        const NAME: &'static str = "media.understanding.authorize";
        type Input = t::MediaUnderstandingAuthorizationRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaUnderstandingStart;
    impl Op for MediaUnderstandingStart {
        const NAME: &'static str = "media.understanding.start";
        type Input = t::MediaJobRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaSpeechCreate;
    impl Op for MediaSpeechCreate {
        const NAME: &'static str = "media.speech.create";
        type Input = t::MediaSpeechRequest;
        type Result = t::MediaSpeechJob;
    }
    pub struct MediaSpeechResume;
    impl Op for MediaSpeechResume {
        const NAME: &'static str = "media.speech.resume";
        type Input = t::MediaJobRequest;
        type Result = t::MediaSpeechJob;
    }
    pub struct MediaUnderstandingCleanup;
    impl Op for MediaUnderstandingCleanup {
        const NAME: &'static str = "media.understanding.cleanup";
        type Input = t::MediaJobRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaJobGet;
    impl Op for MediaJobGet {
        const NAME: &'static str = "media.job.get";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobCancel;
    impl Op for MediaJobCancel {
        const NAME: &'static str = "media.job.cancel";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobPreviewRelease;
    impl Op for MediaJobPreviewRelease {
        const NAME: &'static str = "media.job.previewRelease";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaJobRelease;
    impl Op for MediaJobRelease {
        const NAME: &'static str = "media.job.release";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobDownload;
    impl Op for MediaJobDownload {
        const NAME: &'static str = "media.job.download";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobList;
    impl Op for MediaJobList {
        const NAME: &'static str = "media.job.list";
        type Input = ();
        type Result = Vec<t::MediaJob>;
    }
    /// Newest first.
    pub struct LibraryItemList;
    impl Op for LibraryItemList {
        const NAME: &'static str = "library.item.list";
        type Input = t::LibraryListRequest;
        type Result = t::LibraryItems;
    }
    pub struct LibraryItemAdd;
    impl Op for LibraryItemAdd {
        const NAME: &'static str = "library.item.add";
        type Input = t::LibraryAddRequest;
        type Result = t::LibraryItem;
    }
    /// Only the item goes: a message that has the file still opens it.
    pub struct LibraryItemDelete;
    impl Op for LibraryItemDelete {
        const NAME: &'static str = "library.item.delete";
        type Input = t::LibraryItemDeleteInput;
        type Result = ();
    }
    pub struct LibraryItemPreviewDelete;
    impl Op for LibraryItemPreviewDelete {
        const NAME: &'static str = "library.item.previewDelete";
        type Input = t::LibraryItemDeleteInput;
        type Result = t::Preview;
    }
    /// A line heard on the call that is on, without its id: refused unless one call is.
    pub struct VoiceHear;
    impl Op for VoiceHear {
        const NAME: &'static str = "voice.hear";
        type Input = t::VoiceHearInput;
        type Result = ();
    }
    /// Whether MOSS Live takes the key: a session is attached and closed again, nothing is said.
    pub struct VoiceMossVerify;
    impl Op for VoiceMossVerify {
        const NAME: &'static str = "voice.moss.verify";
        type Input = ();
        type Result = t::Validation;
    }
    pub struct VoiceGrantCreate;
    impl Op for VoiceGrantCreate {
        const NAME: &'static str = "voice.grant.create";
        type Input = ();
        type Result = t::VoiceGrant;
    }
    pub struct VoiceCallStart;
    impl Op for VoiceCallStart {
        const NAME: &'static str = "voice.call.start";
        type Input = t::VoiceCallStart;
        type Result = t::VoiceCall;
    }
    pub struct VoiceCallStop;
    impl Op for VoiceCallStop {
        const NAME: &'static str = "voice.call.stop";
        type Input = t::VoiceCall;
        type Result = ();
    }
    pub struct VoiceCallHear;
    impl Op for VoiceCallHear {
        const NAME: &'static str = "voice.call.hear";
        type Input = t::VoiceHeard;
        type Result = ();
    }
    pub struct VoiceCallSay;
    impl Op for VoiceCallSay {
        const NAME: &'static str = "voice.call.say";
        type Input = t::VoiceSaid;
        type Result = ();
    }
    pub struct VoiceAsrStart;
    impl Op for VoiceAsrStart {
        const NAME: &'static str = "voice.asr.start";
        type Input = ();
        type Result = t::VoiceAsrGrant;
    }
    pub struct VoiceAsrStop;
    impl Op for VoiceAsrStop {
        const NAME: &'static str = "voice.asr.stop";
        type Input = t::VoiceAsrStopInput;
        type Result = ();
    }
    pub struct VoiceAsrTranscribe;
    impl Op for VoiceAsrTranscribe {
        const NAME: &'static str = "voice.asr.transcribe";
        type Input = t::VoiceAsrTranscribeInput;
        type Result = t::VoiceAsrResult;
    }
    /// The notes announced in a channel or made for an issue, newest change first; every one the workspace has when neither is given.
    pub struct NoteList;
    impl Op for NoteList {
        const NAME: &'static str = "note.list";
        type Input = t::NoteListRequest;
        type Result = Vec<t::Note>;
    }
    pub struct NoteGet;
    impl Op for NoteGet {
        const NAME: &'static str = "note.get";
        type Input = t::NoteGetInput;
        type Result = t::Note;
    }
    /// Reads the note's primary entry file content (optionally at a historical version snapshot).
    pub struct NoteContentGet;
    impl Op for NoteContentGet {
        const NAME: &'static str = "note.content.get";
        type Input = t::NoteReadRequest;
        type Result = t::NoteContent;
    }
    /// Creates a new directory-backed note seeded with starter files for its `note_type`.
    pub struct NoteCreate;
    impl Op for NoteCreate {
        const NAME: &'static str = "note.create";
        type Input = t::NoteRequest;
        type Result = t::Note;
    }
    /// Cuts a new immutable directory snapshot version over the latest state.
    pub struct NoteVersionCreate;
    impl Op for NoteVersionCreate {
        const NAME: &'static str = "note.version.create";
        type Input = t::NoteVersionRequest;
        type Result = t::Note;
    }
    /// Updates a note's title, tree placement, or linked issue.
    pub struct NoteUpdate;
    impl Op for NoteUpdate {
        const NAME: &'static str = "note.update";
        type Input = t::NoteUpdateRequest;
        type Result = t::Note;
    }
    pub struct NoteDelete;
    impl Op for NoteDelete {
        const NAME: &'static str = "note.delete";
        type Input = t::NoteDeleteInput;
        type Result = ();
    }
    pub struct NotePreviewDelete;
    impl Op for NotePreviewDelete {
        const NAME: &'static str = "note.previewDelete";
        type Input = t::NoteDeleteInput;
        type Result = t::Preview;
    }
    /// Moves a note in the workspace page tree (`parent_id`, `sort_order`).
    pub struct NoteTreeMove;
    impl Op for NoteTreeMove {
        const NAME: &'static str = "note.tree.move";
        type Input = t::NoteTreeMoveRequest;
        type Result = t::Note;
    }
    /// Lists outgoing links and incoming backlinks for a note or issue.
    pub struct NoteLinkList;
    impl Op for NoteLinkList {
        const NAME: &'static str = "note.link.list";
        type Input = t::NoteLinkListRequest;
        type Result = t::NoteLinkListResult;
    }
    /// Projects a `doc` note into strongly-typed `DocView` blocks, counts, and extracted links.
    pub struct NoteDocView;
    impl Op for NoteDocView {
        const NAME: &'static str = "note.doc.view";
        type Input = t::NoteDocViewRequest;
        type Result = t::DocView;
    }
    /// Appends a strongly-typed `DocBlock` into a `doc` note.
    pub struct NoteDocAppendBlock;
    impl Op for NoteDocAppendBlock {
        const NAME: &'static str = "note.doc.appendBlock";
        type Input = t::NoteDocAppendBlockRequest;
        type Result = t::DocView;
    }
    /// Projects a `base` note into filtered/sorted/grouped `BaseViewSnapshot`.
    pub struct NoteBaseView;
    impl Op for NoteBaseView {
        const NAME: &'static str = "note.base.view";
        type Input = t::BaseViewRequest;
        type Result = t::BaseViewSnapshot;
    }
    /// Creates or updates a row in a `base` note and returns the refreshed view snapshot.
    pub struct NoteBaseUpsertRow;
    impl Op for NoteBaseUpsertRow {
        const NAME: &'static str = "note.base.upsertRow";
        type Input = t::BaseUpsertRowRequest;
        type Result = t::BaseViewSnapshot;
    }
    /// Runs an `agentAction` column across selected rows of a `base` note.
    pub struct NoteBaseRunAgentColumn;
    impl Op for NoteBaseRunAgentColumn {
        const NAME: &'static str = "note.base.runAgentColumn";
        type Input = t::BaseRunAgentColumnRequest;
        type Result = t::BaseRunAgentColumnResult;
    }
    /// All 4 note primitives (`doc`, `base`, `canvas`, `media`).
    pub struct NoteTypeList;
    impl Op for NoteTypeList {
        const NAME: &'static str = "note.type.list";
        type Input = ();
        type Result = Vec<t::NoteTypeInfo>;
    }
    /// A note type's SKILL.md guide or one of its named reference chapters.
    pub struct NoteTypeRead;
    impl Op for NoteTypeRead {
        const NAME: &'static str = "note.type.read";
        type Input = t::NoteTypeReadRequest;
        type Result = t::NoteTypeGuide;
    }
    /// Lists files (`manifest.json`, `structure/*`, `asset/*`) inside a note directory.
    pub struct NoteFileList;
    impl Op for NoteFileList {
        const NAME: &'static str = "note.file.list";
        type Input = t::NoteFileListRequest;
        type Result = t::NoteFileListResult;
    }
    /// Reads one file by relative path inside a note directory (or historical version snapshot).
    pub struct NoteFileGet;
    impl Op for NoteFileGet {
        const NAME: &'static str = "note.file.get";
        type Input = t::NoteFileGetRequest;
        type Result = t::NoteFileContent;
    }
    /// Atomically writes one or more files into `structure/` or `asset/` with origin attribution and collab sync.
    pub struct NoteFileWrite;
    impl Op for NoteFileWrite {
        const NAME: &'static str = "note.file.write";
        type Input = t::NoteFileWriteRequest;
        type Result = t::NoteFileWriteResult;
    }
    /// Deletes a relative path under `structure/` or `asset/` with origin attribution and collab sync.
    pub struct NoteFileDelete;
    impl Op for NoteFileDelete {
        const NAME: &'static str = "note.file.delete";
        type Input = t::NoteFileDeleteRequest;
        type Result = t::NoteFileDeleteResult;
    }
    /// The open and resolved suggestions on a note, oldest first.
    pub struct NoteSuggestionList;
    impl Op for NoteSuggestionList {
        const NAME: &'static str = "note.suggestion.list";
        type Input = t::NoteSuggestionListInput;
        type Result = Vec<t::Suggestion>;
    }
    /// A proposed edit to a file or structured target inside a note directory.
    pub struct NoteSuggestionCreate;
    impl Op for NoteSuggestionCreate {
        const NAME: &'static str = "note.suggestion.create";
        type Input = t::NoteSuggestionCreateInput;
        type Result = t::Suggestion;
    }
    /// Accepts a pending suggestion and applies it to the note directory and collab state.
    pub struct NoteSuggestionAccept;
    impl Op for NoteSuggestionAccept {
        const NAME: &'static str = "note.suggestion.accept";
        type Input = t::NoteSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    pub struct NoteSuggestionReject;
    impl Op for NoteSuggestionReject {
        const NAME: &'static str = "note.suggestion.reject";
        type Input = t::NoteSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    /// Ephemeral live presence update (cursor, selection, highlight, viewport); never persisted to SQLite.
    pub struct NotePresenceUpdate;
    impl Op for NotePresenceUpdate {
        const NAME: &'static str = "note.presence.update";
        type Input = t::NotePresenceUpdateRequest;
        type Result = ();
    }
    /// Commit history timeline for a collaborative note, newest first.
    pub struct NoteHistoryList;
    impl Op for NoteHistoryList {
        const NAME: &'static str = "note.history.list";
        type Input = t::NoteHistoryListRequest;
        type Result = Vec<t::NoteHistoryEntry>;
    }
    /// Read-only snapshot projection at the requested Loro frontiers.
    pub struct NoteHistoryPreview;
    impl Op for NoteHistoryPreview {
        const NAME: &'static str = "note.history.preview";
        type Input = t::NoteHistoryPreviewRequest;
        type Result = t::NoteHistoryPreviewResult;
    }
    /// Restore a note to the snapshot at the requested Loro frontiers as a new commit.
    pub struct NoteHistoryRestore;
    impl Op for NoteHistoryRestore {
        const NAME: &'static str = "note.history.restore";
        type Input = t::NoteHistoryRestoreRequest;
        type Result = t::Note;
    }
    /// Fork a new note starting from the snapshot at the requested Loro frontiers.
    pub struct NoteHistoryFork;
    impl Op for NoteHistoryFork {
        const NAME: &'static str = "note.history.fork";
        type Input = t::NoteHistoryForkRequest;
        type Result = t::Note;
    }
    /// Selectively undo commits matching one origin while preserving concurrent edits from other actors.
    pub struct NoteHistoryUndoOrigin;
    impl Op for NoteHistoryUndoOrigin {
        const NAME: &'static str = "note.history.undoOrigin";
        type Input = t::NoteHistoryUndoOriginRequest;
        type Result = t::Note;
    }
    /// Compact old operation history into a shallow snapshot while keeping current state intact.
    pub struct NoteHistoryCompact;
    impl Op for NoteHistoryCompact {
        const NAME: &'static str = "note.history.compact";
        type Input = t::NoteHistoryCompactRequest;
        type Result = t::Note;
    }
    /// Export incremental Loro CRDT updates (or snapshot) relative to a client VersionVector.
    pub struct NoteCollabExport;
    impl Op for NoteCollabExport {
        const NAME: &'static str = "note.collab.export";
        type Input = t::NoteCollabExportRequest;
        type Result = t::NoteCollabExportResult;
    }
    /// Import incremental Loro CRDT updates (or snapshot) into a note and optionally return missing server updates.
    pub struct NoteCollabImport;
    impl Op for NoteCollabImport {
        const NAME: &'static str = "note.collab.import";
        type Input = t::NoteCollabImportRequest;
        type Result = t::NoteCollabImportResult;
    }
    /// Saves a derived auto-captured cover image outside the note directory and CRDT.
    pub struct NoteCoverSet;
    impl Op for NoteCoverSet {
        const NAME: &'static str = "note.cover.set";
        type Input = t::NoteCoverSetRequest;
        type Result = t::NoteCover;
    }
    pub struct ProviderGet;
    impl Op for ProviderGet {
        const NAME: &'static str = "provider.get";
        type Input = ();
        type Result = t::ProviderStatus;
    }
    pub struct ProviderUpdate;
    impl Op for ProviderUpdate {
        const NAME: &'static str = "provider.update";
        type Input = t::ProviderUpdate;
        type Result = t::ProviderStatus;
    }
    pub struct ProviderVoiceList;
    impl Op for ProviderVoiceList {
        const NAME: &'static str = "provider.voice.list";
        type Input = t::ProviderVoiceRequest;
        type Result = t::ProviderVoiceListing;
    }
    pub struct ProviderModelList;
    impl Op for ProviderModelList {
        const NAME: &'static str = "provider.model.list";
        type Input = t::ProviderModelRequest;
        type Result = t::ProviderModelListing;
    }
    pub struct SettingGet;
    impl Op for SettingGet {
        const NAME: &'static str = "setting.get";
        type Input = ();
        type Result = t::SettingsStatus;
    }
    /// The first thing Save would refuse in these settings, without saving them.
    pub struct SettingValidate;
    impl Op for SettingValidate {
        const NAME: &'static str = "setting.validate";
        type Input = t::SettingsUpdate;
        type Result = t::Validation;
    }
    pub struct SettingUpdate;
    impl Op for SettingUpdate {
        const NAME: &'static str = "setting.update";
        type Input = t::SettingsUpdate;
        type Result = t::SettingsStatus;
    }
    /// Only on this machine: never through the gate.
    /// Takes back the key the request came with.
    /// What deleting the device would do, refused as it would be; nothing changes.
    /// A device asks to be signed in (the command line's auth login); no key needed.
    /// The asking device collects its key once approved; no key needed, the claim is its proof.
    /// What stopPairing would do, refused as it would be; nothing changes.
    pub struct OrchestratorOpen;
    impl Op for OrchestratorOpen {
        const NAME: &'static str = "orchestrator.open";
        type Input = ();
        type Result = ();
    }
    /// Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working.
    pub struct OrchestratorStop;
    impl Op for OrchestratorStop {
        const NAME: &'static str = "orchestrator.stop";
        type Input = t::OrchestratorStopInput;
        type Result = ();
    }
    /// Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done.
    pub struct OrchestratorEvalCreate;
    impl Op for OrchestratorEvalCreate {
        const NAME: &'static str = "orchestrator.eval.create";
        type Input = t::OrchestratorEvalRequest;
        type Result = t::OrchestratorEval;
    }
    pub struct OrchestratorApprovalList;
    impl Op for OrchestratorApprovalList {
        const NAME: &'static str = "orchestrator.approval.list";
        type Input = t::OrchestratorApprovalListInput;
        type Result = Vec<t::OrchestratorApproval>;
    }
    pub struct OrchestratorApprovalResolve;
    impl Op for OrchestratorApprovalResolve {
        const NAME: &'static str = "orchestrator.approval.resolve";
        type Input = t::OrchestratorApprovalResolveInput;
        type Result = ();
    }
    /// Kept once by its bytes: the same file again is the same attachment.
    pub struct AttachmentCreate;
    impl Op for AttachmentCreate {
        const NAME: &'static str = "attachment.create";
        type Input = t::AttachmentUpload;
        type Result = t::Attachment;
    }
    /// Local regular file imported directly into CAS without base64 framing (`Caller::User` only).
    pub struct AttachmentImportPath;
    impl Op for AttachmentImportPath {
        const NAME: &'static str = "attachment.importPath";
        type Input = t::AttachmentImportPathInput;
        type Result = t::Attachment;
    }
    pub struct ServerHealthGet;
    impl Op for ServerHealthGet {
        const NAME: &'static str = "server.health.get";
        type Input = ();
        type Result = t::Health;
    }
    pub struct DebugSnapshot;
    impl Op for DebugSnapshot {
        const NAME: &'static str = "debug.snapshot";
        type Input = ();
        type Result = t::DebugSnapshot;
    }
    pub struct DebugTimelineList;
    impl Op for DebugTimelineList {
        const NAME: &'static str = "debug.timeline.list";
        type Input = t::DebugTimelineQuery;
        type Result = t::DebugTimelinePage;
    }
    pub struct DebugTimelineClear;
    impl Op for DebugTimelineClear {
        const NAME: &'static str = "debug.timeline.clear";
        type Input = ();
        type Result = ();
    }
    pub struct DebugTrajectoryList;
    impl Op for DebugTrajectoryList {
        const NAME: &'static str = "debug.trajectory.list";
        type Input = ();
        type Result = Vec<t::DebugTrajectorySummary>;
    }
    pub struct DebugTrajectoryGet;
    impl Op for DebugTrajectoryGet {
        const NAME: &'static str = "debug.trajectory.get";
        type Input = t::DebugTrajectoryGetRequest;
        type Result = t::DebugTrajectoryDetail;
    }
    pub struct DebugTrajectoryExport;
    impl Op for DebugTrajectoryExport {
        const NAME: &'static str = "debug.trajectory.export";
        type Input = t::DebugTrajectoryExportRequest;
        type Result = t::DebugTrajectoryExportResult;
    }
    pub struct DebugOverrideSet;
    impl Op for DebugOverrideSet {
        const NAME: &'static str = "debug.override.set";
        type Input = t::DebugOverrideConfig;
        type Result = t::DebugOverrideConfig;
    }
    pub struct DebugBundleExport;
    impl Op for DebugBundleExport {
        const NAME: &'static str = "debug.bundle.export";
        type Input = ();
        type Result = t::DebugBundleResult;
    }
    pub struct RemoteStatus;
    impl Op for RemoteStatus {
        const NAME: &'static str = "remote.status";
        type Input = ();
        type Result = t::RemoteStatus;
    }
    pub struct RemoteEnable;
    impl Op for RemoteEnable {
        const NAME: &'static str = "remote.enable";
        type Input = t::RemoteEnableRequest;
        type Result = t::RemoteStatus;
    }
    pub struct RemoteDisable;
    impl Op for RemoteDisable {
        const NAME: &'static str = "remote.disable";
        type Input = ();
        type Result = t::RemoteStatus;
    }
    pub struct RemotePairCreate;
    impl Op for RemotePairCreate {
        const NAME: &'static str = "remote.pair.create";
        type Input = ();
        type Result = t::RemotePairCode;
    }
    pub struct RemotePairExchange;
    impl Op for RemotePairExchange {
        const NAME: &'static str = "remote.pair.exchange";
        type Input = t::RemotePairExchangeRequest;
        type Result = t::RemotePairExchangeResult;
    }
    pub struct RemoteDeviceRevoke;
    impl Op for RemoteDeviceRevoke {
        const NAME: &'static str = "remote.device.revoke";
        type Input = t::RemoteDeviceRevokeRequest;
        type Result = ();
    }
    pub struct RemoteWhoami;
    impl Op for RemoteWhoami {
        const NAME: &'static str = "remote.whoami";
        type Input = ();
        type Result = t::RemoteWhoami;
    }
    pub struct MachineList;
    impl Op for MachineList {
        const NAME: &'static str = "machine.list";
        type Input = ();
        type Result = Vec<t::MachineInfo>;
    }
    pub struct GameShopList;
    impl Op for GameShopList {
        const NAME: &'static str = "game.shop.list";
        type Input = ();
        type Result = t::FarmShopView;
    }
    pub struct GameShopBuy;
    impl Op for GameShopBuy {
        const NAME: &'static str = "game.shop.buy";
        type Input = t::ShopPurchaseRequest;
        type Result = t::FarmShopView;
    }
    pub struct GameDailyList;
    impl Op for GameDailyList {
        const NAME: &'static str = "game.daily.list";
        type Input = ();
        type Result = t::DailyTaskBoard;
    }
}

/// Every server subscription, naming who may subscribe (`can`) and its wire payload/event types.
pub const SUBSCRIPTIONS: &[SubscriptionSpec] = &[
    SubscriptionSpec {
        name: "channel.follow",
        module: "channel",
        can: &[Caller::User, Caller::Remote],
        payload: "ChannelFollowPayload",
        event: "ChannelEvent",
    },
    SubscriptionSpec {
        name: "channel.reports",
        module: "channel",
        can: &[Caller::User, Caller::Remote],
        payload: "ChannelReportsPayload",
        event: "ChannelEvent",
    },
    SubscriptionSpec {
        name: "note.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NoteFollowPayload",
        event: "NoteEvent",
    },
    SubscriptionSpec {
        name: "note.suggestion.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NoteSuggestionFollowPayload",
        event: "SuggestionEvent",
    },
    SubscriptionSpec {
        name: "note.presence.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NotePresenceFollowRequest",
        event: "NotePresenceEvent",
    },
    SubscriptionSpec {
        name: "session.watch",
        module: "session",
        can: &[Caller::User, Caller::Remote],
        payload: "SessionWatchPayload",
        event: "SessionWatchEvent",
    },
    SubscriptionSpec {
        name: "issue.watch",
        module: "issue",
        can: &[Caller::User, Caller::Remote],
        payload: "IssueGetInput",
        event: "IssueWatch",
    },
];

/// Subscriptions as types: each one's name, allowed callers, payload, and event.
pub mod subscriptions {
    use super::t;
    use crate::wire::{Caller, Subscription};

    pub struct ChannelFollow;
    impl Subscription for ChannelFollow {
        const NAME: &'static str = "channel.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::ChannelFollowPayload;
        type Event = t::ChannelEvent;
    }
    pub struct ChannelReports;
    impl Subscription for ChannelReports {
        const NAME: &'static str = "channel.reports";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::ChannelReportsPayload;
        type Event = t::ChannelEvent;
    }
    pub struct NoteFollow;
    impl Subscription for NoteFollow {
        const NAME: &'static str = "note.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NoteFollowPayload;
        type Event = t::NoteEvent;
    }
    pub struct NoteSuggestionFollow;
    impl Subscription for NoteSuggestionFollow {
        const NAME: &'static str = "note.suggestion.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NoteSuggestionFollowPayload;
        type Event = t::SuggestionEvent;
    }
    pub struct NotePresenceFollow;
    impl Subscription for NotePresenceFollow {
        const NAME: &'static str = "note.presence.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NotePresenceFollowRequest;
        type Event = t::NotePresenceEvent;
    }
    pub struct SessionWatch;
    impl Subscription for SessionWatch {
        const NAME: &'static str = "session.watch";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::SessionWatchPayload;
        type Event = t::SessionWatchEvent;
    }
    pub struct IssueWatch;
    impl Subscription for IssueWatch {
        const NAME: &'static str = "issue.watch";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::IssueGetInput;
        type Event = t::IssueWatch;
    }
}

macro_rules! endpoint_ids {
    ($($variant:ident => $op:literal),* $(,)?) => {
        /// Compile-time exhaustive identifier for every endpoint in [`ENDPOINTS`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum EndpointId {
            $($variant,)*
        }

        impl EndpointId {
            /// Every endpoint id in the exact order of [`ENDPOINTS`].
            pub const ALL: &'static [EndpointId] = &[$(EndpointId::$variant,)*];

            /// Maps an endpoint op string (e.g. `"issue.create"`) to its [`EndpointId`].
            pub fn from_op(op: &str) -> Option<EndpointId> {
                match op {
                    $($op => Some(EndpointId::$variant),)*
                    _ => None,
                }
            }

            /// Returns the wire op string for this endpoint.
            pub const fn as_op(self) -> &'static str {
                match self {
                    $(EndpointId::$variant => $op,)*
                }
            }

            /// Returns the static [`Endpoint`] metadata for this endpoint.
            pub const fn spec(self) -> &'static Endpoint {
                &ENDPOINTS[self as usize]
            }
        }
    };
}

endpoint_ids! {
    // agent & skill
    AgentList => "agent.list",
    AgentValidate => "agent.validate",
    AgentCreate => "agent.create",
    AgentUpdate => "agent.update",
    AgentDelete => "agent.delete",
    AgentPreviewDelete => "agent.previewDelete",
    AgentTemplateList => "agent.template.list",
    AgentTemplateInstall => "agent.template.install",
    AgentTemplateUpdate => "agent.template.update",
    AgentTemplateAdd => "agent.template.add",
    AgentTemplateDelete => "agent.template.delete",
    SkillList => "skill.list",
    SkillCreate => "skill.create",
    SkillUpdate => "skill.update",
    SkillDelete => "skill.delete",
    // runtime
    RuntimeList => "runtime.list",
    RuntimeRefresh => "runtime.refresh",
    RuntimeSettingUpdate => "runtime.setting.update",
    RuntimeMcpList => "runtime.mcp.list",
    RuntimeMcpInstall => "runtime.mcp.install",
    RuntimeMcpUninstall => "runtime.mcp.uninstall",
    RuntimeMcpServerList => "runtime.mcpServer.list",
    RuntimeMcpServerSave => "runtime.mcpServer.save",
    RuntimeMcpServerToggle => "runtime.mcpServer.toggle",
    RuntimeMcpServerRemove => "runtime.mcpServer.remove",
    // memory
    MemoryList => "memory.list",
    MemoryRecall => "memory.recall",
    MemoryCreate => "memory.create",
    MemorySearch => "memory.search",
    MemoryDelete => "memory.delete",
    MemoryPreviewDelete => "memory.previewDelete",
    // repo & github
    RepoPrSubmit => "repo.pr.submit",
    GithubGet => "github.get",
    GithubRefresh => "github.refresh",
    RepoList => "repo.list",
    RepoValidate => "repo.validate",
    RepoCreate => "repo.create",
    RepoMount => "repo.mount",
    RepoUnmount => "repo.unmount",
    RepoLanguageList => "repo.language.list",
    RepoTemplateList => "repo.template.list",
    RepoActivityGet => "repo.activity.get",
    // session
    SessionStop => "session.stop",
    SessionList => "session.list",
    SessionGet => "session.get",
    SessionEventList => "session.event.list",
    SessionOpenWorkspace => "session.openWorkspace",
    SessionCloseWorkspace => "session.closeWorkspace",
    SessionSend => "session.send",
    SessionRespondPermission => "session.respondPermission",
    SessionRespondInteraction => "session.respondInteraction",
    SessionSetConfig => "session.setConfig",
    SessionChildTranscript => "session.childTranscript",
    SessionCompact => "session.compact",
    SessionRunCode => "session.runCode",
    // issue
    IssueConversationGet => "issue.conversation.get",
    IssueCommentCreate => "issue.comment.create",
    IssueDiffGet => "issue.diff.get",
    IssueHistoryList => "issue.history.list",
    IssueList => "issue.list",
    IssueReview => "issue.review",
    IssueSplit => "issue.split",
    IssueGet => "issue.get",
    IssueRunList => "issue.run.list",
    IssueTimelineGet => "issue.timeline.get",
    IssueCreate => "issue.create",
    IssueUpdate => "issue.update",
    IssueDelete => "issue.delete",
    IssuePreviewDelete => "issue.previewDelete",
    IssueStatusUpdate => "issue.status.update",
    IssueStatusPreviewUpdate => "issue.status.previewUpdate",
    IssueRefine => "issue.refine",
    IssueRetroGet => "issue.retro.get",
    IssueDigestGet => "issue.digest.get",
    IssueTriageList => "issue.triage.list",
    IssueTriageSuggest => "issue.triage.suggest",
    IssueTriageConfirm => "issue.triage.confirm",
    IssueTriageDismiss => "issue.triage.dismiss",
    // cron
    CronCreate => "cron.create",
    CronList => "cron.list",
    CronUpdate => "cron.update",
    CronDelete => "cron.delete",
    CronPreviewDelete => "cron.previewDelete",
    // channel
    ChannelMessageSend => "channel.message.send",
    ChannelCreate => "channel.create",
    ChannelUpdate => "channel.update",
    ChannelMessageList => "channel.message.list",
    ChannelMarkRead => "channel.markRead",
    ChannelMessageUpdate => "channel.message.update",
    ChannelMessageDelete => "channel.message.delete",
    ChannelMessagePreviewDelete => "channel.message.previewDelete",
    ChannelMessageSearch => "channel.message.search",
    ChannelReactionSet => "channel.reaction.set",
    ChannelPinSet => "channel.pin.set",
    ChannelPinList => "channel.pin.list",
    ChannelThreadCreate => "channel.thread.create",
    ChannelArchiveSet => "channel.archive.set",
    ChannelDelete => "channel.delete",
    ChannelPreviewDelete => "channel.previewDelete",
    ChannelDirectCreate => "channel.direct.create",
    ChannelNotifySet => "channel.notify.set",
    ChannelMarkUnread => "channel.markUnread",
    ChannelList => "channel.list",
    ChannelUnreadList => "channel.unread.list",
    // connector
    ConnectorLogin => "connector.login",
    ConnectorVerify => "connector.verify",
    ConnectorLogout => "connector.logout",
    ConnectorChannelSet => "connector.channel.set",
    // media & library
    MediaDialogueCreate => "media.dialogue.create",
    MediaVoiceDesignCreate => "media.voiceDesign.create",
    MediaCloneCreate => "media.clone.create",
    MediaTranscriptionCreate => "media.transcription.create",
    MediaAudioResume => "media.audio.resume",
    MediaAudioPreviewCleanup => "media.audio.previewCleanup",
    MediaAudioCleanup => "media.audio.cleanup",
    MediaInputCreate => "media.input.create",
    MediaInputAdopt => "media.input.adopt",
    MediaInputList => "media.input.list",
    MediaInputDelete => "media.input.delete",
    MediaInputPreviewDelete => "media.input.previewDelete",
    MediaImageCreate => "media.image.create",
    MediaUnderstandingCreate => "media.understanding.create",
    MediaUnderstandingAuthorize => "media.understanding.authorize",
    MediaUnderstandingStart => "media.understanding.start",
    MediaSpeechCreate => "media.speech.create",
    MediaSpeechResume => "media.speech.resume",
    MediaUnderstandingCleanup => "media.understanding.cleanup",
    MediaJobGet => "media.job.get",
    MediaJobCancel => "media.job.cancel",
    MediaJobPreviewRelease => "media.job.previewRelease",
    MediaJobRelease => "media.job.release",
    MediaJobDownload => "media.job.download",
    MediaJobList => "media.job.list",
    LibraryItemList => "library.item.list",
    LibraryItemAdd => "library.item.add",
    LibraryItemDelete => "library.item.delete",
    LibraryItemPreviewDelete => "library.item.previewDelete",
    // voice
    VoiceHear => "voice.hear",
    VoiceMossVerify => "voice.moss.verify",
    VoiceGrantCreate => "voice.grant.create",
    VoiceCallStart => "voice.call.start",
    VoiceCallStop => "voice.call.stop",
    VoiceCallHear => "voice.call.hear",
    VoiceCallSay => "voice.call.say",
    VoiceAsrStart => "voice.asr.start",
    VoiceAsrStop => "voice.asr.stop",
    VoiceAsrTranscribe => "voice.asr.transcribe",
    // note
    NoteList => "note.list",
    NoteGet => "note.get",
    NoteContentGet => "note.content.get",
    NoteCreate => "note.create",
    NoteVersionCreate => "note.version.create",
    NoteUpdate => "note.update",
    NoteDelete => "note.delete",
    NotePreviewDelete => "note.previewDelete",
    NoteTreeMove => "note.tree.move",
    NoteLinkList => "note.link.list",
    NoteDocView => "note.doc.view",
    NoteDocAppendBlock => "note.doc.appendBlock",
    NoteBaseView => "note.base.view",
    NoteBaseUpsertRow => "note.base.upsertRow",
    NoteBaseRunAgentColumn => "note.base.runAgentColumn",
    NoteTypeList => "note.type.list",
    NoteTypeRead => "note.type.read",
    NoteFileList => "note.file.list",
    NoteFileGet => "note.file.get",
    NoteFileWrite => "note.file.write",
    NoteFileDelete => "note.file.delete",
    NoteSuggestionList => "note.suggestion.list",
    NoteSuggestionCreate => "note.suggestion.create",
    NoteSuggestionAccept => "note.suggestion.accept",
    NoteSuggestionReject => "note.suggestion.reject",
    NotePresenceUpdate => "note.presence.update",
    NoteHistoryList => "note.history.list",
    NoteHistoryPreview => "note.history.preview",
    NoteHistoryRestore => "note.history.restore",
    NoteHistoryFork => "note.history.fork",
    NoteHistoryUndoOrigin => "note.history.undoOrigin",
    NoteHistoryCompact => "note.history.compact",
    NoteCollabExport => "note.collab.export",
    NoteCollabImport => "note.collab.import",
    NoteCoverSet => "note.cover.set",
    // provider & setting
    ProviderGet => "provider.get",
    ProviderUpdate => "provider.update",
    ProviderVoiceList => "provider.voice.list",
    ProviderModelList => "provider.model.list",
    SettingGet => "setting.get",
    SettingValidate => "setting.validate",
    SettingUpdate => "setting.update",
    // orchestrator
    OrchestratorOpen => "orchestrator.open",
    OrchestratorStop => "orchestrator.stop",
    OrchestratorEvalCreate => "orchestrator.eval.create",
    OrchestratorApprovalList => "orchestrator.approval.list",
    OrchestratorApprovalResolve => "orchestrator.approval.resolve",
    // attachment & core
    AttachmentCreate => "attachment.create",
    AttachmentImportPath => "attachment.importPath",
    ServerHealthGet => "server.health.get",
    // debug
    DebugSnapshot => "debug.snapshot",
    DebugTimelineList => "debug.timeline.list",
    DebugTimelineClear => "debug.timeline.clear",
    DebugTrajectoryList => "debug.trajectory.list",
    DebugTrajectoryGet => "debug.trajectory.get",
    DebugTrajectoryExport => "debug.trajectory.export",
    DebugOverrideSet => "debug.override.set",
    DebugBundleExport => "debug.bundle.export",
    // remote & machine
    RemoteStatus => "remote.status",
    RemoteEnable => "remote.enable",
    RemoteDisable => "remote.disable",
    RemotePairCreate => "remote.pair.create",
    RemotePairExchange => "remote.pair.exchange",
    RemoteDeviceRevoke => "remote.device.revoke",
    RemoteWhoami => "remote.whoami",
    MachineList => "machine.list",
    // game
    GameShopList => "game.shop.list",
    GameShopBuy => "game.shop.buy",
    GameDailyList => "game.daily.list",
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn endpoint_id_matches_endpoints_table_exhaustively() {
        assert_eq!(EndpointId::ALL.len(), ENDPOINTS.len());

        let mut seen = HashSet::new();
        for (idx, ep) in ENDPOINTS.iter().enumerate() {
            let id = EndpointId::from_op(ep.op).unwrap_or_else(|| panic!("missing EndpointId for {}", ep.op));
            assert_eq!(id, EndpointId::ALL[idx], "order mismatch at index {idx} ({})", ep.op);
            assert_eq!(id.as_op(), ep.op);
            assert_eq!(id.spec().op, ep.op);
            assert_eq!(id.spec(), ep);
            assert!(seen.insert(id), "duplicate EndpointId for {}", ep.op);
        }

        for &id in EndpointId::ALL {
            assert_eq!(EndpointId::from_op(id.as_op()), Some(id));
            assert_eq!(id.spec().op, id.as_op());
        }

        assert_eq!(EndpointId::from_op(""), None);
        assert_eq!(EndpointId::from_op("unknown.op"), None);
    }
}
