//! The chat (田头): channels, threads and direct channels, numbered
//! messages, members, read cursors, pure audience/loop-guard dispatch policy,
//! and durable pending deliveries (`channel_delivery`) kept in `server.db`
//! with the places in memory (`model`), the state's `chat` kept by the four facts.
//!
//! Every message is written with a numbered event (`channel_event`) and its
//! synchronous `DeliveryPolicy` rows in one transaction; once committed,
//! [`Chat::subscribe_events`] and non-blocking [`Chat::dispatches`] notify
//! downstream consumers without blocking the writer.

pub mod db;
pub mod dispatch;
mod messages;
pub mod model;
mod rooms;
mod service;
mod store;
mod types;
pub mod words;

pub use dispatch::{ChannelDispatched, DeliveryTargetKind, HeldBy, QueuedDelivery, Reason};
pub use service::{direct_async, install, profile_id};
pub use store::Inner;
pub use types::{
    AddressedMessage, ArtifactRef, ChannelEvent, Committed, FileAt, Info, Made, Meta, Note, Noticing, Picked, Place, Posting, ReadOptions, ReadResult, Saying,
    Seat, Speaking, Spoken, ThreadSubject, actor_of, line_of, meta_of, meta_text, to_message,
};

use std::sync::{Arc, Weak};

use arc_swap::{ArcSwap, Guard as SnapshotGuard};
use parking_lot::{Mutex, RwLock};
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard, broadcast};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, ChatMessage, DEFAULT_ORCHESTRATOR, Embed, Fact, FactChannelChanged, FactMessageChanged, FactUserMentionsChanged, QuotedBlock,
    SubjectKind, USER_ID, UserMention,
};

use self::db::{EventRow, MsgRow, ParticipantRow};
use self::dispatch::Reach;
use self::model::ChatModel;
use self::store::{Q, WriteTx};
use self::types::{Write, Written, new_id};
use self::words::ChatTarget;
use crate::app::hub::ports::{ChannelAnnouncePort, ChannelQuotePort};
use crate::app::hub::refusal::{LookIn, internal, missing, refused as refuse};
use crate::content::attachment::AttachmentStore;
use crate::db::ServerDb;
use crate::{Hub, now};

const CHANNEL_EVENT_CAPACITY: usize = 1024;

/// The channel a new farm opens with.
const FIRST_CHANNEL: &str = "general";
/// The state keeps these many channels; the database keeps all.
pub const KEEP_CHANNELS: i64 = 100;
const THREAD_TITLE_MAX: usize = 24;
const LAST_MAX: usize = 80;
const SEARCH_MAX: i64 = 50;
const RETRY_WINDOW_MS: i64 = 60_000;
const HELD_SHOWN: usize = 3;
const READ_LIMIT: i64 = 30;
const SEND_KEY_MAX: usize = 64;
const CALLERS_MAX: i64 = 20;
/// A follower further behind than this is told to start again.
pub const CATCH_UP_MAX: usize = 200;
const LOG_KEEP: i64 = 80;
const NO_NUMBER: i64 = i32::MAX as i64;

fn refused(text: String) -> ApiError {
    refuse(BizCode::ChannelRefused, text)
}

fn no_channel(id: &str) -> ApiError {
    missing(t("server.channel.noChannel", &[("id", id.into())]), LookIn::Channel)
}

type Guard = Arc<dyn Fn(String) -> crate::BoxFuture<'static, Vec<String>> + Send + Sync>;
type Seater = Arc<dyn Fn(&str) + Send + Sync>;

/// The chat.
pub struct Chat {
    hub: Weak<Hub>,
    db: Arc<ServerDb>,
    files: Arc<AttachmentStore>,
    /// Lock-free atomic snapshot of the committed in-memory [`ChatModel`],
    /// used by read-only queries alongside [`ServerDb::read_conn`]
    /// without contending on `inner`.
    snapshot: Arc<ArcSwap<ChatModel>>,
    /// Write-side async lock serializing transactions and protecting `reach`.
    inner: AsyncMutex<Inner>,
    me: Weak<Chat>,
    events: broadcast::Sender<ChannelEvent>,
    removals: broadcast::Sender<String>,
    edited_messages: broadcast::Sender<ChatMessage>,
    dispatches: Mutex<Vec<flume::Sender<ChannelDispatched>>>,
    guards: RwLock<Vec<Guard>>,
    seaters: RwLock<Vec<Seater>>,
    /// Link previews are read off the web; tests turn it off.
    embeds: bool,
    /// The blocks a message quotes, injected at construction via [`ChannelQuotePort`].
    quoter: Option<Arc<dyn ChannelQuotePort>>,
}

