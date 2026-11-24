//! Typed external door (`ServerDoor`) implementing [`crate::transport::api::Server`].
//!
//! Dispatches all 202 protocol endpoints via compile-time exhaustive
//! `match EndpointId`, plus the 7 native endpoints and 8 subscriptions, with
//! unified `CallerContext` RBAC, `InvokeObserver`, `FaultGate`, and immutable
//! transport port handles (zero `attach_*` setters, zero runtime handler maps).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::native::{NATIVE_ENDPOINTS, native_ops};
use vibevalley_protocol::{
    ApiError, ArtifactListRequest, ArtifactMarkdown, BizCode, Caller, ChannelUpdate, ConnectorLogin, Endpoint, EndpointId, Envelope, LiveEvent, Op,
    ProviderVoiceRequest, SUBSCRIPTIONS, SliceKind, SubscriptionSpec, USER_ID, endpoints, ops, subscriptions,
};

use crate::app::App;
use crate::app::live::bridge_live_receiver;
use crate::app::refusal::{AsyncRequestKeys, LookIn, missing};
use crate::app::slice::SliceSubscription;
use crate::collab;
use crate::content::artifact::Maker;
use crate::content::library::AddedBy;
use crate::infra;
use crate::transport::api::{
    BoxFuture, CallerContext, Server, SharedFaultGate, SharedHostDebug, SharedInvokeObserver, SharedLiveVoice, SharedMachineBus, SharedMcp, SharedRemoteAuth,
    media::{SharedMediaInputs, SharedSpeechStreams},
    refusal as envelope_refusal,
};
use crate::{Sink, spawn_blocking_traced};

/// Immutable wiring parts assembled once in `app::bootstrap`.
pub(crate) struct DoorParts {
    pub app: Arc<App>,
    pub mcp: SharedMcp,
    pub remote: SharedRemoteAuth,
    pub machine: SharedMachineBus,
    pub media_input: SharedMediaInputs,
    pub voice: SharedLiveVoice,
    pub speech: SharedSpeechStreams,
    pub observer: Option<SharedInvokeObserver>,
    pub fault_gate: Option<SharedFaultGate>,
    pub host_debug: Option<SharedHostDebug>,
    pub active_subscriptions: Arc<AtomicUsize>,
}

/// Single server external door implementing [`Server`].
pub struct ServerDoor {
    pub(crate) app: Arc<App>,
    mcp: SharedMcp,
    remote: SharedRemoteAuth,
    machine: SharedMachineBus,
    media_input: SharedMediaInputs,
    voice: SharedLiveVoice,
    speech: SharedSpeechStreams,
    observer: Option<SharedInvokeObserver>,
    fault_gate: Option<SharedFaultGate>,
    host_debug: Option<SharedHostDebug>,
    active_subscriptions: Arc<AtomicUsize>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_sub_id: AtomicU64,
    next_trace_id: AtomicU64,
    channel_thread_keys: AsyncRequestKeys<String>,
}

