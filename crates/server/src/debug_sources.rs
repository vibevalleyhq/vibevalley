//! DevTools state and trajectory data source ([`ServerDebugSources`], [`build_debug_kit`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use serde_json::json;
use vibevalley_core::collab::{CollabDoc, DEFAULT_PRESENCE_TTL_MS, encode_frontiers, encode_version_vector};
use vibevalley_core::projection::{InboxInput, derive_issues, overlay_sessions, project_inbox};
use vibevalley_protocol::{
    ApiError, BizCode, DebugCollabClock, DebugCollabNoteState, DebugCollabPresence, DebugRuntimeSummary, DebugTrajectoryKind, NoteListRequest,
    NotePresenceUpdateRequest, SessionEvent,
};
use vibevalley_runtime::agent::durable::ExportOptions;
use vibevalley_runtime::oar::set_observer;

use crate::agent::Agent;
use crate::channel::Chat;
use crate::context::Context;
use crate::context::api::{BoxFuture, SharedHostDebug};
use crate::cron::Scheduler as CronScheduler;
use crate::debug::{DebugDataSource, DebugKit, DebugParts, DebugStateSnapshot, DurableExportSummary, RuntimeProbeSnapshot};
use crate::issue::Board;
use crate::note::Manager as NoteManager;
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
    note: &Arc<NoteManager>,
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
        note: note.clone(),
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
    pub note: Arc<NoteManager>,
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
            let notes = self.note.list_async(&NoteListRequest::default()).await.unwrap_or_default();
            let collab_rows = self.ctx.service.note.list_collab_snapshots(64).await.unwrap_or_default();
            let collab = self.inspect_collab_states_async(&notes, collab_rows).await;
            let media_jobs = self.note.media.list_async().await.unwrap_or_default();
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
                note_count: notes.len() as u32,
                media_job_count: media_jobs.len() as u32,
                inbox_count: inbox.items.len() as u32,
                state_cache_json: json!({
                    "seq": self.ctx.feed.seq(),
                    "sliceSeqs": self.ctx.feed.slice_seqs(),
                    "watchers": self.ctx.feed.watcher_counts(),
                }),
                collab,
            }
        })
    }

    fn export_durable_conversation_async<'a>(
        &'a self,
        session_id: &'a str,
        dest_dir: &'a Path,
    ) -> BoxFuture<'a, Result<Option<DurableExportSummary>, ApiError>> {
        Box::pin(async move {
            let store = self.runtime.durable_store();
            let extras = self.ctx.service.session.extras().await.unwrap_or_default();
            let mut candidates = vec![
                session_id.to_string(),
                vibevalley_runtime::agent::harness::worker_conversation(session_id),
                format!("issue:{session_id}"),
            ];
            if let Some(vendor) = extras.get(session_id).and_then(|e| e.agent_session.as_deref()) {
                candidates.push(vibevalley_runtime::agent::harness::worker_conversation(vendor));
                candidates.push(vendor.to_string());
            }

            let found = store
                .read_async(move |r| {
                    Box::pin(async move {
                        for id in candidates {
                            if r.conversation_async(&id).await.is_ok() {
                                return Ok(Some(id));
                            }
                        }
                        Ok(None)
                    })
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("lookup durable conversation: {e}")))?;

            let Some(conv_id) = found else {
                return Ok(None);
            };
            let manifest = store
                .export_conversation_jsonl(
                    &conv_id,
                    dest_dir,
                    ExportOptions {
                        at_seq: None,
                        include_children: true,
                        fsync: true,
                    },
                )
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("export durable conversation: {e}")))?;

            Ok(Some(DurableExportSummary {
                conversation_id: manifest.root_conversation_id,
                entries_exported: manifest.entries_exported as u32,
                tasks_exported: manifest.tasks_exported as u32,
                conversations_exported: manifest.conversations_exported as u32,
            }))
        })
    }
}

impl ServerDebugSources {
    async fn inspect_collab_states_async(
        &self,
        notes: &[vibevalley_protocol::Note],
        collab_rows: Vec<crate::service::note::CollabSnapshotRow>,
    ) -> Vec<DebugCollabNoteState> {
        let mut by_id: BTreeMap<String, (Option<crate::service::note::CollabSnapshotRow>, Option<&vibevalley_protocol::Note>)> = BTreeMap::new();
        for n in notes.iter().take(64) {
            by_id.insert(n.id.clone(), (None, Some(n)));
        }
        for row in collab_rows {
            let note_id = row.note_id.clone();
            by_id.entry(note_id).or_insert((None, None)).0 = Some(row);
        }

        let mut out = Vec::new();
        for (note_id, (row_opt, note_opt)) in by_id {
            let live_presence = self
                .note
                .update_presence_async(&NotePresenceUpdateRequest {
                    id: note_id.clone(),
                    presence: None,
                    peer_id: None,
                })
                .await
                .unwrap_or_default();

            if row_opt.is_none() && live_presence.is_empty() {
                continue;
            }

            let (snapshot_bytes, frontiers, frontier_ids, version_vector, vv_entries, doc_updated_at) = if let Some(row) = row_opt {
                let bytes_len = row.snapshot.len() as u32;
                match CollabDoc::from_snapshot(&row.snapshot) {
                    Ok(doc) => {
                        let f = doc.frontiers();
                        let vv = doc.version_vector();
                        let frontier_ids = f
                            .iter()
                            .map(|id| DebugCollabClock {
                                peer_id: id.peer.to_string(),
                                counter: id.counter,
                            })
                            .collect();
                        let vv_entries = vv
                            .iter()
                            .map(|(&peer, &counter)| DebugCollabClock {
                                peer_id: peer.to_string(),
                                counter,
                            })
                            .collect();
                        (
                            bytes_len,
                            encode_frontiers(&f),
                            frontier_ids,
                            encode_version_vector(&vv),
                            vv_entries,
                            row.updated_at,
                        )
                    }
                    Err(_) => (bytes_len, String::new(), Vec::new(), String::new(), Vec::new(), row.updated_at),
                }
            } else {
                (0, String::new(), Vec::new(), String::new(), Vec::new(), 0)
            };

            let presence: Vec<DebugCollabPresence> = live_presence
                .into_iter()
                .map(|p| DebugCollabPresence {
                    id: p.id,
                    name: p.name,
                    color: p.color,
                    kind: p.kind.as_str().to_string(),
                    status: p.status,
                    node_id: p.node_id,
                    path: p.path,
                    offset: p.offset,
                    end_offset: p.end_offset,
                    session_id: p.session_id,
                    updated_at: p.updated_at,
                })
                .collect();
            let updated_at = doc_updated_at.max(note_opt.map_or(0, |a| a.updated));
            out.push(DebugCollabNoteState {
                note_id,
                title: note_opt.map_or_else(String::new, |a| a.title.clone()),
                note_type: note_opt.map_or_else(|| "unknown".to_string(), |a| a.note_type.as_str().to_string()),
                seq: note_opt.map_or(0, |a| a.seq),
                snapshot_bytes,
                frontiers,
                frontier_ids,
                version_vector,
                vv_entries,
                ephemeral_ttl_ms: DEFAULT_PRESENCE_TTL_MS,
                presence_count: presence.len() as u32,
                presence,
                updated_at,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.note_id.cmp(&b.note_id)));
        out
    }
}
