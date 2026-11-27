//! Assembled domain container ([`AppCore`]) and thin endpoint/subscription glue
//! helpers invoked by [`super::Router`].

use std::sync::Arc;
use std::time::Duration;

use vibevalley_core::SliceMask;
use vibevalley_protocol::{ApiError, BizCode, Caller, Health, Op, RepoTemplates, SayRequest, SessionSendInput, ops};
use vibevalley_runtime::oar::{Registry, set_observer};

use crate::agent::{Agent, Profile};
use crate::channel::Chat;
use crate::connector::Connector;
use crate::context::api::{CallerContext, DomainSubscription, NativeEndpointInput, NativeEndpointOutput};
use crate::context::{Context, Sink};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::DebugKit;
use crate::game::Game;
use crate::issue::{Board, IssueChat, Pull, SessionChat};
use crate::machine::Machine;
use crate::note::Manager as NoteManager;
use crate::provider::Provider;
use crate::repo::Repo;
use crate::runtime::Runtime;
use crate::setting::Setting;
use crate::storage::Storage;
use crate::voice::Voice;

const SHUTDOWN_DRAIN_GRACE: Duration = Duration::from_secs(10);
const RUNTIME_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

pub(crate) struct AppCore {
    pub ctx: Arc<Context>,
    pub registry: Arc<Registry>,
    pub version: String,
    pub setting: Arc<Setting>,
    pub provider: Arc<Provider>,
    pub storage: Arc<Storage>,
    pub repo: Arc<Repo>,
    pub runtime: Arc<Runtime>,
    pub board: Arc<Board>,
    pub pull: Arc<Pull>,
    pub issue_chat: Arc<IssueChat>,
    pub session_chat: Arc<SessionChat>,
    pub agent: Arc<Agent>,
    pub note: Arc<NoteManager>,
    pub channel: Arc<Chat>,
    pub connector: Arc<Connector>,
    pub cron: Arc<CronScheduler>,
    pub voice: Arc<Voice>,
    pub machine: Arc<Machine>,
    pub debug: Arc<DebugKit>,
    pub game: Arc<Game>,
}

impl AppCore {
    pub(crate) async fn close_all_async(&self) {
        set_observer(None);
        self.ctx.token().cancel();
        let mut set = tokio::task::JoinSet::new();
        {
            let machine = self.machine.clone();
            set.spawn_blocking(move || machine.close());
            let game = self.game.clone();
            set.spawn(async move { game.close_async().await });
            let note = self.note.clone();
            set.spawn_blocking(move || note.close());
            let storage = self.storage.clone();
            set.spawn(async move { storage.close_async().await });
            let repo = self.repo.clone();
            set.spawn(async move { repo.close_async().await });
            let board = self.board.clone();
            set.spawn(async move { board.close_async().await });
            let pull = self.pull.clone();
            set.spawn(async move { pull.close_async().await });
            let issue_chat = self.issue_chat.clone();
            set.spawn(async move { issue_chat.close_async().await });
            let session_chat = self.session_chat.clone();
            set.spawn(async move { session_chat.close_async().await });
            let agent = self.agent.clone();
            set.spawn(async move { agent.close_async().await });
            let cron = self.cron.clone();
            set.spawn(async move { cron.close_async().await });
            let voice = self.voice.clone();
            set.spawn_blocking(move || voice.close());
            let connector = self.connector.clone();
            set.spawn(async move { connector.close_async().await });
        }
        if tokio::time::timeout(SHUTDOWN_DRAIN_GRACE, async { while set.join_next().await.is_some() {} })
            .await
            .is_err()
        {
            tracing::warn!(timeout_secs = SHUTDOWN_DRAIN_GRACE.as_secs(), "server.close timed out waiting for modules");
        }
        let _ = self.ctx.shutdown(RUNTIME_SHUTDOWN_GRACE).await;
        self.runtime.close_async().await;
        self.ctx.service.close().await;
    }
}

