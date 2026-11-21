//! `session.*` and the `issue.watch` stream: the board's sessions, their
//! work logs, and one issue followed with its sessions' steps. Ported from
//! VibeValley `gateway/http/handlers/session.ts`, `modules/session/journal.ts`
//! and `modules/issue/watch.ts`.

use std::collections::HashSet;
use std::sync::Arc;

use vibevalley_core::rules::{session_ids_of, stage_wants_user};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Issue, IssueGetInput, IssueStageKind, IssueWatch, LiveEvent, SessionId, Subscription, ops};

use crate::base::{LookIn, missing};
use crate::modules::work::issue::Board;
use crate::{Hub, Server, Sink};

pub(crate) mod db;
mod delivery;
pub(crate) use delivery::interrupt_on_reopen;
mod drivers;
mod news;
pub use news::News;
pub mod journal;
mod report;
mod runs;
mod sessions;
mod subagents;
mod talk;

pub use drivers::{Drive, Drivers, HelperPlace, Persona, RuntimeDrivers};
pub use journal::{Journal, Trajectories};
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};
pub use runs::trigger_of;
pub use sessions::{DraftEnd, Hire, Rounds, Sessions};

fn helper_ref(id: &str) -> ApiError {
    missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session)
}

/// `issue.watch` (an SSE route in VibeValley, `/api/v1/issue/watch/:id`):
/// here a subscription with `{ id }`.
pub struct IssueWatchStream;

impl Subscription for IssueWatchStream {
    const NAME: &'static str = "issue.watch";
    type Payload = IssueGetInput;
    type Event = IssueWatch;
}

pub fn install(hub: &Arc<Hub>, board: Board, trajectories: Arc<Trajectories>) {
    hub.on::<ops::SessionList>(move |ctx, input| {
        let agent = input.agent.unwrap_or_default();
        let mut out: Vec<_> = ctx
            .hub
            .read(|s| s.sessions.iter().filter(|x| agent.is_empty() || x.agent == agent).cloned().collect());
        out.sort_by_key(|s| std::cmp::Reverse(s.hired_at));
        Ok(out)
    });
    hub.on::<ops::SessionGet>(move |ctx, input| {
        ctx.hub
            .read(|s| s.sessions.iter().find(|x| x.id == input.id).cloned())
            .ok_or_else(|| helper_ref(&input.id))
    });
    let tr = trajectories.clone();
    hub.on::<ops::SessionEventList>(move |_, input| Ok(tr.events(&input.id, input.run.as_deref()).unwrap_or_default()));
    let b = board.clone();
    hub.on::<ops::SessionStop>(move |_, input| stop(&b, &input.id));

    let b = board.clone();
    let tr = trajectories;
    let me = Arc::downgrade(hub);
    hub.on_subscription::<IssueWatchStream>(move |hub, input, sink| {
        let initial = b
            .issue(&input.id)
            .ok_or_else(|| missing(t("server.issue.issueRef", &[("ref", input.id.clone().into())]), LookIn::Issue))?;
        let live = hub.live();
        let states = hub.state_frames();
        let tr = tr.clone();
        let hub = me.clone();
        std::thread::Builder::new()
            .name("vibevalley-issue-watch".into())
            .spawn(move || watch_issue(initial, &hub, states, live, &tr, sink))
            .map_err(crate::base::internal)?;
        Ok(())
    });
}

/// `session.stop`: the working round of a helper this process drives stops.
pub(crate) fn stop(board: &Board, id: &str) -> Result<(), ApiError> {
    let Some(session) = board.session(id).filter(|s| board.sessions().is_live(&s.id)) else {
        return Err(helper_ref(id));
    };
    if session.phase.is_working()
        && let Some(issue) = &session.issue
    {
        // A stop that is not taken is not a refusal.
        let _ = board.stop(issue);
    }
    Ok(())
}

const SHOWN_SESSIONS: usize = 8;
const HISTORY: usize = 241;

/// `watchIssue`: the issue and its last eight sessions as each frame shows
/// them (only when changed), their logs when first seen (and again once it
/// settles), and their steps live.
fn watch_issue(
    initial: Issue,
    hub: &std::sync::Weak<Hub>,
    states: flume::Receiver<Arc<vibevalley_protocol::StateFrame>>,
    live: flume::Receiver<LiveEvent>,
    trajectories: &Trajectories,
    sink: Sink,
) {
    let last = |ids: Vec<&SessionId>| -> Vec<SessionId> { ids.iter().skip(ids.len().saturating_sub(SHOWN_SESSIONS)).map(|s| (*s).clone()).collect() };
    let mut ids: HashSet<SessionId> = last(session_ids_of(&initial)).into_iter().collect();
    let mut loaded = false;
    let mut was_settled = false;
    let mut previous: Option<IssueWatch> = None;
    loop {
        if sink.stopped() {
            return;
        }
        let next = flume::Selector::new()
            .recv(&states, |r| r.ok().map(Ok))
            .recv(&live, |r| r.ok().map(Err))
            .wait_timeout(std::time::Duration::from_millis(500));
        let got = match next {
            Ok(Some(got)) => got,
            Ok(None) => return,
            Err(_) => continue,
        };
        match got {
            Err(LiveEvent::Event(e)) => {
                if ids.contains(&e.id)
                    && !sink.send(&IssueWatch::Event {
                        session: e.id.clone(),
                        event: e.activity,
                    })
                {
                    return;
                }
            }
            Err(_) => {}
            // A frame says the state changed; the full sessions are the hub's.
            Ok(_) => {
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
                    let history = trajectories.events(id, None).unwrap_or_default();
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
