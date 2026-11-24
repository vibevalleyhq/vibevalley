//! Pure slice projections ([`project_slice_json`]), DevTools state/trajectory
//! reader ([`ServerDebugSources`]), composition-root assembly types/helpers, and
//! farm-skin live event bridge.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::broadcast;
use vibevalley_core::SliceMask;
use vibevalley_core::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, OpsInput, SessionInput, derive_issues, overlay_sessions, project_board, project_collab, project_farm,
    project_inbox, project_ops, project_sessions,
};
use vibevalley_protocol::{
    ApiError, Artifact, ArtifactFileDeleteRequest, ArtifactFileDeleteResult, ArtifactFileWriteRequest, ArtifactFileWriteResult,
    ArtifactHistoryUndoOriginRequest, ArtifactListRequest, ArtifactSuggestionAcceptInput, ArtifactSuggestionCreateInput, ArtifactVersionRequest, BizCode,
    Caller, ChatMessage, DebugRuntimeSummary, DebugTrajectoryKind, Health, Op, Phase, RepoTemplates, SayRequest, SessionEvent, SessionSendInput, SliceKind,
    Suggestion, ops,
};
use vibevalley_runtime::agent::ModelClient;
use vibevalley_runtime::agent::harness::SharedExecution;
use vibevalley_runtime::agent::runtime::VibeValleyRuntime;
use vibevalley_runtime::oar::{Registry, set_observer};

