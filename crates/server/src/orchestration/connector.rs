//! Connector notification & IM bridge orchestration (`orchestration::connector`):
//! bridges pure [`Connector`] IM adapters with [`Chat`], [`Board`], [`Runtime`],
//! [`NotifyRouter`], and scheduled progress digests.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, ConnectorID, ConnectorStatus, Issue, IssueStageKind, Millis, Notify, Op, Outcome, Session, SessionPermissionDecision,
    SessionRespondPermissionInput, SliceKind, StuckReason, ops,
};

use super::connector_digest::{
    IssueReplyAction, PermissionReplyAction, PersonalEvent, PersonalEventKind, PushTarget, ReplyParseError, issue_target_label, parse_issue_reply,
    parse_permission_reply, parse_push_issue_message_id, parse_push_message_id, parse_push_perm_message_id, personal_event_for_issue, personal_event_for_run,
    user_line_for_type,
};
use super::cron_digest::DigestTargets;
use super::notify::{NotifyDecision, NotifyOptions, NotifyRouter};
use crate::channel::{ChannelEvent, Chat, Saying, to_message};
use crate::connector::render::short_id;
use crate::connector::{Connector, ConnectorHost, InboundDispatch, InboundHandled, Options as ConnectorOptions, app_of};
use crate::context::text::clip_plain;
use crate::context::{Context, OUTBOX_CONNECTOR_NOTIFY, OutboxConnectorNotify, OutboxEvent, OutboxSessionReported};
use crate::issue::Board;
use crate::runtime::{PermissionEvent, Runtime};
use crate::service::DbError;
use crate::setting::Setting;

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::ConnectorRefused, text)
}

fn internal_db(e: DbError) -> ApiError {
    ApiError::new(BizCode::InternalError, e.to_string())
}

/// Whether the user still has to hear a farm message off the farm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    Unseen,
    /// Read in the farm, answered since, or gone.
    Settled,
}

pub async fn handoff_async(chat: &Chat, message: &str) -> Result<Handoff, ApiError> {
    let Some((m, read_at, superseded)) = chat.user_receipt_async(message).await? else {
        return Ok(Handoff::Settled);
    };
    if superseded || read_at.is_some() || !for_user(&m, chat.notify_of(&m.channel)) {
        return Ok(Handoff::Settled);
    }
    Ok(Handoff::Unseen)
}

fn issue_matches_category(issue: &Issue, category: &str) -> bool {
    if issue.status.is_closed() {
        return false;
    }
    match category {
        "asking" => issue.stage.state == IssueStageKind::Asking,
        "reviewing" => issue.stage.state == IssueStageKind::Reviewing,
        "conflict" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Conflict),
        "interrupted" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Interrupted),
        "failed" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Failed),
        _ => true,
    }
}

fn issue_parse_error_receipt(err: ReplyParseError, target: &str) -> String {
    let key = match err {
        ReplyParseError::EmptyAnswer => "server.connector.reply.emptyAnswer",
        ReplyParseError::ReviewUnrecognized => "server.connector.reply.reviewHint",
        ReplyParseError::RejectNeedsReason => "server.connector.reply.rejectNeedsReason",
        ReplyParseError::StuckUnrecognized => "server.connector.reply.stuckHint",
        ReplyParseError::ConflictNeedsWorkbench => "server.connector.reply.conflictHint",
        ReplyParseError::PermissionUnrecognized | ReplyParseError::UnsupportedCategory => {
            return t("server.connector.reply.alreadyHandled", &[("target", target.into())]);
        }
    };
    t(key, &[("target", target.into())])
}

struct HostAdapter {
    ctx: Arc<Context>,
    chat: Arc<Chat>,
    board: Arc<Board>,
    runtime: Arc<Runtime>,
}

