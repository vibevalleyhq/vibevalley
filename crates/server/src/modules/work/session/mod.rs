//! `session.*` and the `issue.watch` stream: the board's sessions, their
//! work logs, and one issue followed with its sessions' steps.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_core::rules::{session_ids_of, stage_wants_user};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, Issue, IssueStageKind, IssueWatch, LiveEvent, Session, SessionId, SessionWatchEvent, SliceKind, ops, subscriptions,
};

use crate::base::{LookIn, missing};
use crate::modules::content::attachment::Attachments;
use crate::modules::work::ledger::{BoardError, find};
use crate::slice_feed::SliceSubscription;
use crate::{Hub, Sink};

pub(crate) mod db;
mod delivery;
mod drivers;
mod gen_table;
pub mod journal;
pub mod mailbox;
mod news;
mod report;
mod runs;
mod sessions;
mod subagents;
mod talk;
mod workspace;

pub use db::SqliteSessionStore;
pub use drivers::{AgentDrivers, Drive, Drivers, HelperPlace, Persona, RuntimeDrivers};
pub use journal::{Journal, Trajectories};
pub use news::News;
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};
pub use runs::trigger_of;
pub use sessions::{DraftEnd, Hire, Rounds, Sessions};
pub use workspace::WorkspaceSnapshot;

fn helper_ref(id: &str) -> ApiError {
    missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session)
}

fn session_error(e: BoardError) -> ApiError {
    match e {
        BoardError::Api(e) => e,
        BoardError::Agent(err) => match err {
            vibevalley_runtime::oar::AgentError::UnknownRuntime(_)
            | vibevalley_runtime::oar::AgentError::NotAvailable(_)
            | vibevalley_runtime::oar::AgentError::Unsupported { .. } => ApiError::new(BizCode::RuntimeRefused, err.to_string()),
            vibevalley_runtime::oar::AgentError::Rejected(_)
            | vibevalley_runtime::oar::AgentError::Io(_)
            | vibevalley_runtime::oar::AgentError::Protocol(_) => ApiError::new(BizCode::SessionRefused, err.to_string()),
        },
        BoardError::Store(e) => ApiError::new(BizCode::InternalError, e.to_string()),
        other => ApiError::new(BizCode::SessionRefused, other.to_string()),
    }
}

async fn run_blocking<F, R>(f: F) -> Result<R, ApiError>
where
    F: FnOnce() -> Result<R, ApiError> + Send + 'static,
    R: Send + 'static,
{
    crate::spawn_blocking_traced(f)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
}

