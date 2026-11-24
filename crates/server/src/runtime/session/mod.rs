//! `session.*` and the `issue.watch` stream: agent sessions, their work logs,
//! mailbox deliveries, direct workspace chat, and live watch streams.

use std::collections::HashSet;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_core::rules::session_ids_of;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, Issue, IssueGetInput, IssueStageKind, IssueWatch, LiveEvent, Session, SessionBindingInput, SessionChildTranscript,
    SessionChildTranscriptInput, SessionController, SessionEventListInput, SessionEventPage, SessionId, SessionOpenWorkspaceInput,
    SessionRespondInteractionInput, SessionRespondPermissionInput, SessionSendInput, SessionSetConfigInput, SessionWatchEvent, SessionWatchPayload,
    SessionWorkspace, SliceKind,
};

use crate::context::error::{LookIn, missing};
use crate::context::feed::SliceSubscription;
use crate::runtime::{RuntimeError, derive_all_issues};
use crate::storage::Storage;

pub(crate) mod delivery;
pub mod driver;
mod engine;
mod gen_table;
pub mod journal;
pub mod mailbox;
mod news;
pub mod report;
pub mod run;
mod subagent;
mod talk;
mod workspace;

pub use driver::{AgentProfileInfo, Drive, HelperPlace, Persona, RuntimeDriver, SessionDriver};
pub use engine::{DraftEnd, Hire, RememberHook, Rounds, SessionEngine, SessionLifecycleEvent};
pub(crate) use engine::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};
pub use journal::{Journal, Trajectory};
pub use mailbox::{MailboxEntry, MailboxSource, MailboxStatus};
pub use news::News;
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};
pub use run::trigger_of;
pub use workspace::WorkspaceSnapshot;

fn helper_ref(id: &str) -> ApiError {
    missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session)
}

pub(crate) fn session_error(e: RuntimeError) -> ApiError {
    match e {
        RuntimeError::Api(e) => e,
        RuntimeError::Agent(err) => match err {
            vibevalley_runtime::oar::AgentError::UnknownRuntime(_)
            | vibevalley_runtime::oar::AgentError::NotAvailable(_)
            | vibevalley_runtime::oar::AgentError::Unsupported { .. } => ApiError::new(BizCode::RuntimeRefused, err.to_string()),
            vibevalley_runtime::oar::AgentError::Rejected(_)
            | vibevalley_runtime::oar::AgentError::Io(_)
            | vibevalley_runtime::oar::AgentError::Protocol(_) => ApiError::new(BizCode::SessionRefused, err.to_string()),
        },
        RuntimeError::Store(e) => ApiError::new(BizCode::InternalError, e.to_string()),
        other => ApiError::new(BizCode::SessionRefused, other.to_string()),
    }
}

fn send_watch_event<T: serde::Serialize>(events: &flume::Sender<serde_json::Value>, stop: &flume::Receiver<()>, event: &T) -> bool {
    if !stop.is_empty() || matches!(stop.try_recv(), Err(flume::TryRecvError::Disconnected)) {
        return false;
    }
    let Ok(val) = serde_json::to_value(event) else {
        return false;
    };
    events.send(val).is_ok()
}

fn watch_stopped(events: &flume::Sender<serde_json::Value>, stop: &flume::Receiver<()>) -> bool {
    events.is_disconnected() || !stop.is_empty() || matches!(stop.try_recv(), Err(flume::TryRecvError::Disconnected))
}

