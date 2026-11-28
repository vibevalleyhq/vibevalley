//! Issue, runtime, channel, cron, and pull-request orchestration (`orchestration::issue`):
//! enriches issues with cron/PR metadata, bridges issue refinement & conversation
//! with [`Chat`], coordinates session stop + human-pause, and owns `issue.watch`.

use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_core::{Clock, derive_issues};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, AppliedIssue, BacklogTriageConfirmInput, Caller, HumanPauseSource, Issue, IssueFilter, IssueHistory, IssueRefineInput, IssueRequest,
    IssueReviewInput, IssueStageKind, IssueStatus, IssueStatusUpdateInput, IssueWatch, LiveEvent, Session, SessionId, SliceKind, Subscription, subscriptions,
};

use crate::agent::Orchestrator;
use crate::channel::Chat;
use crate::context::{Context, LookIn, Sink, SliceSubscription, missing};
use crate::cron::Scheduler as CronScheduler;
use crate::issue::{Board, Pull};
use crate::runtime::Runtime;

const SHOWN_SESSIONS: usize = 8;
const HISTORY: usize = 241;

/// Application-layer issue orchestration uniting [`Board`], [`Runtime`], [`Chat`], [`CronScheduler`], [`Pull`], and [`Orchestrator`].
pub struct IssueWorkflow {
    ctx: Arc<Context>,
    board: Arc<Board>,
    runtime: Arc<Runtime>,
    channel: Arc<Chat>,
    cron: Arc<CronScheduler>,
    pull: Arc<Pull>,
    orchestrator: Arc<Orchestrator>,
}

