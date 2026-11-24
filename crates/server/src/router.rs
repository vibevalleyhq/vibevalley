//! Thin external [`Server`] router delegating compile-time exhaustive
//! `EndpointId` (202), `NativeEndpointId` (7), and `SUBSCRIPTIONS` (8) traffic
//! directly into domain handlers, while separating non-RPC streams into
//! [`GatewayPorts`].

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_protocol::{
    ApiError, BizCode, Caller, Endpoint, EndpointId, Envelope, Health, LiveEvent, NativeEndpointId, Op, ProviderVoiceRequest, SUBSCRIPTIONS, SliceKind,
    Subscription, SubscriptionSpec, endpoints, ops, subscriptions,
};

use crate::app::AppCore;
use crate::context::{Sink, SliceSubscription, bridge_live_receiver};
use crate::gateway::api::{BoxFuture, CallerContext, GatewayPorts, Server, SharedFaultGate, SharedHostDebug, SharedInvokeObserver, refusal};
use crate::log::{record_call, request_span, spawn_blocking_traced};

/// Immutable wiring parts assembled once in [`crate::app::create_app`].
pub(crate) struct RouterParts {
    pub core: Arc<AppCore>,
    pub ports: GatewayPorts,
    pub observer: Option<SharedInvokeObserver>,
    pub fault_gate: Option<SharedFaultGate>,
    pub host_debug: Option<SharedHostDebug>,
    pub active_subscriptions: Arc<AtomicUsize>,
}

/// Thin RPC, slice, live-event, and subscription router implementing [`Server`].
pub struct Router {
    pub(crate) core: Arc<AppCore>,
    ports: GatewayPorts,
    observer: Option<SharedInvokeObserver>,
    fault_gate: Option<SharedFaultGate>,
    host_debug: Option<SharedHostDebug>,
    active_subscriptions: Arc<AtomicUsize>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_sub_id: AtomicU64,
    next_trace_id: AtomicU64,
}

impl Router {
    pub(crate) fn new(parts: RouterParts) -> Arc<Self> {
        Arc::new(Self {
            core: parts.core,
            ports: parts.ports,
            observer: parts.observer,
            fault_gate: parts.fault_gate,
            host_debug: parts.host_debug,
            active_subscriptions: parts.active_subscriptions,
            subscriptions: Mutex::new(HashMap::new()),
            next_sub_id: AtomicU64::new(1),
            next_trace_id: AtomicU64::new(1),
        })
    }

    pub fn has_observer(&self) -> bool {
        self.observer.is_some()
    }

    pub fn has_fault_gate(&self) -> bool {
        self.fault_gate.is_some()
    }

    pub fn active_subscription_count(&self) -> u32 {
        self.subscriptions.lock().len() as u32
    }

    pub fn answers(&self, op: &str) -> bool {
        EndpointId::from_op(op).is_some() || NativeEndpointId::from_op(op).is_some()
    }

    pub fn answers_subscription(&self, name: &str) -> bool {
        SUBSCRIPTIONS.iter().any(|s| s.name == name)
    }

    pub fn slice_seqs(&self) -> std::collections::BTreeMap<String, i64> {
        self.core.ctx.feed.slice_seqs()
    }

    pub fn slice_watcher_counts(&self) -> std::collections::BTreeMap<String, u32> {
        self.core.ctx.feed.watcher_counts()
    }