impl ServerDoor {
    pub(crate) fn new(parts: DoorParts) -> Arc<Self> {
        Arc::new(Self {
            app: parts.app,
            mcp: parts.mcp,
            remote: parts.remote,
            machine: parts.machine,
            media_input: parts.media_input,
            voice: parts.voice,
            speech: parts.speech,
            observer: parts.observer,
            fault_gate: parts.fault_gate,
            host_debug: parts.host_debug,
            active_subscriptions: parts.active_subscriptions,
            subscriptions: Mutex::new(HashMap::new()),
            next_sub_id: AtomicU64::new(1),
            next_trace_id: AtomicU64::new(1),
            channel_thread_keys: AsyncRequestKeys::default(),
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

    pub fn on_system_wake(&self) {
        self.app.runtime.notify_wake();
    }

    pub fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.app.runtime.subscribe_wake()
    }

    pub fn wake_count(&self) -> u64 {
        self.app.runtime.wake_count()
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
        if env.biz_code != 0 {
            return Err(ApiError {
                biz_code: env.biz_code_enum(),
                message: env.message,
                detail: env.detail.unwrap_or_default(),
            });
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

        let span = tracing::debug_span!("server.op", op, trace_id = ctx.trace_id);
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
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(&ctx, op, envelope.biz_code, us);
        }
        if trace_debug {
            tracing::debug!(
                op,
                biz_code = envelope.biz_code,
                trace_id = ctx.trace_id,
                duration_us = duration_us.unwrap_or(0),
                "server.call"
            );
        }
        envelope
    }

    async fn route_op_async(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        if let Some(id) = EndpointId::from_op(op) {
            let spec = id.spec();
            if let Some(denied) = check_can(ctx, op, spec) {
                return denied;
            }
            let payload = normalize_payload(spec, payload);
            return finish_outcome(spec, self.dispatch_endpoint_id_async(ctx, id, payload).await);
        }
        if let Some(spec) = NATIVE_ENDPOINTS.iter().find(|e| e.op == op) {
            if let Some(denied) = check_can(ctx, op, spec) {
                return denied;
            }
            let payload = normalize_payload(spec, payload);
            return finish_outcome(spec, self.dispatch_native_op_async(op, payload).await);
        }
        envelope_refusal(BizCode::RouteNotFound, format!("no endpoint {op}"))
    }

    async fn dispatch_native_op_async(&self, op: &str, payload: Value) -> Result<Value, ApiError> {
        match op {
            "media.input.file" => {
                let req: <native_ops::MediaInputFile as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.content_async(&req.id).await?)
            }
            "media.input.uploadFile" => {
                let req: <native_ops::MediaInputUploadFile as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.upload_file_async(&req.id, PathBuf::from(req.path)).await?)
            }
            "attachment.file" => {
                let req: <native_ops::AttachmentFile as Op>::Input = decode(payload)?;
                ok_json(self.app.attachment.file_async(&req.id).await?)
            }
            "artifact.page" => {
                let req: <native_ops::ArtifactPage as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.page_async(&req).await?)
            }
            "artifact.view" => {
                let req: <native_ops::ArtifactView as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.view_async(&req).await?)
            }
            "artifact.entry.writeProps" => {
                let req: <native_ops::ArtifactEntryWriteProps as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.write_entry_props_async(&Maker::user(), &req).await?)
            }
            "artifact.tokens.inspect" => {
                let req: <native_ops::ArtifactTokensInspect as Op>::Input = decode(payload)?;
                ok_json(crate::content::artifact::ArtifactStore::inspect_tokens(&req))
            }
            _ => Err(ApiError::new(BizCode::RouteNotFound, format!("no native endpoint {op}"))),
        }
    }

    #[allow(clippy::too_many_lines, reason = "compile-time exhaustive 202-endpoint door dispatch")]
    async fn dispatch_endpoint_id_async(&self, ctx: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            // agent & skill & runtime
            EndpointId::AgentList => ok_json(self.app.agent.profiles.all()),
            EndpointId::AgentValidate => {
                let req: <ops::AgentValidate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.validate(&req.agents))
            }
            EndpointId::AgentCreate => {
                let req: <ops::AgentCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_create_async(req).await?)
            }
            EndpointId::AgentUpdate => {
                let req: <ops::AgentUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_update_async(req).await?)
            }
            EndpointId::AgentDelete => {
                let req: <ops::AgentDelete as Op>::Input = decode(payload)?;
                self.app.agent.agent_delete_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::AgentPreviewDelete => {
                let req: <ops::AgentPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_preview_delete_async(&req.id).await?)
            }
            EndpointId::AgentTemplateList => ok_json(self.app.agent.profiles.templates()),
            EndpointId::AgentTemplateInstall => {
                let req: <ops::AgentTemplateInstall as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_template_install_async(&req.id, req.runtime.as_deref()).await?)
            }
            EndpointId::AgentTemplateUpdate => {
                let req: <ops::AgentTemplateUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_template_update_async(&req.agent).await?)
            }
            EndpointId::AgentTemplateAdd => {
                let req: <ops::AgentTemplateAdd as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_template_add_async(&req.path).await?)
            }
            EndpointId::AgentTemplateDelete => {
                let req: <ops::AgentTemplateDelete as Op>::Input = decode(payload)?;
                self.app.agent.agent_template_delete_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::AgentTemplatePreviewDelete => {
                let req: <ops::AgentTemplatePreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.agent_template_preview_delete_async(&req.id).await?)
            }
            EndpointId::SkillList => ok_json(self.app.agent.profiles.skills()),
            EndpointId::SkillCreate => {
                let req: <ops::SkillCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.skill_create_async(req).await?)
            }
            EndpointId::SkillUpdate => {
                let req: <ops::SkillUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.skill_update_async(req).await?)
            }
            EndpointId::SkillDelete => {
                let req: <ops::SkillDelete as Op>::Input = decode(payload)?;
                self.app.agent.skill_delete_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::SkillPreviewDelete => {
                let req: <ops::SkillPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.skill_preview_delete_async(&req.id).await?)
            }
            EndpointId::RuntimeList => ok_json(self.app.agent.fleet.runtimes()),
            EndpointId::RuntimeRefresh => {
                let req: <ops::RuntimeRefresh as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.runtime_refresh_async(&req.id).await?)
            }
            EndpointId::RuntimeSettingUpdate => {
                let req: <ops::RuntimeSettingUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.agent.runtime_setting_update_async(&req.id, req.settings).await?)
            }

            // memory
            EndpointId::MemoryList => {
                let req: <ops::MemoryList as Op>::Input = decode(payload)?;
                ok_json(self.app.memory.list_for_door_async(req).await?)
            }
            EndpointId::MemoryRecall => {
                let req: <ops::MemoryRecall as Op>::Input = decode(payload)?;
                ok_json(self.app.memory.recall_for_door_async(req).await?)
            }
            EndpointId::MemoryCreate => {
                let req: <ops::MemoryCreate as Op>::Input = decode(payload)?;
                let client_id = ctx.client.as_ref().map(|c| c.id.as_str());
                ok_json(self.app.memory.create_for_caller_async(ctx.caller, client_id, req).await?)
            }
            EndpointId::MemorySearch => {
                let req: <ops::MemorySearch as Op>::Input = decode(payload)?;
                ok_json(self.app.memory.search_for_door_async(req).await?)
            }
            EndpointId::MemoryDelete => {
                let req: <ops::MemoryDelete as Op>::Input = decode(payload)?;
                self.app.memory.delete_for_door_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::MemoryPreviewDelete => {
                let req: <ops::MemoryPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.memory.preview_delete_for_door_async(req).await?)
            }

            // repo & github
            EndpointId::RepoPrSubmit => {
                let req: <ops::RepoPrSubmit as Op>::Input = decode(payload)?;
                ok_json(self.app.pull.submit_pr_async(ctx.caller, &req).await?)
            }
            EndpointId::GithubGet => ok_json(self.app.repo.github_status()),
            EndpointId::GithubRefresh => ok_json(self.app.repo.refresh_github_async().await),
            EndpointId::RepoList => ok_json(self.app.repo.list_summaries_async().await),
            EndpointId::RepoValidate => {
                let req: <ops::RepoValidate as Op>::Input = decode(payload)?;
                ok_json(self.app.repo.validate_repo(&req))
            }
            EndpointId::RepoCreate => {
                let req: <ops::RepoCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.repo.create_repo_async(&req).await?)
            }
            EndpointId::RepoLanguageList => {
                let req: <ops::RepoLanguageList as Op>::Input = decode(payload)?;
                ok_json(self.app.repo.languages_endpoint_async(&req.id).await?)
            }
            EndpointId::RepoTemplateList => {
                let req: <ops::RepoTemplateList as Op>::Input = decode(payload)?;
                let issues = self
                    .app
                    .issue
                    .issues_async()
                    .await
                    .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
                ok_json(self.app.repo.templates_endpoint_async(&req.id, &issues, &self.app.agent).await?)
            }
            EndpointId::RepoActivityGet => {
                let req: <ops::RepoActivityGet as Op>::Input = decode(payload)?;
                ok_json(self.app.repo.activity_endpoint_async(&req.id).await?)
            }

            // session
            EndpointId::SessionStop => {
                let req: <ops::SessionStop as Op>::Input = decode(payload)?;
                self.app.session.stop_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionList => {
                let req: <ops::SessionList as Op>::Input = decode(payload)?;
                ok_json(self.app.session.list_endpoint_async(req.profile, req.controller).await?)
            }
            EndpointId::SessionGet => {
                let req: <ops::SessionGet as Op>::Input = decode(payload)?;
                ok_json(self.app.session.get_endpoint_async(&req.id).await?)
            }
            EndpointId::SessionEventList => {
                let req: <ops::SessionEventList as Op>::Input = decode(payload)?;
                ok_json(self.app.session.event_list_endpoint_async(&req).await?)
            }
            EndpointId::SessionOpenWorkspace => {
                let req: <ops::SessionOpenWorkspace as Op>::Input = decode(payload)?;
                ok_json(self.app.session.open_workspace_endpoint_async(req).await?)
            }
            EndpointId::SessionCloseWorkspace => {
                let req: <ops::SessionCloseWorkspace as Op>::Input = decode(payload)?;
                self.app.session.close_workspace_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionSend => {
                let req: <ops::SessionSend as Op>::Input = decode(payload)?;
                let trace_id = (ctx.trace_id != 0).then_some(ctx.trace_id);
                ok_json(
                    self.app
                        .session
                        .send_workspace_endpoint_async(req, Some(&self.app.attachment), trace_id)
                        .await?,
                )
            }
            EndpointId::SessionRespondPermission => {
                let req: <ops::SessionRespondPermission as Op>::Input = decode(payload)?;
                self.app.session.respond_permission_endpoint_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionRespondInteraction => {
                let req: <ops::SessionRespondInteraction as Op>::Input = decode(payload)?;
                self.app.session.respond_interaction_endpoint_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::SessionSetConfig => {
                let req: <ops::SessionSetConfig as Op>::Input = decode(payload)?;
                ok_json(self.app.session.set_config_endpoint_async(req).await?)
            }
            EndpointId::SessionChildTranscript => {
                let req: <ops::SessionChildTranscript as Op>::Input = decode(payload)?;
                ok_json(self.app.session.child_transcript_endpoint_async(req).await?)
            }
            EndpointId::SessionBindingAttach => {
                let req: <ops::SessionBindingAttach as Op>::Input = decode(payload)?;
                ok_json(self.app.session.attach_binding_endpoint_async(req).await?)
            }
            EndpointId::SessionBindingDetach => {
                let req: <ops::SessionBindingDetach as Op>::Input = decode(payload)?;
                ok_json(self.app.session.detach_binding_endpoint_async(req).await?)
            }

            // issue
            EndpointId::IssueConversationGet => {
                let req: <ops::IssueConversationGet as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_conversation_endpoint_async(Some(&*self.app.channel), &req.id).await?)
            }
            EndpointId::IssueCommentCreate => {
                let req: <ops::IssueCommentCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_comment_endpoint_async(&req.id, &req.text).await?)
            }
            EndpointId::IssueDiffGet => {
                let req: <ops::IssueDiffGet as Op>::Input = decode(payload)?;
                let game = self.app.game.clone();
                let on_reviewed = move |session_id: &str| game.reviewed(session_id);
                ok_json(
                    self.app
                        .issue
                        .issue_diff_endpoint_async(ctx.caller, &req.id, req.since_tree.as_deref(), Some(&on_reviewed))
                        .await?,
                )
            }
            EndpointId::IssueHistoryList => ok_json(self.app.issue.issue_history_list_endpoint_async().await?),
            EndpointId::IssueList => {
                let filter: <ops::IssueList as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_list_endpoint_async(&filter, &*self.app.clock).await?)
            }
            EndpointId::IssueReview => {
                let req: <ops::IssueReview as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_review_endpoint_async(req).await?)
            }
            EndpointId::IssueSplit => {
                let req: <ops::IssueSplit as Op>::Input = decode(payload)?;
                let split_id = self.app.issue.issue_split_endpoint_async(&req).await?;
                self.app.game.on_issue_split();
                ok_json(split_id)
            }
            EndpointId::IssueGet => {
                let req: <ops::IssueGet as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_get_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueRunList => {
                let req: <ops::IssueRunList as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_run_list_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueTimelineGet => {
                let req: <ops::IssueTimelineGet as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_timeline_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueCreate => {
                let req: <ops::IssueCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_create_endpoint_async(Some(&self.app.agent), &req).await?)
            }
            EndpointId::IssueUpdate => {
                let req: <ops::IssueUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_update_endpoint_async(Some(&self.app.agent), req).await?)
            }
            EndpointId::IssueDelete => {
                let req: <ops::IssueDelete as Op>::Input = decode(payload)?;
                self.app.issue.issue_delete_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::IssuePreviewDelete => {
                let req: <ops::IssuePreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_preview_delete_endpoint_async(&req.id).await?)
            }
            EndpointId::IssueStatusUpdate => {
                let req: <ops::IssueStatusUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_status_update_endpoint_async(Some(&self.app.agent), &req).await?)
            }
            EndpointId::IssueStatusPreviewUpdate => {
                let req: <ops::IssueStatusPreviewUpdate as Op>::Input = decode(payload)?;
                ok_json(
                    self.app
                        .issue
                        .issue_status_preview_update_endpoint_async(Some(&self.app.agent), &req)
                        .await?,
                )
            }
            EndpointId::IssueRefine => {
                let req: <ops::IssueRefine as Op>::Input = decode(payload)?;
                ok_json(self.app.issue.issue_refine_endpoint_async(Some(&*self.app.channel), &req).await?)
            }

            // cron
            EndpointId::CronCreate => {
                let req: <ops::CronCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.cron.create_endpoint_async(ctx.caller, req).await?)
            }
            EndpointId::CronList => ok_json(self.app.cron.list_endpoint_async().await?),
            EndpointId::CronUpdate => {
                let req: <ops::CronUpdate as Op>::Input = decode(payload)?;
                self.app.cron.update_endpoint_async(&req.id, req.enabled).await?;
                Ok(Value::Null)
            }
            EndpointId::CronDelete => {
                let req: <ops::CronDelete as Op>::Input = decode(payload)?;
                self.app.cron.delete_endpoint_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::CronPreviewDelete => {
                let req: <ops::CronPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.cron.preview_delete_endpoint_async(&req.id).await?)
            }

            // channel
            EndpointId::ChannelMessageSend => {
                let body: <ops::ChannelMessageSend as Op>::Input = decode(payload)?;
                let game = self.app.game.clone();
                let on_station: Arc<dyn Fn(i64) + Send + Sync> = Arc::new(move |station| game.want(station));
                let was_idle = self.app.live.call_snapshot().0 != vibevalley_protocol::CallState::Live;
                collab::channel::send_message_async(&self.app.channel, &self.app.agent, body, Some(&on_station)).await?;
                if was_idle && self.app.live.call_snapshot().0 == vibevalley_protocol::CallState::Live {
                    self.app.game.on_call_live();
                }
                Ok(Value::Null)
            }
            EndpointId::ChannelCreate => {
                let req: <ops::ChannelCreate as Op>::Input = decode(payload)?;
                let created = self
                    .app
                    .channel
                    .open_channel_async(&req.name, req.description.as_deref().unwrap_or(""), req.repo.as_deref().unwrap_or(""))
                    .await?;
                ok_json(created.id)
            }
            EndpointId::ChannelUpdate => {
                let req: <ops::ChannelUpdate as Op>::Input = decode(payload)?;
                ok_json(
                    self.app
                        .channel
                        .update_channel_async(
                            &req.id,
                            ChannelUpdate {
                                description: req.description,
                                repo: req.repo,
                                name: req.name,
                                category: req.category,
                                before: req.before,
                                members: req.members,
                            },
                        )
                        .await?,
                )
            }
            EndpointId::ChannelDefaultSet => {
                let req: <ops::ChannelDefaultSet as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.make_default_async(&req.id).await?)
            }
            EndpointId::ChannelMessageList => {
                let req: <ops::ChannelMessageList as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.history_async(&req.id, req.before, req.limit).await?)
            }
            EndpointId::ChannelMarkRead => {
                let req: <ops::ChannelMarkRead as Op>::Input = decode(payload)?;
                self.app
                    .channel
                    .mark_read_async(&req.id, req.number)
                    .await
                    .map_err(|e| ApiError::new(BizCode::ChannelNotFound, e.message).with_next(vec![LookIn::Channel.next()]))?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMessageUpdate => {
                let req: <ops::ChannelMessageUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.edit_async(&req.id, &req.text, req.attachments.as_deref()).await?)
            }
            EndpointId::ChannelMessageDelete => {
                let req: <ops::ChannelMessageDelete as Op>::Input = decode(payload)?;
                self.app.channel.remove_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelMessagePreviewDelete => {
                let req: <ops::ChannelMessagePreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.preview_remove_async(&req.id).await?)
            }
            EndpointId::ChannelMessageSearch => {
                let req: <ops::ChannelMessageSearch as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.search_async(&req.text, req.channel.as_deref()).await?)
            }
            EndpointId::ChannelReactionSet => {
                let req: <ops::ChannelReactionSet as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.react_async(&req.id, USER_ID, &req.emoji, req.on).await?)
            }
            EndpointId::ChannelPinSet => {
                let req: <ops::ChannelPinSet as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.pin_async(&req.id, req.on).await?)
            }
            EndpointId::ChannelPinList => {
                let req: <ops::ChannelPinList as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.pins_async(&req.id).await?)
            }
            EndpointId::ChannelThreadCreate => {
                let req: <ops::ChannelThreadCreate as Op>::Input = decode(payload)?;
                let thread = self
                    .channel_thread_keys
                    .once(req.request_key.as_deref(), self.app.channel.thread_under_async(&req.id))
                    .await?;
                ok_json(thread)
            }
            EndpointId::ChannelArchiveSet => {
                let req: <ops::ChannelArchiveSet as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.archive_async(&req.id, req.on).await?)
            }
            EndpointId::ChannelDelete => {
                let req: <ops::ChannelDelete as Op>::Input = decode(payload)?;
                self.app.channel.remove_channel_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelPreviewDelete => {
                let req: <ops::ChannelPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.preview_remove_channel_async(&req.id).await?)
            }
            EndpointId::ChannelDirectCreate => {
                let req: <ops::ChannelDirectCreate as Op>::Input = decode(payload)?;
                ok_json(collab::channel::direct_async(&self.app.channel, &self.app.agent, &req.agent).await?)
            }
            EndpointId::ChannelNotifySet => {
                let req: <ops::ChannelNotifySet as Op>::Input = decode(payload)?;
                ok_json(self.app.channel.set_notify_async(&req.id, req.notify).await?)
            }
            EndpointId::ChannelMarkUnread => {
                let req: <ops::ChannelMarkUnread as Op>::Input = decode(payload)?;
                self.app.channel.mark_unread_async(&req.id, req.number).await?;
                Ok(Value::Null)
            }
            EndpointId::ChannelList => ok_json(self.app.channel.list_async().await?),
            EndpointId::ChannelUnreadList => ok_json(self.app.channel.unread_async(USER_ID, None).await),

            // connector
            EndpointId::ConnectorList => ok_json(self.app.connector.list_async().await),
            EndpointId::ConnectorLogin => {
                let req: <ops::ConnectorLogin as Op>::Input = decode(payload)?;
                let id = collab::connector::app_of(&req.id)?;
                ok_json(
                    self.app
                        .connector
                        .login_async(
                            id,
                            ConnectorLogin {
                                force: req.force.unwrap_or(false),
                                app_id: req.app_id,
                                secret: req.secret,
                            },
                        )
                        .await,
                )
            }
            EndpointId::ConnectorVerify => {
                let req: <ops::ConnectorVerify as Op>::Input = decode(payload)?;
                let id = collab::connector::app_of(&req.id)?;
                ok_json(self.app.connector.verify_async(id, &req.code).await)
            }
            EndpointId::ConnectorLogout => {
                let req: <ops::ConnectorLogout as Op>::Input = decode(payload)?;
                let id = collab::connector::app_of(&req.id)?;
                ok_json(self.app.connector.logout_async(id).await)
            }
            EndpointId::ConnectorChannelSet => {
                let req: <ops::ConnectorChannelSet as Op>::Input = decode(payload)?;
                let id = collab::connector::app_of(&req.id)?;
                ok_json(self.app.connector.set_channel_async(id, &req.channel).await?)
            }

            // game
            EndpointId::GameAchievementList => ok_json(self.app.game.achievements_async().await?),
            EndpointId::GameTitleSet => {
                let req: <ops::GameTitleSet as Op>::Input = decode(payload)?;
                self.app.game.set_title_async(req).await?;
                Ok(Value::Null)
            }

            // media & library
            EndpointId::MediaDialogueCreate => {
                let req: <ops::MediaDialogueCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.create_speakers_for_caller_async(ctx.caller, req).await?)
            }
            EndpointId::MediaVoiceDesignCreate => {
                let req: <ops::MediaVoiceDesignCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.create_voice_design_for_caller_async(ctx.caller, req).await?)
            }
            EndpointId::MediaCloneCreate => {
                let req: <ops::MediaCloneCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.clone_voice_async(req).await?)
            }
            EndpointId::MediaTranscriptionCreate => {
                let req: <ops::MediaTranscriptionCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.transcription_async(req).await?)
            }
            EndpointId::MediaAudioResume => {
                let req: <ops::MediaAudioResume as Op>::Input = decode(payload)?;
                ok_json(self.app.media.audio_resume_async(&req.id).await?)
            }
            EndpointId::MediaAudioPreviewCleanup => {
                let req: <ops::MediaAudioPreviewCleanup as Op>::Input = decode(payload)?;
                ok_json(self.app.media.preview_audio_cleanup_async(&req.id).await?)
            }
            EndpointId::MediaAudioCleanup => {
                let req: <ops::MediaAudioCleanup as Op>::Input = decode(payload)?;
                self.app.media.audio_cleanup_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaInputCreate => {
                let req: <ops::MediaInputCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.create_async(&req).await?)
            }
            EndpointId::MediaInputAdopt => {
                let req: <ops::MediaInputAdopt as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.adopt_async(&req.attachment).await?)
            }
            EndpointId::MediaInputGet => {
                let req: <ops::MediaInputGet as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.get_async(&req.id).await?)
            }
            EndpointId::MediaInputList => ok_json(self.app.media_input.list_async().await?),
            EndpointId::MediaInputDelete => {
                let req: <ops::MediaInputDelete as Op>::Input = decode(payload)?;
                self.app.media_input.delete_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaInputPreviewDelete => {
                let req: <ops::MediaInputPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.media_input.preview_delete_async(&req.id).await?)
            }
            EndpointId::MediaImageCreate => {
                let req: <ops::MediaImageCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.create_image_for_caller_async(ctx.caller, req).await?)
            }
            EndpointId::MediaUnderstandingCreate => {
                let req: <ops::MediaUnderstandingCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.understanding_async(req).await?)
            }
            EndpointId::MediaUnderstandingAuthorize => {
                let req: <ops::MediaUnderstandingAuthorize as Op>::Input = decode(payload)?;
                ok_json(self.app.media.authorize_understanding_async(req).await?)
            }
            EndpointId::MediaUnderstandingStart => {
                let req: <ops::MediaUnderstandingStart as Op>::Input = decode(payload)?;
                ok_json(self.app.media.start_understanding_for_caller_async(ctx.caller, &req.id).await?)
            }
            EndpointId::MediaSpeechCreate => {
                let req: <ops::MediaSpeechCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.media.create_speech_for_caller_async(ctx.caller, req).await?)
            }
            EndpointId::MediaSpeechResume => {
                let req: <ops::MediaSpeechResume as Op>::Input = decode(payload)?;
                ok_json(self.app.media.resume_async(&req.id).await?)
            }
            EndpointId::MediaUnderstandingPreviewCleanup => {
                let req: <ops::MediaUnderstandingPreviewCleanup as Op>::Input = decode(payload)?;
                ok_json(self.app.media.preview_understanding_cleanup_async(&req.id).await?)
            }
            EndpointId::MediaUnderstandingCleanup => {
                let req: <ops::MediaUnderstandingCleanup as Op>::Input = decode(payload)?;
                self.app.media.understanding_cleanup_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaJobGet => {
                let req: <ops::MediaJobGet as Op>::Input = decode(payload)?;
                ok_json(self.app.media.get_async(&req.id).await?)
            }
            EndpointId::MediaJobCancel => {
                let req: <ops::MediaJobCancel as Op>::Input = decode(payload)?;
                ok_json(self.app.media.cancel_async(&req.id).await?)
            }
            EndpointId::MediaJobPreviewRelease => {
                let req: <ops::MediaJobPreviewRelease as Op>::Input = decode(payload)?;
                ok_json(self.app.media.preview_release_async(&req.id).await?)
            }
            EndpointId::MediaJobRelease => {
                let req: <ops::MediaJobRelease as Op>::Input = decode(payload)?;
                self.app.media.release_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaJobDownload => {
                let req: <ops::MediaJobDownload as Op>::Input = decode(payload)?;
                ok_json(self.app.media.retry_download_async(&req.id).await?)
            }
            EndpointId::MediaJobList => ok_json(self.app.media.list_async().await?),
            EndpointId::LibraryItemList => {
                let req: <ops::LibraryItemList as Op>::Input = decode(payload)?;
                ok_json(self.app.library.list_async(&req).await?)
            }
            EndpointId::LibraryItemAdd => {
                let req: <ops::LibraryItemAdd as Op>::Input = decode(payload)?;
                let by = match ctx.caller {
                    Caller::User | Caller::Remote => AddedBy::User,
                    Caller::Orchestrator => AddedBy::Agent {
                        agent: ctx.client.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                        session: None,
                        dir: None,
                    },
                    Caller::Session => {
                        let sid = ctx.client.as_ref().map(|c| c.id.clone()).unwrap_or_default();
                        let (agent, dir) = self
                            .app
                            .session
                            .session_async(&sid)
                            .await
                            .map(|h| (h.profile.unwrap_or_default(), h.cwd.map(PathBuf::from)))
                            .unwrap_or_default();
                        AddedBy::Agent {
                            agent,
                            session: (!sid.is_empty()).then_some(sid),
                            dir,
                        }
                    }
                };
                ok_json(self.app.library.add_async(&req, &by).await?)
            }
            EndpointId::LibraryItemDelete => {
                let req: <ops::LibraryItemDelete as Op>::Input = decode(payload)?;
                self.app.library.remove_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::LibraryItemPreviewDelete => {
                let req: <ops::LibraryItemPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.library.preview_remove_async(&req.id).await?)
            }

            // voice
            EndpointId::VoiceHear => {
                let req: <ops::VoiceHear as Op>::Input = decode(payload)?;
                self.app
                    .voice
                    .heard_current_async(&req.text, req.agent.as_deref(), req.send_key.as_deref())
                    .await?;
                Ok(Value::Null)
            }
            EndpointId::VoiceMossVerify => ok_json(self.app.voice.verify_moss_async().await),
            EndpointId::VoiceGrantCreate => ok_json(self.app.voice.grant()?),
            EndpointId::VoiceCallStart => {
                let req: <ops::VoiceCallStart as Op>::Input = decode(payload)?;
                ok_json(self.app.voice.start(&req.channel, &req.uid, req.about.as_deref())?)
            }
            EndpointId::VoiceCallStop => {
                let req: <ops::VoiceCallStop as Op>::Input = decode(payload)?;
                self.app.voice.stop(&req.agent_id)?;
                Ok(Value::Null)
            }
            EndpointId::VoiceCallHear => {
                let req: <ops::VoiceCallHear as Op>::Input = decode(payload)?;
                self.app
                    .voice
                    .heard_async(&req.agent_id, &req.text, req.agent.as_deref(), req.send_key.as_deref())
                    .await?;
                Ok(Value::Null)
            }
            EndpointId::VoiceCallSay => {
                let req: <ops::VoiceCallSay as Op>::Input = decode(payload)?;
                self.app.voice.said_async(&req.agent_id, &req.text).await?;
                Ok(Value::Null)
            }

            // artifact
            EndpointId::ArtifactList => {
                let req: <ops::ArtifactList as Op>::Input = decode(payload)?;
                let issue = match req.issue.as_deref().filter(|i| !i.is_empty()) {
                    Some(raw) => Some(self.resolve_artifact_issue_async(raw).await?),
                    None => None,
                };
                ok_json(
                    self.app
                        .artifact
                        .list_async(&ArtifactListRequest {
                            channel: req.channel.filter(|c| !c.is_empty()),
                            issue,
                            artifact_type: req.artifact_type,
                        })
                        .await?,
                )
            }
            EndpointId::ArtifactGet => {
                let req: <ops::ArtifactGet as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.get_async(&req.id).await?)
            }
            EndpointId::ArtifactContentGet => {
                let req: <ops::ArtifactContentGet as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.content_async(&req.id, req.version).await?.0)
            }
            EndpointId::ArtifactCreate => {
                let mut req: <ops::ArtifactCreate as Op>::Input = decode(payload)?;
                if let Some(raw) = req.issue.as_deref().filter(|i| !i.is_empty()) {
                    req.issue = Some(self.resolve_artifact_issue_async(raw).await?);
                } else {
                    req.issue = None;
                }
                ok_json(self.app.artifact.create_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactVersionCreate => {
                let req: <ops::ArtifactVersionCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.version_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactHtmlEdit => {
                let req: <ops::ArtifactHtmlEdit as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.html_edit_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactUpdate => {
                let req: <ops::ArtifactUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.update_async(&req).await?)
            }
            EndpointId::ArtifactDelete => {
                let req: <ops::ArtifactDelete as Op>::Input = decode(payload)?;
                self.app.artifact.remove_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::ArtifactPreviewDelete => {
                let req: <ops::ArtifactPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.preview_remove_async(&req.id).await?)
            }
            EndpointId::ArtifactBlockList => {
                let req: <ops::ArtifactBlockList as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.snapshot_async(&req.id).await?)
            }
            EndpointId::ArtifactSubmit => {
                let req: <ops::ArtifactSubmit as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.submit_async(&req.id, USER_ID, &req.batch_id, req.ops).await?)
            }
            EndpointId::ArtifactBlockCreate => {
                let req: <ops::ArtifactBlockCreate as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::BlockCreate {
                    r#type: req.r#type,
                    level: req.level,
                    checked: req.checked,
                    language: req.language,
                    text: req.text,
                    after_block: req.after_block,
                    parent_id: req.parent_id,
                };
                ok_json(self.app.artifact.insert_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockUpdate => {
                let req: <ops::ArtifactBlockUpdate as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::BlockUpdate {
                    block: req.block,
                    base_rev: req.base_rev,
                    text: req.text,
                    r#type: req.r#type,
                    level: req.level,
                    checked: req.checked,
                    language: req.language,
                };
                ok_json(self.app.artifact.update_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockDelete => {
                let req: <ops::ArtifactBlockDelete as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::BlockDelete { block: req.block };
                ok_json(self.app.artifact.delete_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockPreviewDelete => {
                let req: <ops::ArtifactBlockPreviewDelete as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::BlockDelete { block: req.block };
                ok_json(self.app.artifact.preview_delete_block_async(&req.id, &body).await?)
            }
            EndpointId::ArtifactSuggestionList => {
                let req: <ops::ArtifactSuggestionList as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.suggestions_async(&req.id).await?)
            }
            EndpointId::ArtifactSuggestionCreate => {
                let req: <ops::ArtifactSuggestionCreate as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::SuggestionCreate {
                    block: req.block,
                    base_rev: req.base_rev,
                    change: req.change,
                };
                ok_json(self.app.artifact.suggest_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactSuggestionAccept => {
                let req: <ops::ArtifactSuggestionAccept as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.accept_suggestion_async(&req.id, &req.suggestion, USER_ID).await?)
            }
            EndpointId::ArtifactSuggestionReject => {
                let req: <ops::ArtifactSuggestionReject as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.reject_suggestion_async(&req.id, &req.suggestion, USER_ID).await?)
            }
            EndpointId::ArtifactMarkdownGet => {
                let req: <ops::ArtifactMarkdownGet as Op>::Input = decode(payload)?;
                let markdown = self.app.artifact.markdown_async(&req.id).await?;
                ok_json(ArtifactMarkdown { markdown })
            }
            EndpointId::ArtifactTypeList => ok_json(self.app.artifact.list_types_async().await?),
            EndpointId::ArtifactTypeRead => {
                let req: <ops::ArtifactTypeRead as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.read_type_async(&req).await?)
            }
            EndpointId::ArtifactEntryList => {
                let req: <ops::ArtifactEntryList as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.list_entries_async(&req).await?)
            }
            EndpointId::ArtifactEntryGet => {
                let req: <ops::ArtifactEntryGet as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.get_entry_async(&req).await?)
            }
            EndpointId::ArtifactEntryBatch => {
                let req: <ops::ArtifactEntryBatch as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.batch_entries_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactOutlineImport => {
                let mut req: <ops::ArtifactOutlineImport as Op>::Input = decode(payload)?;
                if let Some(raw) = req.issue.as_deref().filter(|i| !i.is_empty()) {
                    req.issue = Some(self.resolve_artifact_issue_async(raw).await?);
                } else {
                    req.issue = None;
                }
                ok_json(self.app.artifact.import_outline_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactPresenceUpdate => {
                let req: <ops::ArtifactPresenceUpdate as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.update_presence_async(USER_ID, &req).await?)
            }
            EndpointId::ArtifactHistoryList => {
                let req: <ops::ArtifactHistoryList as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_list_async(&req).await?)
            }
            EndpointId::ArtifactHistoryPreview => {
                let req: <ops::ArtifactHistoryPreview as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_preview_async(&req).await?)
            }
            EndpointId::ArtifactHistoryRestore => {
                let req: <ops::ArtifactHistoryRestore as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_restore_async(&req).await?)
            }
            EndpointId::ArtifactHistoryFork => {
                let req: <ops::ArtifactHistoryFork as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_fork_async(&req).await?)
            }
            EndpointId::ArtifactHistoryUndoOrigin => {
                let req: <ops::ArtifactHistoryUndoOrigin as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_undo_origin_async(&req).await?)
            }
            EndpointId::ArtifactHistoryCompact => {
                let req: <ops::ArtifactHistoryCompact as Op>::Input = decode(payload)?;
                ok_json(self.app.artifact.history_compact_async(&req).await?)
            }

            // provider & setting
            EndpointId::ProviderGet => ok_json(self.app.provider.status()),
            EndpointId::ProviderUpdate => {
                let req: <ops::ProviderUpdate as Op>::Input = decode(payload)?;
                let provider = self.app.provider.clone();
                let status = spawn_blocking_traced(move || provider.update(&req))
                    .await
                    .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))??;
                ok_json(status)
            }
            EndpointId::ProviderVoiceList => {
                let req: ProviderVoiceRequest = decode(payload)?;
                ok_json(self.app.provider.voices_async(&req).await?)
            }
            EndpointId::ProviderModelList => {
                let req: <ops::ProviderModelList as Op>::Input = decode(payload)?;
                ok_json(self.app.provider.models_async(&req.connection, req.revision).await?)
            }
            EndpointId::SettingGet => ok_json(self.app.setting.status()),
            EndpointId::SettingValidate => {
                let req: <ops::SettingValidate as Op>::Input = decode(payload)?;
                ok_json(self.app.setting.validate(&req))
            }
            EndpointId::SettingUpdate => {
                let req: <ops::SettingUpdate as Op>::Input = decode(payload)?;
                let locale_changed = req.locale.is_some();
                let status = self.app.setting.save_async(req).await?;
                if locale_changed {
                    self.app.projector.mark_dirty(SliceMask::all());
                }
                ok_json(status)
            }

            // orchestrator
            EndpointId::OrchestratorOpen => {
                self.app.orchestrator.open_for_door_async().await?;
                Ok(Value::Null)
            }
            EndpointId::OrchestratorStop => {
                let req: <ops::OrchestratorStop as Op>::Input = decode(payload)?;
                self.app.orchestrator.stop_for_door_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::OrchestratorEvalCreate => {
                let req: <ops::OrchestratorEvalCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.orchestrator.eval_create_for_door_async(req).await?)
            }
            EndpointId::OrchestratorApprovalList => {
                let req: <ops::OrchestratorApprovalList as Op>::Input = decode(payload)?;
                ok_json(self.app.orchestrator.approvals_for_door_async(req).await?)
            }
            EndpointId::OrchestratorApprovalResolve => {
                let req: <ops::OrchestratorApprovalResolve as Op>::Input = decode(payload)?;
                self.app.orchestrator.resolve_approval_for_door_async(req).await?;
                Ok(Value::Null)
            }

            // attachment & core
            EndpointId::AttachmentCreate => {
                let req: <ops::AttachmentCreate as Op>::Input = decode(payload)?;
                ok_json(self.app.attachment.attach_async(req).await?)
            }
            EndpointId::AttachmentImportPath => {
                let req: <ops::AttachmentImportPath as Op>::Input = decode(payload)?;
                ok_json(self.app.attachment.import_path_async(req).await?)
            }
            EndpointId::ServerHealthGet => ok_json(infra::health(&self.app.version)),

            // debug
            EndpointId::DebugSnapshot => ok_json(self.app.debug.snapshot_async().await?),
            EndpointId::DebugTimelineList => {
                let req: <ops::DebugTimelineList as Op>::Input = decode(payload)?;
                ok_json(self.app.debug.timeline_list(&req)?)
            }
            EndpointId::DebugTimelineClear => {
                self.app.debug.timeline_clear()?;
                Ok(Value::Null)
            }
            EndpointId::DebugTrajectoryList => ok_json(self.app.debug.trajectory_list_async().await?),
            EndpointId::DebugTrajectoryGet => {
                let req: <ops::DebugTrajectoryGet as Op>::Input = decode(payload)?;
                ok_json(self.app.debug.trajectory_get_async(&req).await?)
            }
            EndpointId::DebugGraph => ok_json(self.app.debug.graph_async().await?),
            EndpointId::DebugOverrideGet => ok_json(self.app.debug.override_get()?),
            EndpointId::DebugOverrideSet => {
                let req: <ops::DebugOverrideSet as Op>::Input = decode(payload)?;
                ok_json(self.app.debug.override_set(req)?)
            }
            EndpointId::DebugBundleExport => ok_json(self.app.debug.bundle_export_async().await?),

            // remote & machine
            EndpointId::RemoteStatus => ok_json(self.app.remote.status_async().await?),
            EndpointId::RemoteEnable => {
                let req: <ops::RemoteEnable as Op>::Input = decode(payload)?;
                ok_json(self.app.remote.enable_async(req).await?)
            }
            EndpointId::RemoteDisable => ok_json(self.app.remote.disable_async().await?),
            EndpointId::RemotePairCreate => ok_json(self.app.remote.pair_create()?),
            EndpointId::RemotePairExchange => {
                let req: <ops::RemotePairExchange as Op>::Input = decode(payload)?;
                ok_json(self.app.remote.pair_exchange_async(req).await?)
            }
            EndpointId::RemoteDeviceRevoke => {
                let req: <ops::RemoteDeviceRevoke as Op>::Input = decode(payload)?;
                self.app.remote.revoke_device_async(req).await?;
                Ok(Value::Null)
            }
            EndpointId::RemoteWhoami => {
                let who = self.app.remote.whoami_async(&ctx.principal, ctx.caller).await?;
                ok_json(who)
            }
            EndpointId::MachineList => ok_json(self.app.machine.list()),
        }
    }

    async fn resolve_artifact_issue_async(&self, reference: &str) -> Result<String, ApiError> {
        let r = reference.trim();
        let number = r.strip_prefix('#').unwrap_or(r);
        if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
            let issues = self
                .app
                .issue
                .raw_issues_async()
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
            return issues
                .into_iter()
                .find(|i| i.number.to_string() == number)
                .map(|i| i.id)
                .ok_or_else(|| missing(t("server.issue.issueNumbered", &[("n", number.into())]), LookIn::Issue));
        }
        if let Some(session) = self.app.session.session_async(r).await
            && let Some(issue) = session.issue_id()
        {
            return Ok(issue.to_string());
        }
        Ok(r.to_string())
    }

    async fn open_subscription_async(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let Some(spec) = SUBSCRIPTIONS.iter().find(|s| s.name == name) else {
            return Err(envelope_refusal(BizCode::RouteNotFound, format!("no subscription {name}")));
        };
        if ctx.caller != Caller::User && !spec.can.contains(&ctx.caller) {
            return Err(envelope_refusal(
                BizCode::Forbidden,
                format!("{name} is not for the {:?}", ctx.caller),
            ));
        }
        let payload = if payload.is_null() { Value::Object(Default::default()) } else { payload };
        let (events, rx) = flume::unbounded();
        let (stop_tx, stop) = flume::bounded(1);
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);

        let opened = self.dispatch_subscription_async(spec, payload, events, stop).await;
        if let Err(err) = opened {
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
                let p: <subscriptions::ChannelFollow as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.channel.follow(&p.id, p.after, Sink { events, stop })
            }
            "channel.reports" => {
                let p: <subscriptions::ChannelReports as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.channel.reports(p.after, Sink { events, stop })
            }
            "artifact.follow" => {
                let p: <subscriptions::ArtifactFollow as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.artifact.follow_async(&p.id, p.after, Sink { events, stop }).await
            }
            "artifact.entry.follow" => {
                let p: <subscriptions::ArtifactEntryFollow as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.artifact.follow_entries_async(&p.id, p.after, Sink { events, stop }).await
            }
            "artifact.suggestion.follow" => {
                let p: <subscriptions::ArtifactSuggestionFollow as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.artifact.follow_suggestions_async(&p.id, Sink { events, stop }).await
            }
            "artifact.presence.follow" => {
                let p: <subscriptions::ArtifactPresenceFollow as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.artifact.follow_presence_async(&p.id, Sink { events, stop }).await
            }
            "session.watch" => {
                let p: <subscriptions::SessionWatch as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.session.watch_session_async(p, events, stop).await
            }
            "issue.watch" => {
                let p: <subscriptions::IssueWatch as vibevalley_protocol::Subscription>::Payload = decode(payload)?;
                self.app.session.watch_issue_async(p, events, stop).await
            }
            other => Err(ApiError::new(BizCode::RouteNotFound, format!("no subscription {other}"))),
        }
    }
}