impl IssueWorkflow {
    pub fn new(
        ctx: Arc<Context>,
        board: Arc<Board>,
        runtime: Arc<Runtime>,
        channel: Arc<Chat>,
        cron: Arc<CronScheduler>,
        pull: Arc<Pull>,
        orchestrator: Arc<Orchestrator>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            board,
            runtime,
            channel,
            cron,
            pull,
            orchestrator,
        })
    }

    pub fn enrich_issue(&self, mut issue: Issue) -> Issue {
        issue.cron = self.cron.cron_of(&issue.id);
        issue.pull_request = self.pull.of_issue(&issue.id);
        issue
    }

    pub fn enrich_issues(&self, issues: Vec<Issue>) -> Vec<Issue> {
        issues.into_iter().map(|i| self.enrich_issue(i)).collect()
    }

    fn enrich_applied(&self, mut applied: AppliedIssue) -> AppliedIssue {
        applied.cron = self.cron.cron_of(&applied.id);
        applied.pull_request = self.pull.of_issue(&applied.id);
        applied
    }

    pub async fn get_endpoint_async(&self, id: &str) -> Result<Issue, ApiError> {
        Ok(self.enrich_issue(self.board.issue_get_endpoint_async(id).await?))
    }

    pub async fn list_endpoint_async(&self, filter: &IssueFilter, clock: &dyn Clock) -> Result<Vec<Issue>, ApiError> {
        Ok(self.enrich_issues(self.board.issue_list_endpoint_async(filter, clock).await?))
    }

    pub async fn history_list_endpoint_async(&self) -> Result<Vec<IssueHistory>, ApiError> {
        let mut history = self.board.issue_history_list_endpoint_async().await?;
        for entry in &mut history {
            entry.issue.cron = self.cron.cron_of(&entry.issue.id);
            entry.issue.pull_request = self.pull.of_issue(&entry.issue.id);
        }
        Ok(history)
    }

    pub async fn create_endpoint_async(&self, req: &IssueRequest) -> Result<AppliedIssue, ApiError> {
        Ok(self.enrich_applied(self.board.issue_create_endpoint_async(req).await?))
    }

    pub async fn review_endpoint_async(&self, input: IssueReviewInput) -> Result<Issue, ApiError> {
        Ok(self.enrich_issue(self.board.issue_review_endpoint_async(input).await?))
    }

    pub async fn status_update_endpoint_async(&self, input: &IssueStatusUpdateInput) -> Result<AppliedIssue, ApiError> {
        Ok(self.enrich_applied(self.board.issue_status_update_endpoint_async(input).await?))
    }

    pub async fn triage_confirm_endpoint_async(&self, input: &BacklogTriageConfirmInput, clock: &dyn Clock) -> Result<AppliedIssue, ApiError> {
        Ok(self.enrich_applied(self.board.issue_triage_confirm_endpoint_async(input, clock).await?))
    }

    /// `issue.conversation.get`: returns the issue's discussion thread id, if opened.
    pub async fn conversation_endpoint_async(&self, id: &str) -> Result<Option<String>, ApiError> {
        let item = self.board.get_async(id).await?;
        Ok(self.channel.issue_thread_id(&item.id))
    }

    /// `issue.refine`: pulls recent issue thread discussion and starts a drafting session.
    pub async fn refine_endpoint_async(&self, input: &IssueRefineInput) -> Result<Issue, ApiError> {
        let item = self.board.get_async(&input.id).await?;
        let said = input.text.as_deref().unwrap_or("").trim().to_string();
        let discussion = if item.status == IssueStatus::Backlog && item.refining.is_none() {
            let thread = self.channel.issue_thread_async(&item.id, &item.title, None).await?;
            let discussion = self
                .channel
                .history_async(&thread, None, Some(40))
                .await?
                .into_iter()
                .map(|m| m.text)
                .collect::<Vec<_>>()
                .join("\n\n");
            if !said.is_empty() {
                self.channel.say_in_async(&thread, &said, String::new()).await?;
            }
            discussion
        } else {
            String::new()
        };
        let refined = self.board.refine_with_discussion_async(input, &discussion).await?;
        Ok(self.enrich_issue(refined))
    }

    /// `session.stop`: stops a daemon orchestrator session or a worker/workspace session
    /// and records human pause on its issue if any.
    pub async fn stop_session_endpoint_async(&self, session_id: &str) -> Result<(), ApiError> {
        let is_daemon = self.orchestrator.is_daemon_profile(session_id)
            || self
                .runtime
                .session_async(session_id)
                .await
                .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::Daemon);
        if is_daemon {
            self.orchestrator.stop_async(Some(session_id)).await;
            return Ok(());
        }
        let stopped = self.runtime.stop_async(session_id).await?;
        if let Some(issue_id) = stopped.issue_id() {
            self.board
                .mark_human_pause_async(issue_id, HumanPauseSource::UserStop, Some(stopped.id.clone()))
                .await
                .map_err(ApiError::from)?;
        }
        Ok(())
    }

    /// `issue.watch`: streams derived issue state, last 8 sessions, trajectories, and live events.
    pub async fn watch_issue_async(&self, input: <subscriptions::IssueWatch as Subscription>::Payload, sink: Sink) -> Result<(), ApiError> {
        let raw_issues = self
            .ctx
            .service
            .issue
            .all()
            .await
            .map_err(|e| ApiError::new(vibevalley_protocol::BizCode::InternalError, e.to_string()))?;
        let sessions = self.runtime.list_async().await;
        let issues = self.enrich_issues(derive_issues(&raw_issues, &sessions));
        let initial = issues
            .into_iter()
            .find(|i| i.id == input.id || i.number.to_string() == input.id.trim_start_matches('#'))
            .ok_or_else(|| missing(t("server.issue.issueRef", &[("ref", input.id.clone().into())]), LookIn::Issue))?;
        let live = self.ctx.live.subscribe_live();
        let board_sub = self.ctx.feed.subscribe(SliceKind::Board);
        let sessions_sub = self.ctx.feed.subscribe(SliceKind::Sessions);
        let cancel = self.ctx.task.child_token();
        let ctx = self.ctx.clone();
        let runtime = self.runtime.clone();
        let cron = self.cron.clone();
        let pull = self.pull.clone();
        self.ctx.spawn(
            "issue.watch",
            watch_issue(initial, ctx, runtime, cron, pull, board_sub, sessions_sub, live, cancel, sink),
        );
        Ok(())
    }

    pub async fn diff_endpoint_async(
        &self,
        caller: Caller,
        id: &str,
        since_tree: Option<&str>,
        on_reviewed: Option<&(dyn Fn(&str) + Send + Sync)>,
    ) -> Result<vibevalley_protocol::Changes, ApiError> {
        self.board.issue_diff_endpoint_async(caller, id, since_tree, on_reviewed).await
    }
}

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

