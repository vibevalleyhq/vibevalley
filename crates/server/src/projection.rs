//! Pure 6-slice projections ([`project_slice_json`]) and feed boot helper
//! ([`finish_boot_and_start_feeds`]).

use std::sync::Arc;

use vibevalley_core::SliceMask;
use vibevalley_core::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, OpsInput, SessionInput, project_board, project_collab, project_farm, project_inbox, project_ops,
    project_sessions,
};
use vibevalley_protocol::{ApiError, SliceKind};

use crate::channel::Chat;
use crate::context::{Context, encode_slice};
use crate::cron::Scheduler as CronScheduler;
use crate::game::Game;
use crate::issue::Board;
use crate::note::Manager as NoteManager;
use crate::repo::Repo;
use crate::service::DbError;

/// Narrow domain handles required to project the six server slices.
#[derive(Clone)]
pub(crate) struct SliceSources {
    pub ctx: Arc<Context>,
    pub board: Arc<Board>,
    pub channel: Arc<Chat>,
    pub cron: Arc<CronScheduler>,
    pub note: Arc<NoteManager>,
    pub game: Arc<Game>,
    pub repo: Arc<Repo>,
}

pub(crate) async fn project_slice_json(sources: &SliceSources, kind: SliceKind, seq: i64) -> Result<Arc<str>, String> {
    let err = |e: ApiError| e.message;
    let dberr = |e: DbError| e.to_string();
    match kind {
        SliceKind::Board => {
            let (raw_issues, raw_sessions, channels) = tokio::join!(
                sources.board.raw_issues_async(),
                sources.ctx.service.session.all(),
                sources.channel.channels_snapshot_async(),
            );
            let input = BoardInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                channels: channels.map_err(err)?,
                commits: sources.ctx.live.commits_snapshot(),
                repos: sources.repo.cached_health_inputs(),
                evaluated_at: Some(sources.ctx.clock.now_ms()),
            };
            let live = sources.ctx.live.to_core_snapshot(false);
            encode_slice(&project_board(&input, &live, seq)).map_err(err)
        }
        SliceKind::Sessions => {
            let (raw_sessions, telemetry_map, raw_issues) = tokio::join!(
                sources.ctx.service.session.all(),
                sources.ctx.service.session.telemetry_by_session(),
                sources.board.raw_issues_async(),
            );
            let mut sessions = raw_sessions.map_err(dberr)?;
            let mut telemetry_map = telemetry_map.map_err(dberr)?;
            for s in &mut sessions {
                if let Some(tel) = telemetry_map.remove(&s.id) {
                    s.telemetry = Some(tel);
                }
            }
            let input = SessionInput {
                sessions,
                issues: raw_issues.map_err(|e| e.to_string())?,
                machines: sources.ctx.live.machines_snapshot(),
            };
            let live = sources.ctx.live.to_core_snapshot(false);
            encode_slice(&project_sessions(&input, &live, seq)).map_err(err)
        }
        SliceKind::Collab => {
            let chat = sources.channel.slice_chat_async().await.map_err(err)?;
            let input = CollabInput {
                chat: Some(chat),
                connectors: sources.ctx.live.connectors_snapshot(),
            };
            encode_slice(&project_collab(&input, seq)).map_err(err)
        }
        SliceKind::Inbox => {
            let (raw_issues, raw_sessions, user_mentions) = tokio::join!(
                sources.board.raw_issues_async(),
                sources.ctx.service.session.all(),
                sources.channel.user_mentions_snapshot_async(),
            );
            let crons = sources.cron.list();
            let (call, call_reason) = sources.ctx.live.call_snapshot();
            let input = InboxInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                crons,
                user_mentions: user_mentions.map_err(err)?,
                runtime_inbox_items: sources.ctx.live.runtime_inbox_snapshot(),
                call,
                call_reason,
            };
            let live = sources.ctx.live.to_core_snapshot(false);
            encode_slice(&project_inbox(&input, &live, seq)).map_err(err)
        }
        SliceKind::Ops => {
            let crons = sources.cron.list();
            let media = sources.note.media.list_async().await.map_err(err)?;
            let input = OpsInput { crons, media: Some(media) };
            encode_slice(&project_ops(&input, seq)).map_err(err)
        }
        SliceKind::Farm => {
            let (raw_issues, raw_sessions) = tokio::join!(sources.board.raw_issues_async(), sources.ctx.service.session.all());
            let input = FarmInput {
                issues: raw_issues.map_err(|e| e.to_string())?,
                sessions: raw_sessions.map_err(dberr)?,
                progress: sources.ctx.live.progress_snapshot(),
                commits: sources.ctx.live.commits_snapshot(),
            };
            let mut live = sources.ctx.live.to_core_snapshot(true);
            live.plays = sources.game.plays_snapshot();
            encode_slice(&project_farm(&input, &live, seq)).map_err(err)
        }
    }
}

pub(crate) fn finish_boot_and_start_feeds(
    ctx: &Arc<Context>,
    board: &Arc<Board>,
    channel: &Arc<Chat>,
    cron: &Arc<CronScheduler>,
    note: &Arc<NoteManager>,
    game: &Arc<Game>,
    repo: &Arc<Repo>,
) {
    let sources = SliceSources {
        ctx: ctx.clone(),
        board: board.clone(),
        channel: channel.clone(),
        cron: cron.clone(),
        note: note.clone(),
        game: game.clone(),
        repo: repo.clone(),
    };
    sources.ctx.outbox.start(&sources.ctx.task);
    sources.ctx.feed.start(&sources.ctx.task, {
        let sources = sources.clone();
        move |kind, seq| {
            let sources = sources.clone();
            Box::pin(async move { project_slice_json(&sources, kind, seq).await })
        }
    });
    sources.ctx.mark_dirty(SliceMask::ALL);
    let warmup_ctx = ctx.clone();
    let warmup_repo = repo.clone();
    let warmup_cancel = ctx.task.child_token();
    ctx.task.spawn_named("repo.health.warmup", async move {
        if warmup_cancel.is_cancelled() {
            return;
        }
        let summaries = warmup_repo.list_summaries_async().await;
        if !summaries.is_empty() && !warmup_cancel.is_cancelled() {
            warmup_ctx.mark_dirty(SliceMask::BOARD);
        }
    });
}
