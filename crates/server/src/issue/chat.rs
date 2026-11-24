//! Issue and session channel bridge (`issue/chat`):
//! connects [`Board`] / [`crate::runtime::SessionEngine`] directly with
//! [`crate::channel::Chat`], subscribing to session lifecycle events, durable
//! [`crate::context::Outbox`] reports, and dispatching per-issue / per-target
//! lanes on `ctx.task`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Applied, ArtifactViewContext, BizCode, ChannelType, MessageKind, NoticeLevel, Outcome, Session, SubjectKind};

use super::board::Board;
use crate::channel::{
    ChannelDispatched, Chat, Committed, DeliveryTargetKind, Meta, Note, Noticing, QueuedDelivery, Saying, Seat, ThreadSubject, meta_of, profile_id,
};
use crate::context::error::{LookIn, missing, refused};
use crate::context::text::{format_artifact_view_context, head};
use crate::context::{Context, now};
use crate::runtime::{MailboxSource, MailboxStatus, OUTBOX_SESSION_REPORTED, OutboxSessionReported, SessionLifecycleEvent};

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

/// Bridges session lifecycle events, durable outbox reports, and `Chat` deliveries onto
/// issue threads and [`Board::tell_message_async`] asynchronously per issue.
pub struct IssueChat {
    ctx: Arc<Context>,
    board: Arc<Board>,
    channel: Arc<Chat>,
    opening: tokio::sync::Mutex<()>,
    cancel: CancellationToken,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<IssueWake>>>,
    lane_tasks: TaskTracker,
    next_waiter_id: AtomicU64,
    delivery_waiters: Mutex<HashMap<String, Vec<DeliveryWaiter>>>,
}

