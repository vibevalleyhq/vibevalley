//! Issue and session channel bridge (`work/chat`, L2 `work` domain):
//! connects `Board`/`Sessions` with the channel domain strictly through
//! `crate::ports::ChannelDispatchPort` (zero concrete `collab/channel` import)
//! and dispatches per-issue / per-target lanes on `vibevalley_runtime::rt`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use vibevalley_core::Transition;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ChannelType, Fact, FactSessionReported, MessageKind, NoticeLevel, Outcome, Session, Spent, SubjectKind, ops};

use crate::Hub;
use crate::event_bus::Subscription;
use crate::modules::infra::text::{format_artifact_view_context, head};
use crate::modules::team::agent::Agents;
use crate::modules::work::issue::Board;
use crate::modules::work::session::mailbox::{MailboxSource, MailboxStatus};
use crate::ports::{
    ChannelDelivery, ChannelDeliveryKind, ChannelDispatchPort, ChannelDispatchedBatch, ChannelNoteRequest, ChannelNoticeRequest, ChannelPostedMessage,
    ChannelSeat, ChannelThreadSubject,
};

const HANDED_EMOJI: &str = "👀";
const REPORT_MAX: usize = 1500;
const COMMENT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_CLOSE_GRACE: Duration = Duration::from_secs(5);

fn warn(what: &str, e: &ApiError) {
    eprintln!("vibevalley-server: issue-chat: {what}: {}", e.message);
}

fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spent: Option<Spent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<String>,
}

fn meta_json(meta: &NoteMeta) -> Option<String> {
    serde_json::to_string(meta).ok()
}

fn wake_input(lines: &[String]) -> String {
    let mut out = format!("[输入] 有 {} 条给你的新消息：", lines.len());
    for l in lines {
        out.push('\n');
        out.push_str(l);
    }
    out
}

fn line_of(channel: &dyn ChannelDispatchPort, c: &ChannelPostedMessage) -> String {
    let name = &c.sender_name;
    let from = if c.sender_kind == "agent" && c.sender_agent.is_some() {
        format!("{} {name}", c.sender_id)
    } else {
        name.clone()
    };
    let target = channel.target_of(&c.channel_id).unwrap_or_else(|| format!("#{}", c.channel_name));
    let reply = c.reply_number.map(|n| format!(" reply={n}")).unwrap_or_default();
    let edited = if c.edited_at.is_some() { "（改过）" } else { "" };
    let view = c
        .view_context
        .as_ref()
        .filter(|_| c.deleted_at.is_none())
        .map(|vc| format!("\n  │ {}", format_artifact_view_context(vc).replace('\n', "\n  │ ")))
        .unwrap_or_default();
    format!(
        "[target={target} msg={}{reply} from={from}]{edited} {}{view}",
        c.number,
        c.body.trim().replace('\n', "\n  │ ")
    )
}

#[derive(Clone)]
enum IssueWake {
    Issue {
        delivery: ChannelDelivery,
        committed: Option<Arc<ChannelPostedMessage>>,
    },
    Session {
        delivery: ChannelDelivery,
        issue_id: String,
        committed: Option<Arc<ChannelPostedMessage>>,
    },
}

type DeliveryWaiter = (u64, flume::Sender<()>);

/// Bridges `Hub` session transitions and `ChannelDispatchPort` deliveries onto
/// issue threads and `Board::tell_message` asynchronously per issue.
pub struct IssueChat {
    hub: Weak<Hub>,
    board: Board,
    channel: Arc<dyn ChannelDispatchPort>,
    opening: Mutex<()>,
    cancel: CancellationToken,
    sub: Mutex<Option<Subscription>>,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<IssueWake>>>,
    lane_tasks: TaskTracker,
    next_waiter_id: AtomicU64,
    delivery_waiters: Mutex<HashMap<String, Vec<DeliveryWaiter>>>,
}

impl IssueChat {
    pub fn start(hub: &Arc<Hub>, board: Board, channel: Arc<dyn ChannelDispatchPort>) -> Arc<Self> {
        let dispatches = channel.dispatches();
        let cancel = hub.child_token();
        let ic = Arc::new(Self {
            hub: Arc::downgrade(hub),
            board,
            channel,
            opening: Mutex::new(()),
            cancel: cancel.clone(),
            sub: Mutex::new(None),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
            next_waiter_id: AtomicU64::new(1),
            delivery_waiters: Mutex::new(HashMap::new()),
        });

        let w = Arc::downgrade(&ic);
        let sub = hub.subscribe_transitions("issue-watch", move |_, tr: &Transition| {
            let Some(ic) = w.upgrade() else { return };
            ic.on_transition(tr);
        });
        *ic.sub.lock() = Some(sub);

        let w = Arc::downgrade(&ic);
        let task_cancel = cancel;
        let coordinator = hub.spawn_task(async move {
            let Some(boot_ic) = w.upgrade() else { return };
            let _ = tokio::task::spawn_blocking(move || {
                boot_ic.open_threads();
                boot_ic.replay_reports();
                boot_ic.replay_pending_deliveries();
            })
            .await;
            loop {
                let dispatched = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = dispatches.recv_async() => match res {
                        Ok(dispatched) => dispatched,
                        Err(_) => return,
                    },
                };
                let Some(ic) = w.upgrade() else { return };
                if ic.cancel.is_cancelled() {
                    return;
                }
                let _ = tokio::task::spawn_blocking(move || ic.route_dispatched(dispatched)).await;
            }
        });
        *ic.coordinator.lock() = Some(coordinator);

