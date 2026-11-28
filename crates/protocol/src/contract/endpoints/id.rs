use super::ENDPOINTS;
use crate::wire::Endpoint;

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
    AgentRegister => "agent.register",
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
    SessionEvalCreate => "session.eval.create",
    SessionApprovalList => "session.approval.list",
    SessionApprovalResolve => "session.approval.resolve",
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
    IssueBodyEnsure => "issue.body.ensure",
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
    VoiceMossVerify => "voice.moss.verify",
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
    NoteAnnotationUpsert => "note.annotation.upsert",
    NoteAnnotationDelete => "note.annotation.delete",
    NoteBaseSyncReview => "note.base.syncReview",
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
    ProviderVerify => "provider.verify",
    ProviderVoiceList => "provider.voice.list",
    SettingGet => "setting.get",
    SettingValidate => "setting.validate",
    SettingUpdate => "setting.update",
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
