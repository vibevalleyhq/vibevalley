//! Issue and session channel bridge (`work/chat`, L3):
//! connects `Board`/`Sessions` directly with `collab/channel::Chat`
//! and dispatches per-issue / per-target lanes on `vibevalley_runtime::rt`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use vibevalley_core::Transition;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ArtifactViewContext, ChannelType, Fact, FactSessionReported, MessageKind, NoticeLevel, Outcome, Session, SubjectKind, ops,
};

use crate::Hub;
use crate::app::hub::event_bus::Subscription;
use crate::collab::channel::{
    ChannelDispatched, Chat, Committed, DeliveryTargetKind, Meta, Note, Noticing, QueuedDelivery, Saying, Seat, ThreadSubject, meta_of, profile_id,
};
use crate::infra::text::{format_artifact_view_context, head};
use crate::team::agent::Agents;
use crate::work::issue::Board;
use crate::work::session::mailbox::{MailboxSource, MailboxStatus};

const HANDED_EMOJI: &str = "👀";
const REPORT_MAX: usize = 1500;
const COMMENT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_CLOSE_GRACE: Duration = Duration::from_secs(5);

fn warn(what: &str, e: &ApiError) {
    eprintln!("vibevalley-server: issue-chat: {what}: {}", e.message);
}

fn view_context_of(c: &Committed) -> Option<ArtifactViewContext> {
    if c.row.deleted_at.is_some() {
        return None;
    }
    meta_of(c.row.meta.as_deref()).view_context
}

fn wake_input(lines: &[String]) -> String {
    let mut out = format!("[输入] 有 {} 条给你的新消息：", lines.len());
    for l in lines {
        out.push('\n');
        out.push_str(l);
    }
    out
}

