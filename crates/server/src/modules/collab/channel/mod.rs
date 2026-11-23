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
pub(in crate::modules::collab::channel) use crate::db::generated::collab_channel as queries;
mod messages;
pub mod model;
mod rooms;
mod service;
mod store;
mod types;
pub mod words;

pub use dispatch::{ChannelDispatched, DeliveryTargetKind, HeldBy, QueuedDelivery, Reason};
pub use service::{direct, install, profile_id};
pub use store::Inner;
pub use types::{
    AddressedMessage, ArtifactRef, ChannelEvent, Committed, FileAt, Info, Made, Meta, Note, Noticing, Picked, Place, Posting, ReadOptions, ReadResult, Saying,
    Seat, Speaking, Spoken, ThreadSubject, actor_of, line_of, meta_of, meta_text, to_message,
};

use std::sync::{Arc, Weak};

use arc_swap::{ArcSwap, Guard as SnapshotGuard};
use parking_lot::{Mutex, MutexGuard, RwLock};
use tokio::sync::broadcast;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, ChatMessage, DEFAULT_ORCHESTRATOR, Embed, Fact, FactChannelChanged, FactMessageChanged, FactUserMentionsChanged, QuotedBlock, USER_ID,
    UserMention,
};

use self::db::{Connection, EventRow, MsgRow, ParticipantRow};
use self::dispatch::Reach;
use self::model::ChatModel;
use self::store::{Q, tx};
use self::types::{Write, Written, new_id};
use crate::base::{LookIn, ServerDb, internal, missing, refused as refuse};
use crate::modules::content::attachment::Attachments;
use crate::ports::{
    ChannelAnnouncePort, ChannelDelivery, ChannelDeliveryKind, ChannelDispatchPort, ChannelDispatchedBatch, ChannelNoteRequest, ChannelNoticeRequest,
    ChannelParticipant, ChannelPlace, ChannelPostedMessage, ChannelQuotePort, ChannelSeat,
};
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

type Guard = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;
type Seater = Arc<dyn Fn(&str) + Send + Sync>;