impl HostAdapter {
    async fn handle_issue_quote_reply_async(&self, req: &InboundDispatch, push_msg_id: &str, issue_id: &str, category: &str) -> InboundHandled {
        let issue = match self.board.issue_async(issue_id).await {
            Ok(Some(issue)) => issue,
            Ok(None) => {
                let target = short_id(issue_id);
                return InboundHandled {
                    delivered_id: None,
                    reply_text: Some(t("server.connector.reply.alreadyHandled", &[("target", target.into())])),
                    withdraw_messages: vec![push_msg_id.to_owned()],
                    withdraw_prefixes: vec![format!("push:issue:{issue_id}:")],
                };
            }
            Err(e) => {
                let target = short_id(issue_id);
                let msg = t(
                    "server.connector.reply.actionFailed",
                    &[("target", target.into()), ("why", e.to_string().into())],
                );
                return InboundHandled {
                    reply_text: Some(msg),
                    ..Default::default()
                };
            }
        };
        let target = issue_target_label(Some(issue.number), Some(&issue.title));
        if !issue_matches_category(&issue, category) {
            return InboundHandled {
                reply_text: Some(t("server.connector.reply.alreadyHandled", &[("target", target.into())])),
                withdraw_messages: vec![push_msg_id.to_owned()],
                ..Default::default()
            };
        }
        let action = match parse_issue_reply(category, &req.text) {
            Ok(action) => action,
            Err(err) => {
                return InboundHandled {
                    reply_text: Some(issue_parse_error_receipt(err, &target)),
                    ..Default::default()
                };
            }
        };
        let outcome: Result<String, ApiError> = match &action {
            IssueReplyAction::Answer { text } => self
                .board
                .tell_async(&issue.id, text)
                .await
                .map_err(ApiError::from)
                .map(|_| t("server.connector.reply.answered", &[("target", target.clone().into())])),
            IssueReplyAction::Accept => self
                .board
                .move_to_async(&issue.id, vibevalley_protocol::IssueStatus::Done, None)
                .await
                .map_err(ApiError::from)
                .map(|_| t("server.connector.reply.accepted", &[("target", target.clone().into())])),
            IssueReplyAction::Reject { reason } => {
                let findings = vibevalley_core::brief::findings_of(reason);
                self.board
                    .review_async(&issue.id, false, &findings, "", None)
                    .await
                    .map_err(ApiError::from)
                    .map(|_| {
                        t(
                            "server.connector.reply.rejected",
                            &[("target", target.clone().into()), ("reason", clip_plain(reason, 120).into())],
                        )
                    })
            }
            IssueReplyAction::Retry { words } => self
                .board
                .move_to_async(&issue.id, vibevalley_protocol::IssueStatus::Todo, words.as_deref())
                .await
                .map_err(ApiError::from)
                .map(|_| t("server.connector.reply.retried", &[("target", target.clone().into())])),
        };
        match outcome {
            Ok(ok_receipt) => InboundHandled {
                delivered_id: None,
                reply_text: Some(ok_receipt),
                withdraw_messages: vec![push_msg_id.to_owned()],
                withdraw_prefixes: if matches!(action, IssueReplyAction::Accept) {
                    vec![format!("push:issue:{}:", issue.id)]
                } else {
                    vec![]
                },
            },
            Err(e) => InboundHandled {
                reply_text: Some(t(
                    "server.connector.reply.actionFailed",
                    &[("target", target.into()), ("why", e.message.into())],
                )),
                ..Default::default()
            },
        }
    }

    async fn handle_perm_quote_reply_async(&self, req: &InboundDispatch, push_msg_id: &str, session_id: &str, request_id: &str) -> InboundHandled {
        let session_label = self
            .runtime
            .session_async(session_id)
            .await
            .map(|s| clip_plain(&s.name, 40))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| short_id(session_id));
        if !self.runtime.has_pending_permission(session_id, request_id) {
            return InboundHandled {
                reply_text: Some(t("server.connector.reply.permAlreadyHandled", &[("session", session_label.into())])),
                withdraw_messages: vec![push_msg_id.to_owned()],
                ..Default::default()
            };
        }
        let action = match parse_permission_reply(&req.text) {
            Ok(action) => action,
            Err(_) => {
                return InboundHandled {
                    reply_text: Some(t("server.connector.reply.permHint", &[("session", session_label.into())])),
                    ..Default::default()
                };
            }
        };
        let (decision, message, receipt_key) = match action {
            PermissionReplyAction::AllowOnce => (SessionPermissionDecision::AllowOnce, None, "server.connector.reply.permAllowed"),
            PermissionReplyAction::AllowAlways => (SessionPermissionDecision::AllowAlways, None, "server.connector.reply.permAllowedAlways"),
            PermissionReplyAction::Deny { reason } => (SessionPermissionDecision::Deny, reason, "server.connector.reply.permDenied"),
        };
        match self
            .runtime
            .respond_permission_endpoint_async(SessionRespondPermissionInput {
                id: session_id.to_owned(),
                request_id: request_id.to_owned(),
                decision,
                message,
            })
            .await
        {
            Ok(()) => InboundHandled {
                reply_text: Some(t(receipt_key, &[("session", session_label.into())])),
                withdraw_messages: vec![push_msg_id.to_owned()],
                ..Default::default()
            },
            Err(e) => {
                if !self.runtime.has_pending_permission(session_id, request_id) {
                    InboundHandled {
                        reply_text: Some(t("server.connector.reply.permAlreadyHandled", &[("session", session_label.into())])),
                        withdraw_messages: vec![push_msg_id.to_owned()],
                        ..Default::default()
                    }
                } else {
                    InboundHandled {
                        reply_text: Some(t(
                            "server.connector.reply.permFailed",
                            &[("session", session_label.into()), ("why", e.message.into())],
                        )),
                        ..Default::default()
                    }
                }
            }
        }
    }
}