fn line_of(channel: &Chat, c: &Committed) -> String {
    let name = &c.row.sender_name;
    let from = if c.row.sender_kind == "agent" && c.row.sender_agent.is_some() {
        format!("{} {name}", c.row.sender_id)
    } else {
        name.clone()
    };
    let target = channel.target_of(&c.row.channel_id).unwrap_or_else(|| format!("#{}", c.channel_name));
    let reply = c.row.reply_number.map(|n| format!(" reply={n}")).unwrap_or_default();
    let edited = if c.row.edited_at.is_some() { "（改过）" } else { "" };
    let view = view_context_of(c)
        .as_ref()
        .map(|vc| format!("\n  │ {}", format_artifact_view_context(vc).replace('\n', "\n  │ ")))
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

type DeliveryWaiter = (u64, oneshot::Sender<()>);

/// Bridges `Hub` session transitions and `Chat` deliveries onto
/// issue threads and `Board::tell_message` asynchronously per issue.
pub struct IssueChat {
    hub: Weak<Hub>,
    board: Board,
    channel: Arc<Chat>,
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
    pub fn start(hub: &Arc<Hub>, board: Board, channel: Arc<Chat>) -> Arc<Self> {
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
            let boot_sync = boot_ic.clone();
            let _ = crate::spawn_blocking_traced(move || {
                boot_sync.open_threads();
                boot_sync.replay_reports();
            })
            .await;
            boot_ic.replay_pending_deliveries_async().await;
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
                ic.route_dispatched_async(dispatched).await;
            }
        });
        *ic.coordinator.lock() = Some(coordinator);

        let c = ic.clone();
        hub.on_async::<ops::IssueCommentCreate, _, _>(move |ctx, input| {
            let c = c.clone();
            async move {
                c.comment_async(&input.id, &input.text, input.send_key.as_deref().unwrap_or("")).await?;
                Ok(vibevalley_protocol::Applied { seq: ctx.hub.seq() })
            }
        });

        ic
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        self.delivery_waiters.lock().clear();
        let sub = self.sub.lock().take();
        if let Some(sub) = sub {
            sub.close_async().await;
        }
        self.lanes.lock().clear();
        let coordinator = self.coordinator.lock().take();
        let timed_out = tokio::time::timeout(CHAT_CLOSE_GRACE, async {
            if let Some(handle) = coordinator {
                let _ = handle.await;
            }
            self.lanes.lock().clear();
            self.lane_tasks.close();
            self.lane_tasks.wait().await;
        })
        .await
        .is_err();
        if timed_out {
            tracing::warn!(
                remaining = self.lane_tasks.len(),
                timeout_secs = CHAT_CLOSE_GRACE.as_secs(),
                "issue-chat close timed out waiting for lane tasks"
            );
        }
    }

    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }

    /// `issue.comment.create`: writes the user's words into the issue's thread
    /// and awaits its issue-lane delivery without blocking a worker thread so
    /// `BoardSlice` reflects the accepted comment (e.g. leaving `Asking`).
    pub async fn comment_async(&self, issue: &str, text: &str, send_key: &str) -> Result<(), ApiError> {
        let item = self
            .board
            .issue(issue)
            .ok_or_else(|| crate::app::hub::refusal::missing(t("server.issue.notFound", &[("id", issue.into())]), crate::app::hub::refusal::LookIn::Issue))?;
        if item.status.is_closed() {
            return Err(crate::app::hub::refusal::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.closedReopen", &[]),
            ));
        }
        if text.trim().is_empty() {
            return Err(crate::app::hub::refusal::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.wordsRequired", &[]),
            ));
        }
        let channel = item.latest_session_id().and_then(|s| {
            self.hub
                .upgrade()?
                .read(|st| st.sessions.iter().find(|x| &x.id == s).and_then(|x| x.channel_id().map(str::to_string)))
        });
        let thread = self.channel.issue_thread_async(&item.id, &item.title, channel.as_deref()).await?;
        let (msg, _) = self
            .channel
            .say_async(Saying {
                text: text.to_string(),
                channel: Some(thread),
                send_key: send_key.to_string(),
                ..Saying::default()
            })
            .await?;
        self.await_comment_delivery(&item.id, &msg.id).await;
        Ok(())
    }

    async fn await_comment_delivery(&self, issue_id: &str, message_id: &str) {
        self.await_comment_delivery_for(issue_id, message_id, COMMENT_DELIVERY_TIMEOUT).await;
    }

    fn register_delivery_waiter(&self, message_id: &str) -> Option<(u64, oneshot::Receiver<()>)> {
        if self.cancel.is_cancelled() {
            return None;
        }
        let waiter_id = self.next_waiter_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let mut waiters = self.delivery_waiters.lock();
        if self.cancel.is_cancelled() {
            return None;
        }
        waiters.entry(message_id.to_string()).or_default().push((waiter_id, tx));
        Some((waiter_id, rx))
    }

    async fn wait_for_delivery_signal(&self, issue_id: &str, message_id: &str, waiter_id: u64, rx: oneshot::Receiver<()>, timeout: Duration) -> bool {
        let cancel = self.cancel.clone();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                self.remove_waiter(message_id, waiter_id);
                true
            }
            res = tokio::time::timeout(timeout, rx) => match res {
                Ok(Ok(())) | Ok(Err(_)) => true,
                Err(_) => {
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
    }

    async fn await_comment_delivery_for(&self, issue_id: &str, message_id: &str, timeout: Duration) -> bool {
        let Some((waiter_id, rx)) = self.register_delivery_waiter(message_id) else {
            return true;
        };
        // Check DB outside `delivery_waiters` lock so SQLite I/O never stalls settling lanes.
        let pending = self
            .channel
            .pending_deliveries_async(DeliveryTargetKind::Issue)
            .await
            .map(|rows| rows.iter().any(|d| d.recipient_id == issue_id && d.message_id == message_id))
            .unwrap_or(false);
        if !pending {
            self.remove_waiter(message_id, waiter_id);
            return true;
        }
        self.wait_for_delivery_signal(issue_id, message_id, waiter_id, rx, timeout).await
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
        self.channel.note(Note {
            channel: channel.clone(),
            from: self.channel.orchestrator_in(&channel),
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
                agent: h.profile.clone(),
                home: None,
            }),
        })?;
        Ok(())
    }

    fn handed_on(&self, h: &Session, thread: &str) -> Result<(), ApiError> {
        self.channel.seat(&Seat {
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
        self.channel.note(Note {
            channel: thread.to_string(),
            from: self.channel.orchestrator_in(thread),
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
            let Some(thread) = self.channel.issue_thread_id(issue) else { continue };
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
                    spent: serde_json::from_value(p["spent"].clone()).ok().flatten(),
                    run: Some(d.scope_id.clone()),
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
            self.channel.notice(Noticing {
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
            .channel
            .home_of(&h.id)
            .or_else(|| h.issue_id().and_then(|i| self.channel.issue_thread_id(i)))
        else {
            return Ok(());
        };
        self.deliver_report(
            Note {
                channel: thread,
                from: h.id.clone(),
                kind: MessageKind::Report,
                text: head(&f.summary, REPORT_MAX),
                meta: Meta {
                    outcome: Some(f.outcome),
                    spent: f.spent.clone(),
                    run: f.run.clone(),
                    ..Meta::default()
                },
                topic: None,
                member: None,
                seat: None,
            },
            f.run.as_deref(),
        )?;
        Ok(())
    }

    async fn replay_pending_deliveries_async(self: &Arc<Self>) {
        if let Ok(pending) = self.channel.pending_deliveries_async(DeliveryTargetKind::Issue).await {
            for d in pending {
                let issue_id = d.recipient_id.clone();
                self.enqueue_lane(issue_id, IssueWake::Issue { delivery: d, committed: None });
            }
        }
        if let Ok(pending) = self.channel.pending_deliveries_async(DeliveryTargetKind::Session).await {
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

    async fn route_dispatched_async(self: &Arc<Self>, dispatched: ChannelDispatched) {
        let sessions = self.board.sessions().clone();
        for d in dispatched.deliveries {
            match d.recipient_kind {
                DeliveryTargetKind::Issue => {
                    let issue_id = d.recipient_id.clone();
                    let owner = self.on_issue(&issue_id).map(|s| s.id).unwrap_or_else(|| format!("issue:{issue_id}"));
                    let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                    let sessions = sessions.clone();
                    let msg_id = d.message_id.clone();
                    let body = dispatched.committed.row.body.clone();
                    let _ =
                        crate::spawn_blocking_traced(move || sessions.enqueue_mailbox(&owner, &mail_key, MailboxSource::IssueComment, Some(&msg_id), &body))
                            .await;
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
                        let owner = self.on_issue(&issue_id).map(|s| s.id).unwrap_or_else(|| d.recipient_id.clone());
                        let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                        let sessions = sessions.clone();
                        let msg_id = d.message_id.clone();
                        let body = dispatched.committed.row.body.clone();
                        let _ = crate::spawn_blocking_traced(move || {
                            sessions.enqueue_mailbox(&owner, &mail_key, MailboxSource::IssueComment, Some(&msg_id), &body)
                        })
                        .await;
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
                    ic.handle_wake_async(item).await;
                }
            },
            &handle,
        );
    }

    async fn handle_wake_async(&self, wake: IssueWake) {
        match wake {
            IssueWake::Issue { delivery, committed } => self.deliver_to_issue_async(delivery, committed).await,
            IssueWake::Session { delivery, issue_id, committed } => self.deliver_to_session_async(delivery, &issue_id, committed).await,
        }
    }

    async fn deliver_to_issue_async(&self, delivery: QueuedDelivery, committed: Option<Arc<Committed>>) {
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

        if !self.channel.delivery_is_pending_async(delivery.id).await.unwrap_or(false) {
            let sessions = self.board.sessions().clone();
            let msg_id = delivery.message_id.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox_by_message(&msg_id)).await;
            return;
        }
        let c = match committed {
            Some(c) => Some(c),
            None => self.channel.committed_of_async(&delivery.message_id).await.ok().flatten().map(Arc::new),
        };
        let Some(c) = c else {
            let sessions = self.board.sessions().clone();
            let msg_id = delivery.message_id.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox_by_message(&msg_id)).await;
            let _ = self.channel.withdraw_delivery_async(delivery.id).await;
            return;
        };
        let on = self.on_issue(&delivery.recipient_id).map(|h| h.id);
        let mut text = c.row.body.trim().to_string();
        if let Some(vc) = view_context_of(&c) {
            text = format!("{}\n{text}", format_artifact_view_context(&vc));
        }
        let mut earlier_ids: Vec<(i64, String)> = Vec::new();
        let mut earlier_lines: Vec<String> = Vec::new();
        if let Some(session_id) = on.as_deref() {
            let pending = self
                .channel
                .pending_deliveries_for_async(DeliveryTargetKind::Session, session_id, delivery.id)
                .await
                .unwrap_or_default();
            for d in pending {
                match self.channel.committed_of_async(&d.message_id).await.ok().flatten() {
                    Some(ec) => {
                        earlier_lines.push(line_of(&self.channel, &ec));
                        earlier_ids.push((d.id, d.message_id));
                    }
                    None => {
                        let _ = self.channel.withdraw_delivery_async(d.id).await;
                    }
                }
            }
        }
        if !earlier_lines.is_empty() {
            text = format!("{text}\n\n{}", wake_input(&earlier_lines));
        }
        let board = self.board.clone();
        let recipient_id = delivery.recipient_id.clone();
        let msg_id = delivery.message_id.clone();
        let tell_res = crate::spawn_blocking_traced(move || board.tell_message(&recipient_id, &text, &msg_id)).await;
        match tell_res {
            Ok(Ok(())) => {
                let _ = self.channel.settle_delivery_async(delivery.id, true).await;
                for (did, _) in &earlier_ids {
                    let _ = self.channel.settle_delivery_async(*did, true).await;
                }
                if let Some(session_id) = on.as_deref() {
                    for m in std::iter::once(delivery.message_id).chain(earlier_ids.into_iter().map(|(_, mid)| mid)) {
                        if let Err(e) = self.channel.mark_seen_async(session_id, &m).await {
                            warn("seen", &e);
                        }
                        if let Err(e) = self.channel.react_async(&m, session_id, HANDED_EMOJI, true).await {
                            warn("👀", &e);
                        }
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
            Err(e) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }

    async fn deliver_to_session_async(&self, delivery: QueuedDelivery, issue_id: &str, committed: Option<Arc<Committed>>) {
        if !self.channel.delivery_is_pending_async(delivery.id).await.unwrap_or(false) {
            let sessions = self.board.sessions().clone();
            let msg_id = delivery.message_id.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox_by_message(&msg_id)).await;
            return;
        }
        let pending = self
            .channel
            .pending_deliveries_for_async(DeliveryTargetKind::Session, &delivery.recipient_id, delivery.id)
            .await
            .unwrap_or_default();
        let mut settled_ids: Vec<(i64, String)> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        for d in pending {
            let loaded = if d.id == delivery.id {
                match committed.clone() {
                    Some(c) => Some(c),
                    None => self.channel.committed_of_async(&d.message_id).await.ok().flatten().map(Arc::new),
                }
            } else {
                self.channel.committed_of_async(&d.message_id).await.ok().flatten().map(Arc::new)
            };
            match loaded {
                Some(ec) => {
                    lines.push(line_of(&self.channel, &ec));
                    settled_ids.push((d.id, d.message_id));
                }
                None => {
                    let _ = self.channel.withdraw_delivery_async(d.id).await;
                }
            }
        }
        if lines.is_empty() {
            return;
        }
        let board = self.board.clone();
        let issue = issue_id.to_string();
        let body = wake_input(&lines);
        let msg_id = delivery.message_id.clone();
        let tell_res = crate::spawn_blocking_traced(move || board.tell_message(&issue, &body, &msg_id)).await;
        match tell_res {
            Ok(Ok(())) => {
                for (did, _) in &settled_ids {
                    let _ = self.channel.settle_delivery_async(*did, true).await;
                }
                for (_, mid) in settled_ids {
                    if let Err(e) = self.channel.mark_seen_async(&delivery.recipient_id, &mid).await {
                        warn("seen", &e);
                    }
                    if let Err(e) = self.channel.react_async(&mid, &delivery.recipient_id, HANDED_EMOJI, true).await {
                        warn("👀", &e);
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
            Err(e) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                if let Some(hub) = self.hub.upgrade() {
                    hub.notice(NoticeLevel::Warn, e.to_string());
                }
            }
        }
    }
}

#[derive(Clone)]
struct DirectWake {
    delivery: QueuedDelivery,
    committed: Option<Arc<Committed>>,
}

/// Bridges session seating, direct-talk reports, and asynchronous per-target
/// direct-channel talk onto `Chat`.
pub struct SessionChat {
    hub: Weak<Hub>,
    board: Board,
    channel: Arc<Chat>,
    agents: Arc<Agents>,
    cancel: CancellationToken,
    sub: Mutex<Option<Subscription>>,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<DirectWake>>>,
    lane_tasks: TaskTracker,
}

impl SessionChat {
    pub fn start(hub: &Arc<Hub>, board: Board, channel: Arc<Chat>, agents: Arc<Agents>, ensure_issue_thread: Arc<dyn Fn(&Session) + Send + Sync>) -> Arc<Self> {
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
            channel.ensure_seated(move |who| {
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
                    seat_direct_session(&c, &session);
                }
            });
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
                Dispatched(ChannelDispatched),
                Removed(String),
                Ignore,
                Stop,
            }
            let Some(boot_sc) = w.upgrade() else { return };
            boot_sc.boot_async().await;
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
                        sc.route_dispatched_async(dispatched).await;
                    }
                    CoordinatorEvent::Removed(message_id) => {
                        let _ = crate::spawn_blocking_traced(move || sc.withdraw_message_mailbox(&message_id)).await;
                    }
                    CoordinatorEvent::Ignore => {}
                    CoordinatorEvent::Stop => return,
                }
            }
        });
        *sc.coordinator.lock() = Some(coordinator);

        sc
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        let sub = self.sub.lock().take();
        if let Some(sub) = sub {
            sub.close_async().await;
        }
        self.lanes.lock().clear();
        let coordinator = self.coordinator.lock().take();
        let timed_out = tokio::time::timeout(CHAT_CLOSE_GRACE, async {
            if let Some(handle) = coordinator {
                let _ = handle.await;
            }
            self.lanes.lock().clear();
            self.lane_tasks.close();
            self.lane_tasks.wait().await;
        })
        .await
        .is_err();
        if timed_out {
            tracing::warn!(
                remaining = self.lane_tasks.len(),
                timeout_secs = CHAT_CLOSE_GRACE.as_secs(),
                "session-chat close timed out waiting for lane tasks"
            );
        }
    }

    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }

    async fn boot_async(self: &Arc<Self>) {
        if let Some(hub) = self.hub.upgrade() {
            let talks: Vec<Session> = hub.read(|s| s.sessions.iter().filter(|x| x.is_direct_talker() && x.issue_id().is_none()).cloned().collect());
            for h in &talks {
                seat_direct_session_async(&self.channel, h).await;
            }
            sessions_left_async(&hub, &self.channel).await;
        }
        if let Ok(pending) = self.channel.pending_deliveries_async(DeliveryTargetKind::Direct).await {
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
                seat_direct_session(&self.channel, &f.session);
            }
            Fact::SessionLeft(f) => {
                if let Err(e) = self.channel.leave(&f.id) {
                    eprintln!("vibevalley-server: session-chat: leave {}: {}", f.id, e.message);
                }
                sessions_left(hub, &self.channel);
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
                post_talk_report(&self.channel, s, f);
            }
            _ => {}
        }
    }

    async fn route_dispatched_async(self: &Arc<Self>, dispatched: ChannelDispatched) {
        let sessions = self.board.sessions().clone();
        for d in dispatched.deliveries {
            if d.recipient_kind == DeliveryTargetKind::Direct {
                let mailbox_owner = sessions
                    .talker(&d.recipient_id, &d.channel_id)
                    .map(|s| s.id)
                    .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
                let key = direct_mail_key(&d.recipient_id, &d.message_id);
                let sessions_for_enqueue = sessions.clone();
                let msg_id = d.message_id.clone();
                let body = dispatched.committed.row.body.clone();
                let _ = crate::spawn_blocking_traced(move || {
                    sessions_for_enqueue.enqueue_mailbox(&mailbox_owner, &key, MailboxSource::ChannelDirect, Some(&msg_id), &body)
                })
                .await;
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
                    sc.on_direct_async(item).await;
                }
            },
            &handle,
        );
    }

    async fn on_direct_async(&self, wake: DirectWake) {
        let d = wake.delivery;
        let mail_key = direct_mail_key(&d.recipient_id, &d.message_id);
        let sessions = self.board.sessions().clone();
        if !self.channel.delivery_is_pending_async(d.id).await.unwrap_or(false) {
            let key = mail_key.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox(&key)).await;
            return;
        }
        let c = match wake.committed {
            Some(c) => Some(c),
            None => self.channel.committed_of_async(&d.message_id).await.ok().flatten().map(Arc::new),
        };
        let Some(c) = c else {
            let key = mail_key.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox(&key)).await;
            let _ = self.channel.withdraw_delivery_async(d.id).await;
            return;
        };
        if c.row.deleted_at.is_some() {
            let key = mail_key.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.withdraw_mailbox(&key)).await;
            let _ = self.channel.withdraw_delivery_async(d.id).await;
            return;
        }
        let recipient_id = d.recipient_id.clone();
        let channel_id = d.channel_id.clone();
        let msg_id = d.message_id.clone();
        let body = c.row.body.clone();
        let key_for_claim = mail_key.clone();
        let sessions_for_claim = sessions.clone();
        let (mail_entry, claimed) = crate::spawn_blocking_traced(move || {
            let mailbox_owner = sessions_for_claim
                .talker(&recipient_id, &channel_id)
                .map(|s| s.id)
                .unwrap_or_else(|| format!("profile:{recipient_id}"));
            let mail_entry = sessions_for_claim
                .enqueue_mailbox(&mailbox_owner, &key_for_claim, MailboxSource::ChannelDirect, Some(&msg_id), &body)
                .ok();
            let claimed = sessions_for_claim.claim_mailbox_by_key(&key_for_claim).unwrap_or(false);
            (mail_entry, claimed)
        })
        .await
        .unwrap_or((None, false));
        if !claimed
            && mail_entry
                .as_ref()
                .is_some_and(|e| matches!(e.status, MailboxStatus::Withdrawn | MailboxStatus::Done | MailboxStatus::Claimed))
        {
            return;
        }
        let settle_id = mail_entry.as_ref().map(|e| e.id);
        let words = match view_context_of(&c) {
            Some(vc) => format!("{}\n{}", format_artifact_view_context(&vc), c.row.body),
            None => c.row.body.clone(),
        };
        enum TalkOutcome {
            Ok(String),
            Err(String),
        }
        let outcome = match self.agents.profiles.agent(&d.recipient_id) {
            Some(a) if !a.enabled => TalkOutcome::Err(t("server.channel.profileDisabled", &[("name", a.name.into())])),
            _ => {
                let sessions_for_talk = sessions.clone();
                let recipient = d.recipient_id.clone();
                let chan = d.channel_id.clone();
                match crate::spawn_blocking_traced(move || sessions_for_talk.talk(&recipient, &chan, &words)).await {
                    Ok(Ok(sid)) => TalkOutcome::Ok(sid),
                    Ok(Err(e)) => TalkOutcome::Err(e.to_string()),
                    Err(e) => TalkOutcome::Err(e.to_string()),
                }
            }
        };
        let why = match outcome {
            TalkOutcome::Ok(sid) => {
                if let Some(id) = settle_id {
                    let _ = crate::spawn_blocking_traced(move || sessions.settle_mailbox(id, true, Some(&sid))).await;
                }
                let _ = self.channel.settle_delivery_async(d.id, true).await;
                return;
            }
            TalkOutcome::Err(why) => why,
        };
        if let Some(id) = settle_id {
            let why_c = why.clone();
            let _ = crate::spawn_blocking_traced(move || sessions.settle_mailbox(id, false, Some(&why_c))).await;
        }
        let _ = self.channel.settle_delivery_async(d.id, false).await;
        self.channel
            .notice_async(Noticing {
                channel: d.channel_id,
                text: t("server.channel.talkFailed", &[("why", why.into())]),
                code: "talk_refused".into(),
                ..Noticing::default()
            })
            .await;
    }
}