pub(crate) async fn repo_list_async(c: &AppCore) -> Vec<vibevalley_protocol::RepoSummary> {
    c.board.repo_summaries_with_health_async(&c.repo, c.ctx.clock.now_ms()).await
}

pub(crate) async fn repo_templates_async(c: &AppCore, id: &str) -> Result<RepoTemplates, ApiError> {
    let issues = c.board.issues_async().await.map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
    let mut out = c.repo.templates_async(id, &issues, |a| c.agent.profile.is_orchestrator(a)).await?;
    c.game.append_purchased_templates(&mut out);
    Ok(out)
}

pub(crate) async fn issue_review(c: &AppCore, r: <ops::IssueReview as Op>::Input) -> Result<<ops::IssueReview as Op>::Result, ApiError> {
    let pass = r.pass;
    let i = c.board.issue_review_endpoint_async(r).await?;
    c.game.record_issue_review_async(&i, pass).await;
    Ok(i)
}

pub(crate) async fn issue_status_update(c: &AppCore, r: &<ops::IssueStatusUpdate as Op>::Input) -> Result<<ops::IssueStatusUpdate as Op>::Result, ApiError> {
    let a = c.board.issue_status_update_endpoint_async(r).await?;
    c.game.on_issue_status_updated_async(&a.id, a.status).await;
    Ok(a)
}

pub(crate) async fn issue_split_async(c: &AppCore, req: &vibevalley_protocol::IssueSplitInput) -> Result<String, ApiError> {
    let split = c.board.issue_split_endpoint_async(req).await?;
    c.game.on_issue_split();
    Ok(split)
}

pub(crate) async fn issue_diff_req_async(
    c: &AppCore,
    caller: Caller,
    id: &str,
    since_tree: Option<&str>,
) -> Result<<ops::IssueDiffGet as Op>::Result, ApiError> {
    c.board.issue_diff_endpoint_async(caller, id, since_tree, Some(&|s| c.game.reviewed(s))).await
}

pub(crate) async fn issue_comment(c: &AppCore, r: <ops::IssueCommentCreate as Op>::Input) -> Result<<ops::IssueCommentCreate as Op>::Result, ApiError> {
    c.issue_chat.comment_endpoint_async(&r.id, &r.text, r.send_key.as_deref()).await
}

pub(crate) async fn channel_send_async(c: &AppCore, body: SayRequest) -> Result<(), ApiError> {
    let picked_agent = body.agent.as_deref().and_then(|a| c.agent.profile.agent(a)).map(|p| p.id);
    let g = c.game.clone();
    if c.channel.handle_message_send(body, picked_agent, Some(&|s| g.want(s))).await? {
        c.game.on_call_live();
    }
    Ok(())
}

pub(crate) async fn channel_direct_async(c: &AppCore, agent_name: &str) -> Result<String, ApiError> {
    let name = agent_name.trim();
    let pr = &c.agent.profile;
    let found = pr
        .named(name)
        .or_else(|| pr.agent(name))
        .or_else(|| pr.orchestrators().into_iter().find(|o| o.name == name));
    let resolved = found.map(|a| (a.clone(), pr.is_orchestrator(&a.id)));
    c.channel.handle_direct_create(resolved.as_ref().map(|(a, o)| (a, *o)), agent_name).await
}

pub(crate) async fn library_add_async(
    c: &AppCore,
    ctx: &CallerContext,
    req: &vibevalley_protocol::LibraryAddRequest,
) -> Result<vibevalley_protocol::LibraryItem, ApiError> {
    let by = c.note.added_by_for_caller_async(ctx).await;
    c.note.library.add_async(req, &by).await
}

pub(crate) async fn agent_tmpl_install(pr: &Profile, r: vibevalley_protocol::AgentTemplateInstallInput) -> Result<vibevalley_protocol::Agent, ApiError> {
    pr.agent_template_install_async(&r.id, r.runtime.as_deref()).await
}

pub(crate) async fn memory_create(
    c: &AppCore,
    ctx: &CallerContext,
    r: vibevalley_protocol::MemoryCreateInput,
) -> Result<<ops::MemoryCreate as Op>::Result, ApiError> {
    c.agent
        .memory
        .create_endpoint_async(ctx.caller, ctx.client.as_ref().map(|x| x.id.as_str()), r)
        .await
}