use crate::agent::{Agent, Orchestrator, Profile};
use crate::artifact::Manager as ArtifactManager;
use crate::channel::{ChannelMessageEvent, Chat};
use crate::connector::Connector;
use crate::context::api::{BoxFuture, CallerContext, DomainSubscription, NativeEndpointInput, NativeEndpointOutput, SharedHostDebug};
use crate::context::port::CronOrchestratorPort;
use crate::context::{Context, Sink, encode_slice};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::{DebugDataSource, DebugKit, DebugParts, DebugStateSnapshot, RuntimeProbeSnapshot};
use crate::game::Game;
use crate::issue::{Board, IssueChat, Pull, SessionChat};
use crate::machine::Machine;
use crate::provider::Provider;
use crate::repo::Repo;
use crate::runtime::{OUTBOX_SESSION_REPORTED, OutboxSessionReported, Runtime, SessionLifecycleEvent};
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
    pub artifact: Arc<ArtifactManager>,
    pub channel: Arc<Chat>,
    pub connector: Arc<Connector>,
    pub cron: Arc<CronScheduler>,
    pub voice: Arc<Voice>,
    pub machine: Arc<Machine>,
    pub debug: Arc<DebugKit>,
    pub game: Arc<Game>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_debug_kit(
    ctx: &Arc<Context>,
    runtime: &Arc<Runtime>,
    board: &Arc<Board>,
    agent: &Arc<Agent>,
    repo: &Arc<Repo>,
    artifact: &Arc<ArtifactManager>,
    channel: &Arc<Chat>,
    cron: &Arc<CronScheduler>,
    setting: &Arc<Setting>,
    host_debug: Option<SharedHostDebug>,
    home: PathBuf,
    work_root: PathBuf,
    version: String,
    debug_enabled: bool,
    active_subscriptions: Arc<AtomicUsize>,
    boot_started: Instant,
) -> Arc<DebugKit> {
    let sources = Arc::new(ServerDebugSources {
        ctx: ctx.clone(),
        runtime: runtime.clone(),
        board: board.clone(),
        agent: agent.clone(),
        repo: repo.clone(),
        artifact: artifact.clone(),
        channel: channel.clone(),
        cron: cron.clone(),
    });
    let debug = DebugKit::new(DebugParts {
        ctx: ctx.clone(),
        active_subscriptions: Arc::new(move || active_subscriptions.load(Ordering::Acquire) as u32),
        host_debug,
        setting: setting.clone(),
        sources,
        home,
        work_root,
        version,
        boot_started,
        debug_enabled,
    });
    if debug_enabled {
        set_observer(Some(debug.collector()));
    }
    debug
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
            let artifact = self.artifact.clone();
            set.spawn_blocking(move || artifact.close());
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

pub(crate) fn build_runtimes(setting: &Arc<Setting>, home: &std::path::Path, execution: SharedExecution, model: Option<Arc<dyn ModelClient>>) -> Registry {
    let mut registry = Registry::new();
    for r in vibevalley_runtime::oar::default_runtimes().list() {
        if r.id() != vibevalley_runtime::agent::runtime::ID && r.id() != "scripted" {
            registry.register(r.clone());
        }
    }
    let s = setting.clone();
    let builtin =
        VibeValleyRuntime::new(Arc::new(move || s.deepseek_api_key()), home.join("conversations")).with_execution(Arc::new(OnceLock::from(execution)));
    registry.register(Arc::new(match model {
        Some(model) => builtin.with_client(model),
        None => builtin,
    }));
    registry
}

pub(crate) struct LazyCronOrchestrator(pub Arc<OnceLock<Arc<dyn CronOrchestratorPort>>>);

impl CronOrchestratorPort for LazyCronOrchestrator {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool {
        self.0.get().is_some_and(|o| o.hear_cron(agent, channel, line))
    }
}

pub(crate) async fn seat_orchestrators_and_watch(ctx: &Context, profile: &Arc<Profile>, channel: &Arc<Chat>) {
    for orch in profile.orchestrators() {
        if let Err(e) = channel.seat_orchestrator_async(&orch).await {
            eprintln!("vibevalley-server: chat: seating {}: {}", orch.id, e.message);
        }
    }
    let (c_w, p_w, ctx_seat) = (Arc::downgrade(channel), Arc::downgrade(profile), ctx.clone());
    profile.store.when_kept(Arc::new(move |agent| {
        if let (Some(c), Some(p)) = (c_w.upgrade(), p_w.upgrade())
            && p.is_orchestrator(&agent.id)
        {
            let agent = agent.clone();
            ctx_seat.spawn("channel.seat_orchestrator", async move {
                if let Err(e) = c.seat_orchestrator_async(&agent).await {
                    eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
                }
            });
        }
        Ok(())
    }));
}

pub(crate) struct ServerDebugSources {
    pub ctx: Arc<Context>,
    pub runtime: Arc<Runtime>,
    pub board: Arc<Board>,
    pub agent: Arc<Agent>,
    pub repo: Arc<Repo>,
    pub artifact: Arc<ArtifactManager>,
    pub channel: Arc<Chat>,
    pub cron: Arc<CronScheduler>,
}

impl DebugDataSource for ServerDebugSources {
    fn trajectory_events(&self, session_id: &str) -> Vec<SessionEvent> {
        self.runtime.trajectory().open_events(session_id)
    }

    fn open_trajectory_ids(&self) -> Vec<String> {
        self.runtime.trajectory().open_session_ids()
    }

    fn system_prompt(&self, session_id: &str, kind: DebugTrajectoryKind) -> Option<String> {
        match kind {
            DebugTrajectoryKind::IssueSession | DebugTrajectoryKind::WorkspaceChat => None,
            DebugTrajectoryKind::Orchestrator => Some(self.agent.orchestrator.system_prompt_snapshot(session_id)),
        }
    }

    fn runtime_probe(&self) -> RuntimeProbeSnapshot {
        let runtimes = self
            .agent
            .profile
            .runtimes()
            .into_iter()
            .map(|info| {
                let (installed, version) = match &info.installation {
                    vibevalley_protocol::Installation::Available(a) => (true, a.version.clone()),
                    vibevalley_protocol::Installation::NotFound(_)
                    | vibevalley_protocol::Installation::Checking(_)
                    | vibevalley_protocol::Installation::Unsupported(_) => (false, None),
                };
                let ready = installed && info.settings.enabled;
                DebugRuntimeSummary {
                    id: info.id.clone(),
                    name: if info.preset.label.is_empty() {
                        info.id.clone()
                    } else {
                        info.preset.label.clone()
                    },
                    installed,
                    ready,
                    version,
                }
            })
            .collect();
        RuntimeProbeSnapshot {
            runtimes,
            agent_count: self.agent.profile.all().len() as u32,
            orchestrator_ids: self.agent.profile.orchestrators().into_iter().map(|a| a.id).collect(),
        }
    }

    fn state_snapshot_async(&self) -> BoxFuture<'_, DebugStateSnapshot> {
        Box::pin(async move {
            let raw_issues = self.board.raw_issues_async().await.unwrap_or_default();
            let raw_sessions = self.ctx.service.session.all().await.unwrap_or_default();
            let live_overlays = self.ctx.live.core_session_overlays();
            let sessions = overlay_sessions(&raw_sessions, &live_overlays);
            let issues = derive_issues(&raw_issues, &sessions);
            let channels = self.channel.channels_snapshot_async().await.unwrap_or_default();
            let user_mentions = self.channel.user_mentions_snapshot_async().await.unwrap_or_default();
            let artifacts = self.artifact.list_async(&ArtifactListRequest::default()).await.unwrap_or_default();
            let media_jobs = self.artifact.media.list_async().await.unwrap_or_default();
            let crons = self.cron.list();
            let (call, call_reason) = self.ctx.live.call_snapshot();
            let live_snap = self.ctx.live.to_core_snapshot(false);
            let inbox = project_inbox(
                &InboxInput {
                    issues: raw_issues,
                    sessions: raw_sessions,
                    crons,
                    user_mentions,
                    runtime_inbox_items: self.ctx.live.runtime_inbox_snapshot(),
                    call,
                    call_reason,
                },
                &live_snap,
                0,
            );
            DebugStateSnapshot {
                issues,
                sessions,
                channel_count: channels.len() as u32,
                repo_count: self.repo.list_async().await.len() as u32,
                artifact_count: artifacts.len() as u32,
                media_job_count: media_jobs.len() as u32,
                inbox_count: inbox.items.len() as u32,
                state_cache_json: json!({
                    "seq": self.ctx.feed.seq(),
                    "sliceSeqs": self.ctx.feed.slice_seqs(),
                    "watchers": self.ctx.feed.watcher_counts(),
                }),
            }
        })
    }
}

