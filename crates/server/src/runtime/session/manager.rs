use std::collections::HashSet;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_core::rules::session_ids_of;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, HumanPause, HumanPauseSource, Issue, IssueGetInput, IssueStageKind, IssueWatch, LiveEvent, ResumeCondition, Session,
    SessionChildTranscript, SessionChildTranscriptInput, SessionController, SessionEventListInput, SessionEventPage, SessionId, SessionOpenWorkspaceInput,
    SessionRespondInteractionInput, SessionRespondPermissionInput, SessionSendInput, SessionSetConfigInput, SessionWatchEvent, SessionWatchPayload,
    SessionWorkspace, SliceKind,
};
use vibevalley_runtime::oar::{ControlAction, ControlStatus};

use super::engine::SessionEngine;
use super::types::{helper_ref, session_error};
use crate::context::error::{LookIn, missing};
use crate::context::feed::SliceSubscription;
use crate::context::now;
use crate::runtime::{IssueChange, derive_all_issues};
use crate::storage::Storage;

fn send_watch_event<T: serde::Serialize>(sink: &crate::context::Sink, event: &T) -> bool {
    sink.send(event)
}

fn watch_stopped(sink: &crate::context::Sink) -> bool {
    sink.stopped() || sink.events.is_closed()
}

impl SessionEngine {
    pub(crate) async fn list_endpoint_async(&self, profile: Option<String>, controller: Option<SessionController>) -> Result<Vec<Session>, ApiError> {
        let profile = profile.unwrap_or_default();
        let all = self.sessions_with_telemetry_async().await.map_err(session_error)?;
        let mut out: Vec<_> = all
            .into_iter()
            .filter(|x| (profile.is_empty() || x.profile_id() == Some(profile.as_str())) && controller.is_none_or(|c| x.controller == c))
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.hired_at));
        Ok(out)
    }

    pub(crate) async fn get_endpoint_async(&self, id: &str) -> Result<Session, ApiError> {
        self.session_with_telemetry_async(id).await.ok_or_else(|| helper_ref(id))
    }

    pub(crate) async fn event_list_endpoint_async(&self, input: &SessionEventListInput) -> Result<SessionEventPage, ApiError> {
        let Some(tr) = &self.0.trajectory else {
            return Ok(SessionEventPage::default());
        };
        Ok(tr.events_page_async(input).await.unwrap_or_default())
    }

    pub async fn stop_async(&self, id: &str) -> Result<(), ApiError> {
        self.stop_with_pause_async(id, None).await
    }

    /// Stops a live session and, when invoked by a human (`source`), persists
    /// an explicit human pause on its bound issue across restarts.
    pub async fn stop_with_pause_async(&self, id: &str, source: Option<HumanPauseSource>) -> Result<(), ApiError> {
        let Some(session) = self.session_async(id).await.filter(|s| self.is_live(&s.id)) else {
            return Err(helper_ref(id));
        };
        if let Some(src) = source
            && let Some(issue_id) = session.issue_id()
        {
            let pause = HumanPause {
                source: src,
                clear_condition: ResumeCondition::ExplicitUserResume,
                paused_at: now(),
                session_id: Some(session.id.clone()),
                note: None,
            };
            self.apply_issue_change_async(issue_id, IssueChange::Paused(pause))
                .await
                .map_err(session_error)?;
        }
        if session.phase.is_working() {
            let _ = self.abort_turn_async(&session.id).await;
        }
        Ok(())
    }

    pub(crate) async fn stop_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        self.stop_with_pause_async(id, Some(HumanPauseSource::UserStop)).await
    }

    pub(crate) async fn open_workspace_endpoint_async(&self, input: SessionOpenWorkspaceInput) -> Result<SessionWorkspace, ApiError> {
        self.open_workspace_async(input).await.map_err(session_error)
    }

    pub(crate) async fn close_workspace_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        self.close_workspace_async(id).await;
        Ok(())
    }

    pub(crate) async fn send_workspace_endpoint_async(
        &self,
        input: SessionSendInput,
        storage: Option<&Storage>,
        trace_id: Option<u64>,
    ) -> Result<Session, ApiError> {
        self.send_workspace_with_trace_async(input, storage, trace_id).await.map_err(session_error)
    }

    pub(crate) async fn respond_permission_endpoint_async(&self, input: SessionRespondPermissionInput) -> Result<(), ApiError> {
        self.respond_permission_async(input).await.map_err(session_error)
    }

    pub(crate) async fn respond_interaction_endpoint_async(&self, input: SessionRespondInteractionInput) -> Result<(), ApiError> {
        self.respond_interaction_async(input).await.map_err(session_error)
    }

    pub(crate) async fn set_config_endpoint_async(&self, input: SessionSetConfigInput) -> Result<SessionWorkspace, ApiError> {
        self.set_workspace_config_async(input).await.map_err(session_error)
    }

    pub(crate) async fn child_transcript_endpoint_async(&self, input: SessionChildTranscriptInput) -> Result<SessionChildTranscript, ApiError> {
        self.read_child_transcript_async(input).await.map_err(session_error)
    }

    pub(crate) async fn compact_live_async(&self, id: &str) -> Result<(), ApiError> {
        let Some(agent) = self.live_agent(id) else {
            return Err(ApiError::new(BizCode::SessionRefused, t("server.session.workspace.notLive", &[])));
        };
        let key = format!("compact-{}", uuid::Uuid::now_v7());
        let outcome = agent
            .control(ControlAction::Compact, "", &key, &key)
            .await
            .map_err(|e| session_error(e.into()))?;
        match outcome.status {
            ControlStatus::Accepted => Ok(()),
            ControlStatus::Unsupported => Err(ApiError::new(BizCode::RuntimeRefused, outcome.reason)),
            ControlStatus::Rejected | ControlStatus::NotRunning => Err(ApiError::new(BizCode::SessionRefused, outcome.reason)),
        }
    }

    pub(crate) fn worker_conversation(&self, id: &str) -> Option<String> {
        self.extra(id)
            .agent_session
            .filter(|vendor| !vendor.trim().is_empty())
            .map(|vendor| vibevalley_runtime::agent::harness::worker_conversation(&vendor))
    }

    pub(crate) async fn watch_session_async(&self, input: SessionWatchPayload, sink: crate::context::Sink) -> Result<(), ApiError> {
        let initial = self.session_async(&input.id).await.ok_or_else(|| helper_ref(&input.id))?;
        let live = self.0.ctx.live.subscribe_live();
        let sessions_sub = self.0.ctx.feed.subscribe(SliceKind::Sessions);
        let workspace_updates = self.watch_workspace(&initial.id);
        let cancel = self.0.ctx.task.child_token();
        let me = self.clone();
        self.0.ctx.spawn(
            "session.watch",
            watch_session(initial, input.after_seq, me, sessions_sub, live, workspace_updates, cancel, sink),
        );
        Ok(())
    }

    pub(crate) async fn watch_issue_async(&self, input: IssueGetInput, sink: crate::context::Sink) -> Result<(), ApiError> {
        let initial = self
            .raw_issue_async(&input.id)
            .await
            .map_err(session_error)?
            .ok_or_else(|| missing(t("server.issue.issueRef", &[("ref", input.id.clone().into())]), LookIn::Issue))?;
        let live = self.0.ctx.live.subscribe_live();
        let board_sub = self.0.ctx.feed.subscribe(SliceKind::Board);
        let sessions_sub = self.0.ctx.feed.subscribe(SliceKind::Sessions);
        let cancel = self.0.ctx.task.child_token();
        let me = self.clone();
        self.0
            .ctx
            .spawn("issue.watch", watch_issue(initial, me, board_sub, sessions_sub, live, cancel, sink));
        Ok(())
    }
}