pub(crate) async fn session_send(c: &AppCore, ctx: &CallerContext, r: SessionSendInput) -> Result<vibevalley_protocol::Session, ApiError> {
    c.runtime
        .send_workspace_endpoint_async(r, Some(&c.storage), (ctx.trace_id != 0).then_some(ctx.trace_id))
        .await
}

pub(crate) async fn setting_update(c: &AppCore, r: <ops::SettingUpdate as Op>::Input) -> Result<<ops::SettingUpdate as Op>::Result, ApiError> {
    let locale_changed = r.locale.is_some();
    let github_token_changed = r.github_token.is_some();
    let status = c.setting.save_async(r).await?;
    if locale_changed {
        c.ctx.mark_dirty(SliceMask::ALL);
    }
    if github_token_changed {
        c.repo.invalidate_github_cache();
    }
    Ok(status)
}

pub(crate) async fn mcp_server_save(c: &AppCore, r: <ops::RuntimeMcpServerSave as Op>::Input) -> Result<<ops::RuntimeMcpServerSave as Op>::Result, ApiError> {
    let res = c.runtime.save_host_mcp_server_endpoint_async(r).await?;
    c.agent.profile.fleet.sync_host_mcp_servers(res.host, &res.servers);
    Ok(res)
}

pub(crate) async fn mcp_server_toggle(
    c: &AppCore,
    r: <ops::RuntimeMcpServerToggle as Op>::Input,
) -> Result<<ops::RuntimeMcpServerToggle as Op>::Result, ApiError> {
    let res = c.runtime.toggle_host_mcp_server_endpoint_async(r).await?;
    c.agent.profile.fleet.sync_host_mcp_servers(res.host, &res.servers);
    Ok(res)
}

pub(crate) async fn mcp_server_remove(
    c: &AppCore,
    r: <ops::RuntimeMcpServerRemove as Op>::Input,
) -> Result<<ops::RuntimeMcpServerRemove as Op>::Result, ApiError> {
    let res = c.runtime.remove_host_mcp_server_endpoint_async(r).await?;
    c.agent.profile.fleet.sync_host_mcp_servers(res.host, &res.servers);
    Ok(res)
}

pub(crate) fn health(c: &AppCore) -> Health {
    Health {
        ok: true,
        version: c.version.clone(),
    }
}

pub(crate) async fn dispatch_native_domain_async(s: &Storage, input: NativeEndpointInput) -> Result<NativeEndpointOutput, ApiError> {
    match input {
        NativeEndpointInput::Attachment(id) => Ok(NativeEndpointOutput::AttachmentFile(s.file_async(&id).await?)),
        NativeEndpointInput::MediaInput(id) => Ok(NativeEndpointOutput::AttachmentFile(s.input_content_async(&id).await?)),
        NativeEndpointInput::MediaInputUpload(id, path) => Ok(NativeEndpointOutput::MediaInput(s.upload_input_file_async(&id, path).await?)),
    }
}

pub(crate) async fn open_sub_domain_async(core: &AppCore, input: DomainSubscription, sink: Sink) -> Result<(), ApiError> {
    match input {
        DomainSubscription::ChannelFollow(q) => core.channel.follow(&q.id, q.after, sink),
        DomainSubscription::ChannelReports(q) => core.channel.reports(q.after, sink),
        DomainSubscription::NoteFollow(q) => core.note.follow_files_async(&q.id, q.after, sink).await,
        DomainSubscription::NoteSuggestionFollow(q) => core.note.follow_suggestions_async(&q.id, sink).await,
        DomainSubscription::NotePresenceFollow(q) => core.note.follow_presence_async(&q.id, sink).await,
        DomainSubscription::SessionWatch(q) => core.runtime.watch_session_async(q, sink).await,
        DomainSubscription::IssueWatch(q) => core.runtime.watch_issue_async(q, sink).await,
    }
}
