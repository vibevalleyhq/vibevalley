//! `session.*` and the `issue.watch` stream: the board's sessions, their
//! work logs, and one issue followed with its sessions' steps. Ported from
//! VibeValley `gateway/http/handlers/session.ts`, `modules/session/journal.ts`
//! and `modules/issue/watch.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;

use vibevalley_core::Transition;
use vibevalley_core::rules::{session_ids_of, stage_wants_user};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    AgentRole, ApiError, BizCode, ChannelType, Fact, FactSessionReported, Issue, IssueGetInput, IssueStageKind, IssueWatch, LiveEvent, MessageKind, Outcome,
    Session, SessionId, SessionWatchEvent, Subscription, ops, subscriptions,
};

use crate::base::{LookIn, missing};
use crate::event_bus::Subscription as BusSubscription;
use crate::modules::collab::channel::{
    ChannelDispatched, Chat, Committed, DeliveryTargetKind, Meta, Note, Noticing, QueuedDelivery, Seat, meta_of, profile_id,
};
use crate::modules::content::attachment::Attachments;
use crate::modules::team::agent::Agents;
use crate::modules::work::issue::Board;
use crate::modules::work::ledger::BoardError;
use crate::{Hub, Server, Sink, lock};

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
mod workspace;

pub use drivers::{Drive, Drivers, HelperPlace, Persona, RuntimeDrivers};
pub use journal::{Journal, Trajectories};
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};
pub use runs::trigger_of;
pub use sessions::{DraftEnd, Hire, Rounds, Sessions};
pub use workspace::WorkspaceSnapshot;
pub(crate) use workspace::is_workspace;

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

/// `issue.watch` (an SSE route in VibeValley, `/api/v1/issue/watch/:id`):
/// here a subscription with `{ id }`.
pub struct IssueWatchStream;

impl Subscription for IssueWatchStream {
    const NAME: &'static str = "issue.watch";
    type Payload = IssueGetInput;
    type Event = IssueWatch;
}

