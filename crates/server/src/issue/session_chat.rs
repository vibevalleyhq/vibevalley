//! Direct-talk session channel bridge (`issue/session_chat`):
//! connects [`Board`] / [`crate::runtime::SessionEngine`] with
//! [`crate::channel::Chat`] for session seating, direct-talk reports,
//! message-removal mailbox withdrawals, and per-target direct-channel lanes.

use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{ChannelType, MessageKind, Outcome, Session};

use super::board::Board;
use super::chat::{IssueChat, KeyedLaneQueue, REPORT_MAX, view_context_of};
use crate::channel::{ChannelDispatched, Chat, Committed, DeliveryTargetKind, Meta, Note, Noticing, QueuedDelivery, Seat, profile_id};
use crate::context::Context;
use crate::context::text::{format_note_view_context, head};
use crate::runtime::{MailboxSource, MailboxStatus, OUTBOX_SESSION_REPORTED, OutboxSessionReported, SessionLifecycleEvent};

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
    lanes: KeyedLaneQueue<DirectWake>,
}

impl SessionChat {
    pub fn start(ctx: Arc<Context>, board: Arc<Board>, channel: Arc<Chat>, issue_chat: Option<Arc<IssueChat>>) -> Arc<Self> {
        let mut dispatches = channel.dispatches();
        let mut removals = channel.subscribe_removals();
        let cancel = ctx.task.child_token();
        let sc = Arc::new(Self {
            board: board.clone(),
            channel: channel.clone(),
            cancel: cancel.clone(),
            coordinator: Mutex::new(None),
            lanes: KeyedLaneQueue::new(cancel.clone()),
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
                    res = dispatches.recv() => match res {
                        Some(dispatched) => CoordinatorEvent::Dispatched(dispatched),
                        None => CoordinatorEvent::Stop,
                    },
                    res = removals.recv() => match res {
                        Ok(message_id) => CoordinatorEvent::Removed(message_id),
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "session_chat removals broadcast lagged; skipped message removals");
                            CoordinatorEvent::Ignore
                        }
                        Err(broadcast::error::RecvError::Closed) => CoordinatorEvent::Stop,
                    },
                    res = session_events.recv() => match res {
                        Ok(ev) => CoordinatorEvent::Lifecycle(ev),
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "session_chat lifecycle broadcast lagged; resyncing seats");
                            CoordinatorEvent::LaggedLifecycle
                        }
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
        self.lanes.close_async(&self.coordinator, "session-chat").await;
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
        match self.channel.pending_deliveries_async(DeliveryTargetKind::Direct).await {
            Ok(pending) => {
                for d in pending {
                    self.enqueue_lane(d.recipient_id.clone(), DirectWake { delivery: d, committed: None });
                }
            }
            Err(err) => {
                tracing::warn!(error = %err, "session_chat failed to load pending direct deliveries on boot");
            }
        }
    }

    async fn withdraw_message_mailbox_async(&self, message_id: &str) {
        if let Err(err) = self.board.session_engine().withdraw_mailbox_by_message_async(message_id).await {
            tracing::warn!(message_id, error = %err, "session_chat failed to withdraw removed message mailbox");
        }
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
                if let Err(err) = sessions
                    .enqueue_mailbox_async(
                        &mailbox_owner,
                        &key,
                        MailboxSource::ChannelDirect,
                        Some(&d.message_id),
                        &dispatched.committed.row.body,
                    )
                    .await
                {
                    tracing::warn!(recipient_id = %d.recipient_id, message_id = %d.message_id, error = %err, "session_chat failed to enqueue direct mailbox");
                }
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
        let sc = Arc::downgrade(self);
        self.lanes.enqueue(agent_id, wake, move |item| {
            let sc = sc.clone();
            async move {
                if let Some(sc) = sc.upgrade() {
                    sc.on_direct_async(item).await;
                }
            }
        });
    }

    async fn on_direct_async(&self, wake: DirectWake) {
        let d = wake.delivery;
        let mail_key = direct_mail_key(&d.recipient_id, &d.message_id);
        let sessions = self.board.session_engine();
        if !self.channel.delivery_is_pending_async(d.id).await.unwrap_or(false) {
            if let Err(err) = sessions.withdraw_mailbox_async(&mail_key).await {
                tracing::warn!(delivery_id = d.id, mail_key = %mail_key, error = %err, "session_chat failed to withdraw non-pending direct mailbox");
            }
            return;
        }
        let c = match wake.committed {
            Some(c) => Some(c),
            None => match self.channel.committed_of_async(&d.message_id).await {
                Ok(found) => found.map(Arc::new),
                Err(err) => {
                    tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "session_chat failed to load committed direct message");
                    None
                }
            },
        };
        let Some(c) = c else {
            if let Err(err) = sessions.withdraw_mailbox_async(&mail_key).await {
                tracing::warn!(delivery_id = d.id, mail_key = %mail_key, error = %err, "session_chat failed to withdraw missing-message direct mailbox");
            }
            if let Err(err) = self.channel.withdraw_delivery_async(d.id).await {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "session_chat failed to withdraw missing-message direct delivery");
            }
            return;
        };
        if c.row.deleted_at.is_some() {
            if let Err(err) = sessions.withdraw_mailbox_async(&mail_key).await {
                tracing::warn!(delivery_id = d.id, mail_key = %mail_key, error = %err, "session_chat failed to withdraw deleted-message direct mailbox");
            }
            if let Err(err) = self.channel.withdraw_delivery_async(d.id).await {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "session_chat failed to withdraw deleted-message direct delivery");
            }
            return;
        }
        let mailbox_owner = sessions
            .talker_async(&d.recipient_id, &d.channel_id)
            .await
            .map(|s| s.id)
            .unwrap_or_else(|| format!("profile:{}", d.recipient_id));
        let mail_entry = match sessions
            .enqueue_mailbox_async(&mailbox_owner, &mail_key, MailboxSource::ChannelDirect, Some(&d.message_id), &c.row.body)
            .await
        {
            Ok(entry) => Some(entry),
            Err(err) => {
                tracing::warn!(delivery_id = d.id, mail_key = %mail_key, error = %err, "session_chat failed to upsert direct mailbox entry");
                None
            }
        };
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
            Some(vc) => format!("{}\n{}", format_note_view_context(&vc), c.row.body),
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
                if let Some(id) = settle_id
                    && let Err(err) = sessions.settle_mailbox_async(id, true, Some(&sid)).await
                {
                    tracing::warn!(delivery_id = d.id, mailbox_id = id, error = %err, "session_chat failed to settle direct mailbox");
                }
                if let Err(err) = self.channel.settle_delivery_async(d.id, true).await {
                    tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "session_chat failed to settle direct delivery");
                }
                return;
            }
            TalkOutcome::Err(why) => why,
        };
        if let Some(id) = settle_id
            && let Err(err) = sessions.settle_mailbox_async(id, false, Some(&why)).await
        {
            tracing::warn!(delivery_id = d.id, mailbox_id = id, error = %err, "session_chat failed to mark failed direct mailbox");
        }
        if let Err(err) = self.channel.settle_delivery_async(d.id, false).await {
            tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "session_chat failed to mark failed direct delivery");
        }
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