async fn workspace_state_event_async(session: Session, sessions: &SessionEngine) -> SessionWatchEvent {
    let title = sessions.session_title_async(&session.id).await;
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

#[allow(clippy::too_many_arguments, reason = "watch task carries engine, streams, cancel token, and channels")]
async fn watch_session(
    initial: Session,
    after_seq: Option<i64>,
    sessions: SessionEngine,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    mut workspace_updates: tokio::sync::mpsc::Receiver<()>,
    cancel: CancellationToken,
    sink: crate::context::Sink,
) {
    let id = initial.id.clone();
    let history: Vec<_> = match &sessions.0.trajectory {
        Some(tr) => tr
            .events_async(&id, None)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|e| after_seq.is_none_or(|after| e.seq > after))
            .collect(),
        None => Vec::new(),
    };
    if !send_watch_event(
        &sink,
        &SessionWatchEvent::History {
            session: id.clone(),
            events: history,
        },
    ) {
        return;
    }
    let first_state = workspace_state_event_async(initial, &sessions).await;
    if watch_stopped(&sink) || cancel.is_cancelled() || !send_watch_event(&sink, &first_state) {
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
        if watch_stopped(&sink) || cancel.is_cancelled() {
            return;
        }
        let got = tokio::select! {
            biased;
            _ = cancel.cancelled() => Msg::Stop,
            _ = sink.stop.cancelled() => Msg::Stop,
            changed = sessions_sub.changed() => if changed { Msg::State } else { Msg::Stop },
            ws = workspace_updates.recv(), if workspace_open => {
                if ws.is_some() { Msg::State } else { Msg::WorkspaceDropped }
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
                    && !send_watch_event(
                        &sink,
                        &SessionWatchEvent::Event {
                            session: e.id.clone(),
                            event: e.activity,
                        },
                    )
                {
                    return;
                }
            }
            Msg::State | Msg::WorkspaceDropped => {
                if matches!(got, Msg::WorkspaceDropped) {
                    workspace_open = false;
                }
                let current = sessions.session_async(&id).await;
                let Some(session) = current else {
                    let missing = SessionWatchEvent::Missing { session: id.clone() };
                    if previous.as_ref() != Some(&missing) {
                        if !send_watch_event(&sink, &missing) {
                            return;
                        }
                        previous = Some(missing);
                    }
                    continue;
                };
                let state = workspace_state_event_async(session, &sessions).await;
                if watch_stopped(&sink) || cancel.is_cancelled() {
                    return;
                }
                if previous.as_ref() == Some(&state) {
                    continue;
                }
                if !send_watch_event(&sink, &state) {
                    return;
                }
                previous = Some(state);
            }
        }
    }
}

