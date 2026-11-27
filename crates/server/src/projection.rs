//! Pure 6-slice projections ([`project_slice_json`]) and feed boot helper
//! ([`finish_boot_and_start_feeds`]).

use std::sync::Arc;

use vibevalley_core::SliceMask;
use vibevalley_core::projection::{
    CollabInput, OpsInput, prepare_shared_context, project_board_shared, project_collab, project_farm_shared, project_inbox_shared, project_ops,
    project_sessions_shared,
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

/// Projects a batch of dirty slices sharing a single `(raw_issues, raw_sessions)` DB read
/// and single `derive_issues` pass across `Board`, `Sessions`, `Inbox`, and `Farm`.
pub(crate) async fn project_slices_batch_json(sources: &SliceSources, batch: &[(SliceKind, i64)]) -> Vec<(SliceKind, i64, Result<Arc<str>, String>)> {
    if batch.is_empty() {
        return Vec::new();
    }
    let err = |e: ApiError| e.message;
    let dberr = |e: DbError| e.to_string();

    let needs_core_snapshot = batch
        .iter()
        .any(|(k, _)| matches!(k, SliceKind::Board | SliceKind::Sessions | SliceKind::Inbox | SliceKind::Farm));
    let needs_farm = batch.iter().any(|(k, _)| *k == SliceKind::Farm);

    let shared_bundle = if needs_core_snapshot {
        match sources.board.projection_snapshot_async().await {
            Ok((raw_sessions, raw_issues)) => {
                let mut live = sources.ctx.live.to_core_snapshot(needs_farm);
                if needs_farm {
                    live.plays = sources.game.plays_snapshot();
                }
                let shared = prepare_shared_context(&raw_issues, &raw_sessions, &live);
                Ok(Some((raw_issues, live, shared)))
            }
            Err(e) => Err(e.to_string()),
        }
    } else {
        Ok(None)
    };

    let mut out = Vec::with_capacity(batch.len());
    for &(kind, seq) in batch {
        let result = match kind {
            SliceKind::Board => match &shared_bundle {
                Ok(Some((_, _, shared))) => match sources.channel.channels_snapshot_async().await {
                    Ok(channels) => encode_slice(&project_board_shared(
                        shared,
                        &channels,
                        sources.ctx.live.commits_snapshot(),
                        &sources.repo.cached_health_inputs(),
                        Some(sources.ctx.clock.now_ms()),
                        seq,
                    ))
                    .map_err(err),
                    Err(e) => Err(err(e)),
                },
                Ok(None) => unreachable!("core snapshot always loaded for Board"),
                Err(e) => Err(e.clone()),
            },
            SliceKind::Sessions => match &shared_bundle {
                Ok(Some((raw_issues, live, shared))) => match sources.ctx.service.session.telemetry_by_session().await {
                    Ok(mut telemetry_map) => encode_slice(&project_sessions_shared(
                        shared,
                        raw_issues,
                        live,
                        &mut telemetry_map,
                        sources.ctx.live.machines_snapshot(),
                        seq,
                    ))
                    .map_err(err),
                    Err(e) => Err(dberr(e)),
                },
                Ok(None) => unreachable!("core snapshot always loaded for Sessions"),
                Err(e) => Err(e.clone()),
            },
            SliceKind::Collab => match sources.channel.slice_chat_async().await {
                Ok(chat) => {
                    let input = CollabInput {
                        chat: Some(chat),
                        connectors: sources.ctx.live.connectors_snapshot(),
                    };
                    encode_slice(&project_collab(&input, seq)).map_err(err)
                }
                Err(e) => Err(err(e)),
            },
            SliceKind::Inbox => match &shared_bundle {
                Ok(Some((_, _, shared))) => match sources.channel.user_mentions_snapshot_async().await {
                    Ok(user_mentions) => {
                        let crons = sources.cron.list();
                        let (call, call_reason) = sources.ctx.live.call_snapshot();
                        encode_slice(&project_inbox_shared(
                            shared,
                            &crons,
                            &user_mentions,
                            &sources.ctx.live.runtime_inbox_snapshot(),
                            call,
                            call_reason,
                            seq,
                        ))
                        .map_err(err)
                    }
                    Err(e) => Err(err(e)),
                },
                Ok(None) => unreachable!("core snapshot always loaded for Inbox"),
                Err(e) => Err(e.clone()),
            },
            SliceKind::Ops => match sources.note.media.list_async().await {
                Ok(media) => {
                    let input = OpsInput {
                        crons: sources.cron.list(),
                        media: Some(media),
                    };
                    encode_slice(&project_ops(&input, seq)).map_err(err)
                }
                Err(e) => Err(err(e)),
            },
            SliceKind::Farm => match &shared_bundle {
                Ok(Some((_, live, shared))) => encode_slice(&project_farm_shared(
                    shared,
                    live,
                    sources.ctx.live.progress_snapshot(),
                    sources.ctx.live.commits_snapshot(),
                    seq,
                ))
                .map_err(err),
                Ok(None) => unreachable!("core snapshot always loaded for Farm"),
                Err(e) => Err(e.clone()),
            },
        };
        out.push((kind, seq, result));
    }
    out
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
    sources.ctx.feed.start_batch(&sources.ctx.task, {
        let sources = sources.clone();
        move |batch| {
            let sources = sources.clone();
            async move { project_slices_batch_json(&sources, &batch).await }
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