fn publish<T: Clone>(to: &Mutex<Vec<flume::Sender<T>>>, value: &T) {
    to.lock().retain(|tx| tx.send(value.clone()).is_ok());
}

impl Chat {
    /// `makeChannelStore` + `makeChannelHub`: the user, the farm and the
    /// default orchestrator seated, `#general` made on a new farm, the
    /// places loaded, and the newest channels and the user's mentions put
    /// in the state.
    pub fn open(
        db: Arc<ServerDb>,
        hub: &Arc<Hub>,
        files: Arc<AttachmentStore>,
        quoter: Option<Arc<dyn ChannelQuotePort>>,
        embeds: bool,
    ) -> Result<Arc<Chat>, ApiError> {
        vibevalley_runtime::rt::block_on(Self::open_async(db, hub, files, quoter, embeds))
    }

    pub(in crate::collab) async fn open_async(
        db: Arc<ServerDb>,
        hub: &Arc<Hub>,
        files: Arc<AttachmentStore>,
        quoter: Option<Arc<dyn ChannelQuotePort>>,
        embeds: bool,
    ) -> Result<Arc<Chat>, ApiError> {
        let at = now();
        {
            let wconn = db.write_conn();
            for (id, kind, name) in [
                (USER_ID, "user", t("server.channel.name.user", &[])),
                ("system", "system", "VibeValley".to_string()),
            ] {
                db::upsert_participant(
                    wconn,
                    &ParticipantRow {
                        id: id.into(),
                        kind: kind.into(),
                        name,
                        agent_id: None,
                        home_id: None,
                        joined_at: at,
                        left_at: None,
                    },
                )
                .await
                .q()?;
            }
            db::add_participant(wconn, DEFAULT_ORCHESTRATOR, "agent", &t("server.channel.name.orchestrator", &[]), at)
                .await
                .q()?;
            if db::default_id(wconn).await.q()?.is_none() {
                let id = new_id();
                db::create_channel(wconn, &id, true, FIRST_CHANNEL, None, None, at).await.q()?;
                db::add_member(wconn, &id, DEFAULT_ORCHESTRATOR, "manual", 0).await.q()?;
            }
        }
        let mut model = ChatModel::default();
        {
            let rconn = db.read_conn();
            model.load(
                db::all_channels(rconn).await.q()?,
                db::participants(rconn).await.q()?,
                db::read_cursors_of(rconn, USER_ID).await.q()?,
                &db::all_members(rconn).await.q()?,
            );
        }
        let snapshot = Arc::new(ArcSwap::from_pointee(model.clone()));
        let (events, _events_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (removals, _removals_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (edited_messages, _edited_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let chat = Arc::new_cyclic(|me| Chat {
            hub: Arc::downgrade(hub),
            db,
            files,
            snapshot: snapshot.clone(),
            inner: AsyncMutex::new(Inner {
                model,
                reach: Reach::default(),
                snapshot,
            }),
            me: me.clone(),
            events,
            removals,
            edited_messages,
            dispatches: Mutex::default(),
            guards: RwLock::default(),
            seaters: RwLock::default(),
            embeds,
            quoter,
        });
        {
            let model = chat.model();
            let rconn = chat.db.read_conn();
            let mut recent = db::recent_channels(rconn, KEEP_CHANNELS).await.q()?;
            recent.reverse();
            let mut facts = vec![];
            for c in &recent {
                facts.push(Fact::ChannelChanged(FactChannelChanged {
                    at: now(),
                    channel: model.counted_async(rconn, c).await?,
                }));
            }
            hub.apply(facts);
            chat.publish_user_mentions_async(&model).await?;
        }
        Ok(chat)
    }

    fn apply(&self, facts: Vec<Fact>) {
        if let Some(hub) = self.hub.upgrade() {
            hub.apply(facts);
        }
    }

    fn emit_event(&self, event: ChannelEvent) {
        match &event {
            ChannelEvent::Removed { event: ev, .. } => {
                let _ = self.removals.send(ev.message_id.clone());
            }
            ChannelEvent::Edited(message) => {
                let _ = self.edited_messages.send(message.clone());
            }
            ChannelEvent::Posted(_) | ChannelEvent::Reacted(_) | ChannelEvent::Pinned(_) | ChannelEvent::UserRead { .. } => {}
        }
        let _ = self.events.send(event);
    }

    async fn locked(&self) -> AsyncMutexGuard<'_, Inner> {
        self.inner.lock().await
    }

    pub(super) fn model(&self) -> SnapshotGuard<Arc<ChatModel>> {
        self.snapshot.load()
    }

    /// `publishChannel`: the place as it stands into the state.
    async fn publish_channel_async(&self, model: &ChatModel, id: &str) -> Result<(), ApiError> {
        let Some(row) = model.channel(id) else { return Ok(()) };
        let mut channel = model.counted_async(self.db.read_conn(), row).await?;
        // A metadata change can read a message's number before the message's own fact is applied.
        if let Some(published) = model.published_number(id)
            && channel.last_number.unwrap_or(0) > published
        {
            channel.last_number = Some(published);
        }
        self.apply(vec![Fact::ChannelChanged(FactChannelChanged { at: now(), channel })]);
        Ok(())
    }

    async fn publish_user_mentions_async(&self, model: &ChatModel) -> Result<(), ApiError> {
        let quiet = |id: &str| model.channel(id).is_some_and(|c| c.notify == "none");
        let rows = db::user_mentions(self.db.read_conn()).await.q()?;
        let mentions = rows
            .into_iter()
            .filter(|r| !quiet(&r.row.channel_id) && !quiet(&r.top_id))
            .map(|r| UserMention {
                message: to_message(&r.row),
                channel: r.top_id.clone(),
                address: model.target_of_row(&r.channel_type, r.root_number, None, Some(&r.top_id), Some(&r.channel_name)),
            })
            .collect();
        self.apply(vec![Fact::UserMentionsChanged(FactUserMentionsChanged { at: now(), mentions })]);
        Ok(())
    }

    fn publish_message(&self, inner: &mut Inner, row: &MsgRow, answers: Option<String>) {
        let ch = inner.model.channel(&row.channel_id);
        let thread = ch
            .filter(|c| c.r#type != "channel" && c.subject_kind.as_deref() == Some("issue"))
            .and_then(|c| c.subject_id.clone());
        let message = to_message(row);
        self.apply(vec![Fact::MessageChanged(FactMessageChanged {
            at: now(),
            message,
            thread,
            answers,
        })]);
        inner.model.note_published(&row.channel_id, row.number);
        inner.publish_snapshot();
    }

    /// `readThrough`: a read that moves the cursor; the user's is told.
    async fn read_through_async(&self, inner: &mut Inner, who: &str, channel: &str, upto: i64) -> Result<(), ApiError> {
        let at = now();
        {
            let mut wtx = WriteTx::begin(inner, self.db.write_conn()).await?;
            wtx.set_read(who, channel, upto, at).await?;
            wtx.commit().await?;
        }
        if who == USER_ID {
            self.emit_event(ChannelEvent::UserRead {
                channel: channel.to_string(),
                upto,
                at,
            });
            self.publish_user_mentions_async(&inner.model).await?;
        }
        Ok(())
    }

    /// Reads back the committed row after a message mutation and publishes its updated channel summary.
    async fn finish_message_change_async(&self, model: &ChatModel, row: &MsgRow) -> Result<ChatMessage, ApiError> {
        let updated = db::message_by_id(self.db.read_conn(), &row.id).await.q()?;
        let message = to_message(updated.as_ref().unwrap_or(row));
        self.publish_channel_async(model, &row.channel_id).await?;
        Ok(message)
    }

    async fn answered_async(&self, channel: &str, number: Option<i64>) -> Result<(), ApiError> {
        if let Some(n) = number
            && db::message_by_number(self.db.read_conn(), channel, n).await.q()?.is_none()
        {
            return Err(refused(t("server.channel.noMessage", &[("n", n.into())])));
        }
        Ok(())
    }

    /// `resolveTarget`: an address as `who` would mean it.
    async fn resolve_target_async(&self, inner: &mut Inner, who: &str, target: &str) -> Result<(String, Option<String>), ApiError> {
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
        let row = db::message_by_number(self.db.read_conn(), &channel, root)
            .await
            .q()?
            .ok_or_else(|| refused(t("server.channel.noMessage", &[("n", root.into())])))?;
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = {
            let mut wtx = WriteTx::begin(inner, self.db.write_conn()).await?;
            let id = wtx.thread_for(&row.id, row.number, &row.channel_id, &talk).await?;
            wtx.commit().await?;
            id
        };
        Ok((thread.clone(), Some(thread)))
    }

    /// `write`, under the lock: the message, its event, who it names and
    /// follows, the state told; the readers are told after the commit.
    async fn write_async(&self, inner: &mut Inner, w: Write) -> Result<Written, ApiError> {
        let written = {
            let mut wtx = WriteTx::begin(inner, self.db.write_conn()).await?;
            if let Some(key) = w.send_key.as_deref().filter(|k| !k.is_empty())
                && let Some(seen) = db::message_by_send_key(&wtx.tx, &w.from, key).await.q()?
            {
                wtx.commit().await?;
                Written {
                    absent: vec![],
                    answers: None,
                    thread: String::new(),
                    again: true,
                    row: seen,
                    event: None,
                    deliveries: vec![],
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
                let revision = db::bump_revision(&wtx.tx, &w.channel).await.q()?;
                let number = db::insert_message(
                    &wtx.tx,
                    &id,
                    &w.channel,
                    &w.from,
                    w.kind.as_str(),
                    &w.text,
                    meta.as_deref(),
                    system_code.as_deref(),
                    send_key.as_deref(),
                    at,
                    revision,
                    w.reply_to,
                )
                .await
                .q()?;
                wtx.touch_channel(&w.channel, number).await?;
                let seq = db::insert_event(&wtx.tx, "posted", &w.channel, &id, at).await.q()?;
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
                let (deliveries, hop_limit_hit) = if row.kind != "notice"
                    && let Some(posted) = wtx.committed_from(&row, &event)
                {
                    let plan = dispatch::plan_deliveries(&wtx.model, &mut wtx.reach, &posted, at);
                    let mut queued = Vec::with_capacity(plan.deliveries.len());
                    for d in plan.deliveries {
                        let did = db::insert_delivery(
                            &wtx.tx,
                            &row.id,
                            &row.channel_id,
                            d.recipient_kind.as_str(),
                            &d.recipient_id,
                            d.reason.as_str(),
                            d.wakes,
                            d.held_by.map(HeldBy::as_str),
                            at,
                        )
                        .await
                        .q()?;
                        queued.push(QueuedDelivery {
                            id: did,
                            message_id: row.id.clone(),
                            channel_id: row.channel_id.clone(),
                            recipient_kind: d.recipient_kind,
                            recipient_id: d.recipient_id,
                            reason: d.reason,
                            wakes: d.wakes,
                            held_by: d.held_by,
                        });
                    }
                    (queued, plan.hop_limit_hit)
                } else {
                    (vec![], false)
                };
                wtx.commit().await?;
                Written {
                    absent,
                    answers: None,
                    thread,
                    again: false,
                    row,
                    event: Some(event),
                    deliveries,
                    hop_limit_hit,
                }
            }
        };
        if written.again {
            return Ok(written);
        }
        let Some(event) = written.event.clone() else { return Ok(written) };
        let answers = inner.model.answers_of_async(self.db.read_conn(), &written.row).await?;
        let written = Written { answers, ..written };
        // after(): the state, the link previews, the places.
        self.publish_message(inner, &written.row, written.answers.clone());
        self.embed_later(&written.row);
        self.publish_channel_async(&inner.model, &w.channel).await?;
        let meta = meta_of(written.row.meta.as_deref());
        if written.row.sender_id == USER_ID || meta.mentions.is_some_and(|m| m.iter().any(|x| x == USER_ID)) {
            self.publish_user_mentions_async(&inner.model).await?;
        }
        if !written.thread.is_empty() {
            self.publish_channel_async(&inner.model, &written.thread).await?;
        }
        if let Some(posted) = inner.model.committed_from(&written.row, &event) {
            let posted = Arc::new(posted);
            self.emit_event(ChannelEvent::Posted(Box::new((*posted).clone())));
            if !written.deliveries.is_empty() {
                publish(
                    &self.dispatches,
                    &ChannelDispatched {
                        committed: posted,
                        deliveries: written.deliveries.clone(),
                    },
                );
            }
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
    fn embed_later(&self, row: &MsgRow) {
        if !self.embeds || row.kind != "chat" || row.deleted_at.is_some() {
            return;
        }
        let links = words::links_in(&row.body);
        if links.is_empty() {
            return;
        }
        let me = self.me.clone();
        let row = row.clone();
        let hub = self.hub.upgrade();
        let cancel = hub.as_ref().map(|h| h.child_token()).unwrap_or_default();
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
            let Ok(Some(current)) = db::message_by_id(chat.db.read_conn(), &row.id).await else {
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
                let Ok(wtx) = WriteTx::begin(&mut inner, chat.db.write_conn()).await else {
                    return;
                };
                let Ok(revision) = db::bump_revision(&wtx.tx, &current.channel_id).await else {
                    return;
                };
                if db::set_meta(&wtx.tx, &current.id, text.as_deref(), revision).await.is_err() {
                    return;
                }
                wtx.commit().await.is_ok()
            };
            if committed && let Ok(message) = chat.finish_message_change_async(&inner.model, &current).await {
                chat.emit_event(ChannelEvent::Edited(message));
            }
        };
        if let Some(hub) = hub {
            hub.spawn_task(fut);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
        }
    }

    /// Subscribes to removed message IDs without receiving other channel events.
    pub fn subscribe_removals(&self) -> broadcast::Receiver<String> {
        self.removals.subscribe()
    }

    pub(super) fn quoted(&self, refs: &[vibevalley_protocol::BlockRef]) -> Vec<QuotedBlock> {
        match &self.quoter {
            Some(q) if !refs.is_empty() => q.quote(refs),
            _ => vec![],
        }
    }
}

impl ChannelAnnouncePort for Chat {
    fn default_channel(&self) -> String {
        Chat::default_channel(self)
    }

    fn place_exists(&self, id: &str) -> bool {
        Chat::place(self, id).is_some()
    }

    fn orchestrator_in(&self, channel: &str) -> String {
        Chat::orchestrator_in(self, channel)
    }

    fn place_of_async<'a>(&'a self, who: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>> {
        Box::pin(Chat::place_of_async(self, who, target))
    }

    fn post_card_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        card: vibevalley_protocol::ArtifactCard,
        run: Option<String>,
        send_key: String,
    ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
        Box::pin(async move {
            let (msg, _) = Chat::post_async(
                self,
                Posting {
                    from: from.to_string(),
                    channel: channel.to_string(),
                    text: text.to_string(),
                    run,
                    send_key,
                    made: Some(Made::Card(card)),
                    spoken: false,
                },
            )
            .await?;
            Ok(msg)
        })
    }

    fn post_attachments_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        attachments: Vec<String>,
        send_key: String,
    ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
        Box::pin(async move {
            let (msg, _) = Chat::post_async(
                self,
                Posting {
                    from: from.to_string(),
                    channel: channel.to_string(),
                    text: text.to_string(),
                    run: None,
                    send_key,
                    made: Some(Made::Attachments(attachments)),
                    spoken: false,
                },
            )
            .await?;
            Ok(msg)
        })
    }

    fn issue_thread_async<'a>(
        &'a self,
        issue_id: &'a str,
        title: &'a str,
        preferred_channel: Option<&'a str>,
    ) -> crate::BoxFuture<'a, Result<String, ApiError>> {
        Box::pin(Chat::issue_thread_async(self, issue_id, title, preferred_channel))
    }

    fn issue_thread_id(&self, issue_id: &str) -> Option<String> {
        Chat::issue_thread_id(self, issue_id)
    }

    fn say_in_async<'a>(&'a self, channel: &'a str, text: &'a str, send_key: String) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
        Box::pin(async move {
            Chat::say_async(
                self,
                Saying {
                    text: text.to_string(),
                    channel: Some(channel.to_string()),
                    send_key,
                    ..Saying::default()
                },
            )
            .await
            .map(|(m, _)| m)
        })
    }

    fn history_async<'a>(&'a self, channel: &'a str, limit: i64) -> crate::BoxFuture<'a, Result<Vec<ChatMessage>, ApiError>> {
        Box::pin(Chat::history_async(self, channel, None, Some(limit)))
    }

    fn message_locations<'a>(&'a self, ids: &'a [String]) -> crate::app::hub::ports::MessageLocationsFuture<'a> {
        Box::pin(async move { db::message_locations(self.db.read_conn(), ids).await.unwrap_or_default() })
    }
}