pub(crate) async fn project_slice_json(core: &AppCore, kind: SliceKind, seq: i64) -> Result<Arc<str>, String> {
    let err = |e: ApiError| e.message;
    let dberr = |e: crate::db::DbError| e.to_string();
    match kind {
        SliceKind::Board => {
            let (raw_issues, raw_sessions, channels) = tokio::join!(
                core.board.raw_issues_async(),
                core.ctx.service.session.all(),
                core.channel.channels_snapshot_async(),
            );
            let input = BoardInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                channels: channels.map_err(err)?,
                commits: core.ctx.live.commits_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_board(&input, &live, seq)).map_err(err)
        }
        SliceKind::Sessions => {
            let (raw_sessions, raw_issues) = tokio::join!(core.ctx.service.session.all(), core.board.raw_issues_async());
            let input = SessionInput {
                sessions: raw_sessions.map_err(dberr)?,
                issues: raw_issues.map_err(|e| e.to_string())?,
                machines: core.ctx.live.machines_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_sessions(&input, &live, seq)).map_err(err)
        }
        SliceKind::Collab => {
            let chat = core.channel.slice_chat_async().await.map_err(err)?;
            let input = CollabInput {
                chat: Some(chat),
                connectors: core.ctx.live.connectors_snapshot(),
            };
            encode_slice(&project_collab(&input, seq)).map_err(err)
        }
        SliceKind::Inbox => {
            let (raw_issues, raw_sessions, user_mentions) = tokio::join!(
                core.board.raw_issues_async(),
                core.ctx.service.session.all(),
                core.channel.user_mentions_snapshot_async(),
            );
            let crons = core.cron.list();
            let (call, call_reason) = core.ctx.live.call_snapshot();
            let input = InboxInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                crons,
                user_mentions: user_mentions.map_err(err)?,
                runtime_inbox_items: core.ctx.live.runtime_inbox_snapshot(),
                call,
                call_reason,
            };
            let live = core.ctx.live.to_core_snapshot(false);
            encode_slice(&project_inbox(&input, &live, seq)).map_err(err)
        }
        SliceKind::Ops => {
            let crons = core.cron.list();
            let media = core.artifact.media.list_async().await.map_err(err)?;
            let input = OpsInput { crons, media: Some(media) };
            encode_slice(&project_ops(&input, seq)).map_err(err)
        }
        SliceKind::Farm => {
            let (raw_issues, raw_sessions) = tokio::join!(core.board.raw_issues_async(), core.ctx.service.session.all());
            let input = FarmInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                progress: core.ctx.live.progress_snapshot(),
                commits: core.ctx.live.commits_snapshot(),
            };
            let live = core.ctx.live.to_core_snapshot(true);
            encode_slice(&project_farm(&input, &live, seq)).map_err(err)
        }
    }
}

