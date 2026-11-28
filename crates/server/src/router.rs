//! Thin compile-time exhaustive [`Router`] implementing [`Server`] over all
//! `EndpointId`, `NativeEndpointId`, and `SUBSCRIPTIONS`.

mod glue;

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

use serde::de::DeserializeOwned;
use serde_json::Value;
use vibevalley_protocol::{ApiError, BizCode, Caller, EndpointId, EndpointId as E, Envelope, LiveEvent, NativeEndpointId, Op, SUBSCRIPTIONS, SliceKind, ops};

pub(crate) use self::glue::AppCore;
use crate::context::{SliceSubscription, bridge_live_receiver};
use crate::gateway::api::{
    BoxFuture, CallerContext, GatewayMeta, GatewayPorts, Server, SharedFaultGate, SharedHostDebug, decode, dispatch_boundary_async, flush_and_snapshot_json,
    flush_and_subscribe_slice, ok_json, open_subscription_channel,
};
use crate::gateway::remote::Remote;

macro_rules! on {
    ($p:expr, $op:ident, |$r:ident| $body:expr) => {
        Box::pin(async move {
            let $r: <ops::$op as Op>::Input = decode($p)?;
            ok_json($body)
        })
    };
}
macro_rules! void {
    ($p:expr, $op:ident, |$r:ident| $body:expr) => {
        Box::pin(async move {
            let $r: <ops::$op as Op>::Input = decode($p)?;
            $body;
            Ok(Value::Null)
        })
    };
}
macro_rules! ret {
    ($body:expr) => {
        Box::pin(async move { $body })
    };
}
macro_rules! router_methods {
    ($($item:item)*) => { $($item)* };
}

pub struct Router {
    pub(crate) me: Weak<Self>,
    pub(crate) core: Arc<AppCore>,
    pub(crate) remote: Arc<Remote>,
    gw: GatewayMeta,
}