impl Server for ServerDoor {
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
        self.app.projector.snapshot_value(slice)
    }

    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        self.app.projector.snapshot_json(slice)
    }

    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move {
            if self.app.projector.feed(slice).seq() < self.app.projector.dirty_seq(slice) {
                self.app.projector.flush().await;
            }
            self.app.projector.snapshot_json(slice)
        })
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        self.app
            .projector
            .feed(slice)
            .watch_since_with_gate(after_seq, self.fault_gate.as_ref(), stop, receive);
    }

    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        Some(self.app.projector.subscribe(slice))
    }

    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<SliceSubscription>> {
        Box::pin(async move {
            if self.app.projector.feed(slice).seq() < self.app.projector.dirty_seq(slice) {
                self.app.projector.flush().await;
            }
            Some(self.app.projector.subscribe(slice))
        })
    }

    fn fault_gate(&self) -> Option<SharedFaultGate> {
        self.fault_gate.clone()
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        bridge_live_receiver(self.app.live.subscribe_live(), self.app.runtime.token())
    }

    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<LiveEvent>> {
        Some(self.app.live.subscribe_live())
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

    fn media_inputs(&self) -> Option<SharedMediaInputs> {
        Some(self.media_input.clone())
    }

    fn speech_streams(&self) -> Option<SharedSpeechStreams> {
        Some(self.speech.clone())
    }

    fn mcp(&self) -> Option<SharedMcp> {
        Some(self.mcp.clone())
    }

    fn host_debug(&self) -> Option<SharedHostDebug> {
        self.host_debug.clone()
    }

    fn voice(&self) -> Option<SharedLiveVoice> {
        Some(self.voice.clone())
    }

    fn remote_auth(&self) -> Option<SharedRemoteAuth> {
        Some(self.remote.clone())
    }

    fn machine_bus(&self) -> Option<SharedMachineBus> {
        Some(self.machine.clone())
    }
}

fn check_can(ctx: &CallerContext, op: &str, spec: &Endpoint) -> Option<Envelope> {
    if ctx.caller != Caller::User && !spec.can.contains(&ctx.caller) {
        Some(envelope_refusal(
            BizCode::Forbidden,
            format!("{op} is not for the {:?}", ctx.caller),
        ))
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

/// Checks at compile time that every `ENDPOINTS` entry maps to a handled [`EndpointId`].
#[allow(dead_code)]
const fn assert_endpoints_covered() {
    let _ = endpoints::ENDPOINTS.len();
}