pub fn install(hub: &Arc<Hub>, sessions: Sessions, trajectories: Arc<Trajectories>, attachments: Option<Arc<Attachments>>) {
    hub.on_async::<ops::SessionList, _, _>(move |ctx, input| async move {
        let profile = input.profile.unwrap_or_default();
        let controller = input.controller;
        let mut out: Vec<_> = ctx.hub.read(|s| {
            s.sessions
                .iter()
                .filter(|x| (profile.is_empty() || x.profile_id() == Some(profile.as_str())) && controller.is_none_or(|c| x.controller == c))
                .cloned()
                .collect()
        });
        out.sort_by_key(|s| std::cmp::Reverse(s.hired_at));
        Ok(out)
    });
    hub.on_async::<ops::SessionGet, _, _>(move |ctx, input| async move {
        ctx.hub
            .read(|s| s.sessions.iter().find(|x| x.id == input.id).cloned())
            .ok_or_else(|| helper_ref(&input.id))
    });
    let tr = trajectories.clone();
    hub.on_async::<ops::SessionEventList, _, _>(move |_, input| {
        let tr = tr.clone();
        async move { run_blocking(move || Ok(tr.events_page(&input).unwrap_or_default())).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionStop, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || stop(&s, &input.id)).await }
    });

    let s = sessions.clone();
    hub.on_async::<ops::SessionOpenWorkspace, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.open_workspace(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionCloseWorkspace, _, _>(move |_, input| {
        let s = s.clone();
        async move {
            run_blocking(move || {
                s.close_workspace(&input.id);
                Ok(())
            })
            .await
        }
    });
    let s = sessions.clone();
    let att = attachments;
    hub.on_async::<ops::SessionSend, _, _>(move |ctx, input| {
        let s = s.clone();
        let att = att.clone();
        async move {
            let trace_id = (ctx.trace_id != 0).then_some(ctx.trace_id);
            run_blocking(move || s.send_workspace_with_trace(input, att.as_deref(), trace_id).map_err(session_error)).await
        }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionRespondPermission, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.respond_permission(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionRespondInteraction, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.respond_interaction(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionSetConfig, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.set_workspace_config(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionChildTranscript, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.read_child_transcript(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionBindingAttach, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.attach_binding(input).map_err(session_error)).await }
    });
    let s = sessions.clone();
    hub.on_async::<ops::SessionBindingDetach, _, _>(move |_, input| {
        let s = s.clone();
        async move { run_blocking(move || s.detach_binding(input).map_err(session_error)).await }
    });

    let s = sessions;
    let tr = trajectories.clone();
    let me = Arc::downgrade(hub);
    hub.on_subscription::<subscriptions::SessionWatch>(move |hub, input, sink| {
        let initial = s.session(&input.id).ok_or_else(|| helper_ref(&input.id))?;
        let live = hub.subscribe_live();
        let sessions_sub = hub.subscribe_slice_feed(SliceKind::Sessions);
        let workspace_updates = s.watch_workspace(&initial.id);
        let sessions = s.clone();
        let tr = tr.clone();
        let hub_weak = me.clone();
        let cancel = hub.child_token();
        let after_seq = input.after_seq;
        hub.spawn_task(watch_session(
            initial,
            after_seq,
            hub_weak,
            sessions,
            sessions_sub,
            live,
            workspace_updates,
            tr,
            cancel,
            sink,
        ));
        Ok(())
    });

    let tr = trajectories;
    let me = Arc::downgrade(hub);
    hub.on_subscription::<subscriptions::IssueWatch>(move |hub, input, sink| {
        let initial = hub
            .read(|st| find(&st.issues, &input.id).cloned())
            .ok_or_else(|| missing(t("server.issue.issueRef", &[("ref", input.id.clone().into())]), LookIn::Issue))?;
        let live = hub.subscribe_live();
        let board_sub = hub.subscribe_slice_feed(SliceKind::Board);
        let sessions_sub = hub.subscribe_slice_feed(SliceKind::Sessions);
        let tr = tr.clone();
        let hub_weak = me.clone();
        let cancel = hub.child_token();
        hub.spawn_task(watch_issue(initial, hub_weak, board_sub, sessions_sub, live, tr, cancel, sink));
        Ok(())
    });
}

/// `session.stop`: the working round of a helper this process drives stops.
pub(crate) fn stop(sessions: &Sessions, id: &str) -> Result<(), ApiError> {
    let Some(session) = sessions.session(id).filter(|s| sessions.is_live(&s.id)) else {
        return Err(helper_ref(id));
    };
    if session.phase.is_working() {
        let _ = sessions.stop(&session.id);
    }
    Ok(())
}

fn workspace_state_event(session: Session, sessions: &Sessions) -> SessionWatchEvent {
    let title = sessions.session_title(&session.id);
    let snap = sessions.workspace_snapshot(&session.id);
    let swarm = sessions.swarm_snapshot(&session.id);
    SessionWatchEvent::State {
        session,
        title,
        model: snap.model,
        effort: snap.effort,
        permission_mode: snap.permission_mode,
        pending_permissions: snap.pending_permissions,
        pending_interactions: snap.pending_interactions,
        tokens: snap.tokens,
        swarm,
    }
}

async fn load_workspace_state_event(session: Session, sessions: Sessions) -> Option<SessionWatchEvent> {
    tokio::task::spawn_blocking(move || workspace_state_event(session, &sessions)).await.ok()
}

#[allow(clippy::too_many_arguments, reason = "watch task carries hub, session streams, cancel token, and sink")]
async fn watch_session(
    initial: Session,
    after_seq: Option<i64>,
    hub: std::sync::Weak<Hub>,
    sessions: Sessions,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    workspace_updates: flume::Receiver<()>,
    trajectories: Arc<Trajectories>,
    cancel: CancellationToken,
    sink: Sink,
) {
    let id = initial.id.clone();
    let history: Vec<_> = {
        let tr = trajectories.clone();
        let sid = id.clone();
        tokio::task::spawn_blocking(move || tr.events(&sid, None).unwrap_or_default())
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|e| after_seq.is_none_or(|after| e.seq > after))
            .collect()
    };
    if !sink.send(&SessionWatchEvent::History {
        session: id.clone(),
        events: history,
    }) {
        return;
    }
    let Some(first_state) = load_workspace_state_event(initial, sessions.clone()).await else {
        return;
    };
    if sink.stopped() || cancel.is_cancelled() || !sink.send(&first_state) {
        return;
    }
    let mut previous: Option<SessionWatchEvent> = Some(first_state);
    let mut workspace_open = true;
    enum Msg {
        State,
        WorkspaceDropped,
        Live(Box<LiveEvent>),
        Stop,
    }
    loop {
        if sink.stopped() || cancel.is_cancelled() {
            return;
        }
        let got = tokio::select! {
            biased;
            _ = cancel.cancelled() => Msg::Stop,
            _ = sink.stop.recv_async() => Msg::Stop,
            changed = sessions_sub.changed() => if changed { Msg::State } else { Msg::Stop },
            ws = workspace_updates.recv_async(), if workspace_open => {
                if ws.is_ok() { Msg::State } else { Msg::WorkspaceDropped }
            }
            ev = live.recv() => match ev {
                Ok(e) => Msg::Live(Box::new(e)),
                Err(broadcast::error::RecvError::Lagged(_)) => Msg::State,
                Err(broadcast::error::RecvError::Closed) => Msg::Stop,
            },
            // Poll mtime-cached swarm snapshots on the 500 ms tick; identical states are skipped.
            _ = tokio::time::sleep(Duration::from_millis(500)) => Msg::State,
        };
        match got {
            Msg::Stop => return,
            Msg::Live(ev) => {
                if let LiveEvent::Event(e) = *ev
                    && e.id == id
                    && !sink.send(&SessionWatchEvent::Event {
                        session: e.id.clone(),
                        event: e.activity,
                    })
                {
                    return;
                }
            }
            Msg::State | Msg::WorkspaceDropped => {
                if matches!(got, Msg::WorkspaceDropped) {
                    workspace_open = false;
                }
                let Some(hub) = hub.upgrade() else { return };
                let current = hub.read(|s| s.sessions.iter().find(|x| x.id == id).cloned());
                drop(hub);
                let Some(session) = current else {
                    let missing = SessionWatchEvent::Missing { session: id.clone() };
                    if previous.as_ref() != Some(&missing) {
                        if !sink.send(&missing) {
                            return;
                        }
                        previous = Some(missing);
                    }
                    continue;
                };
                let Some(state) = load_workspace_state_event(session, sessions.clone()).await else {
                    return;
                };
                if sink.stopped() || cancel.is_cancelled() {
                    return;
                }
                if previous.as_ref() == Some(&state) {
                    continue;
                }
                if !sink.send(&state) {
                    return;
                }
                previous = Some(state);
            }
        }
    }
}

const SHOWN_SESSIONS: usize = 8;
const HISTORY: usize = 241;

/// `watchIssue`: the issue and its last eight sessions as each frame shows
/// them (only when changed), their logs when first seen (and again once it
/// settles), and their steps live.
#[allow(clippy::too_many_arguments, reason = "watch task carries hub, slice feeds, live stream, cancel token, and sink")]
async fn watch_issue(
    initial: Issue,
    hub: std::sync::Weak<Hub>,
    mut board_sub: SliceSubscription,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    trajectories: Arc<Trajectories>,
    cancel: CancellationToken,
    sink: Sink,
) {
    let last = |ids: Vec<&SessionId>| -> Vec<SessionId> { ids.iter().skip(ids.len().saturating_sub(SHOWN_SESSIONS)).map(|s| (*s).clone()).collect() };
    let mut ids: HashSet<SessionId> = last(session_ids_of(&initial)).into_iter().collect();
    let mut loaded = false;
    let mut was_settled = false;
    let mut previous: Option<IssueWatch> = None;
    let mut emit_initial = true;
    enum Step {
        State,
        Live(Box<LiveEvent>),
        Stop,
    }
    loop {
        if sink.stopped() || cancel.is_cancelled() {
            return;
        }
        let step = if emit_initial {
            emit_initial = false;
            Step::State
        } else {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Step::Stop,
                _ = sink.stop.recv_async() => Step::Stop,
                changed = board_sub.changed() => if changed { Step::State } else { Step::Stop },
                changed = sessions_sub.changed() => if changed { Step::State } else { Step::Stop },
                ev = live.recv() => match ev {
                    Ok(e) => Step::Live(Box::new(e)),
                    Err(broadcast::error::RecvError::Lagged(_)) => Step::State,
                    Err(broadcast::error::RecvError::Closed) => Step::Stop,
                },
            }
        };
        match step {
            Step::Stop => return,
            Step::Live(ev) => {
                if let LiveEvent::Event(e) = *ev
                    && ids.contains(&e.id)
                    && !sink.send(&IssueWatch::Event {
                        session: e.id.clone(),
                        event: e.activity,
                    })
                {
                    return;
                }
            }
            // A frame says the state changed; the full sessions are the hub's.
            Step::State => {
                let Some(hub) = hub.upgrade() else { return };
                let (issues, sessions) = hub.read(|s| (s.issues.clone(), s.sessions.clone()));
                drop(hub);
                let issue = issues
                    .iter()
                    .find(|i| i.id == initial.id)
                    .cloned()
                    .or_else(|| initial.closed_at.is_some().then(|| initial.clone()));
                let Some(issue) = issue else {
                    if !sink.send(&IssueWatch::Missing { issue: initial.id.clone() }) {
                        return;
                    }
                    continue;
                };
                let all = session_ids_of(&issue);
                let total = all.len();
                let selected = last(all);
                let settled = stage_wants_user(issue.stage.state) || matches!(issue.stage.state, IssueStageKind::Done | IssueStageKind::Canceled);
                let state = IssueWatch::State {
                    sessions: sessions.iter().filter(|s| selected.contains(&s.id)).cloned().collect(),
                    session_ids: selected.clone(),
                    settled,
                    omitted_sessions: (total - selected.len()) as i64,
                    issue,
                };
                if previous.as_ref() == Some(&state) {
                    continue;
                }
                previous = Some(state.clone());
                let mut rows = Vec::new();
                for id in &selected {
                    if loaded && ids.contains(id) && !(settled && !was_settled) {
                        continue;
                    }
                    let tr = trajectories.clone();
                    let sid = id.clone();
                    let history = tokio::task::spawn_blocking(move || tr.events(&sid, None).unwrap_or_default())
                        .await
                        .unwrap_or_default();
                    let history = history[history.len().saturating_sub(HISTORY)..].to_vec();
                    match history.first().map(|e| e.seq) {
                        Some(first) if first > 0 => rows.push(IssueWatch::Gap {
                            session: id.clone(),
                            before: Some(first),
                        }),
                        None if !sessions.iter().any(|s| &s.id == id) => rows.push(IssueWatch::Gap {
                            session: id.clone(),
                            before: None,
                        }),
                        _ => {}
                    }
                    rows.push(IssueWatch::History {
                        session: id.clone(),
                        events: history,
                    });
                }
                ids = selected.into_iter().collect();
                loaded = true;
                was_settled = settled;
                rows.push(state);
                for row in rows {
                    if !sink.send(&row) {
                        return;
                    }
                }
            }
        }
    }
}
