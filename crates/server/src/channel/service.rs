use std::sync::{Arc, Weak};

use arc_swap::{ArcSwap, Guard as SnapshotGuard};
use parking_lot::RwLock;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard, broadcast};
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ChatMessage, DEFAULT_ORCHESTRATOR, Embed, ParticipantId, SubjectKind, UserMention};

use super::dispatch;
use super::model::{ChatModel, Inner, Q, WriteTx};
use super::types::{
    CHANNEL_EVENT_CAPACITY, ChannelDispatched, ChannelEvent, ChannelMessageEvent, FIRST_CHANNEL, HeldBy, KEEP_CHANNELS, Noticing, QueuedDelivery, Reach,
    ThreadSubject, Write, Written, local_user_id, meta_of, meta_text, new_id, refused, to_message,
};
use super::words::{self, ChatTarget};
use crate::context::{AsyncRequestKeys, Context, LookIn, internal, missing, now};
use crate::service::channel::{EventRow, MsgRow, NewDelivery, NewMessage, ParticipantRow};
use crate::storage::Storage;

type Seater = Arc<dyn Fn(&str) + Send + Sync>;

/// The chat domain service.
pub struct Chat {
    pub(super) ctx: Arc<Context>,
    pub(super) storage: Arc<Storage>,
    /// Lock-free atomic snapshot of the committed in-memory [`ChatModel`],
    /// used by read-only queries alongside `ctx.service.channel`
    /// without contending on `inner`.
    pub(super) snapshot: Arc<ArcSwap<ChatModel>>,
    /// Write-side async lock serializing transactions and protecting `reach`.
    inner: AsyncMutex<Inner>,
    /// Idempotency gate for `channel.thread.create` (`request_key`).
    pub(super) thread_keys: AsyncRequestKeys<String>,
    me: Weak<Chat>,
    pub(super) events: broadcast::Sender<ChannelEvent>,
    pub(super) removals: broadcast::Sender<String>,
    message_events: broadcast::Sender<ChannelMessageEvent>,
    pub(super) dispatches: broadcast::Sender<ChannelDispatched>,
    pub(super) seaters: RwLock<Vec<Seater>>,
    /// Link previews are read off the web; tests turn it off.
    embeds: bool,
}