impl ConnectorHost for HostAdapter {
    fn channel_name(&self, channel_id: Option<&str>) -> Option<String> {
        let id = channel_id.map(str::to_string).unwrap_or_else(|| self.chat.default_channel());
        self.chat.place(&id).and_then(|c| c.name)
    }

    fn is_outgoing_unseen<'a>(&'a self, message_id: &'a str) -> crate::connector::adapter::BoxFuture<'a, Result<bool, ApiError>> {
        Box::pin(async move {
            if message_id.starts_with("digest:") {
                return Ok(true);
            }
            if let Some((issue_id, category)) = parse_push_issue_message_id(message_id) {
                let Some(raw_issue) = self.ctx.service.issue.get(issue_id).await.map_err(internal_db)? else {
                    return Ok(false);
                };
                let sessions = self.ctx.service.session.all().await.map_err(internal_db)?;
                let derived = vibevalley_core::derive_issues(&[raw_issue], &sessions);
                let Some(issue) = derived.into_iter().next() else {
                    return Ok(false);
                };
                return Ok(issue_matches_category(&issue, category));
            }
            if let Some((session_id, request_id)) = parse_push_perm_message_id(message_id) {
                return Ok(self.runtime.has_pending_permission(session_id, request_id));
            }
            if message_id.starts_with("push:") {
                return Ok(true);
            }
            Ok(handoff_async(&self.chat, message_id).await? == Handoff::Unseen)
        })
    }

    fn handle_inbound<'a>(&'a self, req: InboundDispatch) -> crate::connector::adapter::BoxFuture<'a, Result<InboundHandled, ApiError>> {
        Box::pin(async move {
            if let Some(ref push_msg_id) = req.quoted_message_id
                && let Some(target) = parse_push_message_id(push_msg_id)
            {
                return Ok(match target {
                    PushTarget::Issue { issue_id, category } => self.handle_issue_quote_reply_async(&req, push_msg_id, issue_id, category).await,
                    PushTarget::Permission { session_id, request_id } => self.handle_perm_quote_reply_async(&req, push_msg_id, session_id, request_id).await,
                });
            }
            if req.send_key.is_empty() {
                return Ok(InboundHandled::default());
            }
            let channel = match req.quoted_message_id.as_deref() {
                Some(msg) => self.chat.message_location_async(msg).await?.map(|(place, _)| place.id),
                None => None,
            }
            .or(req.bound_channel_id);
            let (message, _) = self
                .chat
                .say_async(Saying {
                    text: req.text,
                    channel,
                    send_key: req.send_key,
                    source: Some("connector".into()),
                    ..Saying::default()
                })
                .await?;
            Ok(InboundHandled {
                delivered_id: Some(message.id),
                ..Default::default()
            })
        })
    }
}