pub(crate) fn spawn_chat_artifact_bridge(ctx: &Context, channel: &Chat) -> broadcast::Receiver<ChatMessage> {
    let (chat_msg_tx, chat_msg_rx) = broadcast::channel(256);
    let mut msg_events = channel.subscribe_message_events();
    let cancel = ctx.task.child_token();
    ctx.spawn("artifact.chat_messages", async move {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                res = msg_events.recv() => match res {
                    Ok(ChannelMessageEvent::Posted { message, .. } | ChannelMessageEvent::Edited(message)) => {
                        let _ = chat_msg_tx.send(message);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    chat_msg_rx
}

pub(crate) fn register_session_reported_outbox(
    ctx: &Context,
    issue_chat: &Arc<IssueChat>,
    session_chat: &Arc<SessionChat>,
    agent: &Arc<Agent>,
    game: &Arc<Game>,
    runtime: &Arc<Runtime>,
) {
    let ic = Arc::downgrade(issue_chat);
    let sc = Arc::downgrade(session_chat);
    let ag = Arc::downgrade(agent);
    let g = Arc::downgrade(game);
    let rt = Arc::downgrade(runtime);
    ctx.outbox.register(OUTBOX_SESSION_REPORTED, move |delivery| {
        let (ic, sc, ag, g, rt) = (ic.clone(), sc.clone(), ag.clone(), g.clone(), rt.clone());
        async move {
            let report: OutboxSessionReported = delivery.decode().map_err(|e| format!("invalid {OUTBOX_SESSION_REPORTED} payload: {e}"))?;
            if let Some(ic) = ic.upgrade() {
                ic.handle_report_async(&report).await.map_err(|e| e.message)?;
            }
            if let Some(sc) = sc.upgrade() {
                sc.handle_report_async(&report).await;
            }
            if let Some(rt) = rt.upgrade()
                && let Some(reported_session) = rt.session_async(&report.id).await
            {
                if let Some(ag) = ag.upgrade() {
                    ag.memory.keep_session_reported_async(&reported_session).await;
                    ag.profile
                        .fleet
                        .on_session_reported(&reported_session.runtime, report.spent.as_ref().and_then(|s| s.cny).map(|n| n.0));
                }
                if let Some(g) = g.upgrade() {
                    g.on_session_reported(&reported_session, report.outcome);
                }
            }
            Ok::<(), String>(())
        }
    });
}

pub(crate) fn spawn_skin_event_bridge(ctx: &Context, game: &Arc<Game>, runtime: &Arc<Runtime>, channel: &Arc<Chat>) {
    let mut session_rx = runtime.subscribe_events();
    let mut message_rx = channel.subscribe_message_events();
    let game = Arc::downgrade(game);
    let runtime_ref = Arc::downgrade(runtime);
    let cancel = ctx.task.child_token();

    ctx.spawn("game.event_bridge", async move {
        let mut known_sessions: HashMap<String, vibevalley_protocol::Session> = HashMap::new();
        let mut was_working: HashSet<String> = HashSet::new();
        if let Some(rt) = runtime_ref.upgrade() {
            for s in rt.list_async().await {
                if s.phase.is_working() {
                    was_working.insert(s.id.clone());
                }
                known_sessions.insert(s.id.clone(), s);
            }
        }
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                ev = session_rx.recv() => match ev {
                    Ok(SessionLifecycleEvent::Changed(session)) => {
                        let Some(g) = game.upgrade() else { return };
                        let existed = known_sessions.contains_key(&session.id);
                        if !existed {
                            let others: Vec<&vibevalley_protocol::Session> = known_sessions.values().collect();
                            g.on_session_hired(&session, &others);
                        }
                        match &session.phase {
                            Phase::Working(w) => {
                                let was = was_working.contains(&session.id);
                                g.on_session_working(&session, was, &w.doing);
                                was_working.insert(session.id.clone());
                            }
                            Phase::Done(_) | Phase::Failed(_) | Phase::Resting(_) | Phase::Closed(_) => {
                                was_working.remove(&session.id);
                            }
                        }
                        known_sessions.insert(session.id.clone(), *session);
                    }
                    Ok(SessionLifecycleEvent::Left { id, .. }) => {
                        was_working.remove(&id);
                        if let Some(removed) = known_sessions.remove(&id)
                            && let Some(g) = game.upgrade()
                        {
                            g.on_session_left(&removed, None, None);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(rt) = runtime_ref.upgrade() {
                            known_sessions.clear();
                            was_working.clear();
                            for s in rt.list_async().await {
                                if s.phase.is_working() {
                                    was_working.insert(s.id.clone());
                                }
                                known_sessions.insert(s.id.clone(), s);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ev = message_rx.recv() => match ev {
                    Ok(ChannelMessageEvent::Posted { message, thread_issue_id, answers }) => {
                        let Some(g) = game.upgrade() else { return };
                        let thread_worker = thread_issue_id.as_deref().and_then(|iid| {
                            known_sessions
                                .values()
                                .find(|s| s.is_board_worker() && s.issue_id() == Some(iid))
                                .map(|s| s.id.as_str())
                        });
                        let mentioned_sessions: Vec<String> = message
                            .mentions
                            .iter()
                            .filter(|m| known_sessions.contains_key(m.as_str()))
                            .cloned()
                            .collect();
                        g.on_message_posted(&message.actor, thread_worker, &mentioned_sessions, answers.is_some());
                    }
                    Ok(ChannelMessageEvent::Edited(_)) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
}

// --- Thin endpoint glue helpers invoked by `Router` to avoid multi-line arms ---

pub(crate) async fn repo_templates_async(c: &AppCore, id: &str) -> Result<RepoTemplates, ApiError> {
    let issues = c.board.issues_async().await.map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
    c.repo.templates_async(id, &issues, |a| c.agent.profile.is_orchestrator(a)).await
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
    let by = c.artifact.added_by_for_caller_async(ctx).await;
    c.artifact.library.add_async(req, &by).await
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

pub(crate) async fn media_speakers(
    c: &AppCore,
    caller: Caller,
    r: <ops::MediaDialogueCreate as Op>::Input,
) -> Result<<ops::MediaDialogueCreate as Op>::Result, ApiError> {
    c.artifact.media.create_speakers_for_caller_async(caller, r).await
}

pub(crate) async fn media_voice_design(
    c: &AppCore,
    caller: Caller,
    r: <ops::MediaVoiceDesignCreate as Op>::Input,
) -> Result<<ops::MediaVoiceDesignCreate as Op>::Result, ApiError> {
    c.artifact.media.create_voice_design_for_caller_async(caller, r).await
}

pub(crate) async fn media_start_u(c: &AppCore, caller: Caller, id: &str) -> Result<<ops::MediaUnderstandingStart as Op>::Result, ApiError> {
    c.artifact.media.start_understanding_for_caller_async(caller, id).await
}

pub(crate) async fn artifact_version(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactVersionRequest) -> Result<Artifact, ApiError> {
    let (m, _, t) = art.caller_meta(ctx);
    art.version_with_meta_async(&m, r, &t).await
}

pub(crate) async fn artifact_write(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactFileWriteRequest) -> Result<ArtifactFileWriteResult, ApiError> {
    let (m, _, t) = art.caller_meta(ctx);
    art.write_files_with_meta_async(&m, r, &t).await
}

pub(crate) async fn artifact_delete_file(
    art: &ArtifactManager,
    ctx: &CallerContext,
    r: &ArtifactFileDeleteRequest,
) -> Result<ArtifactFileDeleteResult, ApiError> {
    let (m, _, t) = art.caller_meta(ctx);
    art.delete_file_with_meta_async(&m, r, &t).await
}

pub(crate) async fn art_suggest(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactSuggestionCreateInput) -> Result<Suggestion, ApiError> {
    art.create_suggestion_async(&art.caller_meta(ctx).1, r).await
}

pub(crate) async fn art_accept(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactSuggestionAcceptInput) -> Result<Suggestion, ApiError> {
    art.accept_suggestion_async(&art.caller_meta(ctx).1, r).await
}

pub(crate) async fn artifact_reject(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactSuggestionAcceptInput) -> Result<Suggestion, ApiError> {
    art.reject_suggestion_async(&art.caller_meta(ctx).1, &r.id, &r.suggestion).await
}

pub(crate) async fn artifact_undo_origin(art: &ArtifactManager, ctx: &CallerContext, r: &ArtifactHistoryUndoOriginRequest) -> Result<Artifact, ApiError> {
    art.history_undo_origin_async(&art.caller_meta(ctx).0, r).await
}

pub(crate) async fn setting_update(c: &AppCore, r: <ops::SettingUpdate as Op>::Input) -> Result<<ops::SettingUpdate as Op>::Result, ApiError> {
    let locale_changed = r.locale.is_some();
    let status = c.setting.save_async(r).await?;
    if locale_changed {
        c.ctx.mark_dirty(SliceMask::ALL);
    }
    Ok(status)
}

pub(crate) async fn orch_open(orch: &Orchestrator) -> Result<(), ApiError> {
    orch.open_endpoint_async().await
}

pub(crate) fn debug_clear(dbg: &DebugKit) -> Result<(), ApiError> {
    dbg.timeline_clear()
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
        DomainSubscription::ArtifactFollow(q) => core.artifact.follow_files_async(&q.id, q.after, sink).await,
        DomainSubscription::ArtifactSuggestionFollow(q) => core.artifact.follow_suggestions_async(&q.id, sink).await,
        DomainSubscription::ArtifactPresenceFollow(q) => core.artifact.follow_presence_async(&q.id, sink).await,
        DomainSubscription::SessionWatch(q) => core.runtime.watch_session_async(q, sink).await,
        DomainSubscription::IssueWatch(q) => core.runtime.watch_issue_async(q, sink).await,
    }
}

pub(crate) fn finish_boot_and_start_feeds(core: &Arc<AppCore>) {
    core.ctx.outbox.start(&core.ctx.task);
    core.ctx.feed.start(&core.ctx.task, {
        let core = core.clone();
        move |kind, seq| {
            let core = core.clone();
            Box::pin(async move { project_slice_json(&core, kind, seq).await })
        }
    });
    core.ctx.mark_dirty(SliceMask::ALL);
}