/// The chat.
pub struct Chat {
    hub: Weak<Hub>,
    db: Arc<ServerDb>,
    files: Arc<Attachments>,
    /// Lock-free atomic snapshot of the committed in-memory [`ChatModel`],
    /// used by read-only queries alongside [`ServerDb`]'s WAL `read_pool`
    /// without contending on `inner`.
    snapshot: Arc<ArcSwap<ChatModel>>,
    /// Write-side lock serializing transactions and protecting `reach`.
    inner: Mutex<Inner>,
    me: Weak<Chat>,
    events: broadcast::Sender<ChannelEvent>,
    removals: broadcast::Sender<String>,
    edited_messages: broadcast::Sender<ChatMessage>,
    dispatches: Mutex<Vec<flume::Sender<ChannelDispatched>>>,
    port_dispatches: Mutex<Vec<flume::Sender<ChannelDispatchedBatch>>>,
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
        files: Arc<Attachments>,
        quoter: Option<Arc<dyn ChannelQuotePort>>,
        embeds: bool,
    ) -> Result<Arc<Chat>, ApiError> {
        let conn = Connection::new(db.clone());
        let at = now();
        for (id, kind, name) in [
            (USER_ID, "user", t("server.channel.name.user", &[])),
            ("system", "system", "VibeValley".to_string()),
        ] {
            db::upsert_participant(
                &conn,
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
            .q()?;
        }
        db::add_participant(&conn, DEFAULT_ORCHESTRATOR, "agent", &t("server.channel.name.orchestrator", &[]), at).q()?;
        if db::default_id(&conn).q()?.is_none() {
            let id = new_id();
            db::create_channel(&conn, &id, true, FIRST_CHANNEL, None, None, at).q()?;
            db::add_member(&conn, &id, DEFAULT_ORCHESTRATOR, "manual", 0).q()?;
        }
        let mut model = ChatModel::default();
        model.load(
            db::all_channels(&conn).q()?,
            db::participants(&conn).q()?,
            db::read_cursors_of(&conn, USER_ID).q()?,
            &db::all_members(&conn).q()?,
        );
        let snapshot = Arc::new(ArcSwap::from_pointee(model.clone()));
        let (events, _events_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (removals, _removals_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let (edited_messages, _edited_rx) = broadcast::channel(CHANNEL_EVENT_CAPACITY);
        let chat = Arc::new_cyclic(|me| Chat {
            hub: Arc::downgrade(hub),
            db,
            files,
            snapshot: snapshot.clone(),
            inner: Mutex::new(Inner {
                db: conn,
                transaction_depth: 0,
                model,
                reach: Reach::default(),
                snapshot,
            }),
            me: me.clone(),
            events,
            removals,
            edited_messages,
            dispatches: Mutex::default(),
            port_dispatches: Mutex::default(),
            guards: RwLock::default(),
            seaters: RwLock::default(),
            embeds,
            quoter,
        });
        {
            let model = chat.model();
            let read_db = chat.read_db();
            let mut recent = db::recent_channels(&read_db, KEEP_CHANNELS).q()?;
            recent.reverse();
            let mut facts = vec![];
            for c in &recent {
                facts.push(Fact::ChannelChanged(FactChannelChanged {
                    at: now(),
                    channel: model.counted(&read_db, c)?,
                }));
            }
            hub.apply(facts);
            chat.publish_user_mentions_with(&model, &read_db)?;
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

    fn locked(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock()
    }

    pub(super) fn model(&self) -> SnapshotGuard<Arc<ChatModel>> {
        self.snapshot.load()
    }

    pub(super) fn read_db(&self) -> Connection {
        Connection::new(self.db.clone())
    }

    /// `publishChannel`: the place as it stands into the state.
    fn publish_channel(&self, inner: &Inner, id: &str) -> Result<(), ApiError> {
        let Some(row) = inner.model.channel(id) else { return Ok(()) };
        let mut channel = inner.counted(row)?;
        // A metadata change can read a message's number before the message's own fact is applied.
        if let Some(published) = inner.model.published_number(id)
            && channel.last_number.unwrap_or(0) > published
        {
            channel.last_number = Some(published);
        }
        self.apply(vec![Fact::ChannelChanged(FactChannelChanged { at: now(), channel })]);
        Ok(())
    }

    fn publish_user_mentions(&self, inner: &Inner) -> Result<(), ApiError> {
        self.publish_user_mentions_with(&inner.model, &inner.db)
    }

    fn publish_user_mentions_with(&self, model: &ChatModel, conn: &Connection) -> Result<(), ApiError> {
        let quiet = |id: &str| model.channel(id).is_some_and(|c| c.notify == "none");
        let rows = db::user_mentions(conn).q()?;
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
    fn read_through(&self, inner: &mut Inner, who: &str, channel: &str, upto: i64) -> Result<(), ApiError> {
        let at = now();
        tx(inner, |me| me.set_read(who, channel, upto, at))?;
        if who == USER_ID {
            self.emit_event(ChannelEvent::UserRead {
                channel: channel.to_string(),
                upto,
                at,
            });
            self.publish_user_mentions(inner)?;
        }
        Ok(())
    }

    /// One message changed with its channel's next revision; caller emits the
    /// matching [`ChannelEvent`] variant.
    fn change(&self, inner: &mut Inner, row: &MsgRow, work: impl FnOnce(&Connection, i64, i64) -> sqlx::Result<()>) -> Result<ChatMessage, ApiError> {
        let at = now();
        tx(inner, |me| {
            let revision = db::bump_revision(&me.db, &row.channel_id).q()?;
            work(&me.db, revision, at).q()
        })?;
        let updated = db::message_by_id(&inner.db, &row.id).q()?;
        let message = to_message(updated.as_ref().unwrap_or(row));
        self.publish_channel(inner, &row.channel_id)?;
        Ok(message)
    }

    /// `write`, under the lock: the message, its event, who it names and
    /// follows, the state told; the readers are told after the lock.
    fn write(&self, inner: &mut Inner, w: Write) -> Result<Written, ApiError> {
        let written = tx(inner, |me| {
            if let Some(key) = w.send_key.as_deref().filter(|k| !k.is_empty())
                && let Some(seen) = db::message_by_send_key(&me.db, &w.from, key).q()?
            {
                return Ok(Written {
                    absent: vec![],
                    answers: None,
                    thread: String::new(),
                    again: true,
                    row: seen,
                    event: None,
                    deliveries: vec![],
                    hop_limit_hit: false,
                });
            }
            let sender = me
                .model
                .participant(&w.from)
                .cloned()
                .ok_or_else(|| internal(format!("no participant {}", w.from)))?;
            let id = new_id();
            let meta = meta_text(w.meta.as_ref());
            let at = now();
            let send_key = w.send_key.clone().filter(|k| !k.is_empty());
            let revision = db::bump_revision(&me.db, &w.channel).q()?;
            let number = db::insert_message(
                &me.db,
                &id,
                &w.channel,
                &w.from,
                w.kind.as_str(),
                &w.text,
                meta.as_deref(),
                send_key.as_deref(),
                at,
                revision,
                w.reply_to,
            )
            .q()?;
            me.touch_channel(&w.channel, number)?;
            let seq = db::insert_event(&me.db, "posted", &w.channel, &id, at).q()?;
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
            let (row, absent) = me.settle(inserted)?;
            if let Some(by) = &w.read_by {
                me.set_read(by, &w.channel, number, now())?;
            }
            if let Some(member) = &w.member {
                me.add_member(&w.channel, member, "user", number)?;
            }
            let thread = match &w.thread {
                Some(subject) => me.thread_for(&id, number, &w.channel, subject)?,
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
                && let Some(posted) = me.committed_from(&row, &event)
            {
                let plan = dispatch::plan_deliveries(&me.model, &mut me.reach, &posted, at);
                let mut queued = Vec::with_capacity(plan.deliveries.len());
                for d in plan.deliveries {
                    let did = db::insert_delivery(
                        &me.db,
                        &row.id,
                        &row.channel_id,
                        d.recipient_kind.as_str(),
                        &d.recipient_id,
                        d.reason.as_str(),
                        d.wakes,
                        d.held_by.map(HeldBy::as_str),
                        at,
                    )
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
            Ok(Written {
                absent,
                answers: None,
                thread,
                again: false,
                row,
                event: Some(event),
                deliveries,
                hop_limit_hit,
            })
        })?;
        if written.again {
            return Ok(written);
        }
        let Some(event) = written.event.clone() else { return Ok(written) };
        let answers = inner.answers_of(&written.row)?;
        let written = Written { answers, ..written };
        // after(): the state, the link previews, the places.
        self.publish_message(inner, &written.row, written.answers.clone());
        self.embed_later(&written.row);
        self.publish_channel(inner, &w.channel)?;
        let meta = meta_of(written.row.meta.as_deref());
        if written.row.sender_id == USER_ID || meta.mentions.is_some_and(|m| m.iter().any(|x| x == USER_ID)) {
            self.publish_user_mentions(inner)?;
        }
        if !written.thread.is_empty() {
            self.publish_channel(inner, &written.thread)?;
        }
        if let Some(posted) = inner.committed_from(&written.row, &event) {
            let posted = Arc::new(posted);
            self.emit_event(ChannelEvent::Posted(Box::new((*posted).clone())));
            if !written.deliveries.is_empty() {
                publish(
                    &self.dispatches,
                    &ChannelDispatched {
                        committed: posted.clone(),
                        deliveries: written.deliveries.clone(),
                    },
                );
                let batch = ChannelDispatchedBatch {
                    committed: Arc::new(posted_to_port(&posted)),
                    deliveries: written.deliveries.iter().map(delivery_to_port).collect(),
                };
                publish(&self.port_dispatches, &batch);
            }
        }
        if written.hop_limit_hit {
            self.notice_locked(
                inner,
                Noticing {
                    channel: w.channel,
                    text: t("server.channel.hopLimit", &[("limit", dispatch::HOP_LIMIT.into())]),
                    code: "hop_limit".into(),
                    until_user_speaks: true,
                    ..Noticing::default()
                },
            );
        }
        Ok(written)
    }

    /// `embedLater`: a message's link previews, read after it is out and
    /// then put on it as a change.
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
        let task = move || {
            let mut found: Vec<Embed> = Vec::new();
            for link in &links {
                if cancel.is_cancelled() {
                    return;
                }
                if let Some(embed) = words::read_embed(link) {
                    found.push(embed);
                }
            }
            if cancel.is_cancelled() {
                return;
            }
            let Some(chat) = me.upgrade() else { return };
            let mut inner = chat.locked();
            let Ok(Some(current)) = db::message_by_id(&inner.db, &row.id) else { return };
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
            if let Ok(message) = chat.change(&mut inner, &current, |db, revision, _| db::set_meta(db, &current.id, text.as_deref(), revision)) {
                chat.emit_event(ChannelEvent::Edited(message));
            }
        };
        if let Some(hub) = hub {
            hub.spawn_blocking_task(task);
        } else {
            vibevalley_runtime::rt::handle().spawn_blocking(task);
        }
    }

    fn quoted(&self, refs: &[vibevalley_protocol::BlockRef]) -> Vec<QuotedBlock> {
        match &self.quoter {
            Some(q) if !refs.is_empty() => q.quote(refs),
            _ => vec![],
        }
    }
}

fn kind_to_port(kind: DeliveryTargetKind) -> ChannelDeliveryKind {
    match kind {
        DeliveryTargetKind::Issue => ChannelDeliveryKind::Issue,
        DeliveryTargetKind::Session => ChannelDeliveryKind::Session,
        DeliveryTargetKind::Direct => ChannelDeliveryKind::Direct,
        DeliveryTargetKind::Orchestrator => ChannelDeliveryKind::Orchestrator,
    }
}

fn kind_from_port(kind: ChannelDeliveryKind) -> DeliveryTargetKind {
    match kind {
        ChannelDeliveryKind::Issue => DeliveryTargetKind::Issue,
        ChannelDeliveryKind::Session => DeliveryTargetKind::Session,
        ChannelDeliveryKind::Direct => DeliveryTargetKind::Direct,
        ChannelDeliveryKind::Orchestrator => DeliveryTargetKind::Orchestrator,
    }
}

fn delivery_to_port(d: &QueuedDelivery) -> ChannelDelivery {
    ChannelDelivery {
        id: d.id,
        message_id: d.message_id.clone(),
        channel_id: d.channel_id.clone(),
        recipient_kind: kind_to_port(d.recipient_kind),
        recipient_id: d.recipient_id.clone(),
        reason: d.reason.as_str().to_string(),
        wakes: d.wakes,
    }
}

fn posted_to_port(c: &Committed) -> ChannelPostedMessage {
    let view_context = meta_of(c.row.meta.as_deref()).view_context.filter(|_| c.row.deleted_at.is_none());
    ChannelPostedMessage {
        event_seq: c.event.seq,
        id: c.row.id.clone(),
        channel_id: c.row.channel_id.clone(),
        number: c.row.number,
        sender_id: c.row.sender_id.clone(),
        sender_kind: c.row.sender_kind.clone(),
        sender_name: c.row.sender_name.clone(),
        sender_agent: c.row.sender_agent.clone(),
        kind: types::message_kind(&c.row.kind),
        body: c.row.body.clone(),
        view_context,
        reply_number: c.row.reply_number,
        edited_at: c.row.edited_at,
        deleted_at: c.row.deleted_at,
        channel_name: c.channel_name.clone(),
        channel_type: c.channel_type,
        peer: c.peer.clone(),
        orchestrator: c.orchestrator.clone(),
        mentions: c.mentions.clone(),
        members: c.members.clone(),
        topic: c.topic.clone(),
    }
}

fn note_from_port(req: ChannelNoteRequest) -> Note {
    Note {
        channel: req.channel,
        from: req.from,
        kind: req.kind,
        text: req.text,
        meta: meta_of(req.meta_json.as_deref()),
        topic: req.topic.map(|t| ThreadSubject {
            kind: t.kind,
            id: t.id,
            owner: t.owner,
        }),
        member: req.member,
        seat: req.seat.map(|s| Seat {
            id: s.id,
            name: s.name,
            agent: s.agent,
            home: s.home,
        }),
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

    fn place_of(&self, who: &str, target: &str) -> Result<String, ApiError> {
        Chat::place_of(self, who, target)
    }

    fn post_card(
        &self,
        from: &str,
        channel: &str,
        text: &str,
        card: vibevalley_protocol::ArtifactCard,
        run: Option<String>,
        send_key: String,
    ) -> Result<ChatMessage, ApiError> {
        let (msg, _) = Chat::post(
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
        )?;
        Ok(msg)
    }

    fn post_attachments(&self, from: &str, channel: &str, text: &str, attachments: Vec<String>, send_key: String) -> Result<ChatMessage, ApiError> {
        let (msg, _) = Chat::post(
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
        )?;
        Ok(msg)
    }

    fn issue_thread(&self, issue_id: &str, title: &str, preferred_channel: Option<&str>) -> Result<String, ApiError> {
        Chat::issue_thread(self, issue_id, title, preferred_channel)
    }

    fn issue_thread_id(&self, issue_id: &str) -> Option<String> {
        Chat::issue_thread_id(self, issue_id)
    }

    fn say_in(&self, channel: &str, text: &str, send_key: String) -> Result<ChatMessage, ApiError> {
        Chat::say(
            self,
            Saying {
                text: text.to_string(),
                channel: Some(channel.to_string()),
                send_key,
                ..Saying::default()
            },
        )
        .map(|(m, _)| m)
    }

    fn history(&self, channel: &str, limit: i64) -> Result<Vec<ChatMessage>, ApiError> {
        Chat::history(self, channel, None, Some(limit))
    }
}

impl ChannelDispatchPort for Chat {
    fn dispatches(&self) -> flume::Receiver<ChannelDispatchedBatch> {
        let (tx, rx) = flume::unbounded();
        self.port_dispatches.lock().push(tx);
        rx
    }

    fn subscribe_removals(&self) -> broadcast::Receiver<String> {
        self.removals.subscribe()
    }

    fn pending_deliveries(&self, kind: ChannelDeliveryKind) -> Result<Vec<ChannelDelivery>, ApiError> {
        Ok(Chat::pending_deliveries(self, kind_from_port(kind))?.iter().map(delivery_to_port).collect())
    }

    fn pending_deliveries_for(&self, kind: ChannelDeliveryKind, recipient_id: &str, max_id: i64) -> Result<Vec<ChannelDelivery>, ApiError> {
        Ok(Chat::pending_deliveries_for(self, kind_from_port(kind), recipient_id, max_id)?
            .iter()
            .map(delivery_to_port)
            .collect())
    }

    fn delivery_is_pending(&self, id: i64) -> Result<bool, ApiError> {
        Chat::delivery_is_pending(self, id)
    }

    fn committed_of(&self, message_id: &str) -> Result<Option<ChannelPostedMessage>, ApiError> {
        Ok(Chat::committed_of(self, message_id)?.as_ref().map(posted_to_port))
    }

    fn settle_delivery(&self, id: i64, delivered: bool) -> Result<(), ApiError> {
        Chat::settle_delivery(self, id, delivered)
    }

    fn withdraw_delivery(&self, id: i64) -> Result<(), ApiError> {
        Chat::withdraw_delivery(self, id)
    }

    fn mark_seen(&self, participant: &str, message_id: &str) -> Result<(), ApiError> {
        Chat::mark_seen(self, participant, message_id)
    }

    fn react(&self, id: &str, who: &str, emoji: &str, on: bool) -> Result<ChatMessage, ApiError> {
        Chat::react(self, id, who, emoji, on)
    }

    fn note(&self, req: ChannelNoteRequest) -> Result<String, ApiError> {
        Chat::note(self, note_from_port(req))
    }

    fn note_once(&self, req: ChannelNoteRequest, send_key: Option<String>) -> Result<String, ApiError> {
        Chat::note_once(self, note_from_port(req), send_key)
    }

    fn notice(&self, req: ChannelNoticeRequest) {
        Chat::notice(
            self,
            Noticing {
                channel: req.channel,
                text: req.text,
                code: req.code,
                send_key: req.send_key,
                until_user_speaks: req.until_user_speaks,
            },
        );
    }

    fn seat(&self, seat: ChannelSeat) -> Result<(), ApiError> {
        Chat::seat(
            self,
            &Seat {
                id: seat.id,
                name: seat.name,
                agent: seat.agent,
                home: seat.home,
            },
        )
    }

    fn leave(&self, participant: &str) -> Result<(), ApiError> {
        Chat::leave(self, participant)
    }

    fn add_follower(&self, thread: &str, participant: &str) -> Result<(), ApiError> {
        Chat::add_follower(self, thread, participant)
    }

    fn members_of(&self, channel: &str) -> Vec<String> {
        Chat::members_of(self, channel)
    }

    fn participants(&self) -> Vec<ChannelParticipant> {
        Chat::participants(self)
            .into_iter()
            .map(|p| ChannelParticipant {
                id: p.id,
                kind: p.kind,
                name: p.name,
                agent_id: p.agent_id,
                home_id: p.home_id,
                left_at: p.left_at,
            })
            .collect()
    }

    fn home_of(&self, participant: &str) -> Option<String> {
        Chat::home_of(self, participant)
    }

    fn place(&self, id: &str) -> Option<ChannelPlace> {
        Chat::place(self, id).map(|p| ChannelPlace {
            id: p.id,
            r#type: p.r#type,
            peer: p.peer,
            parent: p.parent,
            name: p.name,
            last_number: p.last_number,
            root: p.root,
            topic: p.topic,
        })
    }

    fn default_channel(&self) -> String {
        Chat::default_channel(self)
    }

    fn orchestrator_in(&self, channel: &str) -> String {
        Chat::orchestrator_in(self, channel)
    }

    fn target_of(&self, channel: &str) -> Option<String> {
        Chat::target_of(self, channel)
    }

    fn thread_about(&self, kind: vibevalley_protocol::SubjectKind, id: &str) -> Option<String> {
        Chat::thread_about(self, kind, id)
    }

    fn latest(&self, channel: &str) -> Result<i64, ApiError> {
        Chat::latest(self, channel)
    }

    fn read_up_to(&self, participant: &str, channel: &str, upto: i64) -> Result<(), ApiError> {
        Chat::read_up_to(self, participant, channel, upto)
    }

    fn dispatch_count(&self, channel: &str) -> Result<i64, ApiError> {
        Chat::dispatch_count(self, channel)
    }

    fn issue_thread(&self, issue_id: &str, title: &str, preferred_channel: Option<&str>) -> Result<String, ApiError> {
        Chat::issue_thread(self, issue_id, title, preferred_channel)
    }

    fn issue_thread_id(&self, issue_id: &str) -> Option<String> {
        Chat::issue_thread_id(self, issue_id)
    }

    fn say_in(&self, channel: &str, text: &str, send_key: String) -> Result<ChatMessage, ApiError> {
        Chat::say(
            self,
            Saying {
                text: text.to_string(),
                channel: Some(channel.to_string()),
                send_key,
                ..Saying::default()
            },
        )
        .map(|(m, _)| m)
    }

    fn ensure_seated(&self, cb: Arc<dyn Fn(&str) + Send + Sync>) {
        self.seaters.write().push(cb);
    }
}

impl crate::ports::ChannelMessageEventsPort for Chat {
    fn subscribe_edited_messages(&self) -> broadcast::Receiver<ChatMessage> {
        self.edited_messages.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn read_paths_bypass_write_mutex_and_use_wal_read_pool() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let files = Attachments::open(dir.path(), db.clone());
        let chat = Chat::open(db.clone(), &hub, files, None, false).unwrap();
        let gid = chat.default_channel();

        let (msg, _) = chat
            .say(Saying {
                channel: Some(gid.clone()),
                text: "decontended wal read check".into(),
                send_key: "decontend-1".into(),
                ..Saying::default()
            })
            .unwrap();
        chat.pin(&msg.id, true).unwrap();

        // Hold BOTH the channel write mutex (`chat.locked()`) AND a SQLite `BEGIN IMMEDIATE`
        // write transaction on `write_pool` simultaneously.
        let _write_mutex_guard = chat.locked();
        let mut write_conn = db.acquire().unwrap();
        vibevalley_runtime::rt::block_on(async {
            sqlx::raw_sql("BEGIN IMMEDIATE;").execute(&mut *write_conn).await.unwrap();
        });

        let started = Instant::now();
        let (tx, rx) = flume::bounded(1);
        let reader_chat = chat.clone();
        let reader_gid = gid.clone();
        let reader = std::thread::spawn(move || {
            let channels = reader_chat.list().unwrap();
            assert!(!channels.is_empty());
            let history = reader_chat.history(&reader_gid, None, Some(20)).unwrap();
            assert_eq!(history.len(), 1);
            let hits = reader_chat.search("decontended", None).unwrap();
            assert_eq!(hits.len(), 1);
            let pins = reader_chat.pins(&reader_gid).unwrap();
            assert_eq!(pins.len(), 1);
            let recent = reader_chat.recent_rows(&reader_gid, 10).unwrap();
            assert_eq!(recent.len(), 1);
            let _unread = reader_chat.unread(USER_ID, None);
            let _pending = reader_chat.pending_deliveries(DeliveryTargetKind::Orchestrator).unwrap();
            assert_eq!(reader_chat.default_channel(), reader_gid);
            let _ = tx.send(());
        });

        rx.recv_timeout(Duration::from_secs(2))
            .expect("channel read paths must not block on Mutex<Inner> or write_pool");
        reader.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));

        vibevalley_runtime::rt::block_on(async {
            sqlx::raw_sql("ROLLBACK;").execute(&mut *write_conn).await.unwrap();
        });
        drop(write_conn);
        drop(_write_mutex_guard);
        hub.close();
        db.close();
    }
}