impl Chat {
    /// Opens the chat service on `ctx.service.channel`: ensures `user:self`, `system`,
    /// the default orchestrator, and `#general` exist, then loads [`ChatModel`].
    pub async fn open_async(ctx: Arc<Context>, storage: Arc<Storage>, embeds: bool) -> Result<Arc<Chat>, ApiError> {
        let at = now();
        let channels = &ctx.service.channel;
        let local_user = local_user_id();
        for (id, kind, name) in [
            (local_user.as_str(), "user", t("server.channel.name.user", &[])),
            ("system", "system", "VibeValley".to_string()),
        ] {
            channels
                .upsert_participant(&ParticipantRow {
                    id: id.into(),
                    kind: kind.into(),
                    name,
                    agent_id: None,
                    home_id: None,
                    joined_at: at,
                    left_at: None,
                })
                .await
                .q()?;
        }
        channels
            .add_participant(DEFAULT_ORCHESTRATOR, "agent", &t("server.channel.name.orchestrator", &[]), at)
            .await
            .q()?;
        if channels.default_id().await.q()?.is_none() {
            let id = new_id();
            channels.create_channel(&id, true, FIRST_CHANNEL, None, None, at).await.q()?;
            channels.add_member(&id, DEFAULT_ORCHESTRATOR, "manual", 0).await.q()?;
        }
        let mut model = ChatModel::default();
        model.load(
            channels.all_channels().await.q()?,
            channels.participants().await.q()?,
            channels.read_cursors_of(&local_user).await.q()?,
            &channels.all_members().await.q()?,
        );
        let snapshot = Arc::new(ArcSwap::from_pointee(model.clone()));
        let (events, _events_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (removals, _removals_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (message_events, _message_events_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (dispatches, _dispatches_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        Ok(Arc::new_cyclic(|me| Chat {
            ctx,
            storage,
            snapshot: snapshot.clone(),
            inner: AsyncMutex::new(Inner {
                model,
                reach: Reach::default(),
                snapshot,
            }),
            thread_keys: AsyncRequestKeys::default(),
            me: me.clone(),
            events,
            removals,
            message_events,
            dispatches,
            seaters: RwLock::default(),
            embeds,
        }))
    }

    pub fn context(&self) -> &Arc<Context> {
        &self.ctx
    }

    pub fn subscribe_message_events(&self) -> broadcast::Receiver<ChannelMessageEvent> {
        self.message_events.subscribe()
    }

    /// Projects committed channels snapshot for `SliceMask::BOARD` and diagnostics.
    pub async fn channels_snapshot_async(&self) -> Result<Vec<vibevalley_protocol::Channel>, ApiError> {
        let model = self.model();
        let channels_svc = &self.ctx.service.channel;
        let mut recent = channels_svc.recent_channels(KEEP_CHANNELS).await.q()?;
        recent.reverse();
        let mut channels = Vec::with_capacity(recent.len());
        for c in &recent {
            let mut ch = model.counted_async(channels_svc, c).await?;
            if let Some(published) = model.published_number(&ch.id)
                && ch.last_number.unwrap_or(0) > published
            {
                ch.last_number = Some(published);
            }
            channels.push(ch);
        }
        Ok(channels)
    }

    /// Projects the channel list + user mentions bundle for `SliceMask::COLLAB` / `state.get`.
    pub async fn slice_chat_async(&self) -> Result<vibevalley_protocol::Chat, ApiError> {
        let channels = self.channels_snapshot_async().await?;
        let user_mentions = self.user_mentions_snapshot_async().await?;
        Ok(vibevalley_protocol::Chat { channels, user_mentions })
    }

    /// Projects active `@user` mentions for `SliceMask::INBOX` and `collab.chat`.
    pub async fn user_mentions_snapshot_async(&self) -> Result<Vec<UserMention>, ApiError> {
        self.user_mentions_for_async(&ParticipantId::local_user()).await
    }

    /// Projects active `@mention` inbox items for a specific human participant.
    pub async fn user_mentions_for_async(&self, viewer: &ParticipantId) -> Result<Vec<UserMention>, ApiError> {
        let model = self.model();
        let quiet = |id: &str| model.channel(id).is_some_and(|c| c.notify == "none");
        let rows = self.ctx.service.channel.user_mentions(&viewer.to_string()).await.q()?;
        Ok(rows
            .into_iter()
            .filter(|r| !quiet(&r.row.channel_id) && !quiet(&r.top_id))
            .map(|r| UserMention {
                message: to_message(&r.row),
                channel: r.top_id.clone(),
                address: model.target_of_row(&r.channel_type, r.root_number, None, Some(&r.top_id), Some(&r.channel_name)),
            })
            .collect())
    }

    pub(super) fn emit_event(&self, event: ChannelEvent) {
        match &event {
            ChannelEvent::Removed { event: ev, .. } => {
                let _ = self.removals.send(ev.message_id.clone());
            }
            ChannelEvent::Edited(message) => {
                let _ = self.message_events.send(ChannelMessageEvent::Edited(message.clone()));
            }
            ChannelEvent::Posted(_) | ChannelEvent::Reacted(_) | ChannelEvent::Pinned(_) | ChannelEvent::UserRead { .. } => {}
        }
        let _ = self.events.send(event);
    }

    pub(super) async fn locked(&self) -> AsyncMutexGuard<'_, Inner> {
        self.inner.lock().await
    }

    pub(super) fn model(&self) -> SnapshotGuard<Arc<ChatModel>> {
        self.snapshot.load()
    }

    /// Marks `SliceMask::COLLAB` dirty after a channel mutation commits.
    pub(super) async fn publish_channel_async(&self, _model: &ChatModel, _id: &str) -> Result<(), ApiError> {
        self.ctx.mark_dirty(SliceMask::COLLAB);
        Ok(())
    }

    /// Marks `SliceMask::COLLAB | SliceMask::INBOX` dirty after user mention / read-cursor changes.
    pub(super) async fn publish_user_mentions_async(&self, _model: &ChatModel) -> Result<(), ApiError> {
        self.ctx.mark_dirty(SliceMask::COLLAB | SliceMask::INBOX);
        Ok(())
    }

    fn publish_message(&self, inner: &mut Inner, row: &MsgRow, answers: Option<String>) {
        let ch = inner.model.channel(&row.channel_id);
        let thread = ch
            .filter(|c| c.r#type != "channel" && c.subject_kind.as_deref() == Some("issue"))
            .and_then(|c| c.subject_id.clone());
        let message = to_message(row);
        let has_user_mention = message.mentions.iter().any(|m| ParticipantId::parse(m).is_some_and(|p| p.is_human()));
        let _ = self.message_events.send(ChannelMessageEvent::Posted {
            message,
            thread_issue_id: thread,
            answers,
        });
        inner.model.note_published(&row.channel_id, row.number);
        inner.publish_snapshot();
        let mask = if has_user_mention {
            SliceMask::COLLAB | SliceMask::INBOX
        } else {
            SliceMask::COLLAB
        };
        self.ctx.mark_dirty(mask);
    }

    /// `readThrough`: a read that moves the cursor; a human's is broadcast.
    pub(super) async fn read_through_async(&self, inner: &mut Inner, who: &str, channel: &str, upto: i64) -> Result<(), ApiError> {
        let at = now();
        let is_human = ParticipantId::parse(who).is_some_and(|p| p.is_human());
        {
            let mut wtx = WriteTx::begin(inner, &self.ctx.service).await?;
            wtx.set_read(who, channel, upto, at).await?;
            if is_human {
                let events = self.events.clone();
                let ch = channel.to_string();
                wtx.hooks.on_commit(move || {
                    let _ = events.send(ChannelEvent::UserRead { channel: ch, upto, at });
                });
            }
            wtx.commit().await?;
        }
        if is_human {
            self.publish_user_mentions_async(&inner.model).await?;
        }
        Ok(())
    }

    /// Reads back the committed row after a message mutation and publishes its updated channel summary.
    pub(super) async fn finish_message_change_async(&self, model: &ChatModel, row: &MsgRow) -> Result<ChatMessage, ApiError> {
        let updated = self.ctx.service.channel.message_by_id(&row.id).await.q()?;
        let message = to_message(updated.as_ref().unwrap_or(row));
        self.publish_channel_async(model, &row.channel_id).await?;
        Ok(message)
    }

    pub(super) async fn answered_async(&self, channel: &str, number: Option<i64>) -> Result<(), ApiError> {
        if let Some(n) = number
            && self.ctx.service.channel.message_by_number(channel, n).await.q()?.is_none()
        {
            return Err(refused(t("server.channel.noMessage", &[("n", n.into())])));
        }
        Ok(())
    }

    /// `resolveTarget`: an address as `who` would mean it.
    pub(super) async fn resolve_target_async(&self, inner: &mut Inner, who: &str, target: &str) -> Result<(String, Option<String>), ApiError> {
        if target.trim().is_empty() {
            return Ok((inner.model.home_of(who).unwrap_or_else(|| inner.model.default_id()), None));
        }
        let parsed = words::parse_chat_target(target).ok_or_else(|| refused(t("server.channel.badTarget", &[("target", target.into())])))?;
        let root = match parsed {
            ChatTarget::Direct(peer) => {
                let direct = inner
                    .model
                    .direct_with(who, &peer)
                    .ok_or_else(|| refused(t("server.channel.noDirect", &[("target", target.trim().into())])))?;
                return Ok((direct.id, None));
            }
            ChatTarget::Channel(_) => None,
            ChatTarget::Thread(n) => Some(n),
        };
        let trimmed = target.trim();
        let text = trimmed.strip_prefix('#').unwrap_or(trimmed);
        let name = text.split(':').next().unwrap_or("");
        let mut channel = inner.model.default_id();
        if !name.is_empty() {
            let found = inner.model.channel_by_name(name).ok_or_else(|| {
                missing(
                    t(
                        "server.channel.noChannelNamed",
                        &[("name", name.into()), ("tags", inner.model.channel_tags().into())],
                    ),
                    LookIn::Channel,
                )
            })?;
            channel = found.id.clone();
        }
        let Some(root) = root else { return Ok((channel, None)) };
        let row = self
            .ctx
            .service
            .channel
            .message_by_number(&channel, root)
            .await
            .q()?
            .ok_or_else(|| refused(t("server.channel.noMessage", &[("n", root.into())])))?;
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = {
            let mut wtx = WriteTx::begin(inner, &self.ctx.service).await?;
            let id = wtx.thread_for(&row.id, row.number, &row.channel_id, &talk).await?;
            wtx.commit().await?;
            id
        };
        Ok((thread.clone(), Some(thread)))
    }

    /// `write`, under the lock: the message, its event, who it names and
    /// follows, the state told; the readers are told after the commit.
    pub(super) async fn write_async(&self, inner: &mut Inner, w: Write) -> Result<Written, ApiError> {
        let written = {
            let mut wtx = WriteTx::begin(inner, &self.ctx.service).await?;
            let channels = &self.ctx.service.channel;
            if let Some(key) = w.send_key.as_deref().filter(|k| !k.is_empty())
                && let Some(seen) = channels.message_by_send_key_in_tx(&wtx.tx, &w.from, key).await.q()?
            {
                wtx.commit().await?;
                Written {
                    absent: vec![],
                    answers: None,
                    thread: String::new(),
                    again: true,
                    row: seen,
                    event: None,
                    hop_limit_hit: false,
                }
            } else {
                let sender = wtx
                    .model
                    .participant(&w.from)
                    .cloned()
                    .ok_or_else(|| internal(format!("no participant {}", w.from)))?;
                let id = new_id();
                let system_code = w.meta.as_ref().and_then(|m| m.code.as_deref()).filter(|c| !c.is_empty()).map(str::to_owned);
                let meta = meta_text(w.meta.as_ref());
                let at = now();
                let send_key = w.send_key.clone().filter(|k| !k.is_empty());
                let revision = channels.bump_revision_in_tx(&wtx.tx, &w.channel).await.q()?;
                let number = channels
                    .insert_message_in_tx(
                        &wtx.tx,
                        &NewMessage {
                            id: &id,
                            channel_id: &w.channel,
                            sender: &w.from,
                            kind: w.kind.as_str(),
                            body: &w.text,
                            meta: meta.as_deref(),
                            system_code: system_code.as_deref(),
                            send_key: send_key.as_deref(),
                            at,
                            revision,
                            reply_number: w.reply_to,
                        },
                    )
                    .await
                    .q()?;
                wtx.touch_channel(&w.channel, number).await?;
                let seq = channels.insert_event_in_tx(&wtx.tx, "posted", &w.channel, &id, at).await.q()?;
                let inserted = MsgRow {
                    id: id.clone(),
                    channel_id: w.channel.clone(),
                    number,
                    sender_id: w.from.clone(),
                    kind: w.kind.as_str().into(),
                    body: w.text.clone(),
                    meta,
                    send_key,
                    created_at: at,
                    revision,
                    reply_number: w.reply_to,
                    edited_at: None,
                    deleted_at: None,
                    pinned_at: None,
                    reactions: None,
                    sender_name: sender.name,
                    sender_kind: sender.kind,
                    sender_agent: sender.agent_id,
                };
                let (row, absent) = wtx.settle(inserted).await?;
                if let Some(by) = &w.read_by {
                    wtx.set_read(by, &w.channel, number, now()).await?;
                }
                if let Some(member) = &w.member {
                    wtx.add_member(&w.channel, member, "user", number).await?;
                }
                let thread = match &w.thread {
                    Some(subject) => wtx.thread_for(&id, number, &w.channel, subject).await?,
                    None => String::new(),
                };
                let event = EventRow {
                    seq,
                    kind: "posted".into(),
                    channel_id: w.channel.clone(),
                    message_id: id,
                    at,
                };
                let hop_limit_hit = if row.kind != "notice"
                    && let Some(posted) = wtx.committed_from(&row, &event)
                {
                    let plan = dispatch::plan_deliveries(&wtx.model, &mut wtx.reach, &posted, at);
                    let mut queued = Vec::with_capacity(plan.deliveries.len());
                    for d in plan.deliveries {
                        let did = channels
                            .insert_delivery_in_tx(
                                &wtx.tx,
                                &NewDelivery {
                                    message_id: &row.id,
                                    channel_id: &row.channel_id,
                                    recipient_kind: d.recipient.kind_str(),
                                    recipient_id: d.recipient.raw_id(),
                                    reason: d.reason.as_str(),
                                    wakes: d.wakes,
                                    held_by: d.held_by.map(HeldBy::as_str),
                                    at,
                                },
                            )
                            .await
                            .q()?;
                        queued.push(QueuedDelivery {
                            id: did,
                            message_id: row.id.clone(),
                            channel_id: row.channel_id.clone(),
                            recipient: d.recipient,
                            reason: d.reason,
                            wakes: d.wakes,
                            held_by: d.held_by,
                        });
                    }
                    if !queued.is_empty() {
                        let dispatches = self.dispatches.clone();
                        let dispatched = ChannelDispatched {
                            committed: Arc::new(posted),
                            deliveries: queued.clone(),
                        };
                        wtx.hooks.on_commit(move || {
                            let _ = dispatches.send(dispatched);
                        });
                    }
                    plan.hop_limit_hit
                } else {
                    false
                };
                wtx.commit().await?;
                Written {
                    absent,
                    answers: None,
                    thread,
                    again: false,
                    row,
                    event: Some(event),
                    hop_limit_hit,
                }
            }
        };
        if written.again {
            return Ok(written);
        }
        let Some(event) = written.event.clone() else { return Ok(written) };
        let answers = inner.model.answers_of_async(&self.ctx.service.channel, &written.row).await?;
        let written = Written { answers, ..written };
        self.publish_message(inner, &written.row, written.answers.clone());
        self.embed_later(&written.row);
        self.publish_channel_async(&inner.model, &w.channel).await?;
        let meta = meta_of(written.row.meta.as_deref());
        let human_touched = written.row.sender_kind == "user"
            || meta
                .mentions
                .is_some_and(|m| m.iter().any(|x| ParticipantId::parse(x).is_some_and(|p| p.is_human())));
        if human_touched {
            self.publish_user_mentions_async(&inner.model).await?;
        }
        if !written.thread.is_empty() {
            self.publish_channel_async(&inner.model, &written.thread).await?;
        }
        if let Some(posted) = inner.model.committed_from(&written.row, &event) {
            self.emit_event(ChannelEvent::Posted(Box::new(posted)));
        }
        if written.hop_limit_hit {
            Box::pin(self.notice_locked_async(
                inner,
                Noticing {
                    channel: w.channel,
                    text: t("server.channel.hopLimit", &[("limit", dispatch::HOP_LIMIT.into())]),
                    code: "hop_limit".into(),
                    until_user_speaks: true,
                    ..Noticing::default()
                },
            ))
            .await;
        }
        Ok(written)
    }

    /// `embedLater`: a message's link previews, read asynchronously after it
    /// is out and then put on it as a change without occupying a blocking thread.
    pub(super) fn embed_later(&self, row: &MsgRow) {
        if !self.embeds || row.kind != "chat" || row.deleted_at.is_some() {
            return;
        }
        let links = words::links_in(&row.body);
        if links.is_empty() {
            return;
        }
        let me = self.me.clone();
        let row = row.clone();
        let cancel = self.ctx.task.child_token();
        let fut = async move {
            let mut found: Vec<Embed> = Vec::new();
            for link in &links {
                if cancel.is_cancelled() {
                    return;
                }
                let maybe = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    embed = words::read_embed_async(link) => embed,
                };
                if let Some(embed) = maybe {
                    found.push(embed);
                }
            }
            if cancel.is_cancelled() {
                return;
            }
            let Some(chat) = me.upgrade() else { return };
            let mut inner = chat.locked().await;
            let Ok(Some(current)) = chat.ctx.service.channel.message_by_id(&row.id).await else {
                return;
            };
            // Changed meanwhile: its words are not the ones read.
            if current.deleted_at.is_some() || current.body != row.body {
                return;
            }
            let mut meta = meta_of(current.meta.as_deref());
            if found.is_empty() && meta.embeds.is_none() {
                return;
            }
            meta.embeds = Some(found);
            let text = meta_text(Some(&meta));
            let committed = {
                let Ok(wtx) = WriteTx::begin(&mut inner, &chat.ctx.service).await else {
                    return;
                };
                let channels = &chat.ctx.service.channel;
                let Ok(revision) = channels.bump_revision_in_tx(&wtx.tx, &current.channel_id).await else {
                    return;
                };
                if channels.set_meta_in_tx(&wtx.tx, &current.id, text.as_deref(), revision).await.is_err() {
                    return;
                }
                wtx.commit().await.is_ok()
            };
            if committed && let Ok(message) = chat.finish_message_change_async(&inner.model, &current).await {
                chat.emit_event(ChannelEvent::Edited(message));
            }
        };
        self.ctx.spawn("channel.embed", fut);
    }

    /// Subscribes to removed message IDs without receiving other channel events.
    pub fn subscribe_removals(&self) -> broadcast::Receiver<String> {
        self.removals.subscribe()
    }
}