impl crate::app::hub::ports::ChannelMessageEventsPort for Chat {
    fn subscribe_edited_messages(&self) -> broadcast::Receiver<ChatMessage> {
        self.edited_messages.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_paths_bypass_write_mutex_and_use_wal_read_pool() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let files = AttachmentStore::open(dir.path(), db.clone());
        let chat = Chat::open_async(db.clone(), &hub, files, None, false).await.unwrap();
        let gid = chat.default_channel();

        let (msg, _) = chat
            .say_async(Saying {
                channel: Some(gid.clone()),
                text: "decontended wal read check".into(),
                send_key: "decontend-1".into(),
                ..Saying::default()
            })
            .await
            .unwrap();
        chat.pin_async(&msg.id, true).await.unwrap();

        // Hold BOTH the channel write mutex (`chat.inner`) AND a SQLite `BEGIN IMMEDIATE`
        // write transaction on `write_conn()` simultaneously.
        let _write_mutex_guard = chat.locked().await;
        let write_tx = crate::db::begin_write_tx(db.write_conn()).await.unwrap();
        let _ = db::bump_revision(&write_tx, &gid).await.unwrap();

        let started = Instant::now();
        let reader_chat = chat.clone();
        let reader_gid = gid.clone();
        let reader = tokio::spawn(async move {
            let channels = reader_chat.list_async().await.unwrap();
            assert!(!channels.is_empty());
            let history = reader_chat.history_async(&reader_gid, None, Some(20)).await.unwrap();
            assert_eq!(history.len(), 1);
            let hits = reader_chat.search_async("decontended", None).await.unwrap();
            assert_eq!(hits.len(), 1);
            let pins = reader_chat.pins_async(&reader_gid).await.unwrap();
            assert_eq!(pins.len(), 1);
            let recent = reader_chat.recent_rows_async(&reader_gid, 10).await.unwrap();
            assert_eq!(recent.len(), 1);
            let _unread = reader_chat.unread_async(USER_ID, None).await;
            let _pending = reader_chat.pending_deliveries_async(DeliveryTargetKind::Orchestrator).await.unwrap();
            assert_eq!(reader_chat.default_channel(), reader_gid);
        });

        tokio::time::timeout(Duration::from_secs(2), reader)
            .await
            .expect("channel read paths must not block on AsyncMutex<Inner> or write_pool")
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));

        write_tx.rollback().await.unwrap();
        drop(_write_mutex_guard);
        hub.close_async().await;
        db.close_async().await;
    }

    #[tokio::test]
    async fn async_channel_handlers_execute_on_hub_on_async_with_thread_idempotency() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let files = AttachmentStore::open(dir.path(), db.clone());
        let chat = Chat::open_async(db.clone(), &hub, files, None, false).await.unwrap();
        let registry = Arc::new(vibevalley_runtime::oar::Registry::new());
        let agents = crate::team::agent::Agents::open(&hub, dir.path(), &[], registry, false).unwrap();
        install(&hub, chat.clone(), agents, None);

        use vibevalley_protocol::{Caller, ChannelMessageListInput, ChannelRequest, ChannelThreadCreateInput, SayRequest, ops};

        let cid = hub
            .invoke_as_async::<ops::ChannelCreate>(
                Caller::User,
                ChannelRequest {
                    name: "async-room".into(),
                    description: Some("native async room".into()),
                    repo: None,
                },
            )
            .await
            .unwrap();

        hub.invoke_as_async::<ops::ChannelMessageSend>(
            Caller::User,
            SayRequest {
                id: cid.clone(),
                text: "hello async hub".into(),
                send_key: Some("async-send-1".into()),
                agent: None,
                repo: None,
                station: None,
                reply_to: None,
                attachments: None,
                to: None,
                blocks: None,
                view_context: None,
            },
        )
        .await
        .unwrap();

        let history = hub
            .invoke_as_async::<ops::ChannelMessageList>(
                Caller::User,
                ChannelMessageListInput {
                    id: cid.clone(),
                    before: None,
                    limit: Some(10),
                },
            )
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        let msg_id = history[0].id.clone();

        let t1 = hub
            .invoke_as_async::<ops::ChannelThreadCreate>(
                Caller::User,
                ChannelThreadCreateInput {
                    id: msg_id.clone(),
                    request_key: Some("thread-key-1".into()),
                },
            )
            .await
            .unwrap();
        let t2 = hub
            .invoke_as_async::<ops::ChannelThreadCreate>(
                Caller::User,
                ChannelThreadCreateInput {
                    id: msg_id,
                    request_key: Some("thread-key-1".into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(t1, t2);

        let listed = hub.invoke_as_async::<ops::ChannelList>(Caller::User, ()).await.unwrap();
        assert!(listed.iter().any(|c| c.id == cid));

        hub.close_async().await;
        db.close_async().await;
    }
}
