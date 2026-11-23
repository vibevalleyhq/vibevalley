//! The chat (田头): channels, threads and direct channels, numbered
//! messages, members, read cursors, pure audience/loop-guard dispatch policy,
//! and durable pending deliveries (`channel_delivery`) kept in `server.db`
//! with the places in memory (`model`), the state's `chat` kept by the four facts.
//!
//! Every message is written with a numbered event (`channel_event`) and its
//! synchronous `DeliveryPolicy` rows in one transaction; once committed,
//! [`Chat::committed`] and non-blocking [`Chat::dispatches`] notify downstream
//! consumers without blocking the writer.

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
    AddressedMessage, ArtifactRef, Committed, FileAt, Info, Made, Meta, Note, Noticing, Picked, Place, Posting, ReadOptions, ReadResult, Saying, Seat,
    Speaking, Spoken, ThreadSubject, Told, actor_of, line_of, meta_of, meta_text, to_message,
};

use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};

use sqlx::SqliteConnection;
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
use crate::base::{LookIn, internal, missing, open_sqlx_db, refused as refuse};
use crate::modules::content::attachment::Attachments;
use crate::{Hub, lock, now};

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

type BeforePost<'a> = Box<dyn FnOnce(&mut SqliteConnection, &ChatMessage) -> Result<(), ApiError> + 'a>;

type Guard = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;
type Seater = Arc<dyn Fn(&str) + Send + Sync>;

/// Snapshots of quoted artifact blocks (`quoteBlocks`).
pub type Quoter = Arc<dyn Fn(&[vibevalley_protocol::BlockRef]) -> Vec<QuotedBlock> + Send + Sync>;

/// The chat.
pub struct Chat {
    hub: Weak<Hub>,
    files: Arc<Attachments>,
    inner: Mutex<Inner>,
    me: Weak<Chat>,
    said: Mutex<Vec<flume::Sender<ChatMessage>>>,
    told: Mutex<Vec<flume::Sender<Told>>>,
    dispatches: Mutex<Vec<flume::Sender<ChannelDispatched>>>,
    user_reads: Mutex<Vec<flume::Sender<(String, i64, i64)>>>,
    guards: RwLock<Vec<Guard>>,
    seaters: RwLock<Vec<Seater>>,
    /// Link previews are read off the web; tests turn it off.
    embeds: bool,
    /// The blocks a message quotes, as they are now (the artifact module's).
    quoter: RwLock<Option<Quoter>>,
}

fn publish<T: Clone>(to: &Mutex<Vec<flume::Sender<T>>>, value: &T) {
    lock(to).retain(|tx| tx.send(value.clone()).is_ok());
}

impl Chat {
    /// `makeChannelStore` + `makeChannelHub`: the user, the farm and the
    /// default orchestrator seated, `#general` made on a new farm, the
    /// places loaded, and the newest channels and the user's mentions put
    /// in the state.
    pub fn open(home: &std::path::Path, hub: &Arc<Hub>, files: Arc<Attachments>, embeds: bool) -> Result<Arc<Chat>, ApiError> {
        let conn = Connection::new(pollster::block_on(open_sqlx_db(home)).q()?);
        db::control(&conn, db::SCHEMA).q()?;
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
        let chat = Arc::new_cyclic(|me| Chat {
            hub: Arc::downgrade(hub),
            files,
            inner: Mutex::new(Inner {
                db: conn,
                transaction_depth: 0,
                model,
                reach: Reach::default(),
            }),
            me: me.clone(),
            said: Mutex::default(),
            told: Mutex::default(),
            dispatches: Mutex::default(),
            user_reads: Mutex::default(),
            guards: RwLock::default(),
            seaters: RwLock::default(),
            embeds,
            quoter: RwLock::default(),
        });
        {
            let inner = lock(&chat.inner);
            let mut recent = db::recent_channels(&inner.db, KEEP_CHANNELS).q()?;
            recent.reverse();
            let mut facts = vec![];
            for c in &recent {
                facts.push(Fact::ChannelChanged(FactChannelChanged {
                    at: now(),
                    channel: inner.counted(c)?,
                }));
            }
            hub.apply(facts);
            chat.publish_user_mentions(&inner)?;
        }
        Ok(chat)
    }

