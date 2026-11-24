//! Single-source DB + `LiveOverlay` -> pure `vibevalley_core::projection`
//! slice builders for `SliceProjector`, `SliceBundle`, and diagnostics.

use std::sync::Arc;

use vibevalley_core::projection::{
    BoardInput, CollabInput, FarmInput, InboxInput, OpsInput, SessionInput, derive_issues, overlay_sessions, project_board, project_collab, project_farm,
    project_inbox, project_ops, project_sessions,
};
use vibevalley_protocol::{ApiError, BizCode, Issue, Session, SliceBundle, SliceKind};

use crate::app::App;
use crate::infra::debug::DebugStateSnapshot;
use crate::work::ledger::BoardError;

fn ser<T: serde::Serialize>(val: &T) -> Result<Arc<str>, String> {
    serde_json::to_string(val).map(Arc::<str>::from).map_err(|e| e.to_string())
}

fn ser_err<T: serde::Serialize>(val: &T) -> Result<Arc<str>, ApiError> {
    ser(val).map_err(|e| ApiError::new(BizCode::InternalError, e))
}

fn board_err(e: BoardError) -> ApiError {
    match e {
        BoardError::Api(e) => e,
        _ => ApiError::new(BizCode::InternalError, e.to_string()),
    }
}

/// Queries DB snapshots + `LiveOverlay` and overlays running sessions / derived issue views.
pub(crate) async fn derived_issues_and_sessions(app: &App) -> Result<(Vec<Issue>, Vec<Session>), ApiError> {
    let raw_issues = app.issue.raw_issues_async().await.map_err(board_err)?;
    let raw_sessions = app.session.sessions_async().await.map_err(board_err)?;
    let live_sessions = app.live.core_session_overlays();
    let sessions = overlay_sessions(&raw_sessions, &live_sessions);
    let issues = derive_issues(&raw_issues, &sessions);
    Ok((issues, sessions))
}

/// Projects one slice directly from `ServerDb` + `LiveOverlay` and returns pre-encoded JSON.
pub(crate) async fn project_slice_json(app: &App, kind: SliceKind, seq: i64) -> Result<Arc<str>, ApiError> {
    match kind {
        SliceKind::Board => {
            let (raw_issues, raw_sessions, channels) = tokio::join!(
                app.issue.raw_issues_async(),
                app.session.sessions_async(),
                app.channel.channels_snapshot_async(),
            );
            let input = BoardInput {
                issues: raw_issues.map_err(board_err)?,
                sessions: raw_sessions.map_err(board_err)?,
                channels: channels?,
                commits: app.live.commits_snapshot(),
            };
            let live = app.live.to_core_snapshot(false);
            ser_err(&project_board(&input, &live, seq))
        }
        SliceKind::Sessions => {
            let (raw_sessions, raw_issues) = tokio::join!(app.session.sessions_async(), app.issue.raw_issues_async());
            let input = SessionInput {
                sessions: raw_sessions.map_err(board_err)?,
                issues: raw_issues.map_err(board_err)?,
                machines: app.live.machines_snapshot(),
            };
            let live = app.live.to_core_snapshot(false);
            ser_err(&project_sessions(&input, &live, seq))
        }
        SliceKind::Collab => {
            let chat = app.channel.slice_chat_async().await?;
            let input = CollabInput {
                chat: Some(chat),
                connectors: app.live.connectors_snapshot(),
            };
            ser_err(&project_collab(&input, seq))
        }
        SliceKind::Inbox => {
            let (raw_issues, raw_sessions, user_mentions) = tokio::join!(
                app.issue.raw_issues_async(),
                app.session.sessions_async(),
                app.channel.user_mentions_snapshot_async(),
            );
            let crons = app.cron.list();
            let (call, call_reason) = app.live.call_snapshot();
            let input = InboxInput {
                issues: raw_issues.map_err(board_err)?,
                sessions: raw_sessions.map_err(board_err)?,
                crons,
                user_mentions: user_mentions?,
                runtime_inbox_items: app.live.runtime_inbox_snapshot(),
                call,
                call_reason,
            };
            let live = app.live.to_core_snapshot(false);
            ser_err(&project_inbox(&input, &live, seq))
        }
        SliceKind::Ops => {
            let crons = app.cron.list();
            let media = app.media.list_async().await?;
            let input = OpsInput {
                crons,
                media: Some(media),
            };
            ser_err(&project_ops(&input, seq))
        }
        SliceKind::Farm => {
            let (raw_issues, raw_sessions) = tokio::join!(app.issue.raw_issues_async(), app.session.sessions_async());
            let input = FarmInput {
                issues: raw_issues.map_err(board_err)?,
                sessions: raw_sessions.map_err(board_err)?,
                progress: app.live.progress_snapshot(),
                commits: app.live.commits_snapshot(),
            };
            let live = app.live.to_core_snapshot(true);
            ser_err(&project_farm(&input, &live, seq))
        }
    }
}

