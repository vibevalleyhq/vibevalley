//! Issue channel bridge (`issue/chat`):
//! connects [`Board`] / [`crate::runtime::SessionEngine`] directly with
//! [`crate::channel::Chat`], subscribing to issue session lifecycle events,
//! durable [`crate::context::Outbox`] reports, and handling issue/session
//! deliveries routed by [`super::delivery::DeliveryRouter`].

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Applied, BizCode, ChannelType, MessageKind, NoteViewContext, NoticeLevel, Outcome, ParticipantId, Session, SubjectKind};

use crate::channel::{Chat, Committed, Meta, Note, Noticing, QueuedDelivery, Saying, Seat, ThreadSubject, meta_of};
use crate::context::error::{LookIn, missing, refused};
use crate::context::text::{format_note_view_context, head};
use crate::context::{Context, now};
use crate::issue::Board;
use crate::runtime::{MailboxSource, OUTBOX_SESSION_REPORTED, OutboxSessionReported, SessionLifecycleEvent};

const HANDED_EMOJI: &str = "👀";
pub(super) const REPORT_MAX: usize = 1500;
const COMMENT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const CHAT_CLOSE_GRACE: Duration = Duration::from_secs(5);

fn warn(what: &str, e: &ApiError) {
    eprintln!("vibevalley-server: issue-chat: {what}: {}", e.message);
}

pub(super) fn view_context_of(c: &Committed) -> Option<NoteViewContext> {
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
        .map(|vc| format!("\n  │ {}", format_note_view_context(vc).replace('\n', "\n  │ ")))
        .unwrap_or_default();
    format!(
        "[target={target} msg={}{reply} from={from}]{edited} {}{view}",
        c.row.number,
        c.row.body.trim().replace('\n', "\n  │ ")
    )
}

type DeliveryWaiter = (u64, oneshot::Sender<()>);

/// Bridges session lifecycle events, durable outbox reports, and issue-thread
/// deliveries onto [`Board::tell_message_async`].
pub struct IssueChat {
    ctx: Arc<Context>,
    board: Arc<Board>,
    channel: Arc<Chat>,
    opening: tokio::sync::Mutex<()>,
    cancel: CancellationToken,
    coordinator: Mutex<Option<TaskHandle<()>>>,
    next_waiter_id: AtomicU64,
    delivery_waiters: Mutex<HashMap<String, Vec<DeliveryWaiter>>>,
}

