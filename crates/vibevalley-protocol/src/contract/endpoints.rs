use crate::wire::{Caller, Endpoint};

mod t {
    pub use crate::contract::*;
    #[allow(unused_imports)]
    pub use crate::wire::*;
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
        dry_run: Some("agent.template.previewDelete"),
        input: Some("AgentDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "agent.template.previewDelete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentDeleteInput"),
        result: Some("Preview"),
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
        dry_run: Some("skill.previewDelete"),
        input: Some("SkillDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "skill.previewDelete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SkillDeleteInput"),
        result: Some("Preview"),
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
        result: Some("Vec<SessionEvent>"),
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
        op: "channel.default.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelDefaultSetInput"),
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
        op: "connector.list",
        module: "connector",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<ConnectorStatus>"),
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
        op: "game.achievement.list",
        module: "game",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<Achievement>"),
    },
    Endpoint {
        op: "game.title.set",
        module: "game",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChooseTitleRequest"),
        result: None,
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
        op: "media.input.get",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
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
        op: "media.understanding.previewCleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.understanding.cleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.understanding.previewCleanup"),
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
        result: Some("AgoraGrant"),
    },
    Endpoint {
        op: "voice.grant.renew",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("VoiceGrantRenew"),
        result: Some("AgoraGrant"),
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
        op: "voice.dictate",
        module: "voice",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("DictateRequest"),
        result: Some("Dictated"),
    },
    Endpoint {
        op: "artifact.list",
        module: "artifact",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ArtifactListRequest"),
        result: Some("Vec<Artifact>"),
    },
    Endpoint {
        op: "artifact.get",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ArtifactGetInput"),
        result: Some("Artifact"),
    },
    Endpoint {
        op: "artifact.content.get",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ArtifactReadRequest"),
        result: Some("ArtifactContent"),
    },
    Endpoint {
        op: "artifact.create",
        module: "artifact",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ArtifactRequest"),
        result: Some("Artifact"),
    },
    Endpoint {
        op: "artifact.version.create",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ArtifactVersionRequest"),
        result: Some("Artifact"),
    },
    Endpoint {
        op: "artifact.html.edit",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactHtmlEdit"),
        result: Some("Artifact"),
    },
    Endpoint {
        op: "artifact.update",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactUpdateRequest"),
        result: Some("Artifact"),
    },
    Endpoint {
        op: "artifact.delete",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("artifact.previewDelete"),
        input: Some("ArtifactDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "artifact.previewDelete",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "artifact.block.list",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactBlockListInput"),
        result: Some("BlockSnapshot"),
    },
    Endpoint {
        op: "artifact.submit",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactSubmitInput"),
        result: Some("BlockAck"),
    },
    Endpoint {
        op: "artifact.block.create",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session, Caller::Orchestrator],
        dry_run: None,
        input: Some("ArtifactBlockCreateInput"),
        result: Some("BlockOpResult"),
    },
    Endpoint {
        op: "artifact.block.update",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session, Caller::Orchestrator],
        dry_run: None,
        input: Some("ArtifactBlockUpdateInput"),
        result: Some("BlockOpResult"),
    },
    Endpoint {
        op: "artifact.block.delete",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session, Caller::Orchestrator],
        dry_run: Some("artifact.block.previewDelete"),
        input: Some("ArtifactBlockDeleteInput"),
        result: Some("BlockOpResult"),
    },
    Endpoint {
        op: "artifact.block.previewDelete",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session, Caller::Orchestrator],
        dry_run: None,
        input: Some("ArtifactBlockDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "artifact.suggestion.list",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactSuggestionListInput"),
        result: Some("Vec<Suggestion>"),
    },
    Endpoint {
        op: "artifact.suggestion.create",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactSuggestionCreateInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "artifact.suggestion.accept",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "artifact.suggestion.reject",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "artifact.markdown.get",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactMarkdownGetInput"),
        result: Some("ArtifactMarkdown"),
    },
    Endpoint {
        op: "artifact.demo",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("ArtifactDemoInput"),
        result: None,
    },
    Endpoint {
        op: "pkm.page.list",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("PkmVault"),
    },
    Endpoint {
        op: "pkm.page.get",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("PkmPageRef"),
        result: Some("PkmPageView"),
    },
    Endpoint {
        op: "pkm.page.save",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmPageRequest"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.page.move",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmMoveRequest"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.page.rename",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmRenameRequest"),
        result: Some("PkmRename"),
    },
    Endpoint {
        op: "pkm.page.export",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmPageRef"),
        result: Some("PkmMarkdown"),
    },
    Endpoint {
        op: "pkm.block.apply",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmMutation"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.search",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("PkmSearchRequest"),
        result: Some("Vec<PkmSearchHit>"),
    },
    Endpoint {
        op: "pkm.capture",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("PkmCaptureRequest"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.source.get",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmPageRef"),
        result: Some("PkmSource"),
    },
    Endpoint {
        op: "pkm.source.update",
        module: "pkm",
        about: &["page"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmSourceUpdate"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.journal.open",
        module: "pkm",
        about: &["day"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmJournalRequest"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.radar.get",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmRadarGetInput"),
        result: Some("PkmRadar"),
    },
    Endpoint {
        op: "pkm.comment.list",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmCommentListInput"),
        result: Some("Vec<PkmComment>"),
    },
    Endpoint {
        op: "pkm.comment.suggest",
        module: "pkm",
        about: &["block"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("PkmProposalRequest"),
        result: Some("PkmProposal"),
    },
    Endpoint {
        op: "pkm.comment.resolve",
        module: "pkm",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmResolveRequest"),
        result: Some("PkmPage"),
    },
    Endpoint {
        op: "pkm.clip.create",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmClipRequest"),
        result: Some("PkmClip"),
    },
    Endpoint {
        op: "pkm.cluster.create",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("PkmClusterRequest"),
        result: Some("PkmCluster"),
    },
    Endpoint {
        op: "pkm.undo",
        module: "pkm",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("PkmUndo"),
    },
    Endpoint {
        op: "pkm.scan",
        module: "pkm",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("PkmScan"),
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
        op: "attachment.create",
        module: "attachment",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AttachmentUpload"),
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
];

/// Each endpoint as a type: its name, input and result.
pub mod ops {
    use super::t;
    use crate::wire::Op;
    #[allow(unused_imports)]
    use std::collections::BTreeMap;
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
    /// What deleting the template would do, refused as it would be; nothing changes.
    pub struct AgentTemplatePreviewDelete;
    impl Op for AgentTemplatePreviewDelete {
        const NAME: &'static str = "agent.template.previewDelete";
        type Input = t::AgentDeleteInput;
        type Result = t::Preview;
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
    /// What delete would do, refused as it would be; nothing changes.
    pub struct SkillPreviewDelete;
    impl Op for SkillPreviewDelete {
        const NAME: &'static str = "skill.previewDelete";
        type Input = t::SkillDeleteInput;
        type Result = t::Preview;
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
    /// Its log, oldest first. run gives one run's only.
    pub struct SessionEventList;
    impl Op for SessionEventList {
        const NAME: &'static str = "session.event.list";
        type Input = t::SessionEventListInput;
        type Result = Vec<t::SessionEvent>;
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
    /// The channel what names none goes to from now on: a connector's, a call's.
    pub struct ChannelDefaultSet;
    impl Op for ChannelDefaultSet {
        const NAME: &'static str = "channel.default.set";
        type Input = t::ChannelDefaultSetInput;
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
    pub struct ConnectorList;
    impl Op for ConnectorList {
        const NAME: &'static str = "connector.list";
        type Input = ();
        type Result = Vec<t::ConnectorStatus>;
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
    /// Every achievement, as the board has them.
    pub struct GameAchievementList;
    impl Op for GameAchievementList {
        const NAME: &'static str = "game.achievement.list";
        type Input = ();
        type Result = Vec<t::Achievement>;
    }
    pub struct GameTitleSet;
    impl Op for GameTitleSet {
        const NAME: &'static str = "game.title.set";
        type Input = t::ChooseTitleRequest;
        type Result = ();
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
    pub struct MediaInputGet;
    impl Op for MediaInputGet {
        const NAME: &'static str = "media.input.get";
        type Input = t::MediaJobRequest;
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
    pub struct MediaUnderstandingPreviewCleanup;
    impl Op for MediaUnderstandingPreviewCleanup {
        const NAME: &'static str = "media.understanding.previewCleanup";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
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
        type Result = t::AgoraGrant;
    }
    pub struct VoiceGrantRenew;
    impl Op for VoiceGrantRenew {
        const NAME: &'static str = "voice.grant.renew";
        type Input = t::VoiceGrantRenew;
        type Result = t::AgoraGrant;
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
    pub struct VoiceDictate;
    impl Op for VoiceDictate {
        const NAME: &'static str = "voice.dictate";
        type Input = t::DictateRequest;
        type Result = t::Dictated;
    }
    /// The artifacts announced in a channel or made for an issue, newest change first; every one the farm has when neither is given.
    pub struct ArtifactList;
    impl Op for ArtifactList {
        const NAME: &'static str = "artifact.list";
        type Input = t::ArtifactListRequest;
        type Result = Vec<t::Artifact>;
    }
    pub struct ArtifactGet;
    impl Op for ArtifactGet {
        const NAME: &'static str = "artifact.get";
        type Input = t::ArtifactGetInput;
        type Result = t::Artifact;
    }
    /// Its words: an html one's version as made, a blocks one's Markdown now (its version is its seq). What an agent reads
    /// to make the next one.
    pub struct ArtifactContentGet;
    impl Op for ArtifactContentGet {
        const NAME: &'static str = "artifact.content.get";
        type Input = t::ArtifactReadRequest;
        type Result = t::ArtifactContent;
    }
    /// Without content, an empty blocks one to write in; with content, a hand-in its maker announces with its card.
    pub struct ArtifactCreate;
    impl Op for ArtifactCreate {
        const NAME: &'static str = "artifact.create";
        type Input = t::ArtifactRequest;
        type Result = t::Artifact;
    }
    /// An html one's new version over the latest. the old ones stay.
    pub struct ArtifactVersionCreate;
    impl Op for ArtifactVersionCreate {
        const NAME: &'static str = "artifact.version.create";
        type Input = t::ArtifactVersionRequest;
        type Result = t::Artifact;
    }
    /// The user's words in place of some in an html one's page: the next version, the rest of its bytes as they were.
    pub struct ArtifactHtmlEdit;
    impl Op for ArtifactHtmlEdit {
        const NAME: &'static str = "artifact.html.edit";
        type Input = t::ArtifactHtmlEdit;
        type Result = t::Artifact;
    }
    /// Its title, as the user renames it.
    pub struct ArtifactUpdate;
    impl Op for ArtifactUpdate {
        const NAME: &'static str = "artifact.update";
        type Input = t::ArtifactUpdateRequest;
        type Result = t::Artifact;
    }
    pub struct ArtifactDelete;
    impl Op for ArtifactDelete {
        const NAME: &'static str = "artifact.delete";
        type Input = t::ArtifactDeleteInput;
        type Result = ();
    }
    pub struct ArtifactPreviewDelete;
    impl Op for ArtifactPreviewDelete {
        const NAME: &'static str = "artifact.previewDelete";
        type Input = t::ArtifactDeleteInput;
        type Result = t::Preview;
    }
    /// A blocks artifact and every live block (no tombstones), in order.
    pub struct ArtifactBlockList;
    impl Op for ArtifactBlockList {
        const NAME: &'static str = "artifact.block.list";
        type Input = t::ArtifactBlockListInput;
        type Result = t::BlockSnapshot;
    }
    /// A batch of ops, as the user: taken in order, in one transaction, one batch at a time.
    pub struct ArtifactSubmit;
    impl Op for ArtifactSubmit {
        const NAME: &'static str = "artifact.submit";
        type Input = t::ArtifactSubmitInput;
        type Result = t::BlockAck;
    }
    /// One block inserted, as one batch of one op.
    pub struct ArtifactBlockCreate;
    impl Op for ArtifactBlockCreate {
        const NAME: &'static str = "artifact.block.create";
        type Input = t::ArtifactBlockCreateInput;
        type Result = t::BlockOpResult;
    }
    /// One block's words, type or attrs changed, as one batch.
    pub struct ArtifactBlockUpdate;
    impl Op for ArtifactBlockUpdate {
        const NAME: &'static str = "artifact.block.update";
        type Input = t::ArtifactBlockUpdateInput;
        type Result = t::BlockOpResult;
    }
    /// One block and its children put in their tombstones.
    pub struct ArtifactBlockDelete;
    impl Op for ArtifactBlockDelete {
        const NAME: &'static str = "artifact.block.delete";
        type Input = t::ArtifactBlockDeleteInput;
        type Result = t::BlockOpResult;
    }
    pub struct ArtifactBlockPreviewDelete;
    impl Op for ArtifactBlockPreviewDelete {
        const NAME: &'static str = "artifact.block.previewDelete";
        type Input = t::ArtifactBlockDeleteInput;
        type Result = t::Preview;
    }
    /// The open and resolved suggestions on an artifact, oldest first.
    pub struct ArtifactSuggestionList;
    impl Op for ArtifactSuggestionList {
        const NAME: &'static str = "artifact.suggestion.list";
        type Input = t::ArtifactSuggestionListInput;
        type Result = Vec<t::Suggestion>;
    }
    /// A change an agent proposes to a block the user wrote.
    pub struct ArtifactSuggestionCreate;
    impl Op for ArtifactSuggestionCreate {
        const NAME: &'static str = "artifact.suggestion.create";
        type Input = t::ArtifactSuggestionCreateInput;
        type Result = t::Suggestion;
    }
    /// The user takes a suggestion; a block that moved on since it was read comes back stale, and is not changed.
    pub struct ArtifactSuggestionAccept;
    impl Op for ArtifactSuggestionAccept {
        const NAME: &'static str = "artifact.suggestion.accept";
        type Input = t::ArtifactSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    pub struct ArtifactSuggestionReject;
    impl Op for ArtifactSuggestionReject {
        const NAME: &'static str = "artifact.suggestion.reject";
        type Input = t::ArtifactSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    /// A blocks artifact as Markdown: the format artifacts trade with agents and MEMORY.md in, not how they are stored.
    pub struct ArtifactMarkdownGet;
    impl Op for ArtifactMarkdownGet {
        const NAME: &'static str = "artifact.markdown.get";
        type Input = t::ArtifactMarkdownGetInput;
        type Result = t::ArtifactMarkdown;
    }
    /// Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
    /// one already running is refused.
    pub struct ArtifactDemo;
    impl Op for ArtifactDemo {
        const NAME: &'static str = "artifact.demo";
        type Input = t::ArtifactDemoInput;
        type Result = ();
    }
    /// Every page in the vault, newest first; files changed on disk are read again first.
    pub struct PkmPageList;
    impl Op for PkmPageList {
        const NAME: &'static str = "pkm.page.list";
        type Input = ();
        type Result = t::PkmVault;
    }
    /// The page with its ((refs)) read out, the blocks linking to it and its open remarks; read again from its file when that changed.
    pub struct PkmPageGet;
    impl Op for PkmPageGet {
        const NAME: &'static str = "pkm.page.get";
        type Input = t::PkmPageRef;
        type Result = t::PkmPageView;
    }
    /// Makes the page, or sets the props and tier of the one with that title (its file moves to the tier's folder).
    pub struct PkmPageSave;
    impl Op for PkmPageSave {
        const NAME: &'static str = "pkm.page.save";
        type Input = t::PkmPageRequest;
        type Result = t::PkmPage;
    }
    pub struct PkmPageMove;
    impl Op for PkmPageMove {
        const NAME: &'static str = "pkm.page.move";
        type Input = t::PkmMoveRequest;
        type Result = t::PkmPage;
    }
    pub struct PkmPageRename;
    impl Op for PkmPageRename {
        const NAME: &'static str = "pkm.page.rename";
        type Input = t::PkmRenameRequest;
        type Result = t::PkmRename;
    }
    /// The page as plain Markdown: refs read out, links and remarks taken off.
    pub struct PkmPageExport;
    impl Op for PkmPageExport {
        const NAME: &'static str = "pkm.page.export";
        type Input = t::PkmPageRef;
        type Result = t::PkmMarkdown;
    }
    /// The ops in order on the page as its file is now, written back once.
    pub struct PkmBlockApply;
    impl Op for PkmBlockApply {
        const NAME: &'static str = "pkm.block.apply";
        type Input = t::PkmMutation;
        type Result = t::PkmPage;
    }
    pub struct PkmSearch;
    impl Op for PkmSearch {
        const NAME: &'static str = "pkm.search";
        type Input = t::PkmSearchRequest;
        type Result = Vec<t::PkmSearchHit>;
    }
    /// Into today's journal as LATER lines tagged #inbox (an agent's says who noted it), or at the end of a page.
    pub struct PkmCapture;
    impl Op for PkmCapture {
        const NAME: &'static str = "pkm.capture";
        type Input = t::PkmCaptureRequest;
        type Result = t::PkmPage;
    }
    /// The page's file as written, ids and all, with when it was written.
    pub struct PkmSourceGet;
    impl Op for PkmSourceGet {
        const NAME: &'static str = "pkm.source.get";
        type Input = t::PkmPageRef;
        type Result = t::PkmSource;
    }
    /// The page written anew from its file's text; refused when the file changed after it was read.
    pub struct PkmSourceUpdate;
    impl Op for PkmSourceUpdate {
        const NAME: &'static str = "pkm.source.update";
        type Input = t::PkmSourceUpdate;
        type Result = t::PkmPage;
    }
    /// The journal of a day, made empty when it has none yet.
    pub struct PkmJournalOpen;
    impl Op for PkmJournalOpen {
        const NAME: &'static str = "pkm.journal.open";
        type Input = t::PkmJournalRequest;
        type Result = t::PkmPage;
    }
    pub struct PkmRadarGet;
    impl Op for PkmRadarGet {
        const NAME: &'static str = "pkm.radar.get";
        type Input = t::PkmRadarGetInput;
        type Result = t::PkmRadar;
    }
    pub struct PkmCommentList;
    impl Op for PkmCommentList {
        const NAME: &'static str = "pkm.comment.list";
        type Input = t::PkmCommentListInput;
        type Result = Vec<t::PkmComment>;
    }
    /// A rewrite of a block for the user to accept: it keeps every [[link]] and ((ref)) the block had.
    pub struct PkmCommentSuggest;
    impl Op for PkmCommentSuggest {
        const NAME: &'static str = "pkm.comment.suggest";
        type Input = t::PkmProposalRequest;
        type Result = t::PkmProposal;
    }
    /// Accepted, the suggested text replaces the block's and its remarks come off; rejected, the block stays.
    pub struct PkmCommentResolve;
    impl Op for PkmCommentResolve {
        const NAME: &'static str = "pkm.comment.resolve";
        type Input = t::PkmResolveRequest;
        type Result = t::PkmPage;
    }
    pub struct PkmClipCreate;
    impl Op for PkmClipCreate {
        const NAME: &'static str = "pkm.clip.create";
        type Input = t::PkmClipRequest;
        type Result = t::PkmClip;
    }
    /// A resource page of ((refs)) to the inbox, journal and resource blocks about the topic.
    pub struct PkmClusterCreate;
    impl Op for PkmClusterCreate {
        const NAME: &'static str = "pkm.cluster.create";
        type Input = t::PkmClusterRequest;
        type Result = t::PkmCluster;
    }
    /// Puts back the file the last change wrote.
    pub struct PkmUndo;
    impl Op for PkmUndo {
        const NAME: &'static str = "pkm.undo";
        type Input = ();
        type Result = t::PkmUndo;
    }
    /// Reads again every file that changed on disk.
    pub struct PkmScan;
    impl Op for PkmScan {
        const NAME: &'static str = "pkm.scan";
        type Input = ();
        type Result = t::PkmScan;
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
    /// Kept once by its bytes: the same file again is the same attachment.
    pub struct AttachmentCreate;
    impl Op for AttachmentCreate {
        const NAME: &'static str = "attachment.create";
        type Input = t::AttachmentUpload;
        type Result = t::Attachment;
    }
    pub struct ServerHealthGet;
    impl Op for ServerHealthGet {
        const NAME: &'static str = "server.health.get";
        type Input = ();
        type Result = t::Health;
    }
}

/// rpc.ts' subscriptions: each one's payload and event.
pub mod subscriptions {
    use super::t;
    use crate::wire::Subscription;
    pub struct ChannelFollow;
    impl Subscription for ChannelFollow {
        const NAME: &'static str = "channel.follow";
        type Payload = t::ChannelFollowPayload;
        type Event = t::ChannelEvent;
    }
    pub struct ChannelReports;
    impl Subscription for ChannelReports {
        const NAME: &'static str = "channel.reports";
        type Payload = t::ChannelReportsPayload;
        type Event = t::ChannelEvent;
    }
    pub struct ArtifactFollow;
    impl Subscription for ArtifactFollow {
        const NAME: &'static str = "artifact.follow";
        type Payload = t::ArtifactFollowPayload;
        type Event = t::ArtifactEvent;
    }
    pub struct ArtifactSuggestionFollow;
    impl Subscription for ArtifactSuggestionFollow {
        const NAME: &'static str = "artifact.suggestion.follow";
        type Payload = t::ArtifactSuggestionFollowPayload;
        type Event = t::SuggestionEvent;
    }
}