/// Projects all 6 slices consistently as a [`SliceBundle`] without draining burst farm effects.
pub(crate) async fn slice_bundle_async(app: &App) -> Result<SliceBundle, ApiError> {
    let (raw_issues, raw_sessions, channels, chat, media) = tokio::join!(
        app.issue.raw_issues_async(),
        app.session.sessions_async(),
        app.channel.channels_snapshot_async(),
        app.channel.slice_chat_async(),
        app.media.list_async(),
    );
    let raw_issues = raw_issues.map_err(board_err)?;
    let raw_sessions = raw_sessions.map_err(board_err)?;
    let channels = channels?;
    let chat = chat?;
    let media = media?;
    let crons = app.cron.list();
    let (call, call_reason) = app.live.call_snapshot();
    let live = app.live.to_core_snapshot(false);
    let seq = app.projector.seq();
    let d = |kind: SliceKind| app.projector.dirty_seq(kind);

    let board = project_board(
        &BoardInput {
            issues: raw_issues.clone(),
            sessions: raw_sessions.clone(),
            channels,
            commits: app.live.commits_snapshot(),
        },
        &live,
        d(SliceKind::Board),
    );
    let sessions = project_sessions(
        &SessionInput {
            sessions: raw_sessions.clone(),
            issues: raw_issues.clone(),
            machines: app.live.machines_snapshot(),
        },
        &live,
        d(SliceKind::Sessions),
    );
    let collab = project_collab(
        &CollabInput {
            chat: Some(chat.clone()),
            connectors: app.live.connectors_snapshot(),
        },
        d(SliceKind::Collab),
    );
    let inbox = project_inbox(
        &InboxInput {
            issues: raw_issues.clone(),
            sessions: raw_sessions.clone(),
            crons: crons.clone(),
            user_mentions: chat.user_mentions,
            runtime_inbox_items: app.live.runtime_inbox_snapshot(),
            call,
            call_reason,
        },
        &live,
        d(SliceKind::Inbox),
    );
    let ops = project_ops(
        &OpsInput {
            crons,
            media: Some(media),
        },
        d(SliceKind::Ops),
    );
    let farm = project_farm(
        &FarmInput {
            issues: raw_issues,
            sessions: raw_sessions,
            progress: app.live.progress_snapshot(),
            commits: app.live.commits_snapshot(),
        },
        &live,
        d(SliceKind::Farm),
    );

    Ok(SliceBundle {
        seq,
        board,
        sessions,
        collab,
        inbox,
        ops,
        farm,
    })
}

/// Builds a [`DebugStateSnapshot`] on demand from DB + `LiveOverlay` without a shadow `SpaceState`.
pub(crate) async fn debug_state_snapshot_async(
    issue: &crate::work::issue::IssueStore,
    session: &crate::work::session::SessionStore,
    channel: &crate::collab::channel::Chat,
    media: &crate::content::media::jobs::MediaStore,
    cron: &crate::work::cron::CronStore,
    live: &crate::app::live::LiveOverlay,
) -> DebugStateSnapshot {
    let raw_issues = issue.raw_issues_async().await.unwrap_or_default();
    let raw_sessions = session.sessions_async().await.unwrap_or_default();
    let live_overlays = live.core_session_overlays();
    let sessions = overlay_sessions(&raw_sessions, &live_overlays);
    let issues = derive_issues(&raw_issues, &sessions);
    let channels = channel.channels_snapshot_async().await.unwrap_or_default();
    let user_mentions = channel.user_mentions_snapshot_async().await.unwrap_or_default();
    let media_jobs = media.list_async().await.unwrap_or_default();
    let crons = cron.list();
    let (call, call_reason) = live.call_snapshot();
    let live_snap = live.to_core_snapshot(false);
    let inbox = project_inbox(
        &InboxInput {
            issues: raw_issues,
            sessions: raw_sessions,
            crons,
            user_mentions,
            runtime_inbox_items: live.runtime_inbox_snapshot(),
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
        media_job_count: media_jobs.len() as u32,
        inbox_count: inbox.items.len() as u32,
        state_cache_json: serde_json::Value::Null,
    }
}