fn watch_stopped(sink: &Sink) -> bool {
    sink.stopped() || sink.events.is_closed()
}

fn send_watch_event<T: serde::Serialize>(sink: &Sink, event: &T) -> bool {
    sink.send(event)
}

fn session_ids_of(issue: &Issue) -> Vec<SessionId> {
    issue.executions().map(|e| e.session().to_string()).collect()
}

fn last_shown_sessions(ids: &[SessionId]) -> Vec<SessionId> {
    ids.iter().skip(ids.len().saturating_sub(SHOWN_SESSIONS)).cloned().collect()
}

async fn next_issue_watch_step_async(
    emit_initial: &mut bool,
    board_sub: &mut SliceSubscription,
    sessions_sub: &mut SliceSubscription,
    live: &mut broadcast::Receiver<LiveEvent>,
    cancel: &CancellationToken,
    sink: &Sink,
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
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(skipped, "issue.watch live stream lagged; resyncing state");
                WatchStep::State
            }
            Err(broadcast::error::RecvError::Closed) => WatchStep::Stop,
        },
    }
}

fn forward_issue_live_event(sink: &Sink, ids: &HashSet<SessionId>, ev: LiveEvent) -> bool {
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
    runtime: &Runtime,
    all_sessions: &[Session],
    selected: &[SessionId],
    state: &IssueWatchState,
    settled: bool,
) -> Vec<IssueWatch> {
    let mut rows = Vec::new();
    let tr = runtime.trajectory();
    for id in selected {
        if state.loaded && state.ids.contains(id) && !(settled && !state.was_settled) {
            continue;
        }
        let history = tr.events_async(id, None).await.unwrap_or_default();
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

#[allow(clippy::too_many_arguments)]
async fn emit_issue_watch_state_async(
    initial: &Issue,
    ctx: &Context,
    runtime: &Runtime,
    cron: &CronScheduler,
    pull: &Pull,
    sink: &Sink,
    state: &mut IssueWatchState,
) -> bool {
    let raw_issues = ctx.service.issue.all().await.unwrap_or_default();
    let all_sessions = runtime.list_async().await;
    let issues = derive_issues(&raw_issues, &all_sessions);
    let issue = issues
        .into_iter()
        .find(|i| i.id == initial.id)
        .map(|mut i| {
            i.cron = cron.cron_of(&i.id);
            i.pull_request = pull.of_issue(&i.id);
            i
        })
        .or_else(|| initial.closed_at.is_some().then(|| initial.clone()));
    let Some(issue) = issue else {
        return send_watch_event(sink, &IssueWatch::Missing { issue: initial.id.clone() });
    };

    let all = session_ids_of(&issue);
    let total = all.len();
    let selected = last_shown_sessions(&all);
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

    let mut rows = collect_issue_history_rows_async(runtime, &all_sessions, &selected, state, settled).await;
    state.ids = selected.into_iter().collect();
    state.loaded = true;
    state.was_settled = settled;
    rows.push(watch_state);

    rows.into_iter().all(|row| send_watch_event(sink, &row))
}

#[allow(clippy::too_many_arguments)]
async fn watch_issue(
    initial: Issue,
    ctx: Arc<Context>,
    runtime: Arc<Runtime>,
    cron: Arc<CronScheduler>,
    pull: Arc<Pull>,
    mut board_sub: SliceSubscription,
    mut sessions_sub: SliceSubscription,
    mut live: broadcast::Receiver<LiveEvent>,
    cancel: CancellationToken,
    sink: Sink,
) {
    let mut state = IssueWatchState {
        ids: last_shown_sessions(&session_ids_of(&initial)).into_iter().collect(),
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
            WatchStep::State => emit_issue_watch_state_async(&initial, &ctx, &runtime, &cron, &pull, &sink, &mut state).await,
        };
        if !keep_going {
            return;
        }
    }
}
