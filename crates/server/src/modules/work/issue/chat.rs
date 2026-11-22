//! Issue chat integration: `issue.comment.create`, issue thread lifecycle
//! (`open_threads`, `handed_on`), single-round report posting, durable
//! `issue.report` outbox replay, and per-issue async delivery from
//! `Chat::dispatches()`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;

use vibevalley_core::Transition;
use vibevalley_i18n::t;
use vibevalley_protocol::{Actor, AgentRole, ApiError, ChannelType, Fact, FactSessionReported, MessageKind, NoticeLevel, Outcome, Session, SubjectKind, ops};

use super::Board;
use crate::event_bus::Subscription;
use crate::modules::collab::channel::{
    Chat, Committed, DeliveryTargetKind, Meta, Note, Noticing, QueuedDelivery, Saying, Seat, ThreadSubject, actor_of, meta_of,
};
use crate::modules::work::session::is_workspace;
use crate::{Hub, lock};

const HANDED_EMOJI: &str = "👀";
const REPORT_MAX: usize = 1500;

fn warn(what: &str, e: &ApiError) {
    eprintln!("vibevalley-server: issue-chat: {what}: {}", e.message);
}

/// First `n` UTF-16 code units without splitting a surrogate pair.
fn head(s: &str, n: usize) -> String {
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

fn wake_input(lines: &[String]) -> String {
    let mut out = format!("[输入] 有 {} 条给你的新消息：", lines.len());
    for l in lines {
        out.push('\n');
        out.push_str(l);
    }
    out
}

fn line_of(chat: &Chat, c: &Committed, actor: &Actor) -> String {
    let name = &c.row.sender_name;
    let from = match actor {
        Actor::Agent { role: AgentRole::Worker, .. } => format!("{} {name}", c.row.sender_id),
        _ => name.clone(),
    };
    let target = chat.target_of(&c.row.channel_id).unwrap_or_else(|| format!("#{}", c.channel_name));
    let reply = c.row.reply_number.map(|n| format!(" reply={n}")).unwrap_or_default();
    let edited = if c.row.edited_at.is_some() { "（改过）" } else { "" };
    let view = meta_of(c.row.meta.as_deref())
        .view_context
        .filter(|_| c.row.deleted_at.is_none())
        .map(|vc| {
            format!(
                "\n  │ {}",
                crate::modules::team::orchestrator::words::format_artifact_view_context(&vc).replace('\n', "\n  │ ")
            )
        })
        .unwrap_or_default();
    format!(
        "[target={target} msg={}{reply} from={from}]{edited} {}{view}",
        c.row.number,
        c.row.body.trim().replace('\n', "\n  │ ")
    )
}

#[derive(Clone)]
enum IssueWake {
    Issue {
        delivery: QueuedDelivery,
        committed: Option<Arc<Committed>>,
    },
    Session {
        delivery: QueuedDelivery,
        issue_id: String,
        committed: Option<Arc<Committed>>,
    },
}

/// Bridges `Hub` session transitions and `Chat` deliveries onto issue threads
/// and `Board::tell_message` asynchronously per issue.
pub struct IssueChat {
    hub: Weak<Hub>,
    board: Board,
    chat: Arc<Chat>,
    opening: Mutex<()>,
    closed: AtomicBool,
    sub: Mutex<Option<Subscription>>,
    stop: Mutex<Option<flume::Sender<()>>>,
    coordinator: Mutex<Option<JoinHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<IssueWake>>>,
    lane_handles: Mutex<Vec<JoinHandle<()>>>,
}

impl IssueChat {
    pub fn start(hub: &Arc<Hub>, board: Board, chat: Arc<Chat>) -> Arc<Self> {
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let dispatches = chat.dispatches();
        let ic = Arc::new(Self {
            hub: Arc::downgrade(hub),
            board,
            chat,
            opening: Mutex::new(()),
            closed: AtomicBool::new(false),
            sub: Mutex::new(None),
            stop: Mutex::new(Some(stop_tx)),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_handles: Mutex::new(Vec::new()),
        });

        let w = Arc::downgrade(&ic);
        let sub = hub.subscribe_transitions("issue-watch", move |_, tr: &Transition| {
            let Some(ic) = w.upgrade() else { return };
            ic.on_transition(tr);
        });
        *lock(&ic.sub) = Some(sub);

        let w = Arc::downgrade(&ic);
        let coordinator = std::thread::Builder::new()
            .name("vibevalley-issue-dispatch".into())
            .spawn(move || {
                let Some(ic) = w.upgrade() else { return };
                ic.open_threads();
                ic.replay_reports();
                ic.replay_pending_deliveries();
                drop(ic);
                loop {
                    let dispatched = flume::Selector::new().recv(&dispatches, |r| r.ok()).recv(&stop_rx, |_| None).wait();
                    let Some(dispatched) = dispatched else { return };
                    let Some(ic) = w.upgrade() else { return };
                    if ic.closed.load(Ordering::Acquire) {
                        return;
                    }
                    ic.route_dispatched(dispatched);
                }
            })
            .expect("issue dispatch thread");
        *lock(&ic.coordinator) = Some(coordinator);

        let c = ic.clone();
        hub.on::<ops::IssueCommentCreate>(move |ctx, input| {
            c.comment(&input.id, &input.text, input.send_key.as_deref().unwrap_or(""))?;
            Ok(vibevalley_protocol::Applied { seq: ctx.hub.seq() })
        });

        ic
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

    /// `issue.comment.create`: writes the user's words into the issue's thread;
    /// `Chat::say` commits the message and durable delivery synchronously while
    /// waking the issue's session asynchronously off-thread.
    pub fn comment(&self, issue: &str, text: &str, send_key: &str) -> Result<(), ApiError> {
        let item = self
            .board
            .issue(issue)
            .ok_or_else(|| crate::base::missing(t("server.issue.notFound", &[("id", issue.into())]), crate::base::LookIn::Issue))?;
        if item.status.is_closed() {
            return Err(crate::base::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.closedReopen", &[]),
            ));
        }
        if text.trim().is_empty() {
            return Err(crate::base::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.wordsRequired", &[]),
            ));
        }
        let channel = item.latest_session_id().and_then(|s| {
            self.hub
                .upgrade()?
                .read(|st| st.sessions.iter().find(|x| &x.id == s).and_then(|x| x.channel.clone()))
        });
        let thread = self.chat.issue_thread(&item.id, &item.title, channel.as_deref())?;
        self.chat.say(Saying {
            text: text.into(),
            channel: Some(thread),
            send_key: send_key.into(),
            ..Saying::default()
        })?;
        Ok(())
    }

    /// Ensures an issue session has its thread opened and seat recorded.
    pub(crate) fn ensure_session_thread(&self, h: &Session) {
        if h.role != AgentRole::Worker || is_workspace(h) || h.issue.is_none() {
            return;
        }
        let _guard = lock(&self.opening);
        if self.chat.home_of(&h.id).is_none()
            && let Err(e) = self.open_thread_locked(h)
        {
            warn(&format!("{}'s thread", h.id), &e);
        }
    }

    fn on_transition(&self, tr: &Transition) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        match &tr.fact {
            Fact::SessionChanged(f)
                if f.session.role == AgentRole::Worker
                    && !is_workspace(&f.session)
                    && f.session.issue.is_some()
                    && !tr.before.sessions.iter().any(|s| s.id == f.session.id) =>
            {
                let _guard = lock(&self.opening);
                if let Err(e) = self.open_thread_locked(&f.session) {
                    warn(&format!("{}'s thread", f.session.id), &e);
                }
            }
            Fact::SessionReported(f) => {
                let Some(s) = tr
                    .after
                    .sessions
                    .iter()
                    .chain(&tr.before.sessions)
                    .find(|s| s.id == f.id && s.role == AgentRole::Worker && !is_workspace(s) && s.issue.is_some())
                else {
                    return;
                };
                if let Err(e) = self.post_report(s, f) {
                    warn("the report", &e);
                }
            }
            _ => {}
        }
    }

    fn issue_sessions(&self) -> Vec<Session> {
        self.hub
            .upgrade()
            .map(|h| {
                h.read(|s| {
                    s.sessions
                        .iter()
                        .filter(|x| x.role == AgentRole::Worker && !is_workspace(x) && x.issue.is_some())
                        .cloned()
                        .collect()
                })
            })
            .unwrap_or_default()
    }

    fn on_issue(&self, issue: &str) -> Option<Session> {
        self.issue_sessions()
            .into_iter()
            .filter(|h| h.issue.as_deref() == Some(issue))
            .max_by_key(|h| h.hired_at)
    }

    fn session_issue(&self, session_id: &str) -> Option<String> {
        self.hub.upgrade().and_then(|h| {
            h.read(|s| {
                s.sessions
                    .iter()
                    .find(|x| x.id == session_id && x.role == AgentRole::Worker && !is_workspace(x))
                    .and_then(|x| x.issue.clone())
            })
        })
    }

    fn channel_of_session(&self, h: &Session) -> String {
        match h.channel.as_deref().and_then(|c| self.chat.place(c)) {
            Some(p) if p.r#type != ChannelType::Thread && p.name.is_some() => p.id,
            _ => self.chat.default_channel(),
        }
    }

    fn open_threads(&self) {
        let _guard = lock(&self.opening);
        for h in self.issue_sessions() {
            if let Err(e) = self.open_thread_locked(&h) {
                warn(&format!("{}'s thread", h.id), &e);
            }
        }
    }

    fn open_thread_locked(&self, h: &Session) -> Result<(), ApiError> {
        let Some(issue) = h.issue.as_deref() else { return Ok(()) };
        if let Some(thread) = self.chat.thread_about(SubjectKind::Issue, issue) {
            return self.handed_on(h, &thread);
        }
        let channel = self.channel_of_session(h);
        let what = if h.refining {
            t("server.channel.dispatch.draft", &[])
        } else {
            head(&h.brief.split_whitespace().collect::<Vec<_>>().join(" "), 80)
        };
        let repo = h
            .repo
            .as_deref()
            .map(|r| {
                std::path::Path::new(r)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| r.to_string())
            })
            .unwrap_or_else(|| t("server.channel.dispatch.repo", &[]));
        let text = t(
            "server.channel.dispatch.sent",
            &[
                ("id", h.id.clone().into()),
                ("name", h.name.clone().into()),
                ("repo", repo.into()),
                ("what", what.into()),
            ],
        );
        self.chat.note(Note {
            channel: channel.clone(),
            from: self.chat.orchestrator_in(&channel),
            kind: MessageKind::Dispatch,
            text,
            meta: Meta {
                session: Some(h.id.clone()),
                ..Meta::default()
            },
            topic: Some(ThreadSubject {
                kind: SubjectKind::Issue,
                id: issue.to_string(),
                owner: h.id.clone(),
            }),
            member: None,
            seat: Some(Seat {
                id: h.id.clone(),
                name: h.name.clone(),
                agent: Some(h.agent.clone()),
                home: None,
            }),
        })?;
        Ok(())
    }

    fn handed_on(&self, h: &Session, thread: &str) -> Result<(), ApiError> {
        self.chat.seat(&Seat {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: Some(h.agent.clone()),
            home: Some(thread.to_string()),
        })?;
        if self.chat.members_of(thread).contains(&h.id) {
            return Ok(());
        }
        let channel = self.channel_of_session(h);
        self.chat.read_up_to(&h.id, &channel, self.chat.latest(&channel)?)?;
        let nth = self.chat.dispatch_count(thread)? + 2;
        let text = if h.refining {
            t(
                "server.channel.dispatch.redraft",
                &[("id", h.id.clone().into()), ("name", h.name.clone().into())],
            )
        } else {
            t(
                "server.channel.dispatch.handedOn",
                &[("id", h.id.clone().into()), ("name", h.name.clone().into()), ("nth", nth.into())],
            )
        };
        self.chat.note(Note {
            channel: thread.to_string(),
            from: self.chat.orchestrator_in(thread),
            kind: MessageKind::Dispatch,
            text,
            meta: Meta {
                session: Some(h.id.clone()),
                ..Meta::default()
            },
            topic: None,
            member: Some(h.id.clone()),
            seat: None,
        })?;
        Ok(())
    }

    fn replay_reports(&self) {
        let store = self.board.sessions().durable_store();
        let docs = match store.read(|r| r.documents_by_kind("run", "issue.report")) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("vibevalley: report outbox: {e}");
                return;
            }
        };
        for d in docs {
            let p = &d.state;
            let Some(issue) = p["issueId"].as_str() else { continue };
            let Some(session) = p["sessionId"].as_str() else { continue };
            let Some(thread) = self.chat.issue_thread_id(issue) else { continue };
            let Ok(outcome) = serde_json::from_value::<Outcome>(p["outcome"].clone()) else {
                continue;
            };
            let note = Note {
                channel: thread,
                from: session.into(),
                kind: MessageKind::Report,
                text: head(p["summary"].as_str().unwrap_or(""), REPORT_MAX),
                meta: Meta {
                    outcome: Some(outcome),
                    run: Some(d.scope_id.clone()),
                    spent: serde_json::from_value(p["spent"].clone()).ok().flatten(),
                    ..Meta::default()
                },
                topic: None,
                member: None,
                seat: None,
            };
            if let Err(e) = self.deliver_report(note, Some(&d.scope_id)) {
                warn("replay report", &e);
            }
        }
    }

    fn deliver_report(&self, note: Note, run: Option<&str>) -> Result<(), ApiError> {
        self.chat.note_once(note, run.map(|id| format!("report:{id}")))?;
        if let Some(id) = run {
            self.board
                .sessions()
                .durable_store()
                .write(|tx| tx.delete_document("run", id, "issue.report"))
                .map_err(|e| ApiError::new(vibevalley_protocol::BizCode::InternalError, e.to_string()))?;
        }
        Ok(())
    }

    fn post_report(&self, h: &Session, f: &FactSessionReported) -> Result<(), ApiError> {
        if h.refining {
            let Some(thread) = h.issue.as_deref().and_then(|i| self.chat.issue_thread_id(i)) else {
                return Ok(());
            };
            self.chat.notice(Noticing {
                channel: thread,
                text: f.summary.clone(),
                code: "issue_refinement".into(),
                ..Noticing::default()
            });
            return Ok(());
        }
        if f.outcome == Outcome::Interrupted {
            return Ok(());
        }
        let Some(thread) = self
            .chat
            .home_of(&h.id)
            .or_else(|| h.issue.as_deref().and_then(|i| self.chat.issue_thread_id(i)))
        else {
            return Ok(());
        };
        let meta = Meta {
            outcome: Some(f.outcome),
            spent: f.spent.clone(),
            run: f.run.clone(),
            ..Meta::default()
        };
        self.deliver_report(
            Note {
                channel: thread,
                from: h.id.clone(),
                kind: MessageKind::Report,
                text: head(&f.summary, REPORT_MAX),
                meta,
                topic: None,
                member: None,
                seat: None,
            },
            f.run.as_deref(),
        )?;
        Ok(())
    }

    fn replay_pending_deliveries(self: &Arc<Self>) {
        if let Ok(pending) = self.chat.pending_deliveries(DeliveryTargetKind::Issue) {
            for d in pending {
                let issue_id = d.recipient_id.clone();
                self.enqueue_lane(issue_id, IssueWake::Issue { delivery: d, committed: None });
            }
        }
        if let Ok(pending) = self.chat.pending_deliveries(DeliveryTargetKind::Session) {
            for d in pending.into_iter().filter(|d| d.wakes) {
                if let Some(issue_id) = self.session_issue(&d.recipient_id) {
                    self.enqueue_lane(
                        issue_id.clone(),
                        IssueWake::Session {
                            delivery: d,
                            issue_id,
                            committed: None,
                        },
                    );
                }
            }
        }
    }

    fn route_dispatched(self: &Arc<Self>, dispatched: crate::modules::collab::channel::ChannelDispatched) {
        for d in dispatched.deliveries {
            match d.recipient_kind {
                DeliveryTargetKind::Issue => {
                    let issue_id = d.recipient_id.clone();
                    self.enqueue_lane(
                        issue_id,
                        IssueWake::Issue {
                            delivery: d,
                            committed: Some(dispatched.committed.clone()),
                        },
                    );
                }
                DeliveryTargetKind::Session if d.wakes => {
                    if let Some(issue_id) = self.session_issue(&d.recipient_id) {
                        self.enqueue_lane(
                            issue_id.clone(),
                            IssueWake::Session {
                                delivery: d,
                                issue_id,
                                committed: Some(dispatched.committed.clone()),
                            },
                        );
                    }
                }
                DeliveryTargetKind::Session | DeliveryTargetKind::Orchestrator | DeliveryTargetKind::Direct => {}
            }
        }
    }

    fn enqueue_lane(self: &Arc<Self>, issue_id: String, wake: IssueWake) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut lanes = lock(&self.lanes);
        if let Some(tx) = lanes.get(&issue_id)
            && tx.send(wake.clone()).is_ok()
        {
            return;
        }
        let (tx, rx) = flume::unbounded::<IssueWake>();
        let _ = tx.send(wake);
        lanes.insert(issue_id.clone(), tx);
        let ic = Arc::downgrade(self);
        let id_for_thread = issue_id.clone();
        let handle = std::thread::Builder::new()
            .name(format!("vibevalley-issue-lane-{issue_id}"))
            .spawn(move || {
                loop {
                    let item = match rx.try_recv() {
                        Ok(item) => item,
                        Err(flume::TryRecvError::Empty) => {
                            let Some(ic) = ic.upgrade() else { return };
                            let mut lanes = lock(&ic.lanes);
                            match rx.try_recv() {
                                Ok(item) => item,
                                Err(_) => {
                                    lanes.remove(&id_for_thread);
                                    return;
                                }
                            }
                        }
                        Err(flume::TryRecvError::Disconnected) => return,
                    };
                    let Some(ic) = ic.upgrade() else { return };
                    if ic.closed.load(Ordering::Acquire) {
                        return;
                    }
                    ic.handle_wake(item);
                }
            })
            .expect("issue delivery lane thread");
        drop(lanes);
        let mut handles = lock(&self.lane_handles);
        handles.retain(|h| !h.is_finished());
        handles.push(handle);
    }

    fn handle_wake(&self, wake: IssueWake) {
        match wake {
            IssueWake::Issue { delivery, committed } => self.deliver_to_issue(delivery, committed),
            IssueWake::Session { delivery, issue_id, committed } => self.deliver_to_session(delivery, &issue_id, committed),
        }
    }

    fn deliver_to_issue(&self, delivery: QueuedDelivery, committed: Option<Arc<Committed>>) {
        if !self.chat.delivery_is_pending(delivery.id).unwrap_or(false) {
            return;
        }
        let Some(c) = committed.or_else(|| self.chat.committed_of(&delivery.message_id).ok().flatten().map(Arc::new)) else {
            let _ = self.chat.withdraw_delivery(delivery.id);
            return;
        };
        let on = self.on_issue(&delivery.recipient_id).map(|h| h.id);
        let mut text = c.row.body.trim().to_string();
        if let Some(vc) = meta_of(c.row.meta.as_deref()).view_context.filter(|_| c.row.deleted_at.is_none()) {
            text = format!("{}\n{text}", crate::modules::team::orchestrator::words::format_artifact_view_context(&vc));
        }
        let mut earlier_ids: Vec<(i64, String)> = Vec::new();
        let mut earlier_lines: Vec<String> = Vec::new();
        if let Some(session_id) = on.as_deref() {
            let pending = self
                .chat
                .pending_deliveries_for(DeliveryTargetKind::Session, session_id, delivery.id)
                .unwrap_or_default();
            for d in pending {
                match self.chat.committed_of(&d.message_id).ok().flatten() {
                    Some(ec) => {
                        let actor = actor_of(
                            &ec.row.sender_kind,
                            ec.row.sender_agent.as_deref(),
                            &ec.row.sender_id,
                            Some(&ec.row.sender_name),
                        );
                        earlier_lines.push(line_of(&self.chat, &ec, &actor));
                        earlier_ids.push((d.id, d.message_id));
                    }
                    None => {
                        let _ = self.chat.withdraw_delivery(d.id);
                    }
                }
            }
        }
        if !earlier_lines.is_empty() {
            text = format!("{text}\n\n{}", wake_input(&earlier_lines));
        }
        match self.board.tell_message(&delivery.recipient_id, &text, &delivery.message_id) {
            Ok(()) => {
                let _ = self.chat.settle_delivery(delivery.id, true);
                for (did, _) in &earlier_ids {
                    let _ = self.chat.settle_delivery(*did, true);
                }
                if let Some(session_id) = on.as_deref() {
                    for m in std::iter::once(delivery.message_id).chain(earlier_ids.into_iter().map(|(_, mid)| mid)) {
                        if let Err(e) = self.chat.mark_seen(session_id, &m) {
                            warn("seen", &e);
                        }
                        if let Err(e) = self.chat.react(&m, session_id, HANDED_EMOJI, true) {
                            warn("👀", &e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = self.chat.settle_delivery(delivery.id, false);
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }

    fn deliver_to_session(&self, delivery: QueuedDelivery, issue_id: &str, committed: Option<Arc<Committed>>) {
        if !self.chat.delivery_is_pending(delivery.id).unwrap_or(false) {
            return;
        }
        let pending = self
            .chat
            .pending_deliveries_for(DeliveryTargetKind::Session, &delivery.recipient_id, delivery.id)
            .unwrap_or_default();
        let mut settled_ids: Vec<(i64, String)> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        for d in pending {
            let loaded = if d.id == delivery.id {
                committed.clone().or_else(|| self.chat.committed_of(&d.message_id).ok().flatten().map(Arc::new))
            } else {
                self.chat.committed_of(&d.message_id).ok().flatten().map(Arc::new)
            };
            match loaded {
                Some(ec) => {
                    let actor = actor_of(
                        &ec.row.sender_kind,
                        ec.row.sender_agent.as_deref(),
                        &ec.row.sender_id,
                        Some(&ec.row.sender_name),
                    );
                    lines.push(line_of(&self.chat, &ec, &actor));
                    settled_ids.push((d.id, d.message_id));
                }
                None => {
                    let _ = self.chat.withdraw_delivery(d.id);
                }
            }
        }
        if lines.is_empty() {
            return;
        }
        match self.board.tell_message(issue_id, &wake_input(&lines), &delivery.message_id) {
            Ok(()) => {
                for (did, _) in &settled_ids {
                    let _ = self.chat.settle_delivery(*did, true);
                }
                for (_, mid) in settled_ids {
                    if let Err(e) = self.chat.mark_seen(&delivery.recipient_id, &mid) {
                        warn("seen", &e);
                    }
                    if let Err(e) = self.chat.react(&mid, &delivery.recipient_id, HANDED_EMOJI, true) {
                        warn("👀", &e);
                    }
                }
            }
            Err(e) => {
                let _ = self.chat.settle_delivery(delivery.id, false);
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }
}