impl IssueChat {
    pub fn start(ctx: Arc<Context>, board: Arc<Board>, channel: Arc<Chat>) -> Arc<Self> {
        let dispatches = channel.dispatches();
        let cancel = ctx.task.child_token();
        let ic = Arc::new(Self {
            ctx: ctx.clone(),
            board,
            channel,
            opening: tokio::sync::Mutex::new(()),
            cancel: cancel.clone(),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
            next_waiter_id: AtomicU64::new(1),
            delivery_waiters: Mutex::new(HashMap::new()),
        });

        let w = Arc::downgrade(&ic);
        ctx.outbox.register(OUTBOX_SESSION_REPORTED, move |delivery| {
            let w = w.clone();
            async move {
                let Some(ic) = w.upgrade() else { return Ok::<(), String>(()) };
                let report: OutboxSessionReported = delivery.decode().map_err(|e| format!("invalid {OUTBOX_SESSION_REPORTED} payload: {e}"))?;
                ic.handle_report_async(&report).await.map_err(|e| e.to_string())
            }
        });

        let w = Arc::downgrade(&ic);
        let mut session_events = ic.board.session_engine().subscribe_events();
        let task_cancel = cancel;
        let coordinator = ctx.spawn("issue_chat.coordinator", async move {
            let Some(boot_ic) = w.upgrade() else { return };
            boot_ic.open_threads_async().await;
            boot_ic.replay_reports_async().await;
            boot_ic.replay_pending_deliveries_async().await;
            loop {
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = dispatches.recv_async() => match res {
                        Ok(dispatched) => {
                            let Some(ic) = w.upgrade() else { return };
                            if ic.cancel.is_cancelled() {
                                return;
                            }
                            ic.route_dispatched_async(dispatched).await;
                        }
                        Err(_) => return,
                    },
                    res = session_events.recv() => match res {
                        Ok(SessionLifecycleEvent::Changed(session)) => {
                            let Some(ic) = w.upgrade() else { return };
                            if ic.cancel.is_cancelled() {
                                return;
                            }
                            ic.ensure_session_thread_async(&session).await;
                        }
                        Ok(SessionLifecycleEvent::Left { .. }) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let Some(ic) = w.upgrade() else { return };
                            if ic.cancel.is_cancelled() {
                                return;
                            }
                            ic.open_threads_async().await;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                }
            }
        });
        *ic.coordinator.lock() = Some(coordinator);

        ic
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        self.delivery_waiters.lock().clear();
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

    /// `issue.comment.create`: router handler returning the current sequence number.
    pub(crate) async fn comment_endpoint_async(&self, issue: &str, text: &str, send_key: Option<&str>) -> Result<Applied, ApiError> {
        self.comment_async(issue, text, send_key.unwrap_or("")).await?;
        Ok(Applied { seq: self.board.seq() })
    }

    /// `issue.comment.create`: writes the user's words into the issue's thread
    /// and awaits its issue-lane delivery without blocking a worker thread so
    /// `BoardSlice` reflects the accepted comment (e.g. leaving `Asking`).
    pub async fn comment_async(&self, issue: &str, text: &str, send_key: &str) -> Result<(), ApiError> {
        let item = self
            .board
            .issue_async(issue)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| missing(t("server.issue.notFound", &[("id", issue.into())]), LookIn::Issue))?;
        if item.status.is_closed() {
            return Err(refused(BizCode::IssueRefused, t("server.issue.closedReopen", &[])));
        }
        if text.trim().is_empty() {
            return Err(refused(BizCode::IssueRefused, t("server.issue.wordsRequired", &[])));
        }
        let channel = match item.latest_session_id() {
            Some(sid) => self.board.session_async(sid).await.and_then(|x| x.channel_id().map(str::to_string)),
            None => None,
        };
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
        // Check DB outside `delivery_waiters` lock so DB I/O never stalls settling lanes.
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
    pub async fn ensure_session_thread_async(&self, h: &Session) {
        if !h.is_board_worker() || h.issue_id().is_none() {
            return;
        }
        let _guard = self.opening.lock().await;
        if self.channel.home_of(&h.id).is_none()
            && let Err(e) = self.open_thread_locked_async(h).await
        {
            warn(&format!("{}'s thread", h.id), &e);
        }
    }

    pub(crate) async fn handle_report_async(&self, report: &OutboxSessionReported) -> Result<(), ApiError> {
        let s = match self.board.session_async(&report.id).await {
            Some(s) => s,
            None => match self.board.past_session_async(&report.id).await {
                Some(s) => s,
                None => return Ok(()),
            },
        };
        if !s.is_board_worker() || s.issue_id().is_none() {
            return Ok(());
        }
        if let Err(e) = self.post_report_async(&s, report).await {
            warn("the report", &e);
        }
        Ok(())
    }

    async fn issue_sessions_async(&self) -> Vec<Session> {
        self.board
            .sessions_async()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|x| x.is_board_worker() && x.issue_id().is_some())
            .collect()
    }

    async fn on_issue_async(&self, issue: &str) -> Option<Session> {
        self.issue_sessions_async()
            .await
            .into_iter()
            .filter(|h| h.issue_id() == Some(issue))
            .max_by_key(|h| h.hired_at)
    }

    async fn session_issue_async(&self, session_id: &str) -> Option<String> {
        self.board
            .session_async(session_id)
            .await
            .filter(|x| x.is_board_worker())
            .and_then(|x| x.issue_id().map(str::to_string))
    }

    fn channel_of_session(&self, h: &Session) -> String {
        match h.channel_id().and_then(|c| self.channel.place(c)) {
            Some(p) if p.r#type != ChannelType::Thread && p.name.is_some() => p.id,
            _ => self.channel.default_channel(),
        }
    }

    async fn open_threads_async(&self) {
        let _guard = self.opening.lock().await;
        for h in self.issue_sessions_async().await {
            if let Err(e) = self.open_thread_locked_async(&h).await {
                warn(&format!("{}'s thread", h.id), &e);
            }
        }
    }

