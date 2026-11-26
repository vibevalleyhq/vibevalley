use std::sync::Arc;
use std::sync::atomic::Ordering;

use vibevalley_protocol::{Actor, ChannelType};

use super::state::Orchestrator;
use super::types::Input;
use super::words;
use super::words::Source;
use crate::BoxFuture;
use crate::agent::profile::text;
use crate::channel::{Chat, Committed, DeliveryTargetKind, QueuedDelivery, actor_of, meta_of};
use crate::context::text::format_artifact_view_context;
use crate::service::session::{MailboxSource, MailboxStatus};

pub(super) trait ChatIntake: Send + Sync {
    fn hear_async(&self, input: Input) -> BoxFuture<'_, bool>;
    fn overhear(&self, agent: Option<&str>, line: String);
}

impl Orchestrator {
    /// Subscribes to orchestrator-targeted deliveries from `self.chat` on `ctx.task`
    /// (plus replays any pending deliveries left from a prior process).
    pub(super) fn start_chat_listener(self: &Arc<Self>, intake: Arc<dyn ChatIntake>) {
        let mut dispatches = self.chat.dispatches();
        let o = Arc::downgrade(self);
        let chat = self.chat.clone();
        let cancel = self.ctx.task.child_token();
        let task_cancel = cancel.clone();
        let handle = self.ctx.spawn("orchestrator.chat_listener", async move {
            if let Some(o) = o.upgrade()
                && let Ok(pending) = chat.pending_deliveries_async(DeliveryTargetKind::Orchestrator).await
            {
                for d in pending {
                    if o.closed.load(Ordering::Acquire) {
                        return;
                    }
                    o.handle_chat_delivery_async(intake.as_ref(), &chat, &d, None).await;
                }
            }
            loop {
                let dispatched = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = dispatches.recv() => match res {
                        Some(dispatched) => dispatched,
                        None => return,
                    },
                };
                let Some(o) = o.upgrade() else { return };
                if o.closed.load(Ordering::Acquire) {
                    return;
                }
                for d in &dispatched.deliveries {
                    if d.recipient_kind == DeliveryTargetKind::Orchestrator {
                        o.handle_chat_delivery_async(intake.as_ref(), &chat, d, Some(&dispatched.committed)).await;
                    }
                }
            }
        });
        let prev = self.chat_listener.lock().replace((cancel, handle));
        if let Some((old_cancel, old_handle)) = prev {
            old_cancel.cancel();
            self.ctx.spawn("orchestrator.chat_listener_drain", async move {
                let _ = old_handle.await;
            });
        }
    }

    async fn handle_chat_delivery_async(self: &Arc<Self>, intake: &dyn ChatIntake, chat: &Chat, d: &QueuedDelivery, committed: Option<&Arc<Committed>>) {
        const HANDED_EMOJI: &str = "👀";
        let sessions = &self.ctx.service.session;
        let now_ms = self.ctx.now();
        let is_pending = match chat.delivery_is_pending_async(d.id).await {
            Ok(pending) => pending,
            Err(err) => {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err.message, "orchestrator.chat delivery_is_pending failed");
                false
            }
        };
        if !is_pending {
            if let Err(err) = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "orchestrator.chat withdraw_mailbox_by_message failed");
            }
            return;
        }
        if !self.profile.is_orchestrator(&d.recipient_id) {
            if let Err(err) = chat.settle_delivery_async(d.id, false).await {
                tracing::warn!(delivery_id = d.id, recipient = %d.recipient_id, error = %err.message, "orchestrator.chat settle_delivery failed");
            }
            return;
        }
        let owned;
        let c = match committed {
            Some(c) => c.as_ref(),
            None => match chat.committed_of_async(&d.message_id).await {
                Ok(Some(c)) => {
                    owned = c;
                    &owned
                }
                Ok(None) => {
                    if let Err(err) = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await {
                        tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "orchestrator.chat withdraw_mailbox_by_message failed");
                    }
                    if let Err(err) = chat.withdraw_delivery_async(d.id).await {
                        tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err.message, "orchestrator.chat withdraw_delivery failed");
                    }
                    return;
                }
                Err(err) => {
                    tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err.message, "orchestrator.chat committed_of failed");
                    if let Err(err) = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await {
                        tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "orchestrator.chat withdraw_mailbox_by_message failed");
                    }
                    if let Err(err) = chat.withdraw_delivery_async(d.id).await {
                        tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err.message, "orchestrator.chat withdraw_delivery failed");
                    }
                    return;
                }
            },
        };
        if c.row.deleted_at.is_some() {
            if let Err(err) = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err, "orchestrator.chat withdraw_mailbox_by_message failed");
            }
            if let Err(err) = chat.withdraw_delivery_async(d.id).await {
                tracing::warn!(delivery_id = d.id, message_id = %d.message_id, error = %err.message, "orchestrator.chat withdraw_delivery failed");
            }
            return;
        }
        let m = chat.addressed_of(&c.row);
        let line = words::orchestrator_lines(std::slice::from_ref(&m));
        if !d.wakes {
            intake.overhear(Some(&d.recipient_id), line);
            if let Err(err) = chat.settle_delivery_async(d.id, true).await {
                tracing::warn!(delivery_id = d.id, recipient = %d.recipient_id, error = %err.message, "orchestrator.chat settle_delivery failed");
            }
            return;
        }
        let mail_key = format!("orchestrator:{}:{}", d.recipient_id, d.message_id);
        let mail_entry = match sessions
            .enqueue_mailbox(
                &d.recipient_id,
                &mail_key,
                MailboxSource::ChannelOrchestrator,
                Some(&d.message_id),
                &c.row.body,
                now_ms,
            )
            .await
        {
            Ok(entry) => Some(entry),
            Err(err) => {
                tracing::warn!(mail_key = %mail_key, error = %err, "orchestrator.chat enqueue_mailbox failed");
                None
            }
        };
        let claimed = match sessions.claim_mailbox_by_key(&mail_key, now_ms).await {
            Ok(claimed) => claimed,
            Err(err) => {
                tracing::warn!(mail_key = %mail_key, error = %err, "orchestrator.chat claim_mailbox_by_key failed");
                false
            }
        };
        if !claimed
            && mail_entry
                .as_ref()
                .is_some_and(|e| matches!(e.status, MailboxStatus::Withdrawn | MailboxStatus::Done | MailboxStatus::Claimed))
        {
            return;
        }
        let settle_id = mail_entry.as_ref().map(|e| e.id);
        let actor = actor_of(&c.row.sender_kind, c.row.sender_agent.as_deref(), &c.row.sender_id, Some(&c.row.sender_name));
        let meta = meta_of(c.row.meta.as_deref());
        let from_user = matches!(actor, Actor::User { .. });
        let mut picked_note = String::new();
        if let Some(p) = &meta.picked {
            if let Some(a) = p.agent.as_deref().and_then(|a| self.profile.agent(a)) {
                picked_note += &words::picked_agent(&a.name);
            }
            if let Some(r) = &p.repo {
                picked_note += &words::picked_repo(r);
            }
        }
        let view_note = meta
            .view_context
            .as_ref()
            .filter(|_| c.row.deleted_at.is_none())
            .map(|vc| format!("{}\n", format_artifact_view_context(vc)))
            .unwrap_or_default();
        let command_note = meta
            .command
            .as_ref()
            .filter(|cmd| !cmd.name.trim().is_empty())
            .map(|cmd| words::command_note(cmd.name.trim(), cmd.args.trim()))
            .unwrap_or_default();
        let text = c.row.body.trim();
        let said = match meta.voice_mode.as_deref() {
            Some("dictated") => format!("{picked_note}{view_note}{command_note}{}{}", words::DICTATED, words::user_line(text)),
            Some("conversation") => format!("{}\n{command_note}{}", text::PROMPTS.voice, words::user_line(text)),
            _ if from_user && (c.channel_type == ChannelType::Direct || c.row.channel_id == chat.default_channel()) => {
                format!("{picked_note}{view_note}{command_note}{}", words::user_line(text))
            }
            _ => format!("{picked_note}{command_note}{}", words::chat_line(&m.target, &line)),
        };
        let input = Input {
            agent: Some(d.recipient_id.clone()),
            channel: c.row.channel_id.clone(),
            source: if from_user { Source::User } else { Source::Chat },
            line: said,
            user: from_user,
            picked: meta.picked.clone(),
            messages: vec![c.row.id.clone()],
            port: meta.response_port.clone(),
        };
        let heard = intake.hear_async(input).await;
        if heard {
            if let Some(id) = settle_id
                && let Err(err) = sessions.settle_mailbox(id, true, Some(&d.recipient_id), self.ctx.now()).await
            {
                tracing::warn!(mailbox_id = id, recipient = %d.recipient_id, error = %err, "orchestrator.chat settle_mailbox failed");
            }
            if let Err(err) = chat.settle_delivery_async(d.id, true).await {
                tracing::warn!(delivery_id = d.id, recipient = %d.recipient_id, error = %err.message, "orchestrator.chat settle_delivery failed");
            }
            if let Err(e) = chat.react_async(&c.row.id, &d.recipient_id, HANDED_EMOJI, true).await {
                tracing::warn!(message_id = %c.row.id, recipient = %d.recipient_id, error = %e.message, "orchestrator.chat react 👀 failed");
            }
        } else if !self.closed.load(Ordering::Acquire) {
            if let Some(id) = settle_id
                && let Err(err) = sessions.settle_mailbox(id, false, Some("rejected"), self.ctx.now()).await
            {
                tracing::warn!(mailbox_id = id, recipient = %d.recipient_id, error = %err, "orchestrator.chat settle_mailbox failed");
            }
            if let Err(err) = chat.settle_delivery_async(d.id, false).await {
                tracing::warn!(delivery_id = d.id, recipient = %d.recipient_id, error = %err.message, "orchestrator.chat settle_delivery failed");
            }
        }
    }
}