const SHOWN_SESSIONS: usize = 8;
const HISTORY: usize = 241;

enum WatchStep {
    State,
    Live(Box<LiveEvent>),
    Stop,
}

struct IssueWatchState {
    ids: HashSet<SessionId>,
    loaded: bool,
    was_settled: bool,
    previous: Option<IssueWatch>,
}

fn last_shown_sessions(ids: Vec<&SessionId>) -> Vec<SessionId> {
    ids.iter().skip(ids.len().saturating_sub(SHOWN_SESSIONS)).map(|s| (*s).clone()).collect()
}

async fn next_issue_watch_step_async(
    emit_initial: &mut bool,
    board_sub: &mut SliceSubscription,
    sessions_sub: &mut SliceSubscription,
    live: &mut broadcast::Receiver<LiveEvent>,
    cancel: &CancellationToken,
    sink: &crate::context::Sink,
) -> WatchStep {
    if *emit_initial {
        *emit_initial = false;
        return WatchStep::State;
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => WatchStep::Stop,
        _ = sink.stop.cancelled() => WatchStep::Stop,
        changed = board_sub.changed() => if changed { WatchStep::State } else { WatchStep::Stop },
        changed = sessions_sub.changed() => if changed { WatchStep::State } else { WatchStep::Stop },
        ev = live.recv() => match ev {
            Ok(e) => WatchStep::Live(Box::new(e)),
            Err(broadcast::error::RecvError::Lagged(_)) => WatchStep::State,
            Err(broadcast::error::RecvError::Closed) => WatchStep::Stop,
        },
    }
}

fn forward_issue_live_event(sink: &crate::context::Sink, ids: &HashSet<SessionId>, ev: LiveEvent) -> bool {
    let LiveEvent::Event(e) = ev else {
        return true;
    };
    if !ids.contains(&e.id) {
        return true;
    }
    send_watch_event(
        sink,
        &IssueWatch::Event {
            session: e.id,
            event: e.activity,
        },
    )
}