impl SessionEngine {
    pub(crate) async fn list_endpoint_async(&self, profile: Option<String>, controller: Option<SessionController>) -> Result<Vec<Session>, ApiError> {
        let profile = profile.unwrap_or_default();
        let all = self.sessions_async().await.map_err(session_error)?;
        let mut out: Vec<_> = all
            .into_iter()
            .filter(|x| (profile.is_empty() || x.profile_id() == Some(profile.as_str())) && controller.is_none_or(|c| x.controller == c))
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.hired_at));
        Ok(out)
    }

    pub(crate) async fn get_endpoint_async(&self, id: &str) -> Result<Session, ApiError> {
        self.session_async(id).await.ok_or_else(|| helper_ref(id))
    }

    pub(crate) async fn event_list_endpoint_async(&self, input: &SessionEventListInput) -> Result<SessionEventPage, ApiError> {
        let Some(tr) = &self.0.trajectory else {
            return Ok(SessionEventPage::default());
        };
        Ok(tr.events_page_async(input).await.unwrap_or_default())
    }

    pub async fn stop_async(&self, id: &str) -> Result<(), ApiError> {
        let Some(session) = self.session_async(id).await.filter(|s| self.is_live(&s.id)) else {
            return Err(helper_ref(id));
        };
        if session.phase.is_working() {
            let _ = self.stop(&session.id);
        }
        Ok(())
    }

    pub(crate) async fn stop_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        self.stop_async(id).await
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

    pub(crate) async fn attach_binding_endpoint_async(&self, input: SessionBindingInput) -> Result<Session, ApiError> {
        self.attach_binding_async(input).await.map_err(session_error)
    }

    pub(crate) async fn detach_binding_endpoint_async(&self, input: SessionBindingInput) -> Result<Session, ApiError> {
        self.detach_binding_async(input).await.map_err(session_error)
    }

    pub(crate) async fn watch_session_async(
        &self,
        input: SessionWatchPayload,
        events: flume::Sender<serde_json::Value>,
        stop: flume::Receiver<()>,
    ) -> Result<(), ApiError> {
        let initial = self.session_async(&input.id).await.ok_or_else(|| helper_ref(&input.id))?;
        let live = self.0.ctx.live.subscribe_live();
        let sessions_sub = self.0.ctx.feed.subscribe(SliceKind::Sessions);
        let workspace_updates = self.watch_workspace(&initial.id);
        let cancel = self.0.ctx.task.child_token();
        let me = self.clone();
        self.0.ctx.spawn(
            "session.watch",
            watch_session(initial, input.after_seq, me, sessions_sub, live, workspace_updates, cancel, events, stop),
        );
        Ok(())
    }

    pub(crate) async fn watch_issue_async(
        &self,
        input: IssueGetInput,
        events: flume::Sender<serde_json::Value>,
        stop: flume::Receiver<()>,
    ) -> Result<(), ApiError> {
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
            .spawn("issue.watch", watch_issue(initial, me, board_sub, sessions_sub, live, cancel, events, stop));
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
    workspace_updates: flume::Receiver<()>,
    cancel: CancellationToken,
    events: flume::Sender<serde_json::Value>,
    stop: flume::Receiver<()>,
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
        &events,
        &stop,
        &SessionWatchEvent::History {
            session: id.clone(),
            events: history,
        },
    ) {
        return;
    }
    let first_state = workspace_state_event_async(initial, &sessions).await;
    if watch_stopped(&events, &stop) || cancel.is_cancelled() || !send_watch_event(&events, &stop, &first_state) {
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
        if watch_stopped(&events, &stop) || cancel.is_cancelled() {
            return;
        }
        let got = tokio::select! {
            biased;
            _ = cancel.cancelled() => Msg::Stop,
            _ = stop.recv_async() => Msg::Stop,
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
                    && !send_watch_event(
                        &events,
                        &stop,
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
                        if !send_watch_event(&events, &stop, &missing) {
                            return;
                        }
                        previous = Some(missing);
                    }
                    continue;
                };
                let state = workspace_state_event_async(session, &sessions).await;
                if watch_stopped(&events, &stop) || cancel.is_cancelled() {
                    return;
                }
                if previous.as_ref() == Some(&state) {
                    continue;
                }
                if !send_watch_event(&events, &stop, &state) {
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
#[allow(
    clippy::too_many_arguments,
    reason = "watch task carries engine, slice feeds, live stream, cancel token, and channels"
)]
async fn watch_issue(
    initial: Issue,
    sessions: SessionEngine,
    mut board_sub: SliceSubscription,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    cancel: CancellationToken,
    events: flume::Sender<serde_json::Value>,
    stop: flume::Receiver<()>,
) {
    let last = |ids: Vec<&SessionId>| -> Vec<SessionId> { ids.iter().skip(ids.len().saturating_sub(SHOWN_SESSIONS)).map(|s| (*s).clone()).collect() };
    let mut ids: HashSet<SessionId> = last(session_ids_of(&initial)).into_iter().collect();
    let mut loaded = false;
    let mut was_settled = false;
    let mut previous: Option<IssueWatch> = None;
    let mut emit_initial = true;
    enum WatchStep {
        State,
        Live(Box<LiveEvent>),
        Stop,
    }
    loop {
        if watch_stopped(&events, &stop) || cancel.is_cancelled() {
            return;
        }
        let step = if emit_initial {
            emit_initial = false;
            WatchStep::State
        } else {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => WatchStep::Stop,
                _ = stop.recv_async() => WatchStep::Stop,
                changed = board_sub.changed() => if changed { WatchStep::State } else { WatchStep::Stop },
                changed = sessions_sub.changed() => if changed { WatchStep::State } else { WatchStep::Stop },
                ev = live.recv() => match ev {
                    Ok(e) => WatchStep::Live(Box::new(e)),
                    Err(broadcast::error::RecvError::Lagged(_)) => WatchStep::State,
                    Err(broadcast::error::RecvError::Closed) => WatchStep::Stop,
                },
            }
        };
        match step {
            WatchStep::Stop => return,
            WatchStep::Live(ev) => {
                if let LiveEvent::Event(e) = *ev
                    && ids.contains(&e.id)
                    && !send_watch_event(
                        &events,
                        &stop,
                        &IssueWatch::Event {
                            session: e.id.clone(),
                            event: e.activity,
                        },
                    )
                {
                    return;
                }
            }
            WatchStep::State => {
                let raw_issues = sessions.0.ctx.service.issue.all().await.unwrap_or_default();
                let all_sessions = sessions.sessions_async().await.unwrap_or_default();
                let issues = derive_all_issues(&raw_issues, &all_sessions);
                let issue = issues
                    .iter()
                    .find(|i| i.id == initial.id)
                    .cloned()
                    .or_else(|| initial.closed_at.is_some().then(|| initial.clone()));
                let Some(issue) = issue else {
                    if !send_watch_event(&events, &stop, &IssueWatch::Missing { issue: initial.id.clone() }) {
                        return;
                    }
                    continue;
                };
                let all = session_ids_of(&issue);
                let total = all.len();
                let selected = last(all);
                let settled = issue.stage.state.wants_user() || matches!(issue.stage.state, IssueStageKind::Done | IssueStageKind::Canceled);
                let state = IssueWatch::State {
                    sessions: all_sessions.iter().filter(|s| selected.contains(&s.id)).cloned().collect(),
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
                    let history = match &sessions.0.trajectory {
                        Some(tr) => tr.events_async(id, None).await.unwrap_or_default(),
                        None => Vec::new(),
                    };
                    let history = history[history.len().saturating_sub(HISTORY)..].to_vec();
                    match history.first().map(|e| e.seq) {
                        Some(first) if first > 0 => rows.push(IssueWatch::Gap {
                            session: id.clone(),
                            before: Some(first),
                        }),
                        None if !all_sessions.iter().any(|s| &s.id == id) => rows.push(IssueWatch::Gap {
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
                    if !send_watch_event(&events, &stop, &row) {
                        return;
                    }
                }
            }
        }
    }
}