impl Router {
    router_methods! {
        pub(crate) fn new(core: Arc<AppCore>, remote: Arc<Remote>, gw: GatewayMeta) -> Arc<Self> { Arc::new_cyclic(|me| Self { me: me.clone(), core, remote, gw }) }
        pub fn has_observer(&self) -> bool { self.gw.observer.is_some() }
        pub fn has_fault_gate(&self) -> bool { self.gw.fault_gate.is_some() }
        pub fn active_subscription_count(&self) -> u32 { self.gw.subs.len() }
        pub fn answers(&self, op: &str) -> bool { EndpointId::from_op(op).is_some() || NativeEndpointId::from_op(op).is_some() }
        pub fn answers_subscription(&self, name: &str) -> bool { SUBSCRIPTIONS.iter().any(|s| s.name == name) }
        pub fn slice_seqs(&self) -> BTreeMap<String, i64> { self.core.ctx.feed.slice_seqs() }
        pub fn slice_watcher_counts(&self) -> BTreeMap<String, u32> { self.core.ctx.feed.watcher_counts() }
        pub async fn call_as_async(&self, caller: Caller, op: &str, payload: Value) -> Envelope { self.dispatch_op_async(CallerContext::from_caller(caller), op, payload).await }
        pub(crate) fn close_subscriptions(&self) { self.gw.subs.close_all(); }
        fn server_arc(&self) -> Result<Arc<dyn Server>, ApiError> { self.me.upgrade().map(|r| r as Arc<dyn Server>).ok_or_else(|| ApiError::new(BizCode::ServiceUnavailable, "router dropped")) }
    }
    pub async fn invoke_async<O: Op>(&self, ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Result: DeserializeOwned,
    {
        let p = serde_json::to_value(input).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))?;
        let env = self.dispatch_op_async(ctx.clone(), O::NAME, p).await;
        if let Some(err) = env.error() {
            return Err(err);
        }
        serde_json::from_value(env.data.unwrap_or(Value::Null)).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
    }
    pub async fn invoke_as_async<O: Op>(&self, caller: Caller, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Result: DeserializeOwned,
    {
        self.invoke_async::<O>(&CallerContext::from_caller(caller), input).await
    }
    #[allow(clippy::result_large_err)]
    async fn open_sub_async(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope> {
        open_subscription_channel(&self.gw, ctx, name, payload, |sub, sink| glue::open_sub_domain_async(&self.core, sub, sink)).await
    }
    router_methods! {
        async fn dispatch_op_async(&self, ctx: CallerContext, op: &str, payload: Value) -> Envelope { dispatch_boundary_async(self, &self.gw, ctx, op, payload, |r, c, id, p| r.dispatch_endpoint_async(c, id, p), |r, n| Box::pin(glue::dispatch_native_domain_async(&r.core.storage, n))).await }
    }

    fn dispatch_endpoint_async<'a>(&'a self, ctx: &'a CallerContext, id: EndpointId, p: Value) -> BoxFuture<'a, Result<Value, ApiError>> {
        let c = &self.core;
        let (pr, mem, orch, med, lib, note) = (
            &c.agent.profile,
            &c.agent.memory,
            &c.agent.orchestrator,
            &c.note.media,
            &c.note.library,
            &c.note,
        );
        let (ch, rt, brd, st, dbg, wf) = (&c.channel, &c.runtime, &c.board, &c.storage, &c.debug, &c.orchestration);
        match id {
            E::AgentList => ret!(ok_json(pr.all())),
            E::AgentValidate => on!(p, AgentValidate, |r| pr.validate_async(&r.agents).await),
            E::AgentCreate => on!(p, AgentCreate, |r| pr.agent_create_async(r).await?),
            E::AgentUpdate => on!(p, AgentUpdate, |r| pr.agent_update_async(r).await?),
            E::AgentRegister => on!(p, AgentRegister, |r| pr.agent_register_async(r).await?),
            E::AgentDelete => void!(p, AgentDelete, |r| pr.agent_delete_async(&r.id).await?),
            E::AgentPreviewDelete => on!(p, AgentPreviewDelete, |r| pr.agent_preview_delete(&r.id)?),
            E::AgentTemplateList => ret!(ok_json(pr.templates_async().await)),
            E::AgentTemplateInstall => on!(p, AgentTemplateInstall, |r| glue::agent_tmpl_install(pr, r).await?),
            E::AgentTemplateUpdate => on!(p, AgentTemplateUpdate, |r| pr.agent_template_update_async(&r.agent).await?),
            E::AgentTemplateAdd => on!(p, AgentTemplateAdd, |r| pr.agent_template_add_async(&r.path).await?),
            E::AgentTemplateDelete => void!(p, AgentTemplateDelete, |r| pr.agent_template_delete_async(&r.id).await?),
            E::SkillList => ret!(ok_json(pr.skills())),
            E::SkillCreate => on!(p, SkillCreate, |r| pr.skill_create_async(r).await?),
            E::SkillUpdate => on!(p, SkillUpdate, |r| pr.skill_update_async(r).await?),
            E::SkillDelete => void!(p, SkillDelete, |r| pr.skill_delete_async(&r.id).await?),
            E::RuntimeList => ret!(ok_json(pr.runtimes())),
            E::RuntimeRefresh => on!(p, RuntimeRefresh, |r| pr.runtime_refresh_async(&r.id).await?),
            E::RuntimeSettingUpdate => on!(p, RuntimeSettingUpdate, |r| pr.runtime_setting_update_input_async(r).await?),
            E::RuntimeMcpList => on!(p, RuntimeMcpList, |r| rt.list_mcp_hosts_endpoint(r)),
            E::RuntimeMcpInstall => on!(p, RuntimeMcpInstall, |r| rt.install_mcp_host_endpoint(r)?),
            E::RuntimeMcpUninstall => on!(p, RuntimeMcpUninstall, |r| rt.uninstall_mcp_host_endpoint(r)?),
            E::RuntimeMcpServerList => on!(p, RuntimeMcpServerList, |r| rt.list_host_mcp_servers_endpoint_async(r).await?),
            E::RuntimeMcpServerSave => on!(p, RuntimeMcpServerSave, |r| glue::mcp_server_save(c, r).await?),
            E::RuntimeMcpServerToggle => on!(p, RuntimeMcpServerToggle, |r| glue::mcp_server_toggle(c, r).await?),
            E::RuntimeMcpServerRemove => on!(p, RuntimeMcpServerRemove, |r| glue::mcp_server_remove(c, r).await?),
            E::MemoryList => on!(p, MemoryList, |r| mem.list_endpoint_async(r).await?),
            E::MemoryRecall => on!(p, MemoryRecall, |r| mem.recall_endpoint_async(r).await?),
            E::MemoryCreate => on!(p, MemoryCreate, |r| glue::memory_create(c, ctx, r).await?),
            E::MemorySearch => on!(p, MemorySearch, |r| mem.search_endpoint_async(r).await?),
            E::MemoryDelete => void!(p, MemoryDelete, |r| mem.delete_endpoint_async(r).await?),
            E::MemoryPreviewDelete => on!(p, MemoryPreviewDelete, |r| mem.preview_delete_endpoint_async(r).await?),
            E::RepoPrSubmit => on!(p, RepoPrSubmit, |r| c.pull.submit_pr_async(ctx.caller, &r).await?),
            E::GithubGet => ret!(ok_json(c.repo.github_status())),
            E::GithubRefresh => ret!(ok_json(c.repo.refresh_github_async().await)),
            E::RepoList => ret!(ok_json(glue::repo_list_async(c).await)),
            E::RepoValidate => on!(p, RepoValidate, |r| c.repo.validate_repo(&r)),
            E::RepoCreate => on!(p, RepoCreate, |r| c.repo.create_repo_async(&r).await?),
            E::RepoMount => on!(p, RepoMount, |r| c.repo.mount_repo_async(&r).await?),
            E::RepoUnmount => void!(p, RepoUnmount, |r| c.repo.unmount_repo_async(&r.id).await?),
            E::RepoLanguageList => on!(p, RepoLanguageList, |r| c.repo.languages_endpoint_async(&r.id).await?),
            E::RepoTemplateList => on!(p, RepoTemplateList, |r| glue::repo_templates_async(c, &r.id).await?),
            E::RepoActivityGet => on!(p, RepoActivityGet, |r| c.repo.activity_endpoint_async(&r.id).await?),
            E::SessionStop => void!(p, SessionStop, |r| wf.issue.stop_session_endpoint_async(&r.id).await?),
            E::SessionList => on!(p, SessionList, |r| rt.list_endpoint_async(r.profile, r.controller).await?),
            E::SessionGet => on!(p, SessionGet, |r| rt.get_endpoint_async(&r.id).await?),
            E::SessionEventList => on!(p, SessionEventList, |r| rt.event_list_endpoint_async(&r).await?),
            E::SessionOpenWorkspace => on!(p, SessionOpenWorkspace, |r| rt.open_workspace_endpoint_async(r).await?),
            E::SessionCloseWorkspace => void!(p, SessionCloseWorkspace, |r| rt.close_workspace_endpoint_async(&r.id).await?),
            E::SessionSend => on!(p, SessionSend, |r| glue::session_send(c, ctx, r).await?),
            E::SessionRespondPermission => void!(p, SessionRespondPermission, |r| rt.respond_permission_endpoint_async(r).await?),
            E::SessionRespondInteraction => void!(p, SessionRespondInteraction, |r| rt.respond_interaction_endpoint_async(r).await?),
            E::SessionSetConfig => on!(p, SessionSetConfig, |r| rt.set_config_endpoint_async(r).await?),
            E::SessionChildTranscript => on!(p, SessionChildTranscript, |r| rt.child_transcript_endpoint_async(r).await?),
            E::SessionCompact => on!(p, SessionCompact, |r| orch.compact_session_endpoint_async(&r.id).await?),
            E::SessionRunCode => on!(p, SessionRunCode, |r| orch.run_code_endpoint_async(r).await?),
            E::SessionEvalCreate => on!(p, SessionEvalCreate, |r| orch.eval_create_endpoint_async(r).await?),
            E::SessionApprovalList => on!(p, SessionApprovalList, |r| orch.approvals_endpoint_async(r).await?),
            E::SessionApprovalResolve => void!(p, SessionApprovalResolve, |r| orch.resolve_approval_endpoint_async(r).await?),
            E::IssueConversationGet => on!(p, IssueConversationGet, |r| wf.issue.conversation_endpoint_async(&r.id).await?),
            E::IssueCommentCreate => on!(p, IssueCommentCreate, |r| glue::issue_comment(c, r).await?),
            E::IssueDiffGet => on!(p, IssueDiffGet, |r| glue::issue_diff_req_async(c, ctx.caller, &r.id, r.since_tree.as_deref())
                .await?),
            E::IssueHistoryList => ret!(ok_json(wf.issue.history_list_endpoint_async().await?)),
            E::IssueList => on!(p, IssueList, |r| wf.issue.list_endpoint_async(&r, &*c.ctx.clock).await?),
            E::IssueReview => on!(p, IssueReview, |r| glue::issue_review(c, r).await?),
            E::IssueSplit => on!(p, IssueSplit, |r| glue::issue_split_async(c, &r).await?),
            E::IssueGet => on!(p, IssueGet, |r| wf.issue.get_endpoint_async(&r.id).await?),
            E::IssueRunList => on!(p, IssueRunList, |r| brd.issue_run_list_endpoint_async(&r.id).await?),
            E::IssueTimelineGet => on!(p, IssueTimelineGet, |r| brd.issue_timeline_endpoint_async(&r.id).await?),
            E::IssueCreate => on!(p, IssueCreate, |r| wf.issue.create_endpoint_async(&r).await?),
            E::IssueUpdate => on!(p, IssueUpdate, |r| wf.note.issue_update_async(ctx, r).await?),
            E::IssueBodyEnsure => on!(p, IssueBodyEnsure, |r| wf.note.issue_body_ensure_async(ctx, &r).await?),
            E::IssueDelete => void!(p, IssueDelete, |r| brd.issue_delete_endpoint_async(&r.id).await?),
            E::IssuePreviewDelete => on!(p, IssuePreviewDelete, |r| brd.issue_preview_delete_endpoint_async(&r.id).await?),
            E::IssueStatusUpdate => on!(p, IssueStatusUpdate, |r| glue::issue_status_update(c, &r).await?),
            E::IssueStatusPreviewUpdate => on!(p, IssueStatusPreviewUpdate, |r| brd.issue_status_preview_update_endpoint_async(&r).await?),
            E::IssueRefine => on!(p, IssueRefine, |r| wf.issue.refine_endpoint_async(&r).await?),
            E::IssueRetroGet => on!(p, IssueRetroGet, |r| brd.issue_retro_endpoint_async(&r, &*c.ctx.clock).await?),
            E::IssueDigestGet => on!(p, IssueDigestGet, |r| brd.issue_digest_get_endpoint_async(&r, &*c.ctx.clock).await?),
            E::IssueTriageList => ret!(ok_json(brd.issue_triage_list_endpoint_async(&*c.ctx.clock).await?)),
            E::IssueTriageSuggest => on!(p, IssueTriageSuggest, |r| brd
                .issue_triage_suggest_endpoint_async(ctx.caller, r, &*c.ctx.clock)
                .await?),
            E::IssueTriageConfirm => on!(p, IssueTriageConfirm, |r| wf.issue.triage_confirm_endpoint_async(&r, &*c.ctx.clock).await?),
            E::IssueTriageDismiss => void!(p, IssueTriageDismiss, |r| brd.issue_triage_dismiss_endpoint_async(&r).await?),
            E::CronCreate => on!(p, CronCreate, |r| wf.cron.create_endpoint_async(ctx.caller, r).await?),
            E::CronList => ret!(ok_json(c.cron.list_endpoint_async().await?)),
            E::CronUpdate => void!(p, CronUpdate, |r| c.cron.update_endpoint_async(&r.id, r.enabled).await?),
            E::CronDelete => void!(p, CronDelete, |r| c.cron.delete_endpoint_async(&r.id).await?),
            E::CronPreviewDelete => on!(p, CronPreviewDelete, |r| c.cron.preview_delete_endpoint_async(&r.id).await?),
            E::ChannelMessageSend => void!(p, ChannelMessageSend, |r| glue::channel_send_async(c, r).await?),
            E::ChannelCreate => on!(p, ChannelCreate, |r| ch.handle_create(r).await?),
            E::ChannelUpdate => on!(p, ChannelUpdate, |r| ch.handle_update(r).await?),
            E::ChannelMessageList => on!(p, ChannelMessageList, |r| ch.handle_message_list(r).await?),
            E::ChannelMarkRead => void!(p, ChannelMarkRead, |r| ch.handle_mark_read(r).await?),
            E::ChannelMessageUpdate => on!(p, ChannelMessageUpdate, |r| ch.handle_message_update(r).await?),
            E::ChannelMessageDelete => void!(p, ChannelMessageDelete, |r| ch.handle_message_delete(r).await?),
            E::ChannelMessagePreviewDelete => on!(p, ChannelMessagePreviewDelete, |r| ch.handle_message_preview_delete(r).await?),
            E::ChannelMessageSearch => on!(p, ChannelMessageSearch, |r| ch.handle_message_search(r).await?),
            E::ChannelReactionSet => on!(p, ChannelReactionSet, |r| ch.handle_reaction_set(r).await?),
            E::ChannelPinSet => on!(p, ChannelPinSet, |r| ch.handle_pin_set(r).await?),
            E::ChannelPinList => on!(p, ChannelPinList, |r| ch.handle_pin_list(r).await?),
            E::ChannelThreadCreate => on!(p, ChannelThreadCreate, |r| ch.handle_thread_create(r).await?),
            E::ChannelArchiveSet => void!(p, ChannelArchiveSet, |r| ch.handle_archive_set(r).await?),
            E::ChannelDelete => void!(p, ChannelDelete, |r| ch.handle_delete(r).await?),
            E::ChannelPreviewDelete => on!(p, ChannelPreviewDelete, |r| ch.handle_preview_delete(r).await?),
            E::ChannelDirectCreate => on!(p, ChannelDirectCreate, |r| glue::channel_direct_async(c, &r.agent, r.from).await?),
            E::ChannelNotifySet => void!(p, ChannelNotifySet, |r| ch.handle_notify_set(r).await?),
            E::ChannelMarkUnread => void!(p, ChannelMarkUnread, |r| ch.handle_mark_unread(r).await?),
            E::ChannelList => ret!(ok_json(ch.handle_list().await?)),
            E::ChannelUnreadList => ret!(ok_json(ch.handle_unread_list().await)),
            E::AttachmentCreate => on!(p, AttachmentCreate, |r| st.attach_async(r).await?),
            E::AttachmentImportPath => on!(p, AttachmentImportPath, |r| st.import_path_async(r).await?),
            E::MediaInputCreate => on!(p, MediaInputCreate, |r| st.create_input_async(&r).await?),
            E::MediaInputAdopt => on!(p, MediaInputAdopt, |r| st.adopt_input_async(&r.attachment).await?),
            E::MediaInputList => ret!(ok_json(st.list_inputs_async().await?)),
            E::MediaInputDelete => void!(p, MediaInputDelete, |r| st.delete_input_async(&r.id).await?),
            E::MediaInputPreviewDelete => on!(p, MediaInputPreviewDelete, |r| st.preview_delete_input_async(&r.id).await?),
            E::MediaDialogueCreate => on!(p, MediaDialogueCreate, |r| med.create_speakers_for_caller_async(ctx.caller, r).await?),
            E::MediaVoiceDesignCreate => on!(p, MediaVoiceDesignCreate, |r| med.create_voice_design_for_caller_async(ctx.caller, r).await?),
            E::MediaCloneCreate => on!(p, MediaCloneCreate, |r| med.clone_voice_async(r).await?),
            E::MediaTranscriptionCreate => on!(p, MediaTranscriptionCreate, |r| med.transcription_async(r).await?),
            E::MediaAudioResume => on!(p, MediaAudioResume, |r| med.audio_resume_async(&r.id).await?),
            E::MediaAudioPreviewCleanup => on!(p, MediaAudioPreviewCleanup, |r| med.preview_audio_cleanup_async(&r.id).await?),
            E::MediaAudioCleanup => on!(p, MediaAudioCleanup, |r| med.audio_cleanup_async(&r.id).await?),
            E::MediaImageCreate => on!(p, MediaImageCreate, |r| med.create_image_for_caller_async(ctx.caller, r).await?),
            E::MediaUnderstandingCreate => on!(p, MediaUnderstandingCreate, |r| med.understanding_async(r).await?),
            E::MediaUnderstandingAuthorize => on!(p, MediaUnderstandingAuthorize, |r| wf.note.authorize_understanding_async(r).await?),
            E::MediaUnderstandingStart => on!(p, MediaUnderstandingStart, |r| wf
                .note
                .start_understanding_for_caller_async(ctx.caller, &r.id)
                .await?),
            E::MediaSpeechCreate => on!(p, MediaSpeechCreate, |r| med.create_speech_for_caller_async(ctx.caller, r).await?),
            E::MediaSpeechResume => on!(p, MediaSpeechResume, |r| med.resume_async(&r.id).await?),
            E::MediaUnderstandingCleanup => on!(p, MediaUnderstandingCleanup, |r| med.understanding_cleanup_async(&r.id).await?),
            E::MediaJobGet => on!(p, MediaJobGet, |r| med.get_async(&r.id).await?),
            E::MediaJobCancel => on!(p, MediaJobCancel, |r| med.cancel_async(&r.id).await?),
            E::MediaJobPreviewRelease => on!(p, MediaJobPreviewRelease, |r| med.preview_release_async(&r.id).await?),
            E::MediaJobRelease => on!(p, MediaJobRelease, |r| med.release_async(&r.id).await?),
            E::MediaJobDownload => on!(p, MediaJobDownload, |r| med.retry_download_async(&r.id).await?),
            E::MediaJobList => ret!(ok_json(med.list_async().await?)),
            E::LibraryItemList => on!(p, LibraryItemList, |r| lib.list_async(&r).await?),
            E::LibraryItemAdd => on!(p, LibraryItemAdd, |r| glue::library_add_async(c, ctx, &r).await?),
            E::LibraryItemDelete => void!(p, LibraryItemDelete, |r| lib.remove_async(&r.id).await?),
            E::LibraryItemPreviewDelete => on!(p, LibraryItemPreviewDelete, |r| lib.preview_remove_async(&r.id).await?),
            E::NoteList => on!(p, NoteList, |r| wf.note.list_notes_async(&r).await?),
            E::NoteGet => on!(p, NoteGet, |r| note.get_async(&r.id).await?),
            E::NoteContentGet => on!(p, NoteContentGet, |r| note.content_async(&r.id, r.version).await?),
            E::NoteCreate => on!(p, NoteCreate, |r| wf.note.create_for_caller_async(ctx, &r).await?),
            E::NoteVersionCreate => on!(p, NoteVersionCreate, |r| wf.note.version_for_caller_async(ctx, &r).await?),
            E::NoteUpdate => on!(p, NoteUpdate, |r| note.update_async(&r).await?),
            E::NoteDelete => void!(p, NoteDelete, |r| note.remove_async(&r.id).await?),
            E::NotePreviewDelete => on!(p, NotePreviewDelete, |r| note.preview_remove_async(&r.id).await?),
            E::NoteTreeMove => on!(p, NoteTreeMove, |r| note.move_tree_async(&r).await?),
            E::NoteLinkList => on!(p, NoteLinkList, |r| note.list_links_async(&r).await?),
            E::NoteDocView => on!(p, NoteDocView, |r| note.doc_view_async(&r.id).await?),
            E::NoteDocAppendBlock => on!(p, NoteDocAppendBlock, |r| note.doc_append_block_for_caller_async(ctx, &r).await?),
            E::NoteBaseView => on!(p, NoteBaseView, |r| note.base_view_async(&r).await?),
            E::NoteBaseUpsertRow => on!(p, NoteBaseUpsertRow, |r| note.base_upsert_row_for_caller_async(ctx, &r).await?),
            E::NoteBaseRunAgentColumn => on!(p, NoteBaseRunAgentColumn, |r| wf.note.base_run_agent_column_async(ctx, &r).await?),
            E::NoteAnnotationUpsert => on!(p, NoteAnnotationUpsert, |r| note.annotation_upsert_for_caller_async(ctx, &r).await?),
            E::NoteAnnotationDelete => on!(p, NoteAnnotationDelete, |r| note.annotation_delete_for_caller_async(ctx, &r).await?),
            E::NoteBaseSyncReview => on!(p, NoteBaseSyncReview, |r| note.base_sync_review_for_caller_async(ctx, &r).await?),
            E::NoteFileList => on!(p, NoteFileList, |r| note.list_files_async(&r).await?),
            E::NoteFileGet => on!(p, NoteFileGet, |r| note.get_file_async(&r).await?),
            E::NoteFileWrite => on!(p, NoteFileWrite, |r| wf.note.write_for_caller_async(ctx, &r).await?),
            E::NoteFileDelete => on!(p, NoteFileDelete, |r| note.delete_file_for_caller_async(ctx, &r).await?),
            E::NoteSuggestionList => on!(p, NoteSuggestionList, |r| note.suggestions_async(&r.id).await?),
            E::NoteSuggestionCreate => on!(p, NoteSuggestionCreate, |r| note.create_suggestion_for_caller_async(ctx, &r).await?),
            E::NoteSuggestionAccept => on!(p, NoteSuggestionAccept, |r| note.accept_suggestion_for_caller_async(ctx, &r).await?),
            E::NoteSuggestionReject => on!(p, NoteSuggestionReject, |r| note.reject_suggestion_for_caller_async(ctx, &r).await?),
            E::NoteTypeList => ret!(ok_json(note.list_types_async().await?)),
            E::NoteTypeRead => on!(p, NoteTypeRead, |r| note.read_type_async(&r).await?),
            E::NotePresenceUpdate => on!(p, NotePresenceUpdate, |r| note.update_presence_async(&r).await?),
            E::NoteHistoryList => on!(p, NoteHistoryList, |r| note.history_list_async(&r).await?),
            E::NoteHistoryPreview => on!(p, NoteHistoryPreview, |r| note.history_preview_async(&r).await?),
            E::NoteHistoryRestore => on!(p, NoteHistoryRestore, |r| note.history_restore_for_caller_async(ctx, &r).await?),
            E::NoteHistoryFork => on!(p, NoteHistoryFork, |r| note.history_fork_for_caller_async(ctx, &r).await?),
            E::NoteHistoryUndoOrigin => on!(p, NoteHistoryUndoOrigin, |r| note.history_undo_origin_for_caller_async(ctx, &r).await?),
            E::NoteHistoryCompact => on!(p, NoteHistoryCompact, |r| note.history_compact_async(&r).await?),
            E::NoteCollabExport => on!(p, NoteCollabExport, |r| note.collab_export_async(&r).await?),
            E::NoteCollabImport => on!(p, NoteCollabImport, |r| note.collab_import_for_caller_async(ctx, &r).await?),
            E::NoteCoverSet => on!(p, NoteCoverSet, |r| note.set_cover_async(&r).await?),
            E::ConnectorLogin => on!(p, ConnectorLogin, |r| c.connector.handle_login(r).await?),
            E::ConnectorVerify => on!(p, ConnectorVerify, |r| c.connector.handle_verify(r).await?),
            E::ConnectorLogout => on!(p, ConnectorLogout, |r| c.connector.handle_logout(r).await?),
            E::ConnectorChannelSet => on!(p, ConnectorChannelSet, |r| wf.connector.handle_channel_set(r).await?),
            E::VoiceMossVerify => ret!(ok_json(c.voice.handle_moss_verify().await)),
            E::ProviderGet => ret!(ok_json(c.provider.status())),
            E::ProviderUpdate => on!(p, ProviderUpdate, |r| c.provider.update_async(&r).await?),
            E::ProviderVerify => on!(p, ProviderVerify, |r| c.provider.verify_async(&r).await?),
            E::ProviderVoiceList => on!(p, ProviderVoiceList, |r| c.provider.voices_async(&r).await?),
            E::SettingGet => ret!(ok_json(c.setting.status())),
            E::SettingValidate => on!(p, SettingValidate, |r| c.setting.validate(&r)),
            E::SettingUpdate => on!(p, SettingUpdate, |r| glue::setting_update(c, r).await?),
            E::ServerHealthGet => ret!(ok_json(glue::health(c))),
            E::DebugSnapshot => ret!(ok_json(dbg.snapshot_async().await?)),
            E::DebugTimelineList => on!(p, DebugTimelineList, |r| dbg.timeline_list(&r)?),
            E::DebugTimelineClear => ret!(dbg.timeline_clear().map(|_| Value::Null)),
            E::DebugTrajectoryList => ret!(ok_json(dbg.trajectory_list_async().await?)),
            E::DebugTrajectoryGet => on!(p, DebugTrajectoryGet, |r| dbg.trajectory_get_async(&r).await?),
            E::DebugTrajectoryExport => on!(p, DebugTrajectoryExport, |r| dbg.trajectory_export_async(&r).await?),
            E::DebugOverrideSet => on!(p, DebugOverrideSet, |r| dbg.override_set(r)?),
            E::DebugBundleExport => ret!(ok_json(dbg.bundle_export_async().await?)),
            E::RemoteStatus => ret!(ok_json(self.remote.status_async().await?)),
            E::RemoteEnable => on!(p, RemoteEnable, |r| self.remote.enable_async(r, self.server_arc()?).await?),
            E::RemoteDisable => ret!(ok_json(self.remote.disable_async().await?)),
            E::RemotePairCreate => ret!(ok_json(self.remote.pair_create()?)),
            E::RemotePairExchange => on!(p, RemotePairExchange, |r| self.remote.pair_exchange_async(r).await?),
            E::RemoteDeviceRevoke => void!(p, RemoteDeviceRevoke, |r| self.remote.revoke_device_async(r).await?),
            E::RemoteWhoami => ret!(ok_json(self.remote.whoami_async(&ctx.principal, ctx.caller).await?)),
            E::MachineList => ret!(ok_json(c.machine.list())),
            E::GameShopList => ret!(ok_json(c.game.shop_list_async().await?)),
            E::GameShopBuy => on!(p, GameShopBuy, |r| c.game.shop_buy_async(&r).await?),
        }
    }
}

impl Server for Router {
    router_methods! {
        fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> { Box::pin(async move { self.dispatch_op_async(ctx, &op, payload).await }) }
        fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> { self.core.ctx.feed.snapshot_json(slice) }
        fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> { Box::pin(flush_and_snapshot_json(self.core.ctx.clone(), slice)) }
        fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> { Some(self.core.ctx.feed.subscribe(slice)) }
        fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<SliceSubscription>> { Box::pin(flush_and_subscribe_slice(self.core.ctx.clone(), slice)) }
        fn fault_gate(&self) -> Option<SharedFaultGate> { self.gw.fault_gate.clone() }
        fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent> { bridge_live_receiver(self.core.ctx.live.subscribe_live(), self.core.ctx.token()) }
        fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<LiveEvent>> { Some(self.core.ctx.live.subscribe_live()) }
        fn subscribe_with_async(self: Arc<Self>, ctx: CallerContext, name: String, payload: Value) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> { Box::pin(async move { self.open_sub_async(&ctx, &name, payload).await }) }
        fn ports(&self) -> GatewayPorts { self.gw.ports.clone() }
        fn host_debug(&self) -> Option<SharedHostDebug> { self.gw.host_debug.clone() }
    }
    fn unsubscribe(&self, id: u64) {
        self.gw.subs.remove(id);
    }
}