fn session_history_gap(id: &SessionId, first_seq: Option<i64>, all_sessions: &[Session]) -> Option<IssueWatch> {
    match first_seq {
        Some(first) if first > 0 => Some(IssueWatch::Gap {
            session: id.clone(),
            before: Some(first),
        }),
        None if !all_sessions.iter().any(|s| &s.id == id) => Some(IssueWatch::Gap {
            session: id.clone(),
            before: None,
        }),
        _ => None,
    }
}

async fn collect_issue_history_rows_async(
    sessions: &SessionEngine,
    all_sessions: &[Session],
    selected: &[SessionId],
    state: &IssueWatchState,
    settled: bool,
) -> Vec<IssueWatch> {
    let mut rows = Vec::new();
    for id in selected {
        if state.loaded && state.ids.contains(id) && !(settled && !state.was_settled) {
            continue;
        }
        let history = match &sessions.0.trajectory {
            Some(tr) => tr.events_async(id, None).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let history = history[history.len().saturating_sub(HISTORY)..].to_vec();
        if let Some(gap) = session_history_gap(id, history.first().map(|e| e.seq), all_sessions) {
            rows.push(gap);
        }
        rows.push(IssueWatch::History {
            session: id.clone(),
            events: history,
        });
    }
    rows
}

async fn emit_issue_watch_state_async(initial: &Issue, sessions: &SessionEngine, sink: &crate::context::Sink, state: &mut IssueWatchState) -> bool {
    let raw_issues = sessions.0.ctx.service.issue.all().await.unwrap_or_default();
    let all_sessions = sessions.sessions_async().await.unwrap_or_default();
    let issues = derive_all_issues(&raw_issues, &all_sessions);
    let issue = issues
        .iter()
        .find(|i| i.id == initial.id)
        .cloned()
        .or_else(|| initial.closed_at.is_some().then(|| initial.clone()));
    let Some(issue) = issue else {
        return send_watch_event(sink, &IssueWatch::Missing { issue: initial.id.clone() });
    };

    let all = session_ids_of(&issue);
    let total = all.len();
    let selected = last_shown_sessions(all);
    let settled = issue.stage.state.wants_user() || matches!(issue.stage.state, IssueStageKind::Done | IssueStageKind::Canceled);
    let watch_state = IssueWatch::State {
        sessions: all_sessions.iter().filter(|s| selected.contains(&s.id)).cloned().collect(),
        session_ids: selected.clone(),
        settled,
        omitted_sessions: (total - selected.len()) as i64,
        issue,
    };
    if state.previous.as_ref() == Some(&watch_state) {
        return true;
    }
    state.previous = Some(watch_state.clone());

    let mut rows = collect_issue_history_rows_async(sessions, &all_sessions, &selected, state, settled).await;
    state.ids = selected.into_iter().collect();
    state.loaded = true;
    state.was_settled = settled;
    rows.push(watch_state);

    rows.into_iter().all(|row| send_watch_event(sink, &row))
}

/// `watchIssue`: the issue and its last eight sessions as each frame shows
/// them (only when changed), their logs when first seen (and again once it
/// settles), and their steps live.
#[allow(
    clippy::too_many_arguments,
    reason = "watch task carries engine, slice feeds, live stream, cancel token, and sink"
)]
async fn watch_issue(
    initial: Issue,
    sessions: SessionEngine,
    mut board_sub: SliceSubscription,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    cancel: CancellationToken,
    sink: crate::context::Sink,
) {
    let mut state = IssueWatchState {
        ids: last_shown_sessions(session_ids_of(&initial)).into_iter().collect(),
        loaded: false,
        was_settled: false,
        previous: None,
    };
    let mut emit_initial = true;
    loop {
        if watch_stopped(&sink) || cancel.is_cancelled() {
            return;
        }
        let step = next_issue_watch_step_async(&mut emit_initial, &mut board_sub, &mut sessions_sub, &mut live, &cancel, &sink).await;
        let keep_going = match step {
            WatchStep::Stop => false,
            WatchStep::Live(ev) => forward_issue_live_event(&sink, &state.ids, *ev),
            WatchStep::State => emit_issue_watch_state_async(&initial, &sessions, &sink, &mut state).await,
        };
        if !keep_going {
            return;
        }
    }
}