pub fn install(hub: &Arc<Hub>, board: Board, trajectories: Arc<Trajectories>, attachments: Option<Arc<Attachments>>) {
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
    hub.on::<ops::SessionOpenWorkspace>(move |_, input| b.sessions().open_workspace(input).map_err(session_error));
    let b = board.clone();
    let att = attachments;
    hub.on::<ops::SessionSend>(move |_, input| b.sessions().send_workspace(input, att.as_deref()).map_err(session_error));
    let b = board.clone();
    hub.on::<ops::SessionRespondPermission>(move |_, input| b.sessions().respond_permission(input).map_err(session_error));
    let b = board.clone();
    hub.on::<ops::SessionRespondInteraction>(move |_, input| b.sessions().respond_interaction(input).map_err(session_error));
    let b = board.clone();
    hub.on::<ops::SessionSetConfig>(move |_, input| b.sessions().set_workspace_config(input).map_err(session_error));
    let b = board.clone();
    hub.on::<ops::SessionChildTranscript>(move |_, input| b.sessions().read_child_transcript(input).map_err(session_error));

    let b = board.clone();
    let tr = trajectories.clone();
    let me = Arc::downgrade(hub);
    hub.on_subscription::<subscriptions::SessionWatch>(move |hub, input, sink| {
        let initial = b.session(&input.id).ok_or_else(|| helper_ref(&input.id))?;
        let live = hub.live();
        let states = hub.state_frames();
        let workspace_updates = b.sessions().watch_workspace(&initial.id);
        let sessions = b.sessions().clone();
        let tr = tr.clone();
        let hub = me.clone();
        let after_seq = input.after_seq;
        std::thread::Builder::new()
            .name("vibevalley-session-watch".into())
            .spawn(move || watch_session(initial, after_seq, &hub, &sessions, states, live, workspace_updates, &tr, sink))
            .map_err(crate::base::internal)?;
        Ok(())
    });

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
    if session.phase.is_working() {
        if let Some(issue) = &session.issue {
            // A stop that is not taken is not a refusal.
            let _ = board.stop(issue);
        } else {
            let _ = board.sessions().stop(&session.id);
        }
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

#[allow(clippy::too_many_arguments, reason = "watch thread carries hub, session streams, and sink")]
fn watch_session(
    initial: Session,
    after_seq: Option<i64>,
    hub: &std::sync::Weak<Hub>,
    sessions: &Sessions,
    states: flume::Receiver<Arc<vibevalley_protocol::StateFrame>>,
    live: flume::Receiver<LiveEvent>,
    workspace_updates: flume::Receiver<()>,
    trajectories: &Trajectories,
    sink: Sink,
) {
    let id = initial.id.clone();
    let history: Vec<_> = trajectories
        .events(&id, None)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| after_seq.is_none_or(|after| e.seq > after))
        .collect();
    if !sink.send(&SessionWatchEvent::History {
        session: id.clone(),
        events: history,
    }) {
        return;
    }
    let first_state = workspace_state_event(initial, sessions);
    if !sink.send(&first_state) {
        return;
    }
    let mut previous: Option<SessionWatchEvent> = Some(first_state);
    let mut workspace_open = true;
    enum Msg {
        State,
        WorkspaceDropped,
        Live(Box<LiveEvent>),
    }
    loop {
        if sink.stopped() {
            return;
        }
        let next = if workspace_open {
            flume::Selector::new()
                .recv(&states, |r| r.ok().map(|_| Msg::State))
                .recv(&workspace_updates, |r| Some(if r.is_ok() { Msg::State } else { Msg::WorkspaceDropped }))
                .recv(&live, |r| r.ok().map(|e| Msg::Live(Box::new(e))))
                .wait_timeout(std::time::Duration::from_millis(500))
        } else {
            flume::Selector::new()
                .recv(&states, |r| r.ok().map(|_| Msg::State))
                .recv(&live, |r| r.ok().map(|e| Msg::Live(Box::new(e))))
                .wait_timeout(std::time::Duration::from_millis(500))
        };
        let got = match next {
            Ok(Some(got)) => got,
            Ok(None) => return,
            // Poll mtime-cached swarm snapshots on the 500 ms tick; identical states are skipped.
            Err(_) => Msg::State,
        };
        match got {
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
                let state = workspace_state_event(session, sessions);
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

const REPORT_MAX: usize = 1500;

fn clip_utf16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in s.chars() {
        len += ch.len_utf16();
        if len > n {
            break;
        }
        out.push(ch);
    }
    out
}

#[derive(Clone)]
struct DirectWake {
    delivery: QueuedDelivery,
    committed: Option<Arc<Committed>>,
}

/// Bridges session seating, channel removal guard, direct-talk reports, and
/// asynchronous per-target direct-channel talk onto `Chat`.
pub struct SessionChat {
    hub: Weak<Hub>,
    board: Board,
    chat: Arc<Chat>,
    agents: Arc<Agents>,
    closed: AtomicBool,
    sub: Mutex<Option<BusSubscription>>,
    stop: Mutex<Option<flume::Sender<()>>>,
    coordinator: Mutex<Option<JoinHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<DirectWake>>>,
    lane_handles: Mutex<Vec<JoinHandle<()>>>,
}

impl SessionChat {
    pub fn start(hub: &Arc<Hub>, board: Board, chat: Arc<Chat>, agents: Arc<Agents>, ensure_issue_thread: Arc<dyn Fn(&Session) + Send + Sync>) -> Arc<Self> {
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let dispatches = chat.dispatches();
        let sc = Arc::new(Self {
            hub: Arc::downgrade(hub),
            board,
            chat: chat.clone(),
            agents,
            closed: AtomicBool::new(false),
            sub: Mutex::new(None),
            stop: Mutex::new(Some(stop_tx)),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_handles: Mutex::new(Vec::new()),
        });

        {
            let h = Arc::downgrade(hub);
            chat.guard_removal(move |id| {
                let there = h
                    .upgrade()
                    .is_some_and(|h| h.read(|s| s.sessions.iter().any(|x| !is_workspace(x) && x.channel.as_deref() == Some(id))));
                if there { vec![t("server.channel.helpersThere", &[])] } else { vec![] }
            });
        }

        {
            let h = Arc::downgrade(hub);
            let c = chat.clone();
            chat.ensure_seated(move |who| {
                let Some(hub) = h.upgrade() else { return };
                if c.home_of(who).is_some() {
                    return;
                }
                let Some(session) = hub.read(|s| {
                    s.sessions
                        .iter()
                        .find(|x| x.id == who && x.role == AgentRole::Worker && !is_workspace(x))
                        .cloned()
                }) else {
                    return;
                };
                if session.issue.is_some() {
                    ensure_issue_thread(&session);
                } else {
                    seat_direct_session(&c, &session);
                }
            });
        }

        let w = Arc::downgrade(&sc);
        let sub = hub.subscribe_transitions("session-chat", move |hub, tr: &Transition| {
            let Some(sc) = w.upgrade() else { return };
            sc.on_transition(hub, tr);
        });
        *lock(&sc.sub) = Some(sub);

        let w = Arc::downgrade(&sc);
        let coordinator = std::thread::Builder::new()
            .name("vibevalley-session-direct".into())
            .spawn(move || {
                let Some(sc) = w.upgrade() else { return };
                sc.boot();
                drop(sc);
                loop {
                    let dispatched = flume::Selector::new().recv(&dispatches, |r| r.ok()).recv(&stop_rx, |_| None).wait();
                    let Some(dispatched) = dispatched else { return };
                    let Some(sc) = w.upgrade() else { return };
                    if sc.closed.load(Ordering::Acquire) {
                        return;
                    }
                    sc.route_dispatched(dispatched);
                }
            })
            .expect("session direct dispatch thread");
        *lock(&sc.coordinator) = Some(coordinator);

        sc
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _ = lock(&self.stop).take();
        if let Some(sub) = lock(&self.sub).take() {
            sub.close();
        }
        let me = std::thread::current().id();
        if let Some(handle) = lock(&self.coordinator).take()
            && handle.thread().id() != me
        {
            let _ = handle.join();
        }
        lock(&self.lanes).clear();
        let handles: Vec<_> = lock(&self.lane_handles).drain(..).collect();
        for handle in handles {
            if handle.thread().id() != me {
                let _ = handle.join();
            }
        }
    }

    fn boot(self: &Arc<Self>) {
        if let Some(hub) = self.hub.upgrade() {
            let talks: Vec<Session> = hub.read(|s| {
                s.sessions
                    .iter()
                    .filter(|x| x.role == AgentRole::Worker && !is_workspace(x) && x.issue.is_none())
                    .cloned()
                    .collect()
            });
            for h in &talks {
                seat_direct_session(&self.chat, h);
            }
            sessions_left(&hub, &self.chat);
        }
        if let Ok(pending) = self.chat.pending_deliveries(DeliveryTargetKind::Direct) {
            for d in pending {
                self.enqueue_lane(d.recipient_id.clone(), DirectWake { delivery: d, committed: None });
            }
        }
    }

    fn on_transition(&self, hub: &Arc<Hub>, tr: &Transition) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        match &tr.fact {
            Fact::SessionChanged(f)
                if f.session.role == AgentRole::Worker
                    && !is_workspace(&f.session)
                    && f.session.issue.is_none()
                    && !tr.before.sessions.iter().any(|s| s.id == f.session.id) =>
            {
                seat_direct_session(&self.chat, &f.session);
            }
            Fact::SessionLeft(f) => {
                if let Err(e) = self.chat.leave(&f.id) {
                    eprintln!("vibevalley-server: session-chat: leave {}: {}", f.id, e.message);
                }
                sessions_left(hub, &self.chat);
            }
            Fact::SessionReported(f) => {
                let Some(s) = tr
                    .after
                    .sessions
                    .iter()
                    .chain(&tr.before.sessions)
                    .find(|s| s.id == f.id && s.role == AgentRole::Worker && !is_workspace(s) && s.issue.is_none())
                else {
                    return;
                };
                post_talk_report(&self.chat, s, f);
            }
            _ => {}
        }
    }

    fn route_dispatched(self: &Arc<Self>, dispatched: ChannelDispatched) {
        for d in dispatched.deliveries {
            if d.recipient_kind == DeliveryTargetKind::Direct {
                self.enqueue_lane(
                    d.recipient_id.clone(),
                    DirectWake {
                        delivery: d,
                        committed: Some(dispatched.committed.clone()),
                    },
                );
            }
        }
    }

    fn enqueue_lane(self: &Arc<Self>, agent_id: String, wake: DirectWake) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut lanes = lock(&self.lanes);
        if let Some(tx) = lanes.get(&agent_id)
            && tx.send(wake.clone()).is_ok()
        {
            return;
        }
        let (tx, rx) = flume::unbounded::<DirectWake>();
        let _ = tx.send(wake);
        lanes.insert(agent_id.clone(), tx);
        let sc = Arc::downgrade(self);
        let key = agent_id.clone();
        let handle = std::thread::Builder::new()
            .name(format!("vibevalley-direct-lane-{agent_id}"))
            .spawn(move || {
                loop {
                    let item = match rx.try_recv() {
                        Ok(item) => item,
                        Err(flume::TryRecvError::Empty) => {
                            let Some(sc) = sc.upgrade() else { return };
                            let mut lanes = lock(&sc.lanes);
                            match rx.try_recv() {
                                Ok(item) => item,
                                Err(_) => {
                                    lanes.remove(&key);
                                    return;
                                }
                            }
                        }
                        Err(flume::TryRecvError::Disconnected) => return,
                    };
                    let Some(sc) = sc.upgrade() else { return };
                    if sc.closed.load(Ordering::Acquire) {
                        return;
                    }
                    sc.on_direct(item);
                }
            })
            .expect("direct talk lane thread");
        drop(lanes);
        let mut handles = lock(&self.lane_handles);
        handles.retain(|h| !h.is_finished());
        handles.push(handle);
    }

    fn on_direct(&self, wake: DirectWake) {
        let d = wake.delivery;
        if !self.chat.delivery_is_pending(d.id).unwrap_or(false) {
            return;
        }
        let Some(c) = wake.committed.or_else(|| self.chat.committed_of(&d.message_id).ok().flatten().map(Arc::new)) else {
            let _ = self.chat.withdraw_delivery(d.id);
            return;
        };
        let words = match meta_of(c.row.meta.as_deref()).view_context.filter(|_| c.row.deleted_at.is_none()) {
            Some(vc) => format!(
                "{}\n{}",
                crate::modules::team::orchestrator::words::format_artifact_view_context(&vc),
                c.row.body
            ),
            None => c.row.body.clone(),
        };
        let why = match self.agents.profiles.agent(&d.recipient_id) {
            Some(a) if !a.enabled => t("server.channel.profileDisabled", &[("name", a.name.into())]),
            _ => match self.board.sessions().talk(&d.recipient_id, &d.channel_id, &words) {
                Ok(_) => {
                    let _ = self.chat.settle_delivery(d.id, true);
                    return;
                }
                Err(e) => e.to_string(),
            },
        };
        let _ = self.chat.settle_delivery(d.id, false);
        self.chat.notice(Noticing {
            channel: d.channel_id,
            text: t("server.channel.talkFailed", &[("why", why.into())]),
            code: "talk_refused".into(),
            ..Noticing::default()
        });
    }
}

fn direct_of_session(chat: &Chat, h: &Session) -> Option<String> {
    let place = chat.place(h.channel.as_deref()?)?;
    (h.issue.is_none() && place.r#type == ChannelType::Direct && place.peer == Some(profile_id(&h.agent))).then_some(place.id)
}

fn seat_direct_session(chat: &Chat, h: &Session) {
    let Some(direct) = direct_of_session(chat, h) else { return };
    if let Err(e) = chat.seat(&Seat {
        id: h.id.clone(),
        name: h.name.clone(),
        agent: Some(h.agent.clone()),
        home: Some(direct.clone()),
    }) {
        eprintln!("vibevalley-server: session-chat: seat {}: {}", h.id, e.message);
        return;
    }
    if !chat.members_of(&direct).contains(&h.id)
        && let Err(e) = chat.add_follower(&direct, &h.id)
    {
        eprintln!("vibevalley-server: session-chat: follower {}: {}", h.id, e.message);
    }
}

fn sessions_left(hub: &Hub, chat: &Chat) {
    let on: Vec<String> = hub.read(|s| {
        s.sessions
            .iter()
            .filter(|h| h.role == AgentRole::Worker && !is_workspace(h))
            .map(|h| h.id.clone())
            .collect()
    });
    for p in chat.participants() {
        let Some(agent) = p.agent_id.as_deref() else { continue };
        if p.id == profile_id(agent) || p.left_at.is_some() || on.contains(&p.id) {
            continue;
        }
        if let Err(e) = chat.leave(&p.id) {
            eprintln!("vibevalley-server: session-chat: leave {}: {}", p.id, e.message);
        }
    }
}

fn post_talk_report(chat: &Chat, h: &Session, f: &FactSessionReported) {
    if f.outcome == Outcome::Interrupted {
        return;
    }
    let Some(channel) = chat.home_of(&h.id).or_else(|| direct_of_session(chat, h)) else {
        return;
    };
    let note = Note {
        channel,
        from: h.id.clone(),
        kind: MessageKind::Report,
        text: clip_utf16(&f.summary, REPORT_MAX),
        meta: Meta {
            outcome: Some(f.outcome),
            spent: f.spent.clone(),
            run: f.run.clone(),
            ..Meta::default()
        },
        topic: None,
        member: None,
        seat: None,
    };
    if let Err(e) = chat.note_once(note, f.run.as_ref().map(|id| format!("report:{id}"))) {
        eprintln!("vibevalley-server: session-chat: talk report {}: {}", h.id, e.message);
    }
}
