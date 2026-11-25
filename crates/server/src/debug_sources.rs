//! DevTools state and trajectory data source ([`ServerDebugSources`], [`build_debug_kit`]).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use serde_json::json;
use vibevalley_core::projection::{InboxInput, derive_issues, overlay_sessions, project_inbox};
use vibevalley_protocol::{ArtifactListRequest, DebugRuntimeSummary, DebugTrajectoryKind, SessionEvent};
use vibevalley_runtime::oar::set_observer;

use crate::agent::Agent;
use crate::artifact::Manager as ArtifactManager;
use crate::channel::Chat;
use crate::context::Context;
use crate::context::api::{BoxFuture, SharedHostDebug};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::{DebugDataSource, DebugKit, DebugParts, DebugStateSnapshot, RuntimeProbeSnapshot};
use crate::issue::Board;
use crate::repo::Repo;
use crate::runtime::Runtime;
use crate::setting::Setting;

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

    fn system_prompt_async<'a>(&'a self, session_id: &'a str, kind: DebugTrajectoryKind) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match kind {
                DebugTrajectoryKind::IssueSession | DebugTrajectoryKind::WorkspaceChat => None,
                DebugTrajectoryKind::Orchestrator => Some(self.agent.orchestrator.system_prompt_snapshot_async(session_id).await),
            }
        })
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