    pub fn invoke<O: Op>(&self, ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Result: DeserializeOwned,
    {
        let payload = serde_json::to_value(input).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))?;
        let env = self.call_with(ctx, O::NAME, payload);
        if let Some(err) = env.error() {
            return Err(err);
        }
        let data = env.data.unwrap_or(Value::Null);
        serde_json::from_value(data).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
    }

    pub fn invoke_as<O: Op>(&self, caller: Caller, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Result: DeserializeOwned,
    {
        self.invoke::<O>(&CallerContext::from_caller(caller), input)
    }

    pub(crate) fn close_subscriptions(&self) {
        let active = std::mem::take(&mut *self.subscriptions.lock());
        self.active_subscriptions.store(0, Ordering::Release);
        drop(active);
    }

    pub fn call_as(&self, caller: Caller, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::from_caller(caller), op, payload)
    }

    pub async fn call_as_async(&self, caller: Caller, op: &str, payload: Value) -> Envelope {
        self.dispatch_op_async(CallerContext::from_caller(caller), op, payload).await
    }

    pub async fn invoke_as_async<O: Op>(&self, caller: Caller, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Result: DeserializeOwned,
    {
        let payload = serde_json::to_value(input).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))?;
        let env = self.call_as_async(caller, O::NAME, payload).await;
        if let Some(err) = env.error() {
            return Err(err);
        }
        let data = env.data.unwrap_or(Value::Null);
        serde_json::from_value(data).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
    }

    fn normalize_ctx(&self, mut ctx: CallerContext) -> CallerContext {
        if ctx.trace_id == 0 {
            ctx.trace_id = self.next_trace_id.fetch_add(1, Ordering::Relaxed);
        }
        ctx
    }

    async fn dispatch_op_async(&self, caller_ctx: CallerContext, op: &str, payload: Value) -> Envelope {
        let is_debug_op = op.starts_with("debug.");
        let observer = if is_debug_op { None } else { self.observer.as_ref() };
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
        let ctx = self.normalize_ctx(caller_ctx);
        let started = if let Some(obs) = observer {
            obs.on_call_start(&ctx, op, &payload);
            Some(Instant::now())
        } else {
            trace_debug.then(Instant::now)
        };

        let span = request_span(op, ctx.trace_id);
        let envelope = async {
            if !is_debug_op && let Some(gate) = &self.fault_gate {
                let delay = gate.delay_ms(op);
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
            self.route_op_async(&ctx, op, payload).await
        }
        .instrument(span)
        .await;

        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let Some(obs) = observer {
            obs.on_call_end(&ctx, op, envelope.biz_code, duration_us.unwrap_or(0));
        }
        record_call(op, ctx.trace_id, envelope.biz_code, duration_us.unwrap_or(0));
        envelope
    }

    async fn route_op_async(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        if let Some(id) = EndpointId::from_op(op) {
            let spec = id.spec();
            if let Some(denied) = check_can(ctx, op, spec) {
                return denied;
            }
            let payload = normalize_payload(spec, payload);
            return finish_outcome(spec, Box::pin(self.dispatch_endpoint_async(ctx, id, payload)).await);
        }
        if let Some(id) = NativeEndpointId::from_op(op) {
            let spec = id.spec();
            if let Some(denied) = check_can(ctx, op, spec) {
                return denied;
            }
            let payload = normalize_payload(spec, payload);
            return finish_outcome(spec, Box::pin(self.dispatch_native_async(id, payload)).await);
        }
        refusal(BizCode::RouteNotFound, format!("no endpoint {op}"))
    }

    async fn dispatch_native_async(&self, id: NativeEndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            NativeEndpointId::MediaInputFile | NativeEndpointId::MediaInputUploadFile | NativeEndpointId::AttachmentFile => {
                self.core.storage.dispatch_native_async(id, payload).await
            }
        }
    }

    async fn dispatch_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            // agent, skill, runtime, memory, orchestrator
            EndpointId::AgentList
            | EndpointId::AgentValidate
            | EndpointId::AgentCreate
            | EndpointId::AgentUpdate
            | EndpointId::AgentDelete
            | EndpointId::AgentPreviewDelete
            | EndpointId::AgentTemplateList
            | EndpointId::AgentTemplateInstall
            | EndpointId::AgentTemplateUpdate
            | EndpointId::AgentTemplateAdd
            | EndpointId::AgentTemplateDelete
            | EndpointId::AgentTemplatePreviewDelete
            | EndpointId::SkillList
            | EndpointId::SkillCreate
            | EndpointId::SkillUpdate
            | EndpointId::SkillDelete
            | EndpointId::SkillPreviewDelete
            | EndpointId::RuntimeList
            | EndpointId::RuntimeRefresh
            | EndpointId::RuntimeSettingUpdate
            | EndpointId::MemoryList
            | EndpointId::MemoryRecall
            | EndpointId::MemoryCreate
            | EndpointId::MemorySearch
            | EndpointId::MemoryDelete
            | EndpointId::MemoryPreviewDelete
            | EndpointId::OrchestratorOpen
            | EndpointId::OrchestratorStop
            | EndpointId::OrchestratorEvalCreate
            | EndpointId::OrchestratorApprovalList
            | EndpointId::OrchestratorApprovalResolve => self
                .core
                .agent
                .dispatch_endpoint_async(ctx, id, payload)
                .await
                .unwrap_or_else(|| Err(ApiError::new(BizCode::RouteNotFound, format!("no endpoint {}", id.as_op())))),

            // repo & github & pull
            EndpointId::RepoPrSubmit
            | EndpointId::GithubGet
            | EndpointId::GithubRefresh
            | EndpointId::RepoList
            | EndpointId::RepoValidate
            | EndpointId::RepoCreate
            | EndpointId::RepoLanguageList
            | EndpointId::RepoTemplateList
            | EndpointId::RepoActivityGet => Box::pin(self.dispatch_repo_endpoint_async(ctx, id, payload)).await,

            // session
            EndpointId::SessionStop
            | EndpointId::SessionList
            | EndpointId::SessionGet
            | EndpointId::SessionEventList
            | EndpointId::SessionOpenWorkspace
            | EndpointId::SessionCloseWorkspace
            | EndpointId::SessionSend
            | EndpointId::SessionRespondPermission
            | EndpointId::SessionRespondInteraction
            | EndpointId::SessionSetConfig
            | EndpointId::SessionChildTranscript
            | EndpointId::SessionBindingAttach
            | EndpointId::SessionBindingDetach => Box::pin(self.dispatch_session_endpoint_async(ctx, id, payload)).await,

            // issue
            EndpointId::IssueConversationGet
            | EndpointId::IssueCommentCreate
            | EndpointId::IssueDiffGet
            | EndpointId::IssueHistoryList
            | EndpointId::IssueList
            | EndpointId::IssueReview
            | EndpointId::IssueSplit
            | EndpointId::IssueGet
            | EndpointId::IssueRunList
            | EndpointId::IssueTimelineGet
            | EndpointId::IssueCreate
            | EndpointId::IssueUpdate
            | EndpointId::IssueDelete
            | EndpointId::IssuePreviewDelete
            | EndpointId::IssueStatusUpdate
            | EndpointId::IssueStatusPreviewUpdate
            | EndpointId::IssueRefine => Box::pin(self.dispatch_issue_endpoint_async(ctx, id, payload)).await,

            // cron
            EndpointId::CronCreate | EndpointId::CronList | EndpointId::CronUpdate | EndpointId::CronDelete | EndpointId::CronPreviewDelete => self
                .core
                .cron
                .dispatch_endpoint_async(ctx.caller, id, payload)
                .await
                .unwrap_or_else(|| Err(ApiError::new(BizCode::RouteNotFound, format!("no endpoint {}", id.as_op())))),

            // channel
            EndpointId::ChannelMessageSend
            | EndpointId::ChannelCreate
            | EndpointId::ChannelUpdate
            | EndpointId::ChannelDefaultSet
            | EndpointId::ChannelMessageList
            | EndpointId::ChannelMarkRead
            | EndpointId::ChannelMessageUpdate
            | EndpointId::ChannelMessageDelete
            | EndpointId::ChannelMessagePreviewDelete
            | EndpointId::ChannelMessageSearch
            | EndpointId::ChannelReactionSet
            | EndpointId::ChannelPinSet
            | EndpointId::ChannelPinList
            | EndpointId::ChannelThreadCreate
            | EndpointId::ChannelArchiveSet
            | EndpointId::ChannelDelete
            | EndpointId::ChannelPreviewDelete
            | EndpointId::ChannelDirectCreate
            | EndpointId::ChannelNotifySet
            | EndpointId::ChannelMarkUnread
            | EndpointId::ChannelList
            | EndpointId::ChannelUnreadList => Box::pin(self.dispatch_channel_endpoint_async(id, payload)).await,

            // game
            EndpointId::GameAchievementList | EndpointId::GameTitleSet => self.core.game.dispatch(id, payload).await,

            // storage (attachments + media inputs)
            EndpointId::AttachmentCreate
            | EndpointId::AttachmentImportPath
            | EndpointId::MediaInputCreate
            | EndpointId::MediaInputAdopt
            | EndpointId::MediaInputGet
            | EndpointId::MediaInputList
            | EndpointId::MediaInputDelete
            | EndpointId::MediaInputPreviewDelete => self.core.storage.dispatch_endpoint_async(id, payload).await,

            // artifact, library, media
            EndpointId::MediaDialogueCreate
            | EndpointId::MediaVoiceDesignCreate
            | EndpointId::MediaCloneCreate
            | EndpointId::MediaTranscriptionCreate
            | EndpointId::MediaAudioResume
            | EndpointId::MediaAudioPreviewCleanup
            | EndpointId::MediaAudioCleanup
            | EndpointId::MediaImageCreate
            | EndpointId::MediaUnderstandingCreate
            | EndpointId::MediaUnderstandingAuthorize
            | EndpointId::MediaUnderstandingStart
            | EndpointId::MediaSpeechCreate
            | EndpointId::MediaSpeechResume
            | EndpointId::MediaUnderstandingPreviewCleanup
            | EndpointId::MediaUnderstandingCleanup
            | EndpointId::MediaJobGet
            | EndpointId::MediaJobCancel
            | EndpointId::MediaJobPreviewRelease
            | EndpointId::MediaJobRelease
            | EndpointId::MediaJobDownload
            | EndpointId::MediaJobList
            | EndpointId::LibraryItemList
            | EndpointId::LibraryItemAdd
            | EndpointId::LibraryItemDelete
            | EndpointId::LibraryItemPreviewDelete
            | EndpointId::ArtifactList
            | EndpointId::ArtifactGet
            | EndpointId::ArtifactContentGet
            | EndpointId::ArtifactCreate
            | EndpointId::ArtifactVersionCreate
            | EndpointId::ArtifactUpdate
            | EndpointId::ArtifactDelete
            | EndpointId::ArtifactPreviewDelete
            | EndpointId::ArtifactFileList
            | EndpointId::ArtifactFileGet
            | EndpointId::ArtifactFileWrite
            | EndpointId::ArtifactFileDelete
            | EndpointId::ArtifactSuggestionList
            | EndpointId::ArtifactSuggestionCreate
            | EndpointId::ArtifactSuggestionAccept
            | EndpointId::ArtifactSuggestionReject
            | EndpointId::ArtifactTypeList
            | EndpointId::ArtifactTypeRead
            | EndpointId::ArtifactPresenceUpdate
            | EndpointId::ArtifactHistoryList
            | EndpointId::ArtifactHistoryPreview
            | EndpointId::ArtifactHistoryRestore
            | EndpointId::ArtifactHistoryFork
            | EndpointId::ArtifactHistoryUndoOrigin
            | EndpointId::ArtifactHistoryCompact => self.core.artifact.dispatch_endpoint_async(ctx, id, payload).await,

            // connector, voice, provider, setting, health, debug, remote, machine
            EndpointId::ConnectorList
            | EndpointId::ConnectorLogin
            | EndpointId::ConnectorVerify
            | EndpointId::ConnectorLogout
            | EndpointId::ConnectorChannelSet
            | EndpointId::VoiceHear
            | EndpointId::VoiceMossVerify
            | EndpointId::VoiceGrantCreate
            | EndpointId::VoiceCallStart
            | EndpointId::VoiceCallStop
            | EndpointId::VoiceCallHear
            | EndpointId::VoiceCallSay
            | EndpointId::ProviderGet
            | EndpointId::ProviderUpdate
            | EndpointId::ProviderVoiceList
            | EndpointId::ProviderModelList
            | EndpointId::SettingGet
            | EndpointId::SettingValidate
            | EndpointId::SettingUpdate
            | EndpointId::ServerHealthGet
            | EndpointId::DebugSnapshot
            | EndpointId::DebugTimelineList
            | EndpointId::DebugTimelineClear
            | EndpointId::DebugTrajectoryList
            | EndpointId::DebugTrajectoryGet
            | EndpointId::DebugGraph
            | EndpointId::DebugOverrideGet
            | EndpointId::DebugOverrideSet
            | EndpointId::DebugBundleExport
            | EndpointId::RemoteStatus
            | EndpointId::RemoteEnable
            | EndpointId::RemoteDisable
            | EndpointId::RemotePairCreate
            | EndpointId::RemotePairExchange
            | EndpointId::RemoteDeviceRevoke
            | EndpointId::RemoteWhoami
            | EndpointId::MachineList => Box::pin(self.dispatch_infra_endpoint_async(ctx, id, payload)).await,
        }
    }

    async fn dispatch_repo_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::RepoPrSubmit => {
                let req: <ops::RepoPrSubmit as Op>::Input = decode(payload)?;
                ok_json(self.core.pull.submit_pr_async(ctx.caller, &req).await?)
            }
            EndpointId::GithubGet => ok_json(self.core.repo.github_status()),
            EndpointId::GithubRefresh => ok_json(self.core.repo.refresh_github_async().await),
            EndpointId::RepoList => ok_json(self.core.repo.list_summaries_async().await),
            EndpointId::RepoValidate => {
                let req: <ops::RepoValidate as Op>::Input = decode(payload)?;
                ok_json(self.core.repo.validate_repo(&req))
            }
            EndpointId::RepoCreate => {
                let req: <ops::RepoCreate as Op>::Input = decode(payload)?;
                ok_json(self.core.repo.create_repo_async(&req).await?)
            }
            EndpointId::RepoLanguageList => {
                let req: <ops::RepoLanguageList as Op>::Input = decode(payload)?;
                ok_json(self.core.repo.languages_endpoint_async(&req.id).await?)
            }
            EndpointId::RepoTemplateList => {
                let req: <ops::RepoTemplateList as Op>::Input = decode(payload)?;
                let issues = self
                    .core
                    .board
                    .issues_async()
                    .await
                    .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
                ok_json(
                    self.core
                        .repo
                        .templates_async(&req.id, &issues, |a| self.core.agent.profile.is_orchestrator(a))
                        .await?,
                )
            }
            EndpointId::RepoActivityGet => {
                let req: <ops::RepoActivityGet as Op>::Input = decode(payload)?;
                ok_json(self.core.repo.activity_endpoint_async(&req.id).await?)
            }
            _ => unreachable!("non-repo endpoint dispatched to dispatch_repo_endpoint_async: {id:?}"),
        }
    }

    async fn dispatch_session_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::SessionStop => {
                let req: <ops::SessionStop as Op>::Input = decode(payload)?;
                self.core.runtime.stop_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionList => {
                let req: <ops::SessionList as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.list_endpoint_async(req.profile, req.controller).await?)
            }
            EndpointId::SessionGet => {
                let req: <ops::SessionGet as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.get_endpoint_async(&req.id).await?)
            }
            EndpointId::SessionEventList => {
                let req: <ops::SessionEventList as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.event_list_endpoint_async(&req).await?)
            }
            EndpointId::SessionOpenWorkspace => {
                let req: <ops::SessionOpenWorkspace as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.open_workspace_endpoint_async(req).await?)
            }
            EndpointId::SessionCloseWorkspace => {
                let req: <ops::SessionCloseWorkspace as Op>::Input = decode(payload)?;
                self.core.runtime.close_workspace_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionSend => {
                let req: <ops::SessionSend as Op>::Input = decode(payload)?;
                let trace_id = (ctx.trace_id != 0).then_some(ctx.trace_id);
                ok_json(self.core.runtime.send_workspace_endpoint_async(req, Some(&self.core.storage), trace_id).await?)
            }
            EndpointId::SessionRespondPermission => {
                let req: <ops::SessionRespondPermission as Op>::Input = decode(payload)?;
                self.core.runtime.respond_permission_endpoint_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionRespondInteraction => {
                let req: <ops::SessionRespondInteraction as Op>::Input = decode(payload)?;
                self.core.runtime.respond_interaction_endpoint_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionSetConfig => {
                let req: <ops::SessionSetConfig as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.set_config_endpoint_async(req).await?)
            }
            EndpointId::SessionChildTranscript => {
                let req: <ops::SessionChildTranscript as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.child_transcript_endpoint_async(req).await?)
            }
            EndpointId::SessionBindingAttach => {
                let req: <ops::SessionBindingAttach as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.attach_binding_endpoint_async(req).await?)
            }
            EndpointId::SessionBindingDetach => {
                let req: <ops::SessionBindingDetach as Op>::Input = decode(payload)?;
                ok_json(self.core.runtime.detach_binding_endpoint_async(req).await?)
            }
            _ => unreachable!("non-session endpoint dispatched to dispatch_session_endpoint_async: {id:?}"),
        }
    }

    async fn dispatch_issue_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::IssueConversationGet => {
                let req: <ops::IssueConversationGet as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_conversation_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueCommentCreate => {
                let req: <ops::IssueCommentCreate as Op>::Input = decode(payload)?;
                ok_json(self.core.issue_chat.comment_endpoint_async(&req.id, &req.text, req.send_key.as_deref()).await?)
            }
            EndpointId::IssueDiffGet => {
                let req: <ops::IssueDiffGet as Op>::Input = decode(payload)?;
                let game = self.core.game.clone();
                let on_reviewed = move |session_id: &str| game.reviewed(session_id);
                ok_json(
                    self.core
                        .board
                        .issue_diff_endpoint_async(ctx.caller, &req.id, req.since_tree.as_deref(), Some(&on_reviewed))
                        .await?,
                )
            }
            EndpointId::IssueHistoryList => ok_json(self.core.board.issue_history_list_endpoint_async().await?),
            EndpointId::IssueList => {
                let filter: <ops::IssueList as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_list_endpoint_async(&filter, &*self.core.ctx.clock).await?)
            }
            EndpointId::IssueReview => {
                let req: <ops::IssueReview as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_review_endpoint_async(req).await?)
            }
            EndpointId::IssueSplit => {
                let req: <ops::IssueSplit as Op>::Input = decode(payload)?;
                let split_id = self.core.board.issue_split_endpoint_async(&req).await?;
                self.core.game.on_issue_split();
                ok_json(split_id)
            }
            EndpointId::IssueGet => {
                let req: <ops::IssueGet as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_get_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueRunList => {
                let req: <ops::IssueRunList as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_run_list_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueTimelineGet => {
                let req: <ops::IssueTimelineGet as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_timeline_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueCreate => {
                let req: <ops::IssueCreate as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_create_endpoint_async(&req).await?)
            }
            EndpointId::IssueUpdate => {
                let req: <ops::IssueUpdate as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_update_endpoint_async(req).await?)
            }
            EndpointId::IssueDelete => {
                let req: <ops::IssueDelete as Op>::Input = decode(payload)?;
                self.core.board.issue_delete_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::IssuePreviewDelete => {
                let req: <ops::IssuePreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_preview_delete_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueStatusUpdate => {
                let req: <ops::IssueStatusUpdate as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_status_update_endpoint_async(&req).await?)
            }
            EndpointId::IssueStatusPreviewUpdate => {
                let req: <ops::IssueStatusPreviewUpdate as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_status_preview_update_endpoint_async(&req).await?)
            }
            EndpointId::IssueRefine => {
                let req: <ops::IssueRefine as Op>::Input = decode(payload)?;
                ok_json(self.core.board.issue_refine_endpoint_async(&req).await?)
            }
            _ => unreachable!("non-issue endpoint dispatched to dispatch_issue_endpoint_async: {id:?}"),
        }
    }

    async fn dispatch_channel_endpoint_async(&self, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::ChannelMessageSend => {
                let body: <ops::ChannelMessageSend as Op>::Input = decode(payload)?;
                let picked_agent = body.agent.as_deref().and_then(|a| self.core.agent.profile.agent(a)).map(|p| p.id);
                let game = self.core.game.clone();
                let on_station = move |station: i64| game.want(station);
                if self.core.channel.handle_message_send(body, picked_agent, Some(&on_station)).await? {
                    self.core.game.on_call_live();
                }
                Ok(Value::Null)
            }
            EndpointId::ChannelCreate => ok_json(self.core.channel.handle_create(decode(payload)?).await?),
            EndpointId::ChannelUpdate => ok_json(self.core.channel.handle_update(decode(payload)?).await?),
            EndpointId::ChannelDefaultSet => {
                self.core.channel.handle_default_set(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMessageList => ok_json(self.core.channel.handle_message_list(decode(payload)?).await?),
            EndpointId::ChannelMarkRead => {
                self.core.channel.handle_mark_read(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMessageUpdate => ok_json(self.core.channel.handle_message_update(decode(payload)?).await?),
            EndpointId::ChannelMessageDelete => {
                self.core.channel.handle_message_delete(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMessagePreviewDelete => ok_json(self.core.channel.handle_message_preview_delete(decode(payload)?).await?),
            EndpointId::ChannelMessageSearch => ok_json(self.core.channel.handle_message_search(decode(payload)?).await?),
            EndpointId::ChannelReactionSet => ok_json(self.core.channel.handle_reaction_set(decode(payload)?).await?),
            EndpointId::ChannelPinSet => ok_json(self.core.channel.handle_pin_set(decode(payload)?).await?),
            EndpointId::ChannelPinList => ok_json(self.core.channel.handle_pin_list(decode(payload)?).await?),
            EndpointId::ChannelThreadCreate => ok_json(self.core.channel.handle_thread_create(decode(payload)?).await?),
            EndpointId::ChannelArchiveSet => {
                self.core.channel.handle_archive_set(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelDelete => {
                self.core.channel.handle_delete(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelPreviewDelete => ok_json(self.core.channel.handle_preview_delete(decode(payload)?).await?),
            EndpointId::ChannelDirectCreate => {
                let req: <ops::ChannelDirectCreate as Op>::Input = decode(payload)?;
                let name = req.agent.trim();
                let profile = &self.core.agent.profile;
                let agent = profile
                    .named(name)
                    .or_else(|| profile.agent(name))
                    .or_else(|| profile.orchestrators().into_iter().find(|o| o.name == name));
                let resolved = agent.map(|a| {
                    let is_o = profile.is_orchestrator(&a.id);
                    (a, is_o)
                });
                ok_json(
                    self.core
                        .channel
                        .handle_direct_create(resolved.as_ref().map(|(a, o)| (a, *o)), &req.agent)
                        .await?,
                )
            }
            EndpointId::ChannelNotifySet => {
                self.core.channel.handle_notify_set(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMarkUnread => {
                self.core.channel.handle_mark_unread(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelList => ok_json(self.core.channel.handle_list().await?),
            EndpointId::ChannelUnreadList => ok_json(self.core.channel.handle_unread_list().await),
            _ => unreachable!("non-channel endpoint dispatched to dispatch_channel_endpoint_async: {id:?}"),
        }
    }

    async fn dispatch_infra_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::ConnectorList => ok_json(self.core.connector.handle_list().await),
            EndpointId::ConnectorLogin => ok_json(self.core.connector.handle_login(decode(payload)?).await?),
            EndpointId::ConnectorVerify => ok_json(self.core.connector.handle_verify(decode(payload)?).await?),
            EndpointId::ConnectorLogout => ok_json(self.core.connector.handle_logout(decode(payload)?).await?),
            EndpointId::ConnectorChannelSet => ok_json(self.core.connector.handle_channel_set(decode(payload)?).await?),
            EndpointId::VoiceHear => {
                self.core.voice.handle_hear(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::VoiceMossVerify => ok_json(self.core.voice.handle_moss_verify().await),
            EndpointId::VoiceGrantCreate => ok_json(self.core.voice.handle_grant_create()?),
            EndpointId::VoiceCallStart => ok_json(self.core.voice.handle_call_start(decode(payload)?)?),
            EndpointId::VoiceCallStop => {
                self.core.voice.handle_call_stop(decode(payload)?)?;
                Ok(Value::Null)
            }
            EndpointId::VoiceCallHear => {
                self.core.voice.handle_call_hear(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::VoiceCallSay => {
                self.core.voice.handle_call_say(decode(payload)?).await?;
                Ok(Value::Null)
            }
            EndpointId::ProviderGet => ok_json(self.core.provider.status()),
            EndpointId::ProviderUpdate => {
                let req: <ops::ProviderUpdate as Op>::Input = decode(payload)?;
                let provider = self.core.provider.clone();
                let status = spawn_blocking_traced(move || provider.update(&req))
                    .await
                    .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))??;
                ok_json(status)
            }
            EndpointId::ProviderVoiceList => {
                let req: ProviderVoiceRequest = decode(payload)?;
                ok_json(self.core.provider.voices_async(&req).await?)
            }
            EndpointId::ProviderModelList => {
                let req: <ops::ProviderModelList as Op>::Input = decode(payload)?;
                ok_json(self.core.provider.models_async(&req.connection, req.revision).await?)
            }
            EndpointId::SettingGet => ok_json(self.core.setting.status()),
            EndpointId::SettingValidate => {
                let req: <ops::SettingValidate as Op>::Input = decode(payload)?;
                ok_json(self.core.setting.validate(&req))
            }
            EndpointId::SettingUpdate => {
                let req: <ops::SettingUpdate as Op>::Input = decode(payload)?;
                let locale_changed = req.locale.is_some();
                let status = self.core.setting.save_async(req).await?;
                if locale_changed {
                    self.core.ctx.mark_dirty(SliceMask::ALL);
                }
                ok_json(status)
            }
            EndpointId::ServerHealthGet => ok_json(Health {
                ok: true,
                version: self.core.version.clone(),
            }),
            EndpointId::DebugSnapshot
            | EndpointId::DebugTimelineList
            | EndpointId::DebugTimelineClear
            | EndpointId::DebugTrajectoryList
            | EndpointId::DebugTrajectoryGet
            | EndpointId::DebugGraph
            | EndpointId::DebugOverrideGet
            | EndpointId::DebugOverrideSet
            | EndpointId::DebugBundleExport => self.core.debug.dispatch(id, payload).await,
            EndpointId::RemoteStatus
            | EndpointId::RemoteEnable
            | EndpointId::RemoteDisable
            | EndpointId::RemotePairCreate
            | EndpointId::RemotePairExchange
            | EndpointId::RemoteDeviceRevoke
            | EndpointId::RemoteWhoami => self.core.remote.dispatch(ctx, id, payload).await,
            EndpointId::MachineList => self.core.machine.dispatch(id),
            _ => unreachable!("non-infra endpoint dispatched to dispatch_infra_endpoint_async: {id:?}"),
        }
    }

    #[allow(clippy::result_large_err)]
    async fn open_subscription_async(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let Some(spec) = SUBSCRIPTIONS.iter().find(|s| s.name == name) else {
            return Err(refusal(BizCode::RouteNotFound, format!("no subscription {name}")));
        };
        if ctx.caller != Caller::User && !spec.can.contains(&ctx.caller) {
            return Err(refusal(BizCode::Forbidden, format!("{name} is not for the {:?}", ctx.caller)));
        }
        let payload = if payload.is_null() { Value::Object(Default::default()) } else { payload };
        let (events, rx) = flume::unbounded();
        let (stop_tx, stop) = flume::bounded(1);
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);

        if let Err(err) = self.dispatch_subscription_async(spec, payload, events, stop).await {
            return Err(Envelope::failure(&err));
        }
        let mut active = self.subscriptions.lock();
        active.insert(id, stop_tx);
        self.active_subscriptions.store(active.len(), Ordering::Release);
        Ok((id, rx))
    }

    async fn dispatch_subscription_async(
        &self,
        spec: &SubscriptionSpec,
        payload: Value,
        events: flume::Sender<Value>,
        stop: flume::Receiver<()>,
    ) -> Result<(), ApiError> {
        match spec.name {
            "channel.follow" => {
                let p: <subscriptions::ChannelFollow as Subscription>::Payload = decode(payload)?;
                self.core.channel.follow(&p.id, p.after, Sink { events, stop })
            }
            "channel.reports" => {
                let p: <subscriptions::ChannelReports as Subscription>::Payload = decode(payload)?;
                self.core.channel.reports(p.after, Sink { events, stop })
            }
            "artifact.follow" | "artifact.suggestion.follow" | "artifact.presence.follow" => {
                self.core.artifact.dispatch_subscription_async(spec.name, payload, Sink { events, stop }).await
            }
            "session.watch" => {
                let p: <subscriptions::SessionWatch as Subscription>::Payload = decode(payload)?;
                self.core.runtime.watch_session_async(p, events, stop).await
            }
            "issue.watch" => {
                let p: <subscriptions::IssueWatch as Subscription>::Payload = decode(payload)?;
                self.core.runtime.watch_issue_async(p, events, stop).await
            }
            other => Err(ApiError::new(BizCode::RouteNotFound, format!("no subscription {other}"))),
        }
    }
}

impl Server for Router {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::local(), op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        vibevalley_runtime::rt::block_on(self.dispatch_op_async(ctx.clone(), op, payload))
    }

    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        Box::pin(async move { self.dispatch_op_async(ctx, &op, payload).await })
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        self.core.ctx.feed.snapshot_value(slice)
    }

    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        self.core.ctx.feed.snapshot_json(slice)
    }

    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move {
            if self.core.ctx.feed.feed(slice).seq() < self.core.ctx.feed.dirty_seq(slice) {
                self.core.ctx.feed.flush().await;
            }
            self.core.ctx.feed.snapshot_json(slice)
        })
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        self.core
            .ctx
            .feed
            .feed(slice)
            .watch_since_with_gate(after_seq, self.fault_gate.as_ref(), stop, receive);
    }

    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        Some(self.core.ctx.feed.subscribe(slice))
    }

    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<SliceSubscription>> {
        Box::pin(async move {
            if self.core.ctx.feed.feed(slice).seq() < self.core.ctx.feed.dirty_seq(slice) {
                self.core.ctx.feed.flush().await;
            }
            Some(self.core.ctx.feed.subscribe(slice))
        })
    }

    fn fault_gate(&self) -> Option<SharedFaultGate> {
        self.fault_gate.clone()
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        bridge_live_receiver(self.core.ctx.live.subscribe_live(), self.core.ctx.token())
    }

    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<LiveEvent>> {
        Some(self.core.ctx.live.subscribe_live())
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.subscribe_with(&CallerContext::local(), name, payload)
    }

    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        vibevalley_runtime::rt::block_on(self.open_subscription_async(ctx, name, payload))
    }

    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, flume::Receiver<Value>), Envelope>> {
        Box::pin(async move { self.open_subscription_async(&ctx, &name, payload).await })
    }

    fn unsubscribe(&self, id: u64) {
        let mut active = self.subscriptions.lock();
        active.remove(&id);
        self.active_subscriptions.store(active.len(), Ordering::Release);
    }

    fn ports(&self) -> GatewayPorts {
        self.ports.clone()
    }

    fn host_debug(&self) -> Option<SharedHostDebug> {
        self.host_debug.clone()
    }
}

fn check_can(ctx: &CallerContext, op: &str, spec: &Endpoint) -> Option<Envelope> {
    if ctx.caller != Caller::User && !spec.can.contains(&ctx.caller) {
        Some(refusal(BizCode::Forbidden, format!("{op} is not for the {:?}", ctx.caller)))
    } else {
        None
    }
}

fn normalize_payload(spec: &Endpoint, payload: Value) -> Value {
    match (spec.input, payload) {
        (None, _) => Value::Null,
        (Some(_), Value::Null) => Value::Object(Default::default()),
        (Some(_), p) => p,
    }
}

fn finish_outcome(spec: &Endpoint, outcome: Result<Value, ApiError>) -> Envelope {
    match outcome {
        Ok(data) if spec.result.is_none() => {
            let _ = data;
            Envelope::void()
        }
        Ok(data) => Envelope::ok(data),
        Err(err) => Envelope::failure(&err),
    }
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_path_to_error::deserialize(payload).map_err(|e| {
        let path = e.path().to_string();
        let problem = e.into_inner().to_string();
        let message = if path == "." || path.is_empty() {
            problem
        } else {
            format!("{path}: {problem}")
        };
        ApiError::new(BizCode::InvalidInput, message)
    })
}

/// Checks at compile time that `ENDPOINTS` table compiles cleanly alongside [`EndpointId`].
#[allow(dead_code)]
const fn assert_endpoints_covered() {
    let _ = endpoints::ENDPOINTS.len();
}