/// Application-layer connector workflow managing IM bridges, notification routing,
/// chat forwarding, board/permission watchers, and digest delivery.
pub struct ConnectorWorkflow {
    ctx: Arc<Context>,
    connector: Arc<Connector>,
    chat: Arc<Chat>,
    notify: Arc<NotifyRouter>,
    cancel: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl ConnectorWorkflow {
    pub async fn open_async(
        ctx: Arc<Context>,
        setting: Arc<Setting>,
        chat: Arc<Chat>,
        board: Arc<Board>,
        runtime: Arc<Runtime>,
        options: ConnectorOptions,
        notify_options: NotifyOptions,
    ) -> Result<Arc<Self>, ApiError> {
        let host: Arc<dyn ConnectorHost> = Arc::new(HostAdapter {
            ctx: ctx.clone(),
            chat: chat.clone(),
            board: board.clone(),
            runtime: runtime.clone(),
        });
        let connector = Connector::open_async(ctx.clone(), setting, options, host).await?;
        let notify = Arc::new(NotifyRouter::new(notify_options.clone()));
        if let (Ok(raw_issues), Ok(sessions)) = (ctx.service.issue.all().await, ctx.service.session.all().await) {
            let derived = vibevalley_core::derive_issues(&raw_issues, &sessions);
            notify.seed_issues(&derived, &sessions, ctx.now());
        }

        // Register durable Outbox connector notification handler.
        {
            let conn = connector.clone();
            let ctx_ob = ctx.clone();
            let push_targets = notify_options.push_targets.clone();
            ctx.outbox.register(OUTBOX_CONNECTOR_NOTIFY, move |delivery| {
                let conn = conn.clone();
                let ctx_ob = ctx_ob.clone();
                let push_targets = push_targets.clone();
                async move {
                    let payload: OutboxConnectorNotify = delivery.decode().map_err(|e| format!("invalid {OUTBOX_CONNECTOR_NOTIFY} payload: {e}"))?;
                    let at = ctx_ob.now();
                    let targets: Vec<ConnectorID> = match payload.connector {
                        Some(id) => vec![id],
                        None => push_targets.clone(),
                    };
                    for id in targets {
                        conn.offer_notification_async(id, &payload.message_id, &payload.body, at).await;
                    }
                    Ok::<(), String>(())
                }
            });
        }

        let cancel = ctx.task.child_token();
        let feed_handle = ctx.spawn("connector.feed", feed(connector.clone(), chat.clone(), chat.subscribe_events(), cancel.clone()));
        let board_rx = ctx.feed.subscribe_json(SliceKind::Board);
        let board_handle = ctx.spawn(
            "connector.board_events",
            watch_board_events(ctx.clone(), connector.clone(), chat.clone(), notify.clone(), board_rx, cancel.clone()),
        );
        let perm_rx = runtime.subscribe_permissions();
        let perm_handle = ctx.spawn(
            "connector.permission_events",
            watch_permission_events(ctx.clone(), connector.clone(), chat.clone(), notify.clone(), perm_rx, cancel.clone()),
        );

        Ok(Arc::new(Self {
            ctx,
            connector,
            chat,
            notify,
            cancel,
            tasks: Mutex::new(vec![feed_handle, board_handle, perm_handle]),
        }))
    }

    pub fn connector(&self) -> &Arc<Connector> {
        &self.connector
    }

    pub async fn close_async(&self) {
        self.connector.close_async().await;
        self.cancel.cancel();
        let handles = std::mem::take(&mut *self.tasks.lock());
        for handle in handles {
            let _ = handle.await;
        }
    }

    /// Ties the app to the channel called `name`.
    pub async fn set_channel_async(&self, id: ConnectorID, name: &str) -> Result<ConnectorStatus, ApiError> {
        let channel = self
            .chat
            .channel_by_name(name)
            .ok_or_else(|| refused(t("server.connector.noChannel", &[("name", name.into())])))?;
        let bound = (!channel.default).then_some(channel.id.as_str());
        self.connector.set_channel_id_async(id, bound).await
    }

    pub(crate) async fn handle_channel_set(&self, req: <ops::ConnectorChannelSet as Op>::Input) -> Result<ConnectorStatus, ApiError> {
        let id = app_of(&req.id)?;
        self.set_channel_async(id, &req.channel).await
    }

    fn has_paired_target(&self, target: Option<ConnectorID>) -> bool {
        match target {
            Some(id) => self.connector.is_paired(id),
            None => self.notify.options().push_targets.iter().any(|id| self.connector.is_paired(*id)),
        }
    }

    pub async fn push_personal_event_async(&self, event: PersonalEvent) -> Result<Option<NotifyDecision>, ApiError> {
        if self.connector.is_closing() || !self.has_paired_target(None) {
            return Ok(None);
        }
        let channel_notify = event.channel_id.as_deref().map(|cid| self.chat.notify_of(cid)).unwrap_or(Notify::All);
        let decision = self.notify.submit_event_async(&self.ctx, None, &event, channel_notify).await?;
        Ok(Some(decision))
    }

    pub async fn on_session_reported_async(&self, report: &OutboxSessionReported) {
        if self.connector.is_closing() || !self.has_paired_target(None) {
            return;
        }
        let session = match self.ctx.service.session.get(&report.id).await {
            Ok(Some(s)) => s,
            Ok(None) => match self.ctx.service.session.past(&report.id).await {
                Ok(Some(s)) => s,
                _ => return,
            },
            Err(_) => return,
        };
        let event = if let Some(issue_id) = session.issue_id() {
            let Ok(Some(raw_issue)) = self.ctx.service.issue.get(issue_id).await else {
                return;
            };
            let Ok(sessions) = self.ctx.service.session.all().await else {
                return;
            };
            let derived = vibevalley_core::derive_issues(&[raw_issue], &sessions);
            let Some(issue) = derived.into_iter().next() else {
                return;
            };
            let channel_id = issue_top_channel(&self.chat, &issue, &sessions);
            let session_summary = (!report.summary.trim().is_empty())
                .then_some(report.summary.as_str())
                .or_else(|| session.last_run.as_ref().map(|r| r.summary.as_str()));
            personal_event_for_issue(&issue, session_summary, report.at, channel_id)
        } else {
            let default_ch = self.chat.default_channel();
            let already_forwarded_in_bound_channel = session.is_direct_talker()
                && report.outcome == Outcome::Completed
                && session.channel_id().is_some_and(|cid| {
                    let top = self.chat.top_of(cid).id;
                    let bound = self
                        .notify
                        .options()
                        .push_targets
                        .iter()
                        .any(|id| self.connector.bound_channel_id(*id).as_deref().unwrap_or(&default_ch) == top);
                    bound && self.chat.notify_of(cid) != Notify::None
                });
            if already_forwarded_in_bound_channel {
                None
            } else {
                personal_event_for_run(
                    &session,
                    report.run.as_deref(),
                    report.outcome,
                    &report.summary,
                    report.spent.as_ref(),
                    report.at,
                )
            }
        };
        if let Some(ev) = event {
            let _ = self.push_personal_event_async(ev).await;
        }
    }

    pub async fn deliver_digest_async(&self, cron_id: &str, at: Millis, targets: DigestTargets, text: &str) -> Result<usize, ApiError> {
        if self.connector.is_closing() || text.trim().is_empty() {
            return Ok(0);
        }
        let target_ids: Vec<ConnectorID> = match targets {
            DigestTargets::Default => self.notify.options().digest_targets,
            DigestTargets::Connectors(ids) => ids,
            DigestTargets::AllConnected => self.connector.paired_ids(),
        };
        let mut delivered = 0usize;
        let now_ms = self.ctx.now();
        for id in target_ids {
            if !self.connector.is_paired(id) {
                continue;
            }
            let payload = OutboxEvent::ConnectorNotify(OutboxConnectorNotify {
                connector: Some(id),
                dedupe_key: format!("digest:{cron_id}:{at}:{}", id.as_str()),
                message_id: format!("digest:{cron_id}:{at}"),
                issue_id: None,
                channel_id: None,
                body: text.to_string(),
                created_at: now_ms,
                urgent: true,
            });
            self.ctx.outbox.enqueue_event(&payload).await?;
            delivered += 1;
        }
        if delivered > 0 {
            self.ctx.outbox.wake();
        }
        Ok(delivered)
    }
}

async fn feed(connector: Arc<Connector>, chat: Arc<Chat>, mut events: broadcast::Receiver<ChannelEvent>, cancel: CancellationToken) {
    loop {
        connector.prune_history_async().await;
        let day = tokio::time::sleep(DAY);
        tokio::pin!(day);
        loop {
            enum Fed {
                Event(Box<ChannelEvent>),
                Lagged,
                Day,
                Over,
            }
            let fed = tokio::select! {
                biased;
                _ = cancel.cancelled() => Fed::Over,
                res = events.recv() => match res {
                    Ok(ev) => Fed::Event(Box::new(ev)),
                    Err(broadcast::error::RecvError::Lagged(_)) => Fed::Lagged,
                    Err(broadcast::error::RecvError::Closed) => Fed::Over,
                },
                _ = &mut day => Fed::Day,
            };
            match fed {
                Fed::Event(event) => {
                    let wake = match *event {
                        ChannelEvent::Posted(c) => {
                            let m = to_message(&c.row);
                            if for_user(&m, chat.notify_of(&m.channel))
                                && matches!(handoff_async(&chat, &m.id).await, Ok(Handoff::Unseen))
                                && let Some(place) = chat.place(&m.channel)
                            {
                                let top = chat.top_of(&m.channel).id;
                                let default_ch = chat.default_channel();
                                let formatted = user_line_for_type(&m, place.r#type);
                                connector.offer_channel_text_async(&m.id, &top, &default_ch, &formatted).await;
                            }
                            true
                        }
                        ChannelEvent::Removed(_) | ChannelEvent::UserRead { .. } => true,
                        ChannelEvent::Edited(_) | ChannelEvent::Reacted(_) | ChannelEvent::Pinned(_) => false,
                    };
                    if wake {
                        connector.notify_changed_all_async().await;
                    }
                }
                Fed::Lagged => {
                    connector.notify_changed_all_async().await;
                }
                Fed::Day => break,
                Fed::Over => return,
            }
        }
    }
}

fn issue_top_channel(chat: &Chat, issue: &Issue, sessions: &[Session]) -> Option<String> {
    let sid = issue.latest_session_id()?;
    let ch = sessions.iter().find(|s| &s.id == sid).and_then(|s| s.channel_id())?;
    Some(chat.top_of(ch).id)
}

async fn watch_board_events(
    ctx: Arc<Context>,
    connector: Arc<Connector>,
    chat: Arc<Chat>,
    notify: Arc<NotifyRouter>,
    mut board_rx: watch::Receiver<Arc<str>>,
    cancel: CancellationToken,
) {
    let _ = board_rx.borrow_and_update();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            changed = board_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
        if connector.is_closing() {
            return;
        }
        let json = board_rx.borrow_and_update().clone();
        let Ok(board) = serde_json::from_str::<BoardSlice>(&json) else {
            continue;
        };
        let sessions = ctx.service.session.all().await.unwrap_or_default();
        let now_ms = ctx.now();
        let (events, settled) = notify.diff_board_issues(&board.issues, &sessions, now_ms, |issue| issue_top_channel(&chat, issue, &sessions));
        for settled_msg_id in settled {
            connector.withdraw_push_message_all_async(&settled_msg_id).await;
        }
        let has_paired = notify.options().push_targets.iter().any(|id| connector.is_paired(*id));
        if !has_paired {
            continue;
        }
        for event in events {
            let channel_notify = event.channel_id.as_deref().map(|cid| chat.notify_of(cid)).unwrap_or(Notify::All);
            let _ = notify.submit_event_async(&ctx, None, &event, channel_notify).await;
        }
    }
}

async fn watch_permission_events(
    ctx: Arc<Context>,
    connector: Arc<Connector>,
    chat: Arc<Chat>,
    notify: Arc<NotifyRouter>,
    mut perm_rx: broadcast::Receiver<PermissionEvent>,
    cancel: CancellationToken,
) {
    loop {
        let ev = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            res = perm_rx.recv() => match res {
                Ok(ev) => ev,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
        };
        if connector.is_closing() {
            return;
        }
        match ev {
            PermissionEvent::Requested {
                session_id,
                session_name,
                channel_id,
                request,
                at,
            } => {
                let has_paired = notify.options().push_targets.iter().any(|id| connector.is_paired(*id));
                if !has_paired {
                    continue;
                }
                let top_channel = channel_id.as_deref().map(|cid| chat.top_of(cid).id);
                let channel_notify = top_channel.as_deref().map(|cid| chat.notify_of(cid)).unwrap_or(Notify::All);
                let event = PersonalEvent {
                    dedupe_key: format!("perm:{session_id}:{}", request.request_id),
                    issue_id: None,
                    issue_number: None,
                    issue_title: None,
                    session_id: Some(session_id),
                    channel_id: top_channel,
                    is_child_review: false,
                    at,
                    kind: PersonalEventKind::PermissionRequest {
                        request_id: request.request_id,
                        session_name,
                        tool: request.tool,
                        summary: request.summary,
                        input: request.input,
                    },
                };
                let _ = notify.submit_event_async(&ctx, None, &event, channel_notify).await;
            }
            PermissionEvent::Resolved { session_id, request_id } => {
                connector.withdraw_push_message_all_async(&format!("push:perm:{session_id}:{request_id}")).await;
            }
            PermissionEvent::ClearedSession { session_id } => {
                connector.withdraw_prefix_all_async(&format!("push:perm:{session_id}:")).await;
            }
        }
    }
}