        let c = ic.clone();
        hub.on::<ops::IssueCommentCreate>(move |ctx, input| {
            c.comment(&input.id, &input.text, input.send_key.as_deref().unwrap_or(""))?;
            Ok(vibevalley_protocol::Applied { seq: ctx.hub.seq() })
        });

        ic
    }

    pub fn close(&self) {
        self.cancel.cancel();
        self.delivery_waiters.lock().clear();
        if let Some(sub) = self.sub.lock().take() {
            sub.close();
        }
        self.lanes.lock().clear();
        let coordinator = self.coordinator.lock().take();
        let timed_out = vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(CHAT_CLOSE_GRACE, async {
                if let Some(handle) = coordinator {
                    let _ = handle.await;
                }
                self.lanes.lock().clear();
                self.lane_tasks.close();
                self.lane_tasks.wait().await;
            })
            .await
            .is_err()
        });
        if timed_out {
            tracing::warn!(
                remaining = self.lane_tasks.len(),
                timeout_secs = CHAT_CLOSE_GRACE.as_secs(),
                "issue-chat close timed out waiting for lane tasks"
            );
        }
    }

    /// `issue.comment.create`: writes the user's words into the issue's thread
    /// and waits for its issue-lane delivery to settle before returning so
    /// `BoardSlice` reflects the accepted comment (e.g. leaving `Asking`).
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
                .read(|st| st.sessions.iter().find(|x| &x.id == s).and_then(|x| x.channel_id().map(str::to_string)))
        });
        let thread = self.channel.issue_thread(&item.id, &item.title, channel.as_deref())?;
        let msg = self.channel.say_in(&thread, text, send_key.to_string())?;
        self.await_comment_delivery(&item.id, &msg.id);
        Ok(())
    }

    fn await_comment_delivery(&self, issue_id: &str, message_id: &str) {
        self.await_comment_delivery_for(issue_id, message_id, COMMENT_DELIVERY_TIMEOUT);
    }

    fn await_comment_delivery_for(&self, issue_id: &str, message_id: &str, timeout: Duration) -> bool {
        if self.cancel.is_cancelled() {
            return true;
        }
        let waiter_id = self.next_waiter_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = flume::bounded(1);
        {
            let mut waiters = self.delivery_waiters.lock();
            if self.cancel.is_cancelled() {
                return true;
            }
            waiters.entry(message_id.to_string()).or_default().push((waiter_id, tx));
        }
        // Check DB outside `delivery_waiters` lock so SQLite I/O never stalls settling lanes.
        let pending = self
            .channel
            .pending_deliveries(ChannelDeliveryKind::Issue)
            .map(|rows| rows.iter().any(|d| d.recipient_id == issue_id && d.message_id == message_id))
            .unwrap_or(false);
        if !pending {
            self.remove_waiter(message_id, waiter_id);
            return true;
        }
        match rx.recv_timeout(timeout) {
            Ok(()) | Err(flume::RecvTimeoutError::Disconnected) => true,
            Err(flume::RecvTimeoutError::Timeout) => {
                self.remove_waiter(message_id, waiter_id);
                tracing::warn!(
                    issue_id,
                    message_id,
                    timeout_ms = timeout.as_millis() as u64,
                    "issue-chat timed out waiting for comment delivery"
                );
                false
            }
        }
    }

    fn remove_waiter(&self, message_id: &str, waiter_id: u64) {
        let mut waiters = self.delivery_waiters.lock();
        if let Some(list) = waiters.get_mut(message_id) {
            list.retain(|(id, _)| *id != waiter_id);
            if list.is_empty() {
                waiters.remove(message_id);
            }
        }
    }

    fn notify_delivery_settled(&self, message_id: &str) {
        if let Some(waiters) = self.delivery_waiters.lock().remove(message_id) {
            for (_, tx) in waiters {
                let _ = tx.send(());
            }
        }
    }

    /// Ensures an issue session has its thread opened and seat recorded.
    pub fn ensure_session_thread(&self, h: &Session) {
        if !h.is_board_worker() || h.issue_id().is_none() {
            return;
        }
        let _guard = self.opening.lock();
        if self.channel.home_of(&h.id).is_none()
            && let Err(e) = self.open_thread_locked(h)
        {
            warn(&format!("{}'s thread", h.id), &e);
        }
    }

    fn on_transition(&self, tr: &Transition) {
        if self.cancel.is_cancelled() {
            return;
        }
        match &tr.fact {
            Fact::SessionChanged(f)
                if f.session.is_board_worker() && f.session.issue_id().is_some() && !tr.before.sessions.iter().any(|s| s.id == f.session.id) =>
            {
                let _guard = self.opening.lock();
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
                    .find(|s| s.id == f.id && s.is_board_worker() && s.issue_id().is_some())
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
            .map(|h| h.read(|s| s.sessions.iter().filter(|x| x.is_board_worker() && x.issue_id().is_some()).cloned().collect()))
            .unwrap_or_default()
    }

    fn on_issue(&self, issue: &str) -> Option<Session> {
        self.issue_sessions()
            .into_iter()
            .filter(|h| h.issue_id() == Some(issue))
            .max_by_key(|h| h.hired_at)
    }

    fn session_issue(&self, session_id: &str) -> Option<String> {
        self.hub.upgrade().and_then(|h| {
            h.read(|s| {
                s.sessions
                    .iter()
                    .find(|x| x.id == session_id && x.is_board_worker())
                    .and_then(|x| x.issue_id().map(str::to_string))
            })
        })
    }

    fn channel_of_session(&self, h: &Session) -> String {
        match h.channel_id().and_then(|c| self.channel.place(c)) {
            Some(p) if p.r#type != ChannelType::Thread && p.name.is_some() => p.id,
            _ => self.channel.default_channel(),
        }
    }

    fn open_threads(&self) {
        let _guard = self.opening.lock();
        for h in self.issue_sessions() {
            if let Err(e) = self.open_thread_locked(&h) {
                warn(&format!("{}'s thread", h.id), &e);
            }
        }
    }

    fn open_thread_locked(&self, h: &Session) -> Result<(), ApiError> {
        let Some(issue) = h.issue_id() else { return Ok(()) };
        if let Some(thread) = self.channel.thread_about(SubjectKind::Issue, issue) {
            return self.handed_on(h, &thread);
        }
        let channel = self.channel_of_session(h);
        let what = if h.is_refining() {
            t("server.channel.dispatch.draft", &[])
        } else {
            head(&h.brief.split_whitespace().collect::<Vec<_>>().join(" "), 80)
        };
        let repo = h
            .repo_name()
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
        self.channel.note(ChannelNoteRequest {
            channel: channel.clone(),
            from: self.channel.orchestrator_in(&channel),
            kind: MessageKind::Dispatch,
            text,
            meta_json: meta_json(&NoteMeta {
                session: Some(h.id.clone()),
                outcome: None,
                spent: None,
                run: None,
            }),
            topic: Some(ChannelThreadSubject {
                kind: SubjectKind::Issue,
                id: issue.to_string(),
                owner: h.id.clone(),
            }),
            member: None,
            seat: Some(ChannelSeat {
                id: h.id.clone(),
                name: h.name.clone(),
                agent: h.profile.clone(),
                home: None,
            }),
        })?;
        Ok(())
    }

    fn handed_on(&self, h: &Session, thread: &str) -> Result<(), ApiError> {
        self.channel.seat(ChannelSeat {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: h.profile.clone(),
            home: Some(thread.to_string()),
        })?;
        if self.channel.members_of(thread).contains(&h.id) {
            return Ok(());
        }
        let channel = self.channel_of_session(h);
        self.channel.read_up_to(&h.id, &channel, self.channel.latest(&channel)?)?;
        let nth = self.channel.dispatch_count(thread)? + 2;
        let text = if h.is_refining() {
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
        self.channel.note(ChannelNoteRequest {
            channel: thread.to_string(),
            from: self.channel.orchestrator_in(thread),
            kind: MessageKind::Dispatch,
            text,
            meta_json: meta_json(&NoteMeta {
                session: Some(h.id.clone()),
                outcome: None,
                spent: None,
                run: None,
            }),
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
            let Some(thread) = self.channel.issue_thread_id(issue) else { continue };
            let Ok(outcome) = serde_json::from_value::<Outcome>(p["outcome"].clone()) else {
                continue;
            };
            let note = ChannelNoteRequest {
                channel: thread,
                from: session.into(),
                kind: MessageKind::Report,
                text: head(p["summary"].as_str().unwrap_or(""), REPORT_MAX),
                meta_json: meta_json(&NoteMeta {
                    session: None,
                    outcome: Some(outcome),
                    spent: serde_json::from_value(p["spent"].clone()).ok().flatten(),
                    run: Some(d.scope_id.clone()),
                }),
                topic: None,
                member: None,
                seat: None,
            };
            if let Err(e) = self.deliver_report(note, Some(&d.scope_id)) {
                warn("replay report", &e);
            }
        }
    }

    fn deliver_report(&self, note: ChannelNoteRequest, run: Option<&str>) -> Result<(), ApiError> {
        self.channel.note_once(note, run.map(|id| format!("report:{id}")))?;
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
        if h.is_refining() {
            let Some(thread) = h.issue_id().and_then(|i| self.channel.issue_thread_id(i)) else {
                return Ok(());
            };
            self.channel.notice(ChannelNoticeRequest {
                channel: thread,
                text: f.summary.clone(),
                code: "issue_refinement".into(),
                ..ChannelNoticeRequest::default()
            });
            return Ok(());
        }
        if f.outcome == Outcome::Interrupted {
            return Ok(());
        }
        let Some(thread) = self
            .channel
            .home_of(&h.id)
            .or_else(|| h.issue_id().and_then(|i| self.channel.issue_thread_id(i)))
        else {
            return Ok(());
        };
        self.deliver_report(
            ChannelNoteRequest {
                channel: thread,
                from: h.id.clone(),
                kind: MessageKind::Report,
                text: head(&f.summary, REPORT_MAX),
                meta_json: meta_json(&NoteMeta {
                    session: None,
                    outcome: Some(f.outcome),
                    spent: f.spent.clone(),
                    run: f.run.clone(),
                }),
                topic: None,
                member: None,
                seat: None,
            },
            f.run.as_deref(),
        )?;
        Ok(())
    }

    fn replay_pending_deliveries(self: &Arc<Self>) {
        if let Ok(pending) = self.channel.pending_deliveries(ChannelDeliveryKind::Issue) {
            for d in pending {
                let issue_id = d.recipient_id.clone();
                self.enqueue_lane(issue_id, IssueWake::Issue { delivery: d, committed: None });
            }
        }
        if let Ok(pending) = self.channel.pending_deliveries(ChannelDeliveryKind::Session) {
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

    fn route_dispatched(self: &Arc<Self>, dispatched: ChannelDispatchedBatch) {
        let sessions = self.board.sessions();
        for d in dispatched.deliveries {
            match d.recipient_kind {
                ChannelDeliveryKind::Issue => {
                    let issue_id = d.recipient_id.clone();
                    let owner = self.on_issue(&issue_id).map(|s| s.id).unwrap_or_else(|| format!("issue:{issue_id}"));
                    let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                    let _ = sessions.enqueue_mailbox(&owner, &mail_key, MailboxSource::IssueComment, Some(&d.message_id), &dispatched.committed.body);
                    self.enqueue_lane(
                        issue_id,
                        IssueWake::Issue {
                            delivery: d,
                            committed: Some(dispatched.committed.clone()),
                        },
                    );
                }
                ChannelDeliveryKind::Session if d.wakes => {
                    if let Some(issue_id) = self.session_issue(&d.recipient_id) {
                        let owner = self.on_issue(&issue_id).map(|s| s.id).unwrap_or_else(|| d.recipient_id.clone());
                        let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                        let _ = sessions.enqueue_mailbox(&owner, &mail_key, MailboxSource::IssueComment, Some(&d.message_id), &dispatched.committed.body);
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
                ChannelDeliveryKind::Session | ChannelDeliveryKind::Orchestrator | ChannelDeliveryKind::Direct => {}
            }
        }
    }

    fn enqueue_lane(self: &Arc<Self>, issue_id: String, wake: IssueWake) {
        if self.cancel.is_cancelled() {
            return;
        }
        let mut lanes = self.lanes.lock();
        if let Some(tx) = lanes.get(&issue_id)
            && tx.send(wake.clone()).is_ok()
        {
            return;
        }
        let (tx, rx) = flume::unbounded::<IssueWake>();
        let _ = tx.send(wake);
        lanes.insert(issue_id.clone(), tx);
        let ic = Arc::downgrade(self);
        let id_for_task = issue_id;
        let cancel = self.cancel.clone();
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        self.lane_tasks.spawn_on(
            async move {
                loop {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let item = match rx.try_recv() {
                        Ok(item) => item,
                        Err(flume::TryRecvError::Empty) => {
                            let Some(ic) = ic.upgrade() else { return };
                            let mut lanes = ic.lanes.lock();
                            match rx.try_recv() {
                                Ok(item) => item,
                                Err(_) => {
                                    lanes.remove(&id_for_task);
                                    return;
                                }
                            }
                        }
                        Err(flume::TryRecvError::Disconnected) => return,
                    };
                    let Some(ic) = ic.upgrade() else { return };
                    if ic.cancel.is_cancelled() {
                        return;
                    }
                    let _ = tokio::task::spawn_blocking(move || ic.handle_wake(item)).await;
                }
            },
            &handle,
        );
    }

    fn handle_wake(&self, wake: IssueWake) {
        match wake {
            IssueWake::Issue { delivery, committed } => self.deliver_to_issue(delivery, committed),
            IssueWake::Session { delivery, issue_id, committed } => self.deliver_to_session(delivery, &issue_id, committed),
        }
    }

    fn deliver_to_issue(&self, delivery: ChannelDelivery, committed: Option<Arc<ChannelPostedMessage>>) {
        struct SettleGuard<'a> {
            chat: &'a IssueChat,
            message_id: String,
        }
        impl Drop for SettleGuard<'_> {
            fn drop(&mut self) {
                self.chat.notify_delivery_settled(&self.message_id);
            }
        }
        let _settle_guard = SettleGuard {
            chat: self,
            message_id: delivery.message_id.clone(),
        };

        if !self.channel.delivery_is_pending(delivery.id).unwrap_or(false) {
            let _ = self.board.sessions().withdraw_mailbox_by_message(&delivery.message_id);
            return;
        }
        let Some(c) = committed.or_else(|| self.channel.committed_of(&delivery.message_id).ok().flatten().map(Arc::new)) else {
            let _ = self.board.sessions().withdraw_mailbox_by_message(&delivery.message_id);
            let _ = self.channel.withdraw_delivery(delivery.id);
            return;
        };
        let on = self.on_issue(&delivery.recipient_id).map(|h| h.id);
        let mut text = c.body.trim().to_string();
        if let Some(vc) = c.view_context.as_ref().filter(|_| c.deleted_at.is_none()) {
            text = format!("{}\n{text}", format_artifact_view_context(vc));
        }
        let mut earlier_ids: Vec<(i64, String)> = Vec::new();
        let mut earlier_lines: Vec<String> = Vec::new();
        if let Some(session_id) = on.as_deref() {
            let pending = self
                .channel
                .pending_deliveries_for(ChannelDeliveryKind::Session, session_id, delivery.id)
                .unwrap_or_default();
            for d in pending {
                match self.channel.committed_of(&d.message_id).ok().flatten() {
                    Some(ec) => {
                        earlier_lines.push(line_of(self.channel.as_ref(), &ec));
                        earlier_ids.push((d.id, d.message_id));
                    }
                    None => {
                        let _ = self.channel.withdraw_delivery(d.id);
                    }
                }
            }
        }
        if !earlier_lines.is_empty() {
            text = format!("{text}\n\n{}", wake_input(&earlier_lines));
        }
        match self.board.tell_message(&delivery.recipient_id, &text, &delivery.message_id) {
            Ok(()) => {
                let _ = self.channel.settle_delivery(delivery.id, true);
                for (did, _) in &earlier_ids {
                    let _ = self.channel.settle_delivery(*did, true);
                }
                if let Some(session_id) = on.as_deref() {
                    for m in std::iter::once(delivery.message_id).chain(earlier_ids.into_iter().map(|(_, mid)| mid)) {
                        if let Err(e) = self.channel.mark_seen(session_id, &m) {
                            warn("seen", &e);
                        }
                        if let Err(e) = self.channel.react(&m, session_id, HANDED_EMOJI, true) {
                            warn("👀", &e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = self.channel.settle_delivery(delivery.id, false);
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }

    fn deliver_to_session(&self, delivery: ChannelDelivery, issue_id: &str, committed: Option<Arc<ChannelPostedMessage>>) {
        if !self.channel.delivery_is_pending(delivery.id).unwrap_or(false) {
            let _ = self.board.sessions().withdraw_mailbox_by_message(&delivery.message_id);
            return;
        }
        let pending = self
            .channel
            .pending_deliveries_for(ChannelDeliveryKind::Session, &delivery.recipient_id, delivery.id)
            .unwrap_or_default();
        let mut settled_ids: Vec<(i64, String)> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        for d in pending {
            let loaded = if d.id == delivery.id {
                committed
                    .clone()
                    .or_else(|| self.channel.committed_of(&d.message_id).ok().flatten().map(Arc::new))
            } else {
                self.channel.committed_of(&d.message_id).ok().flatten().map(Arc::new)
            };
            match loaded {
                Some(ec) => {
                    lines.push(line_of(self.channel.as_ref(), &ec));
                    settled_ids.push((d.id, d.message_id));
                }
                None => {
                    let _ = self.channel.withdraw_delivery(d.id);
                }
            }
        }
        if lines.is_empty() {
            return;
        }
        match self.board.tell_message(issue_id, &wake_input(&lines), &delivery.message_id) {
            Ok(()) => {
                for (did, _) in &settled_ids {
                    let _ = self.channel.settle_delivery(*did, true);
                }
                for (_, mid) in settled_ids {
                    if let Err(e) = self.channel.mark_seen(&delivery.recipient_id, &mid) {
                        warn("seen", &e);
                    }
                    if let Err(e) = self.channel.react(&mid, &delivery.recipient_id, HANDED_EMOJI, true) {
                        warn("👀", &e);
                    }
                }
            }
            Err(e) => {
                let _ = self.channel.settle_delivery(delivery.id, false);
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }
}

#[derive(Clone)]
struct DirectWake {
    delivery: ChannelDelivery,
    committed: Option<Arc<ChannelPostedMessage>>,
}

/// Bridges session seating, direct-talk reports, and asynchronous per-target
/// direct-channel talk onto `ChannelDispatchPort`.
pub struct SessionChat {
    hub: Weak<Hub>,
    board: Board,
    channel: Arc<dyn ChannelDispatchPort>,
    agents: Arc<Agents>,
    cancel: CancellationToken,
    sub: Mutex<Option<Subscription>>,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<DirectWake>>>,
    lane_tasks: TaskTracker,
}

impl SessionChat {
    pub fn start(
        hub: &Arc<Hub>,
        board: Board,
        channel: Arc<dyn ChannelDispatchPort>,
        agents: Arc<Agents>,
        ensure_issue_thread: Arc<dyn Fn(&Session) + Send + Sync>,
    ) -> Arc<Self> {
        let dispatches = channel.dispatches();
        let mut removals = channel.subscribe_removals();
        let cancel = hub.child_token();
        let sc = Arc::new(Self {
            hub: Arc::downgrade(hub),
            board,
            channel: channel.clone(),
            agents,
            cancel: cancel.clone(),
            sub: Mutex::new(None),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
        });

        {
            let h = Arc::downgrade(hub);
            let c = channel.clone();
            channel.ensure_seated(Arc::new(move |who| {
                let Some(hub) = h.upgrade() else { return };
                if c.home_of(who).is_some() {
                    return;
                }
                let Some(session) = hub.read(|s| {
                    s.sessions
                        .iter()
                        .find(|x| x.id == who && (x.is_board_worker() || x.is_direct_talker()))
                        .cloned()
                }) else {
                    return;
                };
                if session.issue_id().is_some() {
                    ensure_issue_thread(&session);
                } else {
                    seat_direct_session(c.as_ref(), &session);
                }
            }));
        }

        let w = Arc::downgrade(&sc);
        let sub = hub.subscribe_transitions("session-chat", move |hub, tr: &Transition| {
            let Some(sc) = w.upgrade() else { return };
            sc.on_transition(hub, tr);
        });
        *sc.sub.lock() = Some(sub);

        let w = Arc::downgrade(&sc);
        let task_cancel = cancel;
        let coordinator = hub.spawn_task(async move {
            enum CoordinatorEvent {
                Dispatched(ChannelDispatchedBatch),
                Removed(String),
                Ignore,
                Stop,
            }
            let Some(boot_sc) = w.upgrade() else { return };
            let _ = tokio::task::spawn_blocking(move || boot_sc.boot()).await;
            loop {
                let event = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => CoordinatorEvent::Stop,
                    res = dispatches.recv_async() => match res {
                        Ok(dispatched) => CoordinatorEvent::Dispatched(dispatched),
                        Err(_) => CoordinatorEvent::Stop,
                    },
                    res = removals.recv() => match res {
                        Ok(message_id) => CoordinatorEvent::Removed(message_id),
                        Err(broadcast::error::RecvError::Lagged(_)) => CoordinatorEvent::Ignore,
                        Err(broadcast::error::RecvError::Closed) => CoordinatorEvent::Stop,
                    },
                };
                let Some(sc) = w.upgrade() else { return };
                if sc.cancel.is_cancelled() {
                    return;
                }
                match event {
                    CoordinatorEvent::Dispatched(dispatched) => {
                        let _ = tokio::task::spawn_blocking(move || sc.route_dispatched(dispatched)).await;
                    }
                    CoordinatorEvent::Removed(message_id) => {
                        let _ = tokio::task::spawn_blocking(move || sc.withdraw_message_mailbox(&message_id)).await;
                    }
                    CoordinatorEvent::Ignore => {}
                    CoordinatorEvent::Stop => return,
                }
            }
        });
        *sc.coordinator.lock() = Some(coordinator);

        sc
    }

    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(sub) = self.sub.lock().take() {
            sub.close();
        }
        self.lanes.lock().clear();
        let coordinator = self.coordinator.lock().take();
        let timed_out = vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(CHAT_CLOSE_GRACE, async {
                if let Some(handle) = coordinator {
                    let _ = handle.await;
                }
                self.lanes.lock().clear();
                self.lane_tasks.close();
                self.lane_tasks.wait().await;
            })
            .await
            .is_err()
        });
        if timed_out {
            tracing::warn!(
                remaining = self.lane_tasks.len(),
                timeout_secs = CHAT_CLOSE_GRACE.as_secs(),
                "session-chat close timed out waiting for lane tasks"
            );
        }
    }

    fn boot(self: &Arc<Self>) {
        if let Some(hub) = self.hub.upgrade() {
            let talks: Vec<Session> = hub.read(|s| s.sessions.iter().filter(|x| x.is_direct_talker() && x.issue_id().is_none()).cloned().collect());
            for h in &talks {
                seat_direct_session(self.channel.as_ref(), h);
            }
            sessions_left(&hub, self.channel.as_ref());
        }
        if let Ok(pending) = self.channel.pending_deliveries(ChannelDeliveryKind::Direct) {
            for d in pending {
                self.enqueue_lane(d.recipient_id.clone(), DirectWake { delivery: d, committed: None });
            }
        }
    }

    fn withdraw_message_mailbox(&self, message_id: &str) {
        let _ = self.board.sessions().withdraw_mailbox_by_message(message_id);
    }

    fn on_transition(&self, hub: &Arc<Hub>, tr: &Transition) {
        if self.cancel.is_cancelled() {
            return;
        }
        match &tr.fact {
            Fact::SessionChanged(f)
                if f.session.is_direct_talker() && f.session.issue_id().is_none() && !tr.before.sessions.iter().any(|s| s.id == f.session.id) =>
            {
                seat_direct_session(self.channel.as_ref(), &f.session);
            }
            Fact::SessionLeft(f) => {
                if let Err(e) = self.channel.leave(&f.id) {
                    eprintln!("vibevalley-server: session-chat: leave {}: {}", f.id, e.message);
                }
                sessions_left(hub, self.channel.as_ref());
            }
            Fact::SessionReported(f) => {
                let Some(s) = tr
                    .after
                    .sessions
                    .iter()
                    .chain(&tr.before.sessions)
                    .find(|s| s.id == f.id && s.is_direct_talker() && s.issue_id().is_none())
                else {
                    return;
                };
                post_talk_report(self.channel.as_ref(), s, f);
            }
            _ => {}
        }
    }

    fn route_dispatched(self: &Arc<Self>, dispatched: ChannelDispatchedBatch) {
        let sessions = self.board.sessions();
        for d in dispatched.deliveries {
            if d.recipient_kind == ChannelDeliveryKind::Direct {
                let mailbox_owner = sessions
                    .talker(&d.recipient_id, &d.channel_id)
                    .map(|s| s.id)
                    .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
                let key = direct_mail_key(&d.recipient_id, &d.message_id);
                let _ = sessions.enqueue_mailbox(
                    &mailbox_owner,
                    &key,
                    MailboxSource::ChannelDirect,
                    Some(&d.message_id),
                    &dispatched.committed.body,
                );
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
        if self.cancel.is_cancelled() {
            return;
        }
        let mut lanes = self.lanes.lock();
        if let Some(tx) = lanes.get(&agent_id)
            && tx.send(wake.clone()).is_ok()
        {
            return;
        }
        let (tx, rx) = flume::unbounded::<DirectWake>();
        let _ = tx.send(wake);
        lanes.insert(agent_id.clone(), tx);
        let sc = Arc::downgrade(self);
        let key = agent_id;
        let cancel = self.cancel.clone();
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        self.lane_tasks.spawn_on(
            async move {
                loop {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let item = match rx.try_recv() {
                        Ok(item) => item,
                        Err(flume::TryRecvError::Empty) => {
                            let Some(sc) = sc.upgrade() else { return };
                            let mut lanes = sc.lanes.lock();
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
                    if sc.cancel.is_cancelled() {
                        return;
                    }
                    let _ = tokio::task::spawn_blocking(move || sc.on_direct(item)).await;
                }
            },
            &handle,
        );
    }

    fn on_direct(&self, wake: DirectWake) {
        let d = wake.delivery;
        let mail_key = direct_mail_key(&d.recipient_id, &d.message_id);
        let sessions = self.board.sessions();
        if !self.channel.delivery_is_pending(d.id).unwrap_or(false) {
            let _ = sessions.withdraw_mailbox(&mail_key);
            return;
        }
        let Some(c) = wake.committed.or_else(|| self.channel.committed_of(&d.message_id).ok().flatten().map(Arc::new)) else {
            let _ = sessions.withdraw_mailbox(&mail_key);
            let _ = self.channel.withdraw_delivery(d.id);
            return;
        };
        if c.deleted_at.is_some() {
            let _ = sessions.withdraw_mailbox(&mail_key);
            let _ = self.channel.withdraw_delivery(d.id);
            return;
        }
        let mailbox_owner = sessions
            .talker(&d.recipient_id, &d.channel_id)
            .map(|s| s.id)
            .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
        let mail_entry = sessions
            .enqueue_mailbox(&mailbox_owner, &mail_key, MailboxSource::ChannelDirect, Some(&d.message_id), &c.body)
            .ok();
        let claimed = sessions.claim_mailbox_by_key(&mail_key).unwrap_or(false);
        if !claimed
            && mail_entry
                .as_ref()
                .is_some_and(|e| matches!(e.status, MailboxStatus::Withdrawn | MailboxStatus::Done | MailboxStatus::Claimed))
        {
            return;
        }
        let settle_id = mail_entry.as_ref().map(|e| e.id);
        let words = match c.view_context.as_ref() {
            Some(vc) => format!("{}\n{}", format_artifact_view_context(vc), c.body),
            None => c.body.clone(),
        };
        let why = match self.agents.profiles.agent(&d.recipient_id) {
            Some(a) if !a.enabled => t("server.channel.profileDisabled", &[("name", a.name.into())]),
            _ => match sessions.talk(&d.recipient_id, &d.channel_id, &words) {
                Ok(sid) => {
                    if let Some(id) = settle_id {
                        let _ = sessions.settle_mailbox(id, true, Some(&sid));
                    }
                    let _ = self.channel.settle_delivery(d.id, true);
                    return;
                }
                Err(e) => e.to_string(),
            },
        };
        if let Some(id) = settle_id {
            let _ = sessions.settle_mailbox(id, false, Some(&why));
        }
        let _ = self.channel.settle_delivery(d.id, false);
        self.channel.notice(ChannelNoticeRequest {
            channel: d.channel_id,
            text: t("server.channel.talkFailed", &[("why", why.into())]),
            code: "talk_refused".into(),
            ..ChannelNoticeRequest::default()
        });
    }
}

fn direct_mail_key(agent_id: &str, message_id: &str) -> String {
    format!("direct:{agent_id}:{message_id}")
}

fn direct_of_session(channel: &dyn ChannelDispatchPort, h: &Session) -> Option<String> {
    let place = channel.place(h.channel_id()?)?;
    let profile = h.profile_id()?;
    (h.is_direct_talker() && h.issue_id().is_none() && place.r#type == ChannelType::Direct && place.peer == Some(profile_id(profile))).then_some(place.id)
}

fn seat_direct_session(channel: &dyn ChannelDispatchPort, h: &Session) {
    let Some(direct) = direct_of_session(channel, h) else { return };
    if let Err(e) = channel.seat(ChannelSeat {
        id: h.id.clone(),
        name: h.name.clone(),
        agent: h.profile.clone(),
        home: Some(direct.clone()),
    }) {
        eprintln!("vibevalley-server: session-chat: seat {}: {}", h.id, e.message);
        return;
    }
    if !channel.members_of(&direct).contains(&h.id)
        && let Err(e) = channel.add_follower(&direct, &h.id)
    {
        eprintln!("vibevalley-server: session-chat: follower {}: {}", h.id, e.message);
    }
}

fn sessions_left(hub: &Hub, channel: &dyn ChannelDispatchPort) {
    let on: Vec<String> = hub.read(|s| {
        s.sessions
            .iter()
            .filter(|h| h.is_board_worker() || h.is_direct_talker())
            .map(|h| h.id.clone())
            .collect()
    });
    for p in channel.participants() {
        let Some(agent) = p.agent_id.as_deref() else { continue };
        if p.id == profile_id(agent) || p.left_at.is_some() || on.contains(&p.id) {
            continue;
        }
        if let Err(e) = channel.leave(&p.id) {
            eprintln!("vibevalley-server: session-chat: leave {}: {}", p.id, e.message);
        }
    }
}

fn post_talk_report(channel: &dyn ChannelDispatchPort, h: &Session, f: &FactSessionReported) {
    if f.outcome == Outcome::Interrupted {
        return;
    }
    let Some(target) = channel.home_of(&h.id).or_else(|| direct_of_session(channel, h)) else {
        return;
    };
    let note = ChannelNoteRequest {
        channel: target,
        from: h.id.clone(),
        kind: MessageKind::Report,
        text: head(&f.summary, REPORT_MAX),
        meta_json: meta_json(&NoteMeta {
            session: None,
            outcome: Some(f.outcome),
            spent: f.spent.clone(),
            run: f.run.clone(),
        }),
        topic: None,
        member: None,
        seat: None,
    };
    if let Err(e) = channel.note_once(note, f.run.as_ref().map(|id| format!("report:{id}"))) {
        eprintln!("vibevalley-server: session-chat: talk report {}: {}", h.id, e.message);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::base::ServerDb;
    use crate::modules::work::ledger::BoardConfig;
    use crate::modules::work::session::RuntimeDrivers;
    use crate::ports::{ChannelParticipant, ChannelPlace};
    use vibevalley_protocol::ChatMessage;

    struct StubChannel {
        entered_pending: Option<flume::Sender<()>>,
        release_pending: Option<flume::Receiver<()>>,
        pending: Vec<ChannelDelivery>,
        removals: broadcast::Sender<String>,
    }

    impl ChannelDispatchPort for StubChannel {
        fn dispatches(&self) -> flume::Receiver<ChannelDispatchedBatch> {
            let (_tx, rx) = flume::unbounded();
            rx
        }
        fn subscribe_removals(&self) -> broadcast::Receiver<String> {
            self.removals.subscribe()
        }
        fn pending_deliveries(&self, _kind: ChannelDeliveryKind) -> Result<Vec<ChannelDelivery>, ApiError> {
            if let Some(tx) = &self.entered_pending {
                let _ = tx.try_send(());
            }
            if let Some(rx) = &self.release_pending {
                let _ = rx.recv_timeout(Duration::from_secs(2));
            }
            Ok(self.pending.clone())
        }
        fn pending_deliveries_for(&self, _: ChannelDeliveryKind, _: &str, _: i64) -> Result<Vec<ChannelDelivery>, ApiError> {
            Ok(vec![])
        }
        fn delivery_is_pending(&self, _: i64) -> Result<bool, ApiError> {
            Ok(false)
        }
        fn committed_of(&self, _: &str) -> Result<Option<ChannelPostedMessage>, ApiError> {
            Ok(None)
        }
        fn settle_delivery(&self, _: i64, _: bool) -> Result<(), ApiError> {
            Ok(())
        }
        fn withdraw_delivery(&self, _: i64) -> Result<(), ApiError> {
            Ok(())
        }
        fn mark_seen(&self, _: &str, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn react(&self, _: &str, _: &str, _: &str, _: bool) -> Result<ChatMessage, ApiError> {
            unreachable!()
        }
        fn note(&self, _: ChannelNoteRequest) -> Result<String, ApiError> {
            Ok(String::new())
        }
        fn note_once(&self, _: ChannelNoteRequest, _: Option<String>) -> Result<String, ApiError> {
            Ok(String::new())
        }
        fn notice(&self, _: ChannelNoticeRequest) {}
        fn seat(&self, _: ChannelSeat) -> Result<(), ApiError> {
            Ok(())
        }
        fn leave(&self, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn add_follower(&self, _: &str, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn members_of(&self, _: &str) -> Vec<String> {
            vec![]
        }
        fn participants(&self) -> Vec<ChannelParticipant> {
            vec![]
        }
        fn home_of(&self, _: &str) -> Option<String> {
            None
        }
        fn place(&self, _: &str) -> Option<ChannelPlace> {
            None
        }
        fn default_channel(&self) -> String {
            "general".into()
        }
        fn orchestrator_in(&self, _: &str) -> String {
            "orchestrator".into()
        }
        fn target_of(&self, _: &str) -> Option<String> {
            None
        }
        fn thread_about(&self, _: SubjectKind, _: &str) -> Option<String> {
            None
        }
        fn latest(&self, _: &str) -> Result<i64, ApiError> {
            Ok(0)
        }
        fn read_up_to(&self, _: &str, _: &str, _: i64) -> Result<(), ApiError> {
            Ok(())
        }
        fn dispatch_count(&self, _: &str) -> Result<i64, ApiError> {
            Ok(0)
        }
        fn issue_thread(&self, _: &str, _: &str, _: Option<&str>) -> Result<String, ApiError> {
            Ok(String::new())
        }
        fn issue_thread_id(&self, _: &str) -> Option<String> {
            None
        }
        fn say_in(&self, _: &str, _: &str, _: String) -> Result<ChatMessage, ApiError> {
            unreachable!()
        }
        fn ensure_seated(&self, _: Arc<dyn Fn(&str) + Send + Sync>) {}
    }

    #[test]
    fn await_comment_delivery_bounds_wait_and_releases_lock_during_db_check() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let board = Board::open_with(
            db.clone(),
            Arc::new(RuntimeDrivers {
                registry: Arc::new(vibevalley_runtime::oar::Registry::new()),
                model: None,
            }),
            BoardConfig::under(dir.path()),
            Arc::new(Arc::downgrade(&hub)),
            Some(Arc::downgrade(&hub)),
            |_| {},
        )
        .unwrap();

        let (entered_tx, entered_rx) = flume::bounded(1);
        let (release_tx, release_rx) = flume::bounded(1);
        let (removals, _) = broadcast::channel(8);
        let pending_row = ChannelDelivery {
            id: 1,
            message_id: "m-stuck".into(),
            channel_id: "c-1".into(),
            recipient_kind: ChannelDeliveryKind::Issue,
            recipient_id: "i-1".into(),
            reason: "thread".into(),
            wakes: true,
        };
        let channel = Arc::new(StubChannel {
            entered_pending: Some(entered_tx),
            release_pending: Some(release_rx),
            pending: vec![pending_row],
            removals,
        });
        let ic = Arc::new(IssueChat {
            hub: Arc::downgrade(&hub),
            board: board.clone(),
            channel,
            opening: Mutex::new(()),
            cancel: hub.child_token(),
            sub: Mutex::new(None),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
            next_waiter_id: AtomicU64::new(1),
            delivery_waiters: Mutex::new(HashMap::new()),
        });

        // Spawn waiter that enters `pending_deliveries` and verify `notify_delivery_settled`
        // can run without blocking on `delivery_waiters.lock()` during the DB call.
        let waiter_ic = ic.clone();
        let waiter = std::thread::spawn(move || waiter_ic.await_comment_delivery_for("i-1", "m-stuck", Duration::from_millis(80)));
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("entered pending_deliveries");

        // Must NOT deadlock while `pending_deliveries` is in flight:
        ic.notify_delivery_settled("m-other");
        drop(release_tx);

        // Unsettled delivery must time out within the bound and clean up the waiter entry.
        let started = Instant::now();
        let settled = waiter.join().unwrap();
        assert!(!settled, "unsettled pending delivery must time out");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            !ic.delivery_waiters.lock().contains_key("m-stuck"),
            "timed-out waiter must be cleaned up from delivery_waiters"
        );

        ic.close();
        board.close();
        hub.close();
        db.close();
    }
}