    async fn open_thread_locked_async(&self, h: &Session) -> Result<(), ApiError> {
        let Some(issue) = h.issue_id() else { return Ok(()) };
        if let Some(thread) = self.channel.thread_about(SubjectKind::Issue, issue) {
            return self.handed_on_async(h, &thread).await;
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
        self.channel
            .note_async(Note {
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
            })
            .await?;
        Ok(())
    }

    async fn handed_on_async(&self, h: &Session, thread: &str) -> Result<(), ApiError> {
        self.channel
            .seat_async(&Seat {
                id: h.id.clone(),
                name: h.name.clone(),
                agent: h.profile.clone(),
                home: Some(thread.to_string()),
            })
            .await?;
        if self.channel.members_of(thread).contains(&h.id) {
            return Ok(());
        }
        let channel = self.channel_of_session(h);
        let latest = self.channel.latest_async(&channel).await?;
        self.channel.read_up_to_async(&h.id, &channel, latest).await?;
        let nth = self.channel.dispatch_count_async(thread).await? + 2;
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
        self.channel
            .note_async(Note {
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
            })
            .await?;
        Ok(())
    }

    async fn replay_reports_async(&self) {
        let store = self.board.session_engine().durable_store();
        let docs = match store
            .read_async(|r| Box::pin(async move { r.documents_by_kind_async("run", "issue.report").await }))
            .await
        {
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
            if let Err(e) = self.deliver_report_async(note, Some(&d.scope_id)).await {
                warn("replay report", &e);
            }
        }
    }

    async fn deliver_report_async(&self, note: Note, run: Option<&str>) -> Result<(), ApiError> {
        self.channel.note_once_async(note, run.map(|id| format!("report:{id}"))).await?;
        if let Some(id) = run {
            self.board
                .session_engine()
                .durable_store()
                .write_with_async(id.to_string(), |tx, id| {
                    Box::pin(async move { tx.delete_document_async("run", id, "issue.report").await })
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        }
        Ok(())
    }

    async fn post_report_async(&self, h: &Session, f: &OutboxSessionReported) -> Result<(), ApiError> {
        if h.is_refining() {
            let Some(thread) = h.issue_id().and_then(|i| self.channel.issue_thread_id(i)) else {
                return Ok(());
            };
            self.channel
                .notice_async(Noticing {
                    channel: thread,
                    text: f.summary.clone(),
                    code: "issue_refinement".into(),
                    ..Noticing::default()
                })
                .await;
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
        self.deliver_report_async(
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
        )
        .await?;
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
                if let Some(issue_id) = self.session_issue_async(&d.recipient_id).await {
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
        let sessions = self.board.session_engine();
        for d in dispatched.deliveries {
            match d.recipient_kind {
                DeliveryTargetKind::Issue => {
                    let issue_id = d.recipient_id.clone();
                    let owner = self
                        .on_issue_async(&issue_id)
                        .await
                        .map(|s| s.id)
                        .unwrap_or_else(|| format!("issue:{issue_id}"));
                    let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                    let _ = sessions
                        .enqueue_mailbox_async(
                            &owner,
                            &mail_key,
                            MailboxSource::IssueComment,
                            Some(&d.message_id),
                            &dispatched.committed.row.body,
                        )
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
                    if let Some(issue_id) = self.session_issue_async(&d.recipient_id).await {
                        let owner = self.on_issue_async(&issue_id).await.map(|s| s.id).unwrap_or_else(|| d.recipient_id.clone());
                        let mail_key = format!("issue:{issue_id}:{}", d.message_id);
                        let _ = sessions
                            .enqueue_mailbox_async(
                                &owner,
                                &mail_key,
                                MailboxSource::IssueComment,
                                Some(&d.message_id),
                                &dispatched.committed.row.body,
                            )
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
            let _ = self.board.session_engine().withdraw_mailbox_by_message_async(&delivery.message_id).await;
            return;
        }
        let c = match committed {
            Some(c) => Some(c),
            None => self.channel.committed_of_async(&delivery.message_id).await.ok().flatten().map(Arc::new),
        };
        let Some(c) = c else {
            let _ = self.board.session_engine().withdraw_mailbox_by_message_async(&delivery.message_id).await;
            let _ = self.channel.withdraw_delivery_async(delivery.id).await;
            return;
        };
        let on = self.on_issue_async(&delivery.recipient_id).await.map(|h| h.id);
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
        let tell_res = self.board.tell_message_async(&delivery.recipient_id, &text, &delivery.message_id).await;
        match tell_res {
            Ok(()) => {
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
            Err(e) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                self.ctx.live.publish_notice(now(), NoticeLevel::Warn, e.to_string());
            }
        }
    }

    async fn deliver_to_session_async(&self, delivery: QueuedDelivery, issue_id: &str, committed: Option<Arc<Committed>>) {
        if !self.channel.delivery_is_pending_async(delivery.id).await.unwrap_or(false) {
            let _ = self.board.session_engine().withdraw_mailbox_by_message_async(&delivery.message_id).await;
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
        let body = wake_input(&lines);
        let tell_res = self.board.tell_message_async(issue_id, &body, &delivery.message_id).await;
        match tell_res {
            Ok(()) => {
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
            Err(e) => {
                let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                self.ctx.live.publish_notice(now(), NoticeLevel::Warn, e.to_string());
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
/// direct-channel talk onto [`Chat`].
pub struct SessionChat {
    board: Arc<Board>,
    channel: Arc<Chat>,
    cancel: CancellationToken,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    lanes: Mutex<HashMap<String, flume::Sender<DirectWake>>>,
    lane_tasks: TaskTracker,
}

impl SessionChat {
    pub fn start(ctx: Arc<Context>, board: Arc<Board>, channel: Arc<Chat>, issue_chat: Option<Arc<IssueChat>>) -> Arc<Self> {
        let dispatches = channel.dispatches();
        let mut removals = channel.subscribe_removals();
        let cancel = ctx.task.child_token();
        let sc = Arc::new(Self {
            board: board.clone(),
            channel: channel.clone(),
            cancel: cancel.clone(),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
        });

        {
            let task = ctx.task.clone();
            let b = board.clone();
            let c = channel.clone();
            let ic = issue_chat.as_ref().map(Arc::downgrade);
            channel.ensure_seated(move |who| {
                if c.home_of(who).is_some() {
                    return;
                }
                let who = who.to_string();
                let b = b.clone();
                let c = c.clone();
                let ic = ic.clone();
                task.spawn_named("session_chat.seat", async move {
                    let Some(session) = b.session_async(&who).await.filter(|x| x.is_board_worker() || x.is_direct_talker()) else {
                        return;
                    };
                    if session.issue_id().is_some() {
                        if let Some(ic) = ic.as_ref().and_then(std::sync::Weak::upgrade) {
                            ic.ensure_session_thread_async(&session).await;
                        }
                    } else {
                        seat_direct_session_async(&c, &session).await;
                    }
                });
            });
        }

        {
            let ic = issue_chat.as_ref().map(Arc::downgrade);
            let sc_weak = Arc::downgrade(&sc);
            ctx.outbox.register(OUTBOX_SESSION_REPORTED, move |delivery| {
                let ic = ic.clone();
                let sc_weak = sc_weak.clone();
                async move {
                    let report: OutboxSessionReported = delivery.decode().map_err(|e| format!("invalid {OUTBOX_SESSION_REPORTED} payload: {e}"))?;
                    if let Some(ic) = ic.as_ref().and_then(std::sync::Weak::upgrade) {
                        ic.handle_report_async(&report).await.map_err(|e| e.to_string())?;
                    }
                    if let Some(sc) = sc_weak.upgrade() {
                        sc.handle_report_async(&report).await;
                    }
                    Ok::<(), String>(())
                }
            });
        }

        let w = Arc::downgrade(&sc);
        let mut session_events = sc.board.session_engine().subscribe_events();
        let task_cancel = cancel;
        let coordinator = ctx.spawn("session_chat.coordinator", async move {
            enum CoordinatorEvent {
                Dispatched(ChannelDispatched),
                Removed(String),
                Lifecycle(SessionLifecycleEvent),
                LaggedLifecycle,
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
                    res = session_events.recv() => match res {
                        Ok(ev) => CoordinatorEvent::Lifecycle(ev),
                        Err(broadcast::error::RecvError::Lagged(_)) => CoordinatorEvent::LaggedLifecycle,
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
                        sc.withdraw_message_mailbox_async(&message_id).await;
                    }
                    CoordinatorEvent::Lifecycle(SessionLifecycleEvent::Changed(session)) => {
                        if session.is_direct_talker() && session.issue_id().is_none() {
                            seat_direct_session_async(&sc.channel, &session).await;
                        }
                    }
                    CoordinatorEvent::Lifecycle(SessionLifecycleEvent::Left { id, .. }) => {
                        if let Err(e) = sc.channel.leave_async(&id).await {
                            eprintln!("vibevalley-server: session-chat: leave {id}: {}", e.message);
                        }
                        sessions_left_async(&sc.board, &sc.channel).await;
                    }
                    CoordinatorEvent::LaggedLifecycle => {
                        sc.sync_seats_async().await;
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

    async fn sync_seats_async(&self) {
        let sessions = self.board.sessions_async().await.unwrap_or_default();
        for h in sessions.iter().filter(|x| x.is_direct_talker() && x.issue_id().is_none()) {
            seat_direct_session_async(&self.channel, h).await;
        }
        sessions_left_async(&self.board, &self.channel).await;
    }

    async fn boot_async(self: &Arc<Self>) {
        self.sync_seats_async().await;
        if let Ok(pending) = self.channel.pending_deliveries_async(DeliveryTargetKind::Direct).await {
            for d in pending {
                self.enqueue_lane(d.recipient_id.clone(), DirectWake { delivery: d, committed: None });
            }
        }
    }

    async fn withdraw_message_mailbox_async(&self, message_id: &str) {
        let _ = self.board.session_engine().withdraw_mailbox_by_message_async(message_id).await;
    }

    pub(crate) async fn handle_report_async(&self, report: &OutboxSessionReported) {
        let s = match self.board.session_async(&report.id).await {
            Some(s) => s,
            None => match self.board.past_session_async(&report.id).await {
                Some(s) => s,
                None => return,
            },
        };
        if s.is_direct_talker() && s.issue_id().is_none() {
            post_talk_report_async(&self.channel, &s, report).await;
        }
    }

    async fn route_dispatched_async(self: &Arc<Self>, dispatched: ChannelDispatched) {
        let sessions = self.board.session_engine();
        for d in dispatched.deliveries {
            if d.recipient_kind == DeliveryTargetKind::Direct {
                let mailbox_owner = sessions
                    .talker_async(&d.recipient_id, &d.channel_id)
                    .await
                    .map(|s| s.id)
                    .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
                let key = direct_mail_key(&d.recipient_id, &d.message_id);
                let _ = sessions
                    .enqueue_mailbox_async(
                        &mailbox_owner,
                        &key,
                        MailboxSource::ChannelDirect,
                        Some(&d.message_id),
                        &dispatched.committed.row.body,
                    )
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
        let sessions = self.board.session_engine();
        if !self.channel.delivery_is_pending_async(d.id).await.unwrap_or(false) {
            let _ = sessions.withdraw_mailbox_async(&mail_key).await;
            return;
        }
        let c = match wake.committed {
            Some(c) => Some(c),
            None => self.channel.committed_of_async(&d.message_id).await.ok().flatten().map(Arc::new),
        };
        let Some(c) = c else {
            let _ = sessions.withdraw_mailbox_async(&mail_key).await;
            let _ = self.channel.withdraw_delivery_async(d.id).await;
            return;
        };
        if c.row.deleted_at.is_some() {
            let _ = sessions.withdraw_mailbox_async(&mail_key).await;
            let _ = self.channel.withdraw_delivery_async(d.id).await;
            return;
        }
        let mailbox_owner = sessions
            .talker_async(&d.recipient_id, &d.channel_id)
            .await
            .map(|s| s.id)
            .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
        let mail_entry = sessions
            .enqueue_mailbox_async(&mailbox_owner, &mail_key, MailboxSource::ChannelDirect, Some(&d.message_id), &c.row.body)
            .await
            .ok();
        let claimed = sessions.claim_mailbox_by_key_async(&mail_key).await.unwrap_or(false);
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
        let outcome = match self.board.runtime().driver().profile_info(&d.recipient_id) {
            Some(a) if !a.enabled => TalkOutcome::Err(t("server.channel.profileDisabled", &[("name", a.name.into())])),
            _ => match sessions.talk_async(&d.recipient_id, &d.channel_id, &words).await {
                Ok(sid) => TalkOutcome::Ok(sid),
                Err(e) => TalkOutcome::Err(e.to_string()),
            },
        };
        let why = match outcome {
            TalkOutcome::Ok(sid) => {
                if let Some(id) = settle_id {
                    let _ = sessions.settle_mailbox_async(id, true, Some(&sid)).await;
                }
                let _ = self.channel.settle_delivery_async(d.id, true).await;
                return;
            }
            TalkOutcome::Err(why) => why,
        };
        if let Some(id) = settle_id {
            let _ = sessions.settle_mailbox_async(id, false, Some(&why)).await;
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

async fn sessions_left_async(board: &Board, channel: &Chat) {
    let on: Vec<String> = board
        .sessions_async()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|h| h.is_board_worker() || h.is_direct_talker())
        .map(|h| h.id)
        .collect();
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

async fn post_talk_report_async(channel: &Chat, h: &Session, f: &OutboxSessionReported) {
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
    if let Err(e) = channel.note_once_async(note, f.run.as_ref().map(|id| format!("report:{id}"))).await {
        eprintln!("vibevalley-server: session-chat: talk report {}: {}", h.id, e.message);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::context::{Http, LiveState, Outbox, StateFeed, TaskGroup};
    use crate::issue::BoardConfig;
    use crate::service::Service;
    use crate::storage::Storage;

    async fn test_issue_chat_async(dir: &std::path::Path) -> (Arc<Context>, Arc<Board>, Arc<Chat>, Arc<IssueChat>) {
        let service = Service::open(dir).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
        let ctx = Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            http.clone(),
            http,
        ));
        let storage = Storage::open_async(dir, ctx.clone()).await.unwrap();
        let channel = Chat::open_async(ctx.clone(), storage, false).await.unwrap();
        let board = Board::open_standalone_async(ctx.clone(), Arc::new(vibevalley_runtime::oar::Registry::new()), BoardConfig::under(dir))
            .await
            .unwrap();
        let ic = Arc::new(IssueChat {
            ctx: ctx.clone(),
            board: board.clone(),
            channel: channel.clone(),
            opening: tokio::sync::Mutex::new(()),
            cancel: ctx.task.child_token(),
            coordinator: Mutex::new(None),
            lanes: Mutex::new(HashMap::new()),
            lane_tasks: TaskTracker::new(),
            next_waiter_id: AtomicU64::new(1),
            delivery_waiters: Mutex::new(HashMap::new()),
        });
        (ctx, board, channel, ic)
    }

    #[tokio::test]
    async fn await_comment_delivery_wakes_on_settle_and_fast_paths_when_settled() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, board, channel, ic) = test_issue_chat_async(dir.path()).await;
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

        // 2. Already-settled delivery in DB returns immediately without leaving a waiter.
        let pending = channel.pending_deliveries_async(DeliveryTargetKind::Issue).await.unwrap();
        assert!(!pending.is_empty());
        for d in pending {
            channel.settle_delivery_async(d.id, true).await.unwrap();
        }
        assert!(ic.await_comment_delivery_for("i-1", &msg.id, COMMENT_DELIVERY_TIMEOUT).await);
        assert!(ic.delivery_waiters.lock().is_empty());

        ic.close_async().await;
        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn await_comment_delivery_obeys_virtual_timeout_and_cleans_waiter() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, board, _channel, ic) = test_issue_chat_async(dir.path()).await;

        tokio::time::pause();
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
        tokio::time::resume();

        ic.close_async().await;
        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }
}