    fn apply(&self, facts: Vec<Fact>) {
        if let Some(hub) = self.hub.upgrade() {
            hub.apply(facts);
        }
    }

    fn locked(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
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
        let quiet = |id: &str| inner.model.channel(id).is_some_and(|c| c.notify == "none");
        let rows = db::user_mentions(&inner.db).q()?;
        let mentions = rows
            .into_iter()
            .filter(|r| !quiet(&r.row.channel_id) && !quiet(&r.top_id))
            .map(|r| UserMention {
                message: to_message(&r.row),
                channel: r.top_id.clone(),
                address: inner.target_of_row(&r.channel_type, r.root_number, None, Some(&r.top_id), Some(&r.channel_name)),
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
            message: message.clone(),
            thread,
            answers,
        })]);
        inner.model.note_published(&row.channel_id, row.number);
        publish(&self.said, &message);
    }

    /// `readThrough`: a read that moves the cursor; the user's is told.
    fn read_through(&self, inner: &mut Inner, who: &str, channel: &str, upto: i64) -> Result<(), ApiError> {
        tx(inner, |me| me.set_read(who, channel, upto, now()))?;
        if who == USER_ID {
            publish(&self.user_reads, &(channel.to_string(), upto, now()));
            self.publish_user_mentions(inner)?;
        }
        Ok(())
    }

    /// One message changed with its channel's next revision; then whoever
    /// follows its channel is told it as it now is.
    fn change(&self, inner: &mut Inner, row: &MsgRow, work: impl FnOnce(&Connection, i64, i64) -> sqlx::Result<()>) -> Result<ChatMessage, ApiError> {
        let at = now();
        tx(inner, |me| {
            let revision = db::bump_revision(&me.db, &row.channel_id).q()?;
            work(&me.db, revision, at).q()
        })?;
        let updated = db::message_by_id(&inner.db, &row.id).q()?;
        let message = to_message(updated.as_ref().unwrap_or(row));
        publish(&self.said, &message);
        self.publish_channel(inner, &row.channel_id)?;
        Ok(message)
    }

    /// `write`, under the lock: the message, its event, who it names and
    /// follows, the state told; the readers are told after the lock.
    fn write(&self, inner: &mut Inner, w: Write) -> Result<Written, ApiError> {
        self.write_with(inner, w, None)
    }

    fn write_with(&self, inner: &mut Inner, w: Write, persist: Option<BeforePost<'_>>) -> Result<Written, ApiError> {
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
            if let Some(persist) = persist {
                persist(&mut me.db.borrow_mut(), &to_message(&row))?;
            }
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
            publish(&self.told, &Told::Posted(Box::new((*posted).clone())));
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
        let _ = std::thread::Builder::new().name("vibevalley-chat-embeds".into()).spawn(move || {
            let found: Vec<Embed> = links.iter().filter_map(|l| words::read_embed(l)).collect();
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
            let _ = chat.change(&mut inner, &current, |db, revision, _| db::set_meta(db, &current.id, text.as_deref(), revision));
        });
    }

    /// The artifact module quotes the blocks a user's message carries.
    pub fn set_quoter(&self, quoter: Quoter) {
        *self.quoter.write().unwrap_or_else(|e| e.into_inner()) = Some(quoter);
    }

    fn quoted(&self, refs: &[vibevalley_protocol::BlockRef]) -> Vec<QuotedBlock> {
        let quoter = self.quoter.read().unwrap_or_else(|e| e.into_inner()).clone();
        match quoter {
            Some(q) if !refs.is_empty() => q(refs),
            _ => vec![],
        }
    }
}