fn direct_mail_key(agent_id: &str, message_id: &str) -> String {
    format!("direct:{agent_id}:{message_id}")
}

fn direct_of_session(channel: &Chat, h: &Session) -> Option<String> {
    let place = channel.place(h.channel_id()?)?;
    let profile = h.profile_id()?;
    (h.is_direct_talker() && h.issue_id().is_none() && place.r#type == ChannelType::Direct && place.peer == Some(profile_id(profile))).then_some(place.id)
}

async fn seat_direct_session_async(channel: &Chat, h: &Session) {
    let Some(direct) = direct_of_session(channel, h) else { return };
    if let Err(e) = channel
        .seat_async(&Seat {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: h.profile.clone(),
            home: Some(direct.clone()),
        })
        .await
    {
        eprintln!("vibevalley-server: session-chat: seat {}: {}", h.id, e.message);
        return;
    }
    if !channel.members_of(&direct).contains(&h.id)
        && let Err(e) = channel.add_follower_async(&direct, &h.id).await
    {
        eprintln!("vibevalley-server: session-chat: follower {}: {}", h.id, e.message);
    }
}

fn seat_direct_session(channel: &Chat, h: &Session) {
    let Some(direct) = direct_of_session(channel, h) else { return };
    if let Err(e) = channel.seat(&Seat {
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

async fn sessions_left_async(hub: &Hub, channel: &Chat) {
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
        if let Err(e) = channel.leave_async(&p.id).await {
            eprintln!("vibevalley-server: session-chat: leave {}: {}", p.id, e.message);
        }
    }
}

fn sessions_left(hub: &Hub, channel: &Chat) {
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

fn post_talk_report(channel: &Chat, h: &Session, f: &FactSessionReported) {
    if f.outcome == Outcome::Interrupted {
        return;
    }
    let Some(target) = channel.home_of(&h.id).or_else(|| direct_of_session(channel, h)) else {
        return;
    };
    let note = Note {
        channel: target,
        from: h.id.clone(),
        kind: MessageKind::Report,
        text: head(&f.summary, REPORT_MAX),
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
    if let Err(e) = channel.note_once(note, f.run.as_ref().map(|id| format!("report:{id}"))) {
        eprintln!("vibevalley-server: session-chat: talk report {}: {}", h.id, e.message);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::content::attachment::Attachments;
    use crate::db::ServerDb;
    use crate::work::ledger::BoardConfig;
    use crate::work::session::RuntimeDrivers;

    fn test_issue_chat(dir: &std::path::Path) -> (Arc<ServerDb>, Arc<Hub>, Board, Arc<Chat>, Arc<IssueChat>) {
        let db = ServerDb::open(dir).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let files = Attachments::open(dir, db.clone());
        let channel = Chat::open(db.clone(), &hub, files, None, false).unwrap();
        let board = Board::open_with(
            db.clone(),
            Arc::new(RuntimeDrivers {
                registry: Arc::new(vibevalley_runtime::oar::Registry::new()),
                model: None,
            }),
            BoardConfig::under(dir),
            Arc::new(Arc::downgrade(&hub)),
            Some(Arc::downgrade(&hub)),
            |_| {},
        )
        .unwrap();
        let ic = Arc::new(IssueChat {
            hub: Arc::downgrade(&hub),
            board: board.clone(),
            channel: channel.clone(),
            opening: Mutex::new(()),
            cancel: hub.child_token(),
            sub: Mutex::new(None),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
            next_waiter_id: AtomicU64::new(1),
            delivery_waiters: Mutex::new(HashMap::new()),
        });
        (db, hub, board, channel, ic)
    }

    #[test]
    fn await_comment_delivery_wakes_on_settle_and_fast_paths_when_settled() {
        let dir = tempfile::tempdir().unwrap();
        let (db, hub, board, channel, ic) = test_issue_chat(dir.path());

        vibevalley_runtime::rt::block_on(async {
            let thread = channel.issue_thread_async("i-1", "test issue", None).await.unwrap();
            let (msg, _) = channel
                .say_async(Saying {
                    channel: Some(thread),
                    text: "please check".into(),
                    send_key: "comment-wait-1".into(),
                    ..Saying::default()
                })
                .await
                .unwrap();

            // 1. Active waiter wakes immediately when the lane settles the delivery.
            let waiter_ic = ic.clone();
            let msg_id = msg.id.clone();
            let waiter = tokio::spawn(async move { waiter_ic.await_comment_delivery_for("i-1", &msg_id, COMMENT_DELIVERY_TIMEOUT).await });
            while !ic.delivery_waiters.lock().contains_key(&msg.id) {
                assert!(!waiter.is_finished(), "waiter exited before settlement while delivery was pending");
                tokio::task::yield_now().await;
            }
            ic.notify_delivery_settled(&msg.id);
            assert!(waiter.await.unwrap(), "notify_delivery_settled must wake active waiter");
            assert!(ic.delivery_waiters.lock().is_empty());

            // 2. Already-settled delivery in SQLite returns immediately without leaving a waiter.
            let pending = channel.pending_deliveries_async(DeliveryTargetKind::Issue).await.unwrap();
            assert!(!pending.is_empty());
            for d in pending {
                channel.settle_delivery_async(d.id, true).await.unwrap();
            }
            assert!(ic.await_comment_delivery_for("i-1", &msg.id, COMMENT_DELIVERY_TIMEOUT).await);
            assert!(ic.delivery_waiters.lock().is_empty());
        });

        ic.close();
        board.close();
        hub.close();
        db.close();
    }

    #[test]
    fn await_comment_delivery_obeys_virtual_timeout_and_cleans_waiter() {
        let dir = tempfile::tempdir().unwrap();
        let (db, hub, board, _channel, ic) = test_issue_chat(dir.path());

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        rt.block_on(async {
            let (waiter_id, rx) = ic.register_delivery_waiter("m-stuck").expect("waiter registered");
            let wall_start = Instant::now();
            let waiter_ic = ic.clone();
            let waiter = tokio::spawn(async move {
                waiter_ic
                    .wait_for_delivery_signal("i-1", "m-stuck", waiter_id, rx, COMMENT_DELIVERY_TIMEOUT)
                    .await
            });

            tokio::task::yield_now().await;
            tokio::time::advance(COMMENT_DELIVERY_TIMEOUT - Duration::from_millis(1)).await;
            tokio::task::yield_now().await;
            assert!(!waiter.is_finished(), "waiter must not time out before full 10s budget");

            tokio::time::advance(Duration::from_millis(1)).await;
            let settled = waiter.await.unwrap();
            assert!(!settled, "unsettled pending delivery must time out");
            assert!(
                wall_start.elapsed() < Duration::from_secs(1),
                "10s virtual timeout must complete instantaneously, took {:?}",
                wall_start.elapsed()
            );
            assert!(
                !ic.delivery_waiters.lock().contains_key("m-stuck"),
                "timed-out waiter must be cleaned up from delivery_waiters"
            );
        });

        ic.close();
        board.close();
        hub.close();
        db.close();
    }
}