impl IssueChat {
    pub fn start(ctx: Arc<Context>, board: Arc<Board>, channel: Arc<Chat>) -> Arc<Self> {
        let cancel = ctx.task.child_token();
        let ic = Arc::new(Self {
            ctx: ctx.clone(),
            board,
            channel,
            opening: tokio::sync::Mutex::new(()),
            cancel: cancel.clone(),
            coordinator: Mutex::new(None),
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
            loop {
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = session_events.recv() => match res {
                        Ok(SessionLifecycleEvent::Changed(session)) => {
                            let Some(ic) = w.upgrade() else { return };
                            if ic.cancel.is_cancelled() {
                                return;
                            }
                            ic.ensure_session_thread_async(&session).await;
                        }
                        Ok(SessionLifecycleEvent::Left { .. }) => {}
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "issue.chat session lifecycle stream lagged; re-opening threads");
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
        let coordinator = self.coordinator.lock().take();
        if let Some(handle) = coordinator {
            let _ = tokio::time::timeout(CHAT_CLOSE_GRACE, handle).await;
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
            .pending_deliveries_all_async()
            .await
            .map(|rows| {
                rows.iter()
                    .any(|d| d.message_id == message_id && matches!(&d.recipient, ParticipantId::Session(_)))
            })
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
        if !(s.is_board_worker() || s.is_readonly_issue_helper()) || s.issue_id().is_none() {
            return Ok(());
        }
        if let Err(e) = self.post_report_async(&s, report).await {
            warn("the report", &e);
        }
        Ok(())
    }

    /// Parses `@<agent>` discussion mentions and dispatches readonly collaborator sessions.
    /// Returns `None` if no collaborators matched, `Some(true)` if handled without waking
    /// the primary worker, or `Some(false)` if collaborators were dispatched alongside primary delivery.
    async fn dispatch_mentioned_collaborators_async(&self, issue_id: &str, c: &Committed, primary_session_id: Option<&str>) -> Option<bool> {
        if matches!(c.row.kind.as_str(), "report" | "dispatch" | "notice") {
            return None;
        }
        let tokens = crate::channel::words::extract_at_tokens(&c.row.body);
        if tokens.is_empty() {
            return None;
        }
        let issue = self.board.issue_async(issue_id).await.ok().flatten();
        let primary_agent = issue.as_ref().and_then(|i| i.assigned_agent()).map(str::to_string);
        let driver = self.board.runtime().driver();
        let mut collaborators = Vec::new();
        let mut explicit_primary_wake = false;
        for tok in &tokens {
            if let Some(primary_id) = primary_session_id
                && tok == primary_id
            {
                explicit_primary_wake = true;
                continue;
            }
            if matches!(tok.as_str(), "everyone" | "所有人") {
                explicit_primary_wake = true;
                continue;
            }
            if let Some(agent) = driver.resolve_mention_agent(tok) {
                if primary_session_id.is_some() && primary_agent.as_deref() == Some(agent.id.as_str()) {
                    explicit_primary_wake = true;
                } else if !collaborators.iter().any(|existing: &String| existing == &agent.id) {
                    collaborators.push(agent.id);
                }
            }
        }
        if collaborators.is_empty() {
            return None;
        }
        let mut all_ok = true;
        for agent_id in &collaborators {
            if let Err(e) = self.board.dispatch_collaborator_async(issue_id, agent_id, &c.row.body, &c.row.id).await {
                all_ok = false;
                self.ctx.live.publish_notice(now(), NoticeLevel::Warn, e.to_string());
            }
        }
        Some(all_ok && !explicit_primary_wake)
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
        if let Ok(Some(item)) = self.board.issue_async(issue).await
            && let Some(id) = item.latest_session_id()
            && let Some(session) = self.board.session_async(id).await
            && !session.is_readonly_issue_helper()
        {
            return Some(session);
        }
        self.issue_sessions_async()
            .await
            .into_iter()
            .filter(|h| h.issue_id() == Some(issue) && !h.is_readonly_issue_helper())
            .max_by_key(|h| h.hired_at)
    }

    pub(crate) async fn session_issue_async(&self, session_id: &str) -> Option<String> {
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

    async fn deliver_report_async(&self, note: Note, run: Option<&str>) -> Result<(), ApiError> {
        self.channel.note_once_async(note, run.map(|id| format!("report:{id}"))).await?;
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
        if h.is_readonly_issue_helper() && self.channel.home_of(&h.id).is_none() {
            self.channel
                .seat_async(&Seat {
                    id: h.id.clone(),
                    name: h.name.clone(),
                    agent: h.profile.clone(),
                    home: None,
                })
                .await?;
        }
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

    /// Called by [`super::delivery::DeliveryRouter`]'s `AgentAdapter` for issue-thread messages.
    pub(crate) async fn deliver_issue_async(&self, issue_id: &str, delivery: QueuedDelivery, committed: Option<Arc<Committed>>) {
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

        let sessions = self.board.session_engine();
        let owner = self.on_issue_async(issue_id).await.map(|s| s.id).unwrap_or_else(|| format!("issue:{issue_id}"));
        let c = match committed {
            Some(c) => Some(c),
            None => match self.channel.committed_of_async(&delivery.message_id).await {
                Ok(found) => found.map(Arc::new),
                Err(err) => {
                    tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err, "issue.chat failed to load committed message");
                    None
                }
            },
        };
        let Some(c) = c else {
            let _ = sessions.withdraw_mailbox_by_message_async(&delivery.message_id).await;
            let _ = self.channel.withdraw_delivery_async(delivery.id).await;
            return;
        };
        let mail_key = format!("issue:{issue_id}:{}", delivery.message_id);
        let _ = sessions
            .enqueue_mailbox_async(&owner, &mail_key, MailboxSource::IssueComment, Some(&delivery.message_id), &c.row.body)
            .await;

        let on = self.on_issue_async(issue_id).await.map(|h| h.id);
        if let Some(suppressed) = self.dispatch_mentioned_collaborators_async(issue_id, &c, on.as_deref()).await
            && suppressed
        {
            if let Err(err) = sessions.withdraw_mailbox_by_message_async(&delivery.message_id).await {
                tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err, "issue.chat failed to withdraw suppressed mailbox");
            }
            if let Err(err) = self.channel.settle_delivery_async(delivery.id, true).await {
                tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err, "issue.chat failed to settle suppressed delivery");
            }
            return;
        }
        let mut text = c.row.body.trim().to_string();
        if let Some(vc) = view_context_of(&c) {
            text = format!("{}\n{text}", format_note_view_context(&vc));
        }
        let mut earlier_ids: Vec<(i64, String)> = Vec::new();
        let mut earlier_lines: Vec<String> = Vec::new();
        if let Some(session_id) = on.as_deref() {
            let pending = self
                .channel
                .pending_deliveries_for_async(&ParticipantId::session(session_id), delivery.id)
                .await
                .unwrap_or_default();
            for d in pending {
                if d.id == delivery.id {
                    continue;
                }
                match self.channel.committed_of_async(&d.message_id).await {
                    Ok(Some(ec)) => {
                        earlier_lines.push(line_of(&self.channel, &ec));
                        earlier_ids.push((d.id, d.message_id));
                    }
                    Ok(None) => {
                        let _ = self.channel.withdraw_delivery_async(d.id).await;
                    }
                    Err(err) => {
                        tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "issue.chat failed to load earlier session delivery");
                    }
                }
            }
        }
        if !earlier_lines.is_empty() {
            text = format!("{text}\n\n{}", wake_input(&earlier_lines));
        }
        let from_user = c.row.sender_kind == "user";
        let tell_res = self.board.tell_message_from_async(issue_id, &text, &delivery.message_id, from_user).await;
        match tell_res {
            Ok(()) => {
                if let Err(err) = self.channel.settle_delivery_async(delivery.id, true).await {
                    tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err, "issue.chat failed to settle issue delivery");
                }
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

    /// Called by [`super::delivery::DeliveryRouter`]'s `AgentAdapter` for live worker session wakes.
    pub(crate) async fn deliver_session_async(&self, session_id: &str, issue_id: &str, delivery: QueuedDelivery, committed: Option<Arc<Committed>>) {
        let sessions = self.board.session_engine();
        if let Some(ref c) = committed {
            let owner = self.on_issue_async(issue_id).await.map(|s| s.id).unwrap_or_else(|| session_id.to_string());
            let mail_key = format!("issue:{issue_id}:{}", delivery.message_id);
            let _ = sessions
                .enqueue_mailbox_async(&owner, &mail_key, MailboxSource::IssueComment, Some(&delivery.message_id), &c.row.body)
                .await;
        }
        let pending = self
            .channel
            .pending_deliveries_for_async(&ParticipantId::session(session_id), delivery.id)
            .await
            .unwrap_or_default();
        let mut settled_ids: Vec<(i64, String)> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        let mut from_user = false;
        for d in pending {
            let loaded = if d.id == delivery.id {
                match committed.clone() {
                    Some(c) => Ok(Some(c)),
                    None => self.channel.committed_of_async(&d.message_id).await.map(|o| o.map(Arc::new)),
                }
            } else {
                self.channel.committed_of_async(&d.message_id).await.map(|o| o.map(Arc::new))
            };
            match loaded {
                Ok(Some(ec)) => {
                    if let Some(suppressed) = self.dispatch_mentioned_collaborators_async(issue_id, &ec, Some(session_id)).await
                        && suppressed
                    {
                        let _ = sessions.withdraw_mailbox_by_message_async(&d.message_id).await;
                        let _ = self.channel.settle_delivery_async(d.id, true).await;
                        continue;
                    }
                    if ec.row.sender_kind == "user" {
                        from_user = true;
                    }
                    lines.push(line_of(&self.channel, &ec));
                    settled_ids.push((d.id, d.message_id));
                }
                Ok(None) => {
                    let _ = self.channel.withdraw_delivery_async(d.id).await;
                }
                Err(err) => {
                    tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "issue.chat failed to load session delivery message");
                }
            }
        }
        if lines.is_empty() {
            return;
        }
        let body = wake_input(&lines);
        let tell_res = self.board.tell_message_from_async(issue_id, &body, &delivery.message_id, from_user).await;
        match tell_res {
            Ok(()) => {
                for (did, _) in &settled_ids {
                    let _ = self.channel.settle_delivery_async(*did, true).await;
                }
                for (_, mid) in settled_ids {
                    if let Err(e) = self.channel.mark_seen_async(session_id, &mid).await {
                        warn("seen", &e);
                    }
                    if let Err(e) = self.channel.react_async(&mid, session_id, HANDED_EMOJI, true).await {
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
        let cancel = ctx.task.child_token();
        let ic = Arc::new(IssueChat {
            ctx: ctx.clone(),
            board: board.clone(),
            channel: channel.clone(),
            opening: tokio::sync::Mutex::new(()),
            cancel,
            coordinator: Mutex::new(None),
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
        let pending = channel.pending_deliveries_all_async().await.unwrap();
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

    #[test]
    fn issue_report_doc_decodes_typed_and_omitted_fields() {
        use crate::runtime::IssueReportDoc;
        let minimal: IssueReportDoc = serde_json::from_value(serde_json::json!({
            "issueId": "i-1",
            "sessionId": "s-1",
            "outcome": "completed"
        }))
        .unwrap();
        assert_eq!(minimal.issue_id, "i-1");
        assert_eq!(minimal.session_id, "s-1");
        assert_eq!(minimal.run_id, "");
        assert_eq!(minimal.outcome, Some(Outcome::Completed));
        assert_eq!(minimal.summary, "");
        assert_eq!(minimal.spent, None);

        let full = IssueReportDoc {
            issue_id: "i-2".into(),
            session_id: "s-2".into(),
            run_id: "r-2".into(),
            outcome: Some(Outcome::Failed),
            summary: "did not compile".into(),
            spent: Some(vibevalley_protocol::Spent {
                tokens: 42,
                cny: Some(vibevalley_protocol::JsNumber(0.1)),
            }),
        };
        let decoded: IssueReportDoc = serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
        assert_eq!(decoded.run_id, "r-2");
        assert_eq!(decoded.outcome, Some(Outcome::Failed));
        assert_eq!(decoded.summary, "did not compile");
        assert_eq!(decoded.spent.map(|s| s.tokens), Some(42));
    }
}
