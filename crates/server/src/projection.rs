//! Pure 6-slice projections ([`project_slice_json`]) and feed boot helper
//! ([`finish_boot_and_start_feeds`]).

use std::sync::Arc;

use vibevalley_core::SliceMask;
use vibevalley_core::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, OpsInput, SessionInput, project_board, project_collab, project_farm, project_inbox, project_ops,
    project_sessions,
};
use vibevalley_protocol::{ApiError, SliceKind};

use crate::artifact::Manager as ArtifactManager;
use crate::channel::Chat;
use crate::context::{Context, encode_slice};
use crate::cron::Scheduler as CronScheduler;
use crate::game::Game;
use crate::issue::Board;
use crate::service::DbError;

/// Narrow domain handles required to project the six server slices.
#[derive(Clone)]
pub(crate) struct SliceSources {
    pub ctx: Arc<Context>,
    pub board: Arc<Board>,
    pub channel: Arc<Chat>,
    pub cron: Arc<CronScheduler>,
    pub artifact: Arc<ArtifactManager>,
    pub game: Arc<Game>,
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
            };
            let live = sources.ctx.live.to_core_snapshot(false);
            encode_slice(&project_board(&input, &live, seq)).map_err(err)
        }
        SliceKind::Sessions => {
            let (raw_sessions, raw_issues) = tokio::join!(sources.ctx.service.session.all(), sources.board.raw_issues_async());
            let input = SessionInput {
                sessions: raw_sessions.map_err(dberr)?,
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
            let media = sources.artifact.media.list_async().await.map_err(err)?;
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
    artifact: &Arc<ArtifactManager>,
    game: &Arc<Game>,
) {
    let sources = SliceSources {
        ctx: ctx.clone(),
        board: board.clone(),
        channel: channel.clone(),
        cron: cron.clone(),
        artifact: artifact.clone(),
        game: game.clone(),
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
}
