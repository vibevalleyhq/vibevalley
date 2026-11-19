//! The chat (田头): channels, threads and direct channels, numbered
//! messages, members and read cursors, kept in `server.db` with the places
//! in memory (`model`), the state's `chat` kept by the four facts. Ported
//! from VibeValley `modules/channel/*` (store.ts, rooms.ts, hub.ts,
//! writing.ts, mutations.ts, directory.ts, channel.ts) and
//! `gateway/http/handlers/channel.ts`.
//!
//! Every message is written with a numbered event (`channel_event`); the
//! event goes to the readers ([`Chat::committed`]) once it is committed,
//! and the write returns once [`Chat::await_reader`]'s readers handled it.

pub mod db;
#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;
pub mod model;
pub mod words;

use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};

use self::db::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    Actor, AgentRole, ApiError, ArtifactCard, Attachment, BizCode, CallState, Channel, ChannelEvent, ChannelLast, ChannelType, ChannelUnread, ChannelUpdate,
    ChatMessage, DEFAULT_ORCHESTRATOR, EVERYONE, Embed, Fact, FactCallChanged, FactChannelChanged, FactChannelRemoved, FactMessageChanged,
    FactUserMentionsChanged, MessageHit, MessageKind, NoticeLevel, Notify, Outcome, Preview, QuotedBlock, Reaction, Spent, SubjectKind, USER_ID, UserMention,
    ops, subscriptions,
};

use self::db::{ChannelRow, EventRow, MsgRow, ParticipantRow};
use self::model::ChatModel;
use self::words::{ChatTarget, Has, Nameable};
use crate::base::{LookIn, RequestKeys, internal, missing, open_sqlx_db, refused as refuse};
use crate::modules::agent::Agents;
use crate::modules::attachment::Attachments;
use crate::{Hub, Sink, lock, now};

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

trait Q<T> {
    fn q(self) -> Result<T, ApiError>;
}

impl<T> Q<T> for sqlx::Result<T> {
    fn q(self) -> Result<T, ApiError> {
        self.map_err(internal)
    }
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// The first n UTF-16 units, never half a pair (`head` in clip.ts).
fn head(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in s.chars() {
        if len + ch.len_utf16() > n {
            break;
        }
        len += ch.len_utf16();
        out.push(ch);
    }
    out
}

/// `lineOf`: the first n units of text, on one line.
pub fn line_of(text: &str, n: usize) -> String {
    head(vibevalley_core::rules::one_line(text).trim(), n)
}

/// `optional`: words trimmed, none for empty.
fn optional(s: Option<&str>) -> Option<String> {
    let text = s.unwrap_or("").trim();
    (!text.is_empty()).then(|| text.to_string())
}

// ----- what a message carries besides its words (meta.ts) -----

/// The profile and repo the user picked for what they said.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

/// `channel_message.meta`. Written with empty values left out, as
/// VibeValley's `metaText` does.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub run: Option<String>,
    pub mentions: Option<Vec<String>>,
    pub session: Option<String>,
    pub outcome: Option<Outcome>,
    pub spent: Option<Spent>,
    pub code: Option<String>,
    pub spoken: Option<bool>,
    pub attachments: Option<Vec<Attachment>>,
    pub embeds: Option<Vec<Embed>>,
    pub artifact: Option<ArtifactCard>,
    pub blocks: Option<Vec<QuotedBlock>>,
    pub picked: Option<Picked>,
    pub ingress_source: Option<String>,
    pub ingress_recipient: Option<String>,
    pub issue: Option<String>,
    pub trigger: Option<Value>,
    pub response_port: Option<String>,
    pub voice_mode: Option<String>,
}

/// `metaOf`: one that does not read is none.
pub fn meta_of(raw: Option<&str>) -> Meta {
    raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default()
}

/// `metaText`: empty strings, false and empty lists left out.
pub fn meta_text(m: Option<&Meta>) -> Option<String> {
    let m = m?;
    let Ok(Value::Object(map)) = serde_json::to_value(m) else {
        return Some("{}".into());
    };
    let kept: serde_json::Map<String, Value> = map
        .into_iter()
        .filter(|(_, v)| match v {
            Value::Null => false,
            Value::String(s) => !s.is_empty(),
            Value::Bool(b) => *b,
            Value::Array(a) => !a.is_empty(),
            _ => true,
        })
        .collect();
    Some(Value::Object(kept).to_string())
}

/// Reactions in the order they came: `{"emoji": ["participant", …]}`.
fn reactions_of(raw: Option<&str>) -> Vec<(String, Vec<String>)> {
    struct InOrder(Vec<(String, Vec<String>)>);
    impl<'de> Deserialize<'de> for InOrder {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> serde::de::Visitor<'de> for V {
                type Value = InOrder;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("reactions")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<InOrder, A::Error> {
                    let mut out = vec![];
                    while let Some((k, v)) = m.next_entry::<String, Vec<String>>()? {
                        out.push((k, v));
                    }
                    Ok(InOrder(out))
                }
            }
            d.deserialize_map(V)
        }
    }
    raw.and_then(|r| serde_json::from_str::<InOrder>(r).ok()).map(|r| r.0).unwrap_or_default()
}

fn reactions_text(r: &[(String, Vec<String>)]) -> Option<String> {
    let kept: Vec<String> = r
        .iter()
        .filter(|(_, by)| !by.is_empty())
        .map(|(e, by)| format!("{}:{}", Value::from(e.as_str()), serde_json::to_string(by).unwrap_or_default()))
        .collect();
    (!kept.is_empty()).then(|| format!("{{{}}}", kept.join(",")))
}

fn message_kind(kind: &str) -> MessageKind {
    serde_json::from_value(Value::from(kind)).unwrap_or(MessageKind::Chat)
}

fn channel_type(kind: &str) -> ChannelType {
    serde_json::from_value(Value::from(kind)).unwrap_or(ChannelType::Channel)
}

fn subject_kind(kind: Option<&str>) -> Option<SubjectKind> {
    serde_json::from_value(Value::from(kind?)).ok()
}

fn notify_of(n: &str) -> Notify {
    serde_json::from_value(Value::from(n)).unwrap_or(Notify::All)
}

/// `actorOf`: an agent's seat that speaks for a profile is a helper's, one
/// that does not is an orchestrator's.
pub fn actor_of(kind: &str, agent: Option<&str>, id: &str, name: Option<&str>) -> Actor {
    let (id, name) = (id.to_string(), name.map(str::to_string));
    match kind {
        "agent" => Actor::Agent {
            id,
            role: if agent.is_some() { AgentRole::Worker } else { AgentRole::Orchestrator },
            name,
            for_user: None,
        },
        "user" => Actor::User { id, name },
        _ => Actor::System { id, name },
    }
}

/// `toMessage`.
pub fn to_message(row: &MsgRow) -> ChatMessage {
    let meta = meta_of(row.meta.as_deref());
    let gone = row.deleted_at.is_some();
    ChatMessage {
        id: row.id.clone(),
        number: row.number,
        channel: row.channel_id.clone(),
        from: row.sender_id.clone(),
        actor: actor_of(&row.sender_kind, row.sender_agent.as_deref(), &row.sender_id, Some(&row.sender_name)),
        name: row.sender_name.clone(),
        agent: row.sender_agent.clone().filter(|a| !a.is_empty()),
        kind: message_kind(&row.kind),
        text: row.body.clone(),
        mentions: meta.mentions.unwrap_or_default(),
        session: meta.session.filter(|s| !s.is_empty()),
        run: meta.run.filter(|s| !s.is_empty()),
        outcome: meta.outcome,
        spent: meta.spent,
        spoken: meta.spoken.unwrap_or(false),
        send_key: row.send_key.clone().filter(|k| !k.is_empty() && row.sender_id == USER_ID),
        at: row.created_at,
        revision: row.revision,
        reply_to: row.reply_number,
        edited: row.edited_at,
        deleted: row.deleted_at,
        pinned: row.pinned_at,
        reactions: reactions_of(row.reactions.as_deref())
            .into_iter()
            .map(|(emoji, by)| Reaction { emoji, by })
            .collect(),
        attachments: meta.attachments.unwrap_or_default(),
        embeds: meta.embeds.unwrap_or_default(),
        artifact: meta.artifact.filter(|_| !gone),
        blocks: meta.blocks.filter(|b| !b.is_empty() && !gone),
    }
}

// ----- the chat as the layers above use it (contracts.ts) -----

/// A file a message carries, as an agent reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileAt {
    pub name: String,
    pub path: String,
}

/// An artifact a message shows, as an agent reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub id: String,
    pub title: String,
    pub version: i64,
}

/// A message as an agent reads it: who said what, at which address.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressedMessage {
    pub id: String,
    pub number: i64,
    pub target: String,
    pub from: String,
    pub actor: Actor,
    pub name: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<FileAt>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<QuotedBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picked: Option<Picked>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_mode: Option<String>,
}

/// An agent seated to speak: an orchestrator (no `agent`), or a helper
/// speaking for the profile `agent`.
#[derive(Debug, Clone, Default)]
pub struct Seat {
    pub id: String,
    pub name: String,
    pub agent: Option<String>,
    /// The place an empty target means for it; none keeps the one it had.
    pub home: Option<String>,
}

/// A place as the chat keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub id: String,
    pub r#type: ChannelType,
    pub peer: Option<String>,
    pub parent: Option<String>,
    pub name: Option<String>,
    pub last_number: i64,
    /// A thread's message it hangs under: id and number.
    pub root: Option<(String, i64)>,
    /// What a thread is kept about: kind and id.
    pub topic: Option<(SubjectKind, String)>,
}

/// What a thread is opened about.
#[derive(Debug, Clone)]
pub struct ThreadSubject {
    pub kind: SubjectKind,
    pub id: String,
    pub owner: String,
}

/// A message just committed, with what the chat knows of where it was
/// said: what the layers above route on.
#[derive(Debug, Clone)]
pub struct Committed {
    pub event: EventRow,
    pub row: MsgRow,
    pub place: Place,
    /// The channel the place is in (a thread's parent's, a channel's own).
    pub channel_name: String,
    pub mentions: Vec<String>,
    pub channel_type: ChannelType,
    pub peer: Option<String>,
    /// The orchestrator in the channel the place is in.
    pub orchestrator: String,
    pub channel_members: Vec<String>,
    /// A thread's members.
    pub members: Vec<String>,
    pub topic: Option<(SubjectKind, String)>,
}

/// One committed event as a reader of the chat is told it.
#[derive(Debug, Clone)]
pub enum Told {
    Posted(Box<Committed>),
    Removed(EventRow),
}

/// The user's words.
#[derive(Debug, Clone, Default)]
pub struct Saying {
    pub text: String,
    /// A place's id, or a channel as the user names it; none is the default.
    pub channel: Option<String>,
    pub send_key: String,
    pub source: Option<String>,
    pub response_port: Option<String>,
    pub voice_mode: Option<String>,
    pub reply_to: Option<i64>,
    pub attachments: Vec<String>,
    pub picked: Option<Picked>,
    pub blocks: Vec<QuotedBlock>,
    /// Delivers only to this orchestrator.
    pub to: Option<String>,
}

/// What was made, shown on the message that says so.
#[derive(Debug, Clone)]
pub enum Made {
    Card(ArtifactCard),
    Attachments(Vec<String>),
}

/// Words written as `from` into a place.
#[derive(Debug, Clone, Default)]
pub struct Posting {
    pub from: String,
    pub channel: String,
    pub text: String,
    pub run: Option<String>,
    pub send_key: String,
    pub made: Option<Made>,
    pub spoken: bool,
}

/// The farm's own line in a place.
#[derive(Debug, Clone, Default)]
pub struct Noticing {
    pub channel: String,
    pub text: String,
    pub code: String,
    pub send_key: String,
    /// Once until the user next speaks there.
    pub until_user_speaks: bool,
}

/// A dispatch or report the farm writes for the layers above.
#[derive(Debug, Clone)]
pub struct Note {
    pub channel: String,
    pub from: String,
    pub kind: MessageKind,
    pub text: String,
    pub meta: Meta,
    pub topic: Option<ThreadSubject>,
    pub member: Option<String>,
    pub seat: Option<Seat>,
}

/// An agent's words in the chat.
#[derive(Debug, Clone, Default)]
pub struct Speaking {
    pub from: String,
    pub text: String,
    pub run: Option<String>,
    pub target: Option<String>,
    pub anyway: bool,
    pub confirm: bool,
    pub reply: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Spoken {
    Sent {
        message: Box<ChatMessage>,
        target: String,
        absent: Vec<String>,
    },
    Held {
        target: String,
        shown: Vec<AddressedMessage>,
        more: usize,
    },
    Confirm {
        target: String,
        last_read: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub target: Option<String>,
    pub unread: bool,
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub target: String,
    pub messages: Vec<AddressedMessage>,
    pub older: bool,
}

/// A channel as the agents see it.
#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repo: String,
    pub default: bool,
}

fn info_of(row: &ChannelRow) -> Info {
    Info {
        id: row.id.clone(),
        name: row.name.clone().unwrap_or_default(),
        description: row.description.clone().unwrap_or_default(),
        repo: row.repo.clone().unwrap_or_default(),
        default: row.is_default,
    }
}

struct Write {
    channel: String,
    from: String,
    kind: MessageKind,
    text: String,
    meta: Option<Meta>,
    thread: Option<ThreadSubject>,
    member: Option<String>,
    send_key: Option<String>,
    reply_to: Option<i64>,
    read_by: Option<String>,
}

impl Write {
    fn new(channel: &str, from: &str, kind: MessageKind, text: &str) -> Write {
        Write {
            channel: channel.into(),
            from: from.into(),
            kind,
            text: text.into(),
            meta: None,
            thread: None,
            member: None,
            send_key: None,
            reply_to: None,
            read_by: None,
        }
    }
}

struct Written {
    absent: Vec<String>,
    answers: Option<String>,
    thread: String,
    again: bool,
    row: MsgRow,
    event: Option<EventRow>,
}

type BeforePost<'a> = Box<dyn FnOnce(&mut SqliteConnection, &ChatMessage) -> Result<(), ApiError> + 'a>;

type Reader = Arc<dyn Fn(i64) -> Result<(), ApiError> + Send + Sync>;
type Guard = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;

/// The tables and the places in memory, under one lock (`locked`).
pub struct Inner {
    db: Connection,
    transaction_depth: usize,
    model: ChatModel,
}

/// A savepoint around `work`: on failure the tables and the model are as
/// they were. The outermost one takes the write lock at once: other modules
/// write to the same file, and a read that later wants to write would be
/// refused (`SQLITE_BUSY`) rather than wait.
fn tx<T>(inner: &mut Inner, work: impl FnOnce(&mut Inner) -> Result<T, ApiError>) -> Result<T, ApiError> {
    struct Savepoint<'a> {
        inner: &'a mut Inner,
        previous: Option<ChatModel>,
        undo: &'static str,
    }
    impl Drop for Savepoint<'_> {
        fn drop(&mut self) {
            self.inner.transaction_depth -= 1;
            if let Some(previous) = self.previous.take() {
                let _ = db::control(&self.inner.db, self.undo);
                self.inner.model = previous;
            }
        }
    }
    let (begin, commit, undo) = if inner.transaction_depth == 0 {
        ("begin immediate", "commit", "rollback")
    } else {
        ("savepoint chat", "release chat", "rollback to chat; release chat")
    };
    let previous = inner.model.clone();
    db::control(&inner.db, begin).q()?;
    inner.transaction_depth += 1;
    let mut guard = Savepoint {
        inner,
        previous: Some(previous),
        undo,
    };
    let value = work(guard.inner)?;
    db::control(&guard.inner.db, commit).q()?;
    guard.previous = None;
    Ok(value)
}

impl Inner {
    // ----- store.ts -----

    fn add_member(&mut self, channel: &str, participant: &str, reason: &str, from: i64) -> Result<(), ApiError> {
        db::add_member(&self.db, channel, participant, reason, from).q()?;
        self.model.member_added(channel, participant);
        Ok(())
    }

    fn upsert_participant(&mut self, p: ParticipantRow) -> Result<(), ApiError> {
        db::upsert_participant(&self.db, &p).q()?;
        self.model.joined(p);
        Ok(())
    }

    /// An agent's seat as it goes now; one already so is left as it is.
    fn seat(&mut self, p: &Seat) -> Result<(), ApiError> {
        if let Some(held) = self.model.participant(&p.id)
            && held.kind == "agent"
            && held.name == p.name
            && held.agent_id == p.agent
            && held.left_at.is_none()
            && p.home.as_ref().is_none_or(|h| Some(h) == held.home_id.as_ref())
        {
            return Ok(());
        }
        self.upsert_participant(ParticipantRow {
            id: p.id.clone(),
            kind: "agent".into(),
            name: p.name.clone(),
            agent_id: p.agent.clone(),
            home_id: p.home.clone(),
            joined_at: now(),
            left_at: None,
        })
    }

    fn set_read(&mut self, who: &str, channel: &str, upto: i64, at: i64) -> Result<(), ApiError> {
        db::set_read_cursor(&self.db, who, channel, upto, at).q()?;
        if who == USER_ID {
            self.model.user_read_to(channel, upto);
        }
        Ok(())
    }

    fn touch_channel(&mut self, id: &str, number: i64) -> Result<(), ApiError> {
        db::touch_channel(&self.db, id, number).q()?;
        self.model.touched(id, number);
        Ok(())
    }

    /// The thread under a message, made if there is none.
    fn thread_for(&mut self, root_id: &str, root_number: i64, channel: &str, subject: &ThreadSubject) -> Result<String, ApiError> {
        if let Some(existing) = self.model.thread_of_root(root_id).filter(|t| !t.is_empty()) {
            return Ok(existing.to_string());
        }
        let id = new_id();
        let at = now();
        let subject_id = (!subject.id.is_empty()).then_some(subject.id.as_str());
        db::create_thread(&self.db, &id, root_id, root_number, subject.kind.as_str(), subject_id, channel, at).q()?;
        self.model.created(ChannelRow {
            root_id: Some(root_id.into()),
            root_number: Some(root_number),
            subject_kind: Some(subject.kind.as_str().into()),
            subject_id: subject_id.map(str::to_string),
            parent_id: Some(channel.into()),
            ..ChannelRow::empty(&id, "thread", at)
        });
        if !subject.owner.is_empty() {
            self.add_member(&id, &subject.owner, "user", root_number)?;
        }
        Ok(id)
    }

    // ----- hub.ts -----

    fn is_orchestrator_seat(&self, id: &str) -> bool {
        self.model
            .participant(id)
            .is_some_and(|p| p.kind == "agent" && p.agent_id.is_none() && p.left_at.is_none())
    }

    fn orchestrator_seats(&self) -> Vec<String> {
        self.model
            .participants()
            .iter()
            .filter(|p| self.is_orchestrator_seat(&p.id))
            .map(|p| p.id.clone())
            .collect()
    }

    fn top_of_row<'a>(&'a self, row: Option<&'a ChannelRow>) -> Option<&'a ChannelRow> {
        match row {
            Some(r) if r.r#type == "thread" => self.top_of_row(r.parent_id.as_deref().and_then(|p| self.model.channel(p))),
            other => other,
        }
    }

    fn members_of_row(&self, row: Option<&ChannelRow>) -> Vec<String> {
        match self.top_of_row(row) {
            Some(top) if top.r#type != "direct" => self.model.members_of(&top.id),
            _ => vec![],
        }
    }

    /// The orchestrator a place's unaddressed words go to.
    fn orchestrator_in_row(&self, row: Option<&ChannelRow>) -> String {
        if let Some(top) = self.top_of_row(row)
            && top.r#type == "direct"
        {
            return top
                .peer_id
                .clone()
                .filter(|p| self.is_orchestrator_seat(p))
                .unwrap_or_else(|| DEFAULT_ORCHESTRATOR.into());
        }
        let members = self.members_of_row(row);
        if members.iter().any(|m| m == DEFAULT_ORCHESTRATOR) {
            return DEFAULT_ORCHESTRATOR.into();
        }
        members
            .into_iter()
            .find(|m| self.is_orchestrator_seat(m))
            .unwrap_or_else(|| DEFAULT_ORCHESTRATOR.into())
    }

    fn orchestrator_in(&self, id: &str) -> String {
        self.orchestrator_in_row(self.model.channel(id))
    }

    fn channel_name(&self, id: &str) -> Option<String> {
        self.model.channel(id).filter(|c| c.r#type != "thread").and_then(|c| c.name.clone())
    }

    fn channel_tags(&self) -> String {
        let mut named: Vec<&ChannelRow> = vec![];
        let all = self.model.channels("channel");
        for c in &all {
            if c.name.is_some() {
                named.push(c);
            }
        }
        named.sort_by(|a, b| a.id.cmp(&b.id));
        list(&named.iter().map(|c| format!("#{}", c.name.as_deref().unwrap_or(""))).collect::<Vec<_>>())
    }

    fn direct_with(&self, who: &str, other: &str) -> Option<ChannelRow> {
        let peer = if who == USER_ID {
            other
        } else if other == USER_ID {
            who
        } else {
            ""
        };
        self.model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer))
    }

    fn target_of_row(&self, kind: &str, root_number: Option<i64>, name: Option<&str>, channel_id: Option<&str>, channel_name_of: Option<&str>) -> String {
        let shown = name.or(channel_name_of);
        let channel = channel_name_of
            .map(str::to_string)
            .or_else(|| channel_id.and_then(|c| self.channel_name(c)))
            .unwrap_or_default();
        words::target_of(kind, root_number, shown, &channel)
    }

    fn target_of_channel(&self, row: &ChannelRow) -> String {
        self.target_of_row(&row.r#type, row.root_number, row.name.as_deref(), row.parent_id.as_deref(), None)
    }

    fn to_channel(&self, row: &ChannelRow, unread: i64, title: String, last: Option<&MsgRow>) -> Channel {
        Channel {
            id: row.id.clone(),
            r#type: channel_type(&row.r#type),
            default: row.is_default,
            peer: row.peer_id.clone(),
            orchestrator: Some(self.orchestrator_in_row(Some(row))),
            members: (row.r#type != "direct").then(|| self.model.members_of(&row.id)),
            parent: row.parent_id.clone(),
            category: row.category.clone().unwrap_or_default(),
            position: row.position,
            archived: row.archived_at,
            notify: notify_of(&row.notify),
            root: row.root_id.clone(),
            root_number: row.root_number,
            name: row.name.clone(),
            description: row.description.clone().unwrap_or_default(),
            repo: row.repo.clone(),
            subject_kind: subject_kind(row.subject_kind.as_deref()),
            subject_id: row.subject_id.clone(),
            last_number: row.last_number,
            replies: row.reply_count,
            read: self.model.user_read_in(&row.id),
            unread: (unread > 0).then_some(unread),
            title,
            last: last.map(|m| ChannelLast {
                from: m.sender_id.clone(),
                name: m.sender_name.clone(),
                text: line_of(&m.body, LAST_MAX),
                at: m.created_at,
            }),
            at: row.created_at,
        }
    }

    /// `counted`: a channel as a page lists it, with the user's unread and
    /// a title.
    fn counted(&self, row: &ChannelRow) -> Result<Channel, ApiError> {
        let n = match row.notify.as_str() {
            "none" => 0,
            "mentions" => db::user_mentions(&self.db).q()?.iter().filter(|m| m.row.channel_id == row.id).count() as i64,
            _ => db::user_unread(&self.db, &row.id, self.model.user_read_in(&row.id).unwrap_or(0)).q()?,
        };
        let sk = row.subject_kind.as_deref();
        let mut title = String::new();
        if row.r#type == "thread" && row.name.as_deref().is_some_and(|n| !n.is_empty()) {
            title = row.name.clone().unwrap_or_default();
        } else if row.r#type == "direct"
            && let Some(peer) = &row.peer_id
        {
            title = self.model.participant(peer).map(|p| p.name.clone()).unwrap_or_default();
        } else if row.r#type == "thread"
            && sk == Some("talk")
            && let Some(s) = &row.subject_id
        {
            title = self.model.participant(s).map(|p| p.name.clone()).unwrap_or_default();
        }
        if title.is_empty()
            && row.r#type == "thread"
            && let Some(root) = &row.root_id
        {
            let body = db::message_by_id(&self.db, root).q()?.map(|m| m.body).unwrap_or_default();
            title = line_of(&body, THREAD_TITLE_MAX);
        }
        let last = match row.last_number {
            Some(n) if n != 0 => db::message_by_number(&self.db, &row.id, n).q()?,
            _ => None,
        };
        Ok(self.to_channel(row, n, title, last.as_ref()))
    }

    fn home_of(&self, participant: &str) -> Option<String> {
        self.model
            .participant(participant)
            .and_then(|p| p.home_id.clone())
            .filter(|h| self.model.channel(h).is_some())
    }

    fn place_of(&self, row: &ChannelRow) -> Place {
        Place {
            id: row.id.clone(),
            r#type: channel_type(&row.r#type),
            peer: row.peer_id.clone(),
            parent: row.parent_id.clone(),
            name: row.name.clone(),
            last_number: row.last_number.unwrap_or(0),
            root: row.root_id.clone().zip(row.root_number),
            topic: subject_kind(row.subject_kind.as_deref()).zip(row.subject_id.clone()),
        }
    }

    fn addressed_of(&self, row: &MsgRow, files: &Attachments) -> AddressedMessage {
        let meta = meta_of(row.meta.as_deref());
        let gone = row.deleted_at.is_some_and(|d| d != 0);
        let attached = meta.attachments.unwrap_or_default();
        AddressedMessage {
            id: row.id.clone(),
            number: row.number,
            target: self.model.channel(&row.channel_id).map(|p| self.target_of_channel(p)).unwrap_or_default(),
            from: row.sender_id.clone(),
            actor: actor_of(&row.sender_kind, row.sender_agent.as_deref(), &row.sender_id, Some(&row.sender_name)),
            name: row.sender_name.clone(),
            text: row.body.clone(),
            reply_to: row.reply_number,
            edited: row.edited_at.is_some_and(|e| e != 0).then_some(true),
            deleted: gone.then_some(true),
            attachments: (!attached.is_empty()).then(|| {
                attached
                    .iter()
                    .map(|f| FileAt {
                        name: f.name.clone(),
                        path: files.path_of(&f.id).to_string_lossy().into_owned(),
                    })
                    .collect()
            }),
            artifact: meta.artifact.filter(|_| !gone).map(|a| ArtifactRef {
                id: a.id,
                title: a.title,
                version: a.version,
            }),
            blocks: meta.blocks.filter(|b| !b.is_empty() && !gone),
            picked: meta.picked,
            response_port: meta.response_port.filter(|s| !s.is_empty()),
            voice_mode: meta.voice_mode.filter(|s| !s.is_empty()),
        }
    }

    /// A participant's unread: the channel given, or the one its home is
    /// in (else the default), and the threads it follows.
    fn unread_of(&self, who: &str, in_channel: Option<&str>) -> Result<Vec<ChannelUnread>, ApiError> {
        let channel = in_channel
            .map(str::to_string)
            .or_else(|| self.home_of(who).and_then(|h| self.top_of_row(self.model.channel(&h)).map(|t| t.id.clone())))
            .unwrap_or_else(|| self.model.default_id());
        Ok(db::unread_of(&self.db, who, &channel)
            .q()?
            .into_iter()
            .map(|r| ChannelUnread {
                channel: words::target_of(&r.r#type, r.root_number, None, &r.channel_name),
                unread: r.unread,
                mentions_you: r.mentions_you,
                latest: r.latest_sender_name.filter(|n| !n.is_empty()),
            })
            .collect())
    }

    /// `resolveTarget`: an address as `who` would mean it.
    fn resolve_target(&mut self, who: &str, target: &str) -> Result<(String, Option<String>), ApiError> {
        if target.trim().is_empty() {
            return Ok((self.home_of(who).unwrap_or_else(|| self.model.default_id()), None));
        }
        let parsed = words::parse_chat_target(target).ok_or_else(|| refused(t("server.channel.badTarget", &[("target", target.into())])))?;
        let root = match parsed {
            ChatTarget::Direct(peer) => {
                let direct = self
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
        let mut channel = self.model.default_id();
        if !name.is_empty() {
            let found = self.model.channel_by_name(name).ok_or_else(|| {
                missing(
                    t("server.channel.noChannelNamed", &[("name", name.into()), ("tags", self.channel_tags().into())]),
                    LookIn::Channel,
                )
            })?;
            channel = found.id.clone();
        }
        let Some(root) = root else { return Ok((channel, None)) };
        let row = db::message_by_number(&self.db, &channel, root)
            .q()?
            .ok_or_else(|| refused(t("server.channel.noMessage", &[("n", root.into())])))?;
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = tx(self, |me| me.thread_for(&row.id, row.number, &row.channel_id, &talk))?;
        Ok((thread.clone(), Some(thread)))
    }

    fn answered(&self, channel: &str, number: Option<i64>) -> Result<(), ApiError> {
        if let Some(n) = number
            && db::message_by_number(&self.db, channel, n).q()?.is_none()
        {
            return Err(refused(t("server.channel.noMessage", &[("n", n.into())])));
        }
        Ok(())
    }

    fn message_of(&self, id: &str) -> Result<MsgRow, ApiError> {
        db::message_by_id(&self.db, id)
            .q()?
            .ok_or_else(|| missing(t("server.channel.noMessageId", &[("id", id.into())]), LookIn::Channel))
    }

    // ----- writing.ts -----

    /// `settle`: who a message names, and who follows the thread from it.
    fn settle(&mut self, inserted: MsgRow) -> Result<(MsgRow, Vec<String>), ApiError> {
        let mut row = inserted;
        let ch = self
            .model
            .channel(&row.channel_id)
            .cloned()
            .ok_or_else(|| internal(format!("no channel {}", row.channel_id)))?;
        let mut meta = meta_of(row.meta.as_deref());
        let orchestrators = self.orchestrator_seats();
        let here = self.orchestrator_in_row(Some(&ch));
        let mentions = if ch.r#type == "direct" {
            vec![]
        } else {
            words::mentions_in(
                &row.body,
                &Nameable {
                    here: &here,
                    orchestrators: &orchestrators,
                },
            )
        };
        let helper = |p: &ParticipantRow| p.kind == "agent" && p.agent_id.is_some() && p.left_at.is_none();
        let present: Vec<String> = self.model.participants().iter().filter(|p| helper(p)).map(|p| p.id.clone()).collect();
        let mut named: Vec<(String, &str)> = vec![];
        for m in &mentions {
            let how = if orchestrators.contains(m) || m == USER_ID || m == EVERYONE || present.contains(m) {
                "delivered"
            } else if self.model.participant(m).is_some() {
                "absent"
            } else {
                "unknown"
            };
            db::insert_mention(&self.db, &row.id, m, how).q()?;
            named.push((m.clone(), how));
        }
        if !mentions.is_empty() {
            meta.mentions = Some(mentions);
            row.meta = meta_text(Some(&meta));
            db::update_message_meta(&self.db, &row.id, row.meta.as_deref()).q()?;
        }
        if ch.r#type == "thread" {
            // A dispatch handing the issue on makes no one a member: the orchestrator would be woken by every word in it.
            if row.sender_id != "system" && row.kind != "dispatch" {
                self.add_member(&ch.id, &row.sender_id, "replied", row.number)?;
            }
            for (m, how) in &named {
                if *how == "delivered" && (orchestrators.contains(m) || present.contains(m)) {
                    self.add_member(&ch.id, m, "mentioned", row.number - 1)?;
                }
            }
        }
        let absent = named.into_iter().filter(|(_, how)| *how != "delivered").map(|(m, _)| m).collect();
        Ok((row, absent))
    }

    fn committed_from(&self, row: &MsgRow, event: &EventRow) -> Option<Committed> {
        let ch = self.model.channel(&row.channel_id)?;
        let topic = if ch.r#type != "channel" {
            subject_kind(ch.subject_kind.as_deref()).zip(ch.subject_id.clone())
        } else {
            None
        };
        Some(Committed {
            event: event.clone(),
            row: row.clone(),
            place: self.place_of(ch),
            channel_name: ch
                .parent_id
                .as_deref()
                .and_then(|p| self.model.channel(p))
                .and_then(|p| p.name.clone())
                .or_else(|| ch.name.clone())
                .unwrap_or_default(),
            mentions: meta_of(row.meta.as_deref()).mentions.unwrap_or_default(),
            channel_type: channel_type(&ch.r#type),
            peer: ch.peer_id.clone(),
            orchestrator: self.orchestrator_in_row(Some(ch)),
            channel_members: self.members_of_row(Some(ch)),
            members: if ch.r#type == "thread" { self.model.members_of(&ch.id) } else { vec![] },
            topic,
        })
    }

    /// `answersOf`: a helper's words answer the session that last named it
    /// there since it last spoke.
    fn answers_of(&self, row: &MsgRow) -> Result<Option<String>, ApiError> {
        if row.kind != "chat" || row.sender_kind != "agent" || self.is_orchestrator_seat(&row.sender_id) {
            return Ok(None);
        }
        let callers = db::callers_of(&self.db, &row.sender_id, &row.channel_id, &row.id, CALLERS_MAX).q()?;
        Ok(callers
            .into_iter()
            .find(|c| self.model.participant(c).is_some_and(|p| p.kind == "agent" && p.agent_id.is_some())))
    }
}

type Seater = Arc<dyn Fn(&str) + Send + Sync>;

/// The chat.
pub struct Chat {
    hub: Weak<Hub>,
    files: Arc<Attachments>,
    inner: Mutex<Inner>,
    me: Weak<Chat>,
    said: Mutex<Vec<flume::Sender<ChatMessage>>>,
    told: Mutex<Vec<flume::Sender<Told>>>,
    user_reads: Mutex<Vec<flume::Sender<(String, i64, i64)>>>,
    readers: RwLock<Vec<Reader>>,
    guards: RwLock<Vec<Guard>>,
    seaters: RwLock<Vec<Seater>>,
    /// Link previews are read off the web; tests turn it off.
    embeds: bool,
    /// The blocks a message quotes, as they are now (the artifact module's).
    quoter: RwLock<Option<Quoter>>,
}

/// Snapshots of quoted artifact blocks (`quoteBlocks`).
pub type Quoter = Arc<dyn Fn(&[vibevalley_protocol::BlockRef]) -> Vec<QuotedBlock> + Send + Sync>;

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
            }),
            me: me.clone(),
            said: Mutex::default(),
            told: Mutex::default(),
            user_reads: Mutex::default(),
            readers: RwLock::default(),
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
            Ok(Written {
                absent,
                answers: None,
                thread,
                again: false,
                row,
                event: Some(event),
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
            publish(&self.told, &Told::Posted(Box::new(posted)));
        }
        Ok(written)
    }

    /// `handled`: every reader has handled the write's event.
    fn handled(&self, event: Option<&EventRow>) -> Result<(), ApiError> {
        let Some(event) = event else { return Ok(()) };
        let readers = self.readers.read().unwrap_or_else(|e| e.into_inner()).clone();
        for reader in readers {
            reader(event.seq)?;
        }
        Ok(())
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

    // ----- the user's words and the agents' (channel.ts) -----

    /// `say`: the user's words in a place; the farm goes live.
    pub fn say(&self, s: Saying) -> Result<(ChatMessage, bool), ApiError> {
        let written = {
            let mut inner = self.locked();
            if let Some(hub) = self.hub.upgrade()
                && hub.read(|st| st.call != CallState::Live)
            {
                hub.apply(vec![Fact::CallChanged(FactCallChanged {
                    at: now(),
                    state: CallState::Live,
                    reason: String::new(),
                })]);
            }
            let files = self.files.of(&s.attachments)?;
            if s.text.trim().is_empty() && files.is_empty() {
                return Err(refused(t("server.channel.empty", &[])));
            }
            if s.send_key.encode_utf16().count() > SEND_KEY_MAX {
                return Err(refused(t("server.channel.sendKeyLong", &[])));
            }
            if let Some(to) = &s.to
                && !inner.is_orchestrator_seat(to)
            {
                return Err(refused(t("server.channel.notOrchestrator", &[("id", to.as_str().into())])));
            }
            let mut opened = None;
            let place = match &s.channel {
                None => inner.model.default_id(),
                Some(c) if inner.model.channel(c).is_some() => c.clone(),
                Some(c) => {
                    let (place, thread) = inner.resolve_target(USER_ID, c)?;
                    opened = thread;
                    place
                }
            };
            if let Some(thread) = opened {
                self.publish_channel(&inner, &thread)?;
            }
            if inner.model.channel(&place).is_none() {
                return Err(no_channel(&place));
            }
            inner.answered(&place, s.reply_to)?;
            let picked = Picked {
                agent: s.picked.as_ref().and_then(|p| p.agent.clone()).filter(|a| !a.is_empty()),
                repo: s
                    .picked
                    .as_ref()
                    .and_then(|p| p.repo.as_deref())
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string),
            };
            let voice = s.source.as_deref() == Some("voice");
            let meta = Meta {
                ingress_recipient: s.to.clone(),
                attachments: (!files.is_empty()).then_some(files),
                picked: (picked.agent.is_some() || picked.repo.is_some()).then_some(picked),
                blocks: (!s.blocks.is_empty()).then(|| s.blocks.clone()),
                ingress_source: s.source.clone(),
                spoken: voice.then_some(true),
                response_port: s.response_port.clone(),
                voice_mode: s.voice_mode.clone(),
                ..Meta::default()
            };
            let empty = meta == Meta::default();
            let written = self.write(
                &mut inner,
                Write {
                    send_key: Some(s.send_key.clone()),
                    read_by: Some(USER_ID.into()),
                    reply_to: s.reply_to,
                    meta: (!empty).then_some(meta),
                    ..Write::new(&place, USER_ID, MessageKind::Chat, s.text.trim())
                },
            )?;
            if !written.again
                && !written.absent.is_empty()
                && let Some(hub) = self.hub.upgrade()
            {
                let who: Vec<String> = written.absent.iter().map(|m| words::mention_of(m).unwrap_or_else(|| format!("@{m}"))).collect();
                hub.notice(
                    NoticeLevel::Warn,
                    t("server.channel.absent", &[("who", list(&who).into()), ("n", written.absent.len().into())]),
                );
            }
            written
        };
        self.handled(written.event.as_ref())?;
        Ok((to_message(&written.row), written.again))
    }

    /// `speak`: an agent's words. A retry of the same words is the same
    /// message; newer words it has not seen are shown instead (held); a
    /// channel right after reading a thread elsewhere is confirmed once.
    pub fn speak(&self, s: Speaking) -> Result<Spoken, ApiError> {
        self.prepare_seat(&s.from);
        let event;
        let spoken = {
            let mut inner = self.locked();
            let text = s.text.trim();
            if text.is_empty() {
                return Err(refused(t("server.channel.empty", &[])));
            }
            let (channel, opened) = inner.resolve_target(&s.from, s.target.as_deref().unwrap_or(""))?;
            if let Some(thread) = opened {
                self.publish_channel(&inner, &thread)?;
            }
            let row = inner
                .model
                .channel(&channel)
                .cloned()
                .ok_or_else(|| refused(t("server.channel.channelGone", &[])))?;
            let target = inner.target_of_channel(&row);
            if let Some(again) = db::recent_duplicate(&inner.db, &s.from, &channel, text, now() - RETRY_WINDOW_MS).q()?
                && let Some(m) = db::message_by_id(&inner.db, &again).q()?
            {
                return Ok(Spoken::Sent {
                    message: Box::new(to_message(&m)),
                    target,
                    absent: vec![],
                });
            }
            let last = inner.model.last_read.get(&s.from).cloned().unwrap_or_default();
            if row.r#type != "thread" && !s.confirm && !last.is_empty() && last != target {
                return Ok(Spoken::Confirm { target, last_read: last });
            }
            let unseen = db::unseen_in(&inner.db, &channel, &s.from).q()?;
            if !unseen.is_empty() && !s.anyway {
                let mut shown = vec![];
                for id in unseen.iter().take(HELD_SHOWN) {
                    if let Some(m) = db::message_by_id(&inner.db, id).q()? {
                        shown.push(inner.addressed_of(&m, &self.files));
                    }
                }
                if let Some(newest) = shown.last() {
                    let n = newest.number;
                    tx(&mut inner, |me| me.set_read(&s.from, &channel, n, now()))?;
                }
                let more = unseen.len() - shown.len();
                return Ok(Spoken::Held { target, shown, more });
            }
            inner.answered(&channel, s.reply)?;
            let written = self.write(
                &mut inner,
                Write {
                    reply_to: s.reply,
                    meta: Some(Meta {
                        run: s.run.clone(),
                        ..Meta::default()
                    }),
                    ..Write::new(&channel, &s.from, MessageKind::Chat, text)
                },
            )?;
            let n = written.row.number;
            tx(&mut inner, |me| me.set_read(&s.from, &channel, n, now()))?;
            event = written.event.clone();
            Spoken::Sent {
                message: Box::new(to_message(&written.row)),
                target,
                absent: written.absent,
            }
        };
        self.handled(event.as_ref())?;
        Ok(spoken)
    }

    /// `post`: words written as `from` into a place; the speaker has read
    /// the place up to them.
    pub fn post(&self, p: Posting) -> Result<(ChatMessage, bool), ApiError> {
        self.post_storing(p, None)
    }

    /// A new card and its owner row share this connection until commit. A repeated send key skips the callback.
    pub(crate) fn post_with(
        &self,
        p: Posting,
        persist: impl FnOnce(&mut SqliteConnection, &ChatMessage) -> Result<(), ApiError>,
    ) -> Result<(ChatMessage, bool), ApiError> {
        self.post_storing(p, Some(Box::new(persist)))
    }

    fn post_storing(&self, p: Posting, persist: Option<BeforePost<'_>>) -> Result<(ChatMessage, bool), ApiError> {
        let written = {
            let mut inner = self.locked();
            if p.send_key.encode_utf16().count() > SEND_KEY_MAX {
                return Err(refused(t("server.channel.sendKeyLong", &[])));
            }
            if p.text.trim().is_empty() && p.made.is_none() {
                return Err(refused(t("server.channel.empty", &[])));
            }
            let place = if inner.model.channel(&p.channel).is_some() {
                p.channel.clone()
            } else {
                let (place, opened) = inner.resolve_target(&p.from, &p.channel)?;
                if let Some(thread) = opened {
                    self.publish_channel(&inner, &thread)?;
                }
                place
            };
            if inner.model.channel(&place).is_none() {
                return Err(refused(t("server.channel.channelGone", &[])));
            }
            let mut meta = Meta {
                run: p.run.clone(),
                spoken: p.spoken.then_some(true),
                ..Meta::default()
            };
            match &p.made {
                Some(Made::Card(card)) => meta.artifact = Some(card.clone()),
                Some(Made::Attachments(ids)) => meta.attachments = Some(self.files.of(ids)?),
                None => {}
            }
            self.write_with(
                &mut inner,
                Write {
                    meta: Some(meta),
                    send_key: Some(p.send_key.clone()),
                    read_by: Some(p.from.clone()),
                    ..Write::new(&place, &p.from, MessageKind::Chat, p.text.trim())
                },
                persist,
            )?
        };
        self.handled(written.event.as_ref())?;
        Ok((to_message(&written.row), written.again))
    }

    /// `notice`: the farm's line; best effort, never fails, wakes no one.
    pub fn notice(&self, n: Noticing) {
        let mut inner = self.locked();
        if n.until_user_speaks && db::notice_since_user(&inner.db, &n.channel, &n.code).unwrap_or(0) > 0 {
            return;
        }
        let w = Write {
            meta: Some(Meta {
                code: Some(n.code),
                ..Meta::default()
            }),
            send_key: Some(n.send_key),
            ..Write::new(&n.channel, "system", MessageKind::Notice, &n.text)
        };
        if let Err(e) = self.write(&mut inner, w) {
            eprintln!("vibevalley-server: chat: notice: {}", e.message);
        }
    }

    /// `note`: a dispatch or report; `topic` opens the place's thread about
    /// it under the note.
    pub fn note(&self, n: Note) -> Result<String, ApiError> {
        self.note_once(n, None)
    }

    pub(crate) fn note_once(&self, n: Note, key: Option<String>) -> Result<String, ApiError> {
        let written = {
            let mut inner = self.locked();
            if let Some(seat) = &n.seat {
                tx(&mut inner, |me| me.seat(seat))?;
            }
            let written = self.write(
                &mut inner,
                Write {
                    meta: Some(n.meta),
                    send_key: key,
                    thread: n.topic,
                    member: n.member,
                    ..Write::new(&n.channel, &n.from, n.kind, &n.text)
                },
            )?;
            if let Some(mut seat) = n.seat {
                if seat.home.is_none() && !written.thread.is_empty() {
                    seat.home = Some(written.thread.clone());
                }
                let at = now();
                tx(&mut inner, |me| {
                    me.seat(&seat)?;
                    me.set_read(&seat.id, &n.channel, written.row.number, at)
                })?;
            }
            written
        };
        self.handled(written.event.as_ref())?;
        Ok(written.thread)
    }

    /// `edit`: the user's own words, changed; nobody is woken.
    pub fn edit(&self, id: &str, text: &str, keep: Option<&[String]>) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if row.sender_id != USER_ID || row.kind != "chat" || row.deleted_at.is_some() {
            return Err(refused(t("server.channel.notYours", &[])));
        }
        let mut meta = meta_of(row.meta.as_deref());
        let had = meta.attachments.clone().unwrap_or_default();
        let files: Vec<Attachment> = match keep {
            None => had.clone(),
            Some(keep) => had.iter().filter(|a| keep.contains(&a.id)).cloned().collect(),
        };
        let words = text.trim().to_string();
        if words.is_empty() && files.is_empty() {
            return Err(refused(t("server.channel.empty", &[])));
        }
        if words == row.body && files.len() == had.len() {
            return Ok(to_message(&row));
        }
        let files_changed = files.len() != had.len();
        meta.attachments = Some(files);
        let text_meta = meta_text(Some(&meta));
        let changed = self.change(&mut inner, &row, |db, revision, at| {
            db::edit_message(db, id, &words, at, revision)?;
            if files_changed {
                db::set_meta(db, id, text_meta.as_deref(), revision)?;
            }
            Ok(())
        })?;
        if words != row.body {
            self.embed_later(&MsgRow { body: words.clone(), ..row });
        }
        Ok(changed)
    }

    /// `remove`: its words go, its number stays.
    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        let event = {
            let mut inner = self.locked();
            let row = inner.message_of(id)?;
            if row.deleted_at.is_some() {
                return Err(refused(t("server.channel.messageGone", &[])));
            }
            let mut seq = 0;
            let mut at = 0;
            self.change(&mut inner, &row, |db, revision, now| {
                db::delete_message(db, id, now, revision)?;
                seq = db::insert_event(db, "removed", &row.channel_id, id, now)?;
                at = now;
                Ok(())
            })?;
            let event = EventRow {
                seq,
                kind: "removed".into(),
                channel_id: row.channel_id.clone(),
                message_id: id.into(),
                at,
            };
            publish(&self.told, &Told::Removed(event.clone()));
            event
        };
        self.handled(Some(&event))
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.locked();
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        let target = inner.model.channel(&row.channel_id).map(|c| inner.target_of_channel(c)).unwrap_or_default();
        Ok(Preview {
            does: vec![t(
                "server.channel.deletes",
                &[
                    ("target", target.into()),
                    ("number", row.number.into()),
                    ("name", row.sender_name.as_str().into()),
                    ("text", line_of(&row.body, LAST_MAX).into()),
                ],
            )],
        })
    }

    /// `reacting`: setting a reaction as it already is writes nothing.
    pub fn react(&self, id: &str, who: &str, emoji: &str, on: bool) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let e = emoji.trim();
        let fits = !e.is_empty() && e.chars().count() <= 16 && !e.chars().any(char::is_whitespace);
        if !fits {
            return Err(refused(t("server.channel.badEmoji", &[])));
        }
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        let mut r = reactions_of(row.reactions.as_deref());
        let at = r.iter().position(|(k, _)| k == e);
        let by = at.map(|i| r[i].1.clone()).unwrap_or_default();
        if by.iter().any(|b| b == who) == on {
            return Ok(to_message(&row));
        }
        let next: Vec<String> = if on {
            by.into_iter().chain([who.to_string()]).collect()
        } else {
            by.into_iter().filter(|b| b != who).collect()
        };
        match at {
            Some(i) => r[i].1 = next,
            None => r.push((e.to_string(), next)),
        }
        let text = reactions_text(&r);
        self.change(&mut inner, &row, |db, revision, _| db::set_reactions(db, id, text.as_deref(), revision))
    }

    pub fn pin(&self, id: &str, on: bool) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        if row.pinned_at.is_some() == on {
            return Ok(to_message(&row));
        }
        self.change(&mut inner, &row, |db, revision, at| db::set_pinned(db, id, on.then_some(at), revision))
    }

    pub fn pins(&self, channel: &str) -> Result<Vec<ChatMessage>, ApiError> {
        let inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        Ok(db::pinned_in(&inner.db, channel).q()?.iter().map(to_message).collect())
    }

    /// `threadUnder`: the thread under a message in a channel, made if
    /// there is none.
    pub fn thread_under(&self, id: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if inner.model.channel(&row.channel_id).is_none_or(|c| c.r#type != "channel") {
            return Err(refused(t("server.channel.threadOnlyInChannel", &[])));
        }
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = tx(&mut inner, |me| me.thread_for(&row.id, row.number, &row.channel_id, &talk))?;
        self.publish_channel(&inner, &thread)?;
        Ok(thread)
    }

    /// `issueThread`: the issue's thread, opened under a notice in
    /// `channel` (else the default) when there is none.
    pub fn issue_thread(&self, issue: &str, title: &str, channel: Option<&str>) -> Result<String, ApiError> {
        let written = {
            let mut inner = self.locked();
            if let Some(existing) = inner.model.thread_of_subject("issue", issue) {
                return Ok(existing.to_string());
            }
            let place = channel.map(str::to_string).unwrap_or_else(|| inner.model.default_id());
            if inner.model.channel(&place).is_none_or(|c| c.r#type != "channel") {
                return Err(refused(t("server.channel.threadOnlyInChannel", &[])));
            }
            self.write(
                &mut inner,
                Write {
                    thread: Some(ThreadSubject {
                        kind: SubjectKind::Issue,
                        id: issue.into(),
                        owner: String::new(),
                    }),
                    ..Write::new(&place, "system", MessageKind::Notice, title)
                },
            )?
        };
        self.handled(written.event.as_ref())?;
        Ok(written.thread)
    }

    pub fn issue_thread_id(&self, issue: &str) -> Option<String> {
        self.locked().model.thread_of_subject("issue", issue).map(str::to_string)
    }

    /// The newest 50 messages of an issue's thread.
    pub fn issue_messages(&self, issue: &str) -> Result<Vec<AddressedMessage>, ApiError> {
        let Some(thread) = self.issue_thread_id(issue) else { return Ok(vec![]) };
        self.recent(&thread, 50)
    }

    fn recent(&self, channel: &str, n: i64) -> Result<Vec<AddressedMessage>, ApiError> {
        let inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Ok(vec![]);
        }
        let mut rows = db::messages_before(&inner.db, channel, NO_NUMBER, n).q()?;
        rows.reverse();
        Ok(rows.iter().map(|r| inner.addressed_of(r, &self.files)).collect())
    }

    pub fn search(&self, text: &str, channel: Option<&str>) -> Result<Vec<MessageHit>, ApiError> {
        let q = words::parse_search(text);
        if q.words.is_empty() && q.from.is_none() && q.r#in.is_none() && q.has.is_empty() && q.before.is_none() && q.after.is_none() {
            return Err(refused(t("server.channel.empty", &[])));
        }
        let inner = self.locked();
        let mut scope = channel.unwrap_or("").to_string();
        if let Some(name) = &q.r#in {
            let named = inner.model.channel_by_name(name).ok_or_else(|| {
                missing(
                    t(
                        "server.channel.noChannelNamed",
                        &[("name", name.as_str().into()), ("tags", inner.channel_tags().into())],
                    ),
                    LookIn::Channel,
                )
            })?;
            scope = named.id.clone();
        }
        let rows = db::search_messages(
            &inner.db,
            &db::SearchParams {
                text: &q.words,
                channel: &scope,
                sender: q.from.as_deref().unwrap_or(""),
                has_file: q.has.contains(&Has::File),
                has_image: q.has.contains(&Has::Image),
                has_link: q.has.contains(&Has::Link),
                after: q.after.unwrap_or(0),
                before: q.before.unwrap_or(i64::MAX),
                n: SEARCH_MAX,
            },
        )
        .q()?;
        Ok(rows
            .into_iter()
            .map(|r| MessageHit {
                message: to_message(&r.row),
                channel: r.top_id.clone(),
                address: inner.target_of_row(&r.channel_type, r.root_number, None, Some(&r.top_id), Some(&r.channel_name)),
            })
            .collect())
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

    /// `placeOf`: a place's id, or an address as `from` would say it.
    pub fn place_of(&self, from: &str, channel: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_some() {
            return Ok(channel.into());
        }
        let (place, opened) = inner.resolve_target(from, channel)?;
        if let Some(thread) = opened {
            self.publish_channel(&inner, &thread)?;
        }
        Ok(place)
    }

    /// `read`: an agent reads a place; a read of the newest moves its
    /// cursor.
    pub fn read(&self, who: &str, opt: ReadOptions) -> Result<ReadResult, ApiError> {
        self.prepare_seat(who);
        let mut inner = self.locked();
        let (channel, opened) = inner.resolve_target(who, opt.target.as_deref().unwrap_or(""))?;
        if let Some(thread) = opened {
            self.publish_channel(&inner, &thread)?;
        }
        let row = inner
            .model
            .channel(&channel)
            .cloned()
            .ok_or_else(|| refused(t("server.channel.channelGone", &[])))?;
        let target = inner.target_of_channel(&row);
        let limit = match opt.limit {
            Some(l) if l != 0 => l.clamp(1, 100),
            _ => READ_LIMIT,
        };
        let cursor = db::read_cursor(&inner.db, who, &channel).q()?.unwrap_or(0);
        let before = opt.before.filter(|b| *b != 0);
        let rows = if opt.unread {
            db::messages_after(&inner.db, &channel, cursor, limit).q()?
        } else {
            let mut rows = db::messages_before(&inner.db, &channel, before.unwrap_or(NO_NUMBER), limit).q()?;
            rows.reverse();
            rows
        };
        if let Some(newest) = rows.last()
            && before.is_none()
        {
            self.read_through(&mut inner, who, &channel, newest.number)?;
        }
        let keep: Vec<String> = inner.model.last_read.keys().cloned().collect();
        for p in keep {
            if inner.model.participant(&p).is_none_or(|x| x.left_at.is_some()) {
                inner.model.last_read.remove(&p);
            }
        }
        inner.model.last_read.insert(who.into(), target.clone());
        let older = match rows.first() {
            Some(oldest) => !db::messages_before(&inner.db, &channel, oldest.number, 1).q()?.is_empty(),
            None => false,
        };
        let messages = rows.iter().map(|r| inner.addressed_of(r, &self.files)).collect();
        Ok(ReadResult { target, messages, older })
    }

    /// `unread`: a hint for the one asking; a failure is none, logged.
    pub fn unread(&self, who: &str, channel: Option<&str>) -> Vec<ChannelUnread> {
        self.prepare_seat(who);
        let inner = self.locked();
        inner.unread_of(who, channel).unwrap_or_else(|e| {
            eprintln!("vibevalley-server: chat: unread of {who}: {}", e.message);
            vec![]
        })
    }

    /// Every channel and direct channel, the default first.
    pub fn list(&self) -> Result<Vec<Channel>, ApiError> {
        let inner = self.locked();
        let mut out = vec![];
        for row in inner.model.channels("channel").iter().chain(inner.model.channels("direct").iter()) {
            out.push(inner.counted(row)?);
        }
        Ok(out)
    }

    /// `history`: a place's messages before a number, oldest first.
    pub fn history(&self, channel: &str, before: Option<i64>, limit: Option<i64>) -> Result<Vec<ChatMessage>, ApiError> {
        let mut inner = self.locked();
        let at = if inner.model.channel(channel).is_some() {
            channel.to_string()
        } else {
            let (place, opened) = inner.resolve_target(USER_ID, channel)?;
            if let Some(thread) = opened {
                self.publish_channel(&inner, &thread)?;
            }
            place
        };
        let mut rows = db::messages_before(&inner.db, &at, before.unwrap_or(NO_NUMBER), limit.unwrap_or(50).clamp(1, 200)).q()?;
        rows.reverse();
        Ok(rows.iter().map(to_message).collect())
    }

    pub fn mark_read(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        self.read_through(&mut inner, USER_ID, channel, number)?;
        self.publish_channel(&inner, channel)
    }

    /// Each read of the user's from now on: (channel, number, at).
    pub fn user_reads(&self) -> flume::Receiver<(String, i64, i64)> {
        let (tx, rx) = flume::unbounded();
        lock(&self.user_reads).push(tx);
        rx
    }

    /// `messageLocation`: a message's place and the channel it is in.
    pub fn message_location(&self, id: &str) -> Result<Option<(Channel, String)>, ApiError> {
        let inner = self.locked();
        let Some(m) = db::message_by_id(&inner.db, id).q()? else { return Ok(None) };
        let Some(row) = inner.model.channel(&m.channel_id) else { return Ok(None) };
        let top = if row.r#type == "thread" {
            row.parent_id.clone().unwrap_or(row.id.clone())
        } else {
            row.id.clone()
        };
        Ok(Some((inner.to_channel(row, 0, String::new(), None), top)))
    }

    /// `userReceipt`: when the user read a message, and whether a later one
    /// took its place; none once it is deleted.
    pub fn user_receipt(&self, id: &str) -> Result<Option<(ChatMessage, Option<i64>, bool)>, ApiError> {
        let inner = self.locked();
        let Some(row) = db::message_by_id(&inner.db, id).q()?.filter(|r| r.deleted_at.is_none()) else {
            return Ok(None);
        };
        let Some((read_at, superseded)) = db::notification_receipt(&inner.db, id).q()? else {
            return Ok(None);
        };
        Ok(Some((to_message(&row), read_at, superseded)))
    }

    /// Each speaker's newest report the user has read: (from, at, readAt).
    pub fn user_read_reports(&self) -> Result<Vec<(String, i64, i64)>, ApiError> {
        db::user_read_reports(&self.locked().db).q()
    }

    pub fn home_of(&self, participant: &str) -> Option<String> {
        self.locked().home_of(participant)
    }

    /// Each event committed from now on, in order.
    pub fn committed(&self) -> flume::Receiver<Told> {
        let (tx, rx) = flume::unbounded();
        lock(&self.told).push(tx);
        rx
    }

    /// The events after `after`, oldest first, at most n.
    pub fn events(&self, after: i64, n: i64) -> Result<Vec<EventRow>, ApiError> {
        db::events_after(&self.locked().db, after, n).q()
    }

    /// A posted message as it is now, told as when it was committed.
    pub fn committed_of(&self, message: &str) -> Result<Option<Committed>, ApiError> {
        let inner = self.locked();
        let row = db::message_by_id(&inner.db, message).q()?;
        let event = db::event_of(&inner.db, message).q()?;
        Ok(match (row, event) {
            (Some(row), Some(e)) if row.deleted_at.is_none() => inner.committed_from(&row, &e),
            _ => None,
        })
    }

    /// A reader the chat's writes wait on (a notice does not).
    pub fn await_reader(&self, reader: impl Fn(i64) -> Result<(), ApiError> + Send + Sync + 'static) {
        self.readers.write().unwrap_or_else(|e| e.into_inner()).push(Arc::new(reader));
    }

    /// Ensures a session's thread is opened and seated before it speaks or reads.
    pub fn ensure_seated(&self, seater: impl Fn(&str) + Send + Sync + 'static) {
        self.seaters.write().unwrap_or_else(|e| e.into_inner()).push(Arc::new(seater));
    }

    fn prepare_seat(&self, who: &str) {
        if who == USER_ID || who == DEFAULT_ORCHESTRATOR || who == "system" || self.home_of(who).is_some() {
            return;
        }
        for f in self.seaters.read().unwrap_or_else(|e| e.into_inner()).iter() {
            f(who);
        }
    }

    /// Seats an agent under the name it goes by now.
    pub fn seat(&self, seat: &Seat) -> Result<(), ApiError> {
        let mut inner = self.locked();
        tx(&mut inner, |me| me.seat(seat))
    }

    /// A participant gone: in nothing, never back.
    pub fn leave(&self, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let at = now();
        tx(&mut inner, |me| {
            db::participant_left(&me.db, participant, at).q()?;
            db::remove_from_all(&me.db, participant, at).q()?;
            me.model.left(participant, at);
            Ok(())
        })
    }

    pub fn participants(&self) -> Vec<ParticipantRow> {
        self.locked().model.participants().to_vec()
    }

    /// Makes a participant a member of a place from its newest message on.
    pub fn add_follower(&self, channel: &str, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let Some(last) = inner.model.channel(channel).map(|r| r.last_number.unwrap_or(0)) else {
            return Ok(());
        };
        tx(&mut inner, |me| me.add_member(channel, participant, "user", last))
    }

    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.locked().model.members_of(channel)
    }

    pub fn thread_about(&self, kind: SubjectKind, id: &str) -> Option<String> {
        self.locked().model.thread_of_subject(kind.as_str(), id).map(str::to_string)
    }

    pub fn place(&self, id: &str) -> Option<Place> {
        let inner = self.locked();
        inner.model.channel(id).map(|r| inner.place_of(r))
    }

    pub fn mark_seen(&self, participant: &str, message: &str) -> Result<(), ApiError> {
        db::mark_seen(&self.locked().db, participant, message, now()).q()
    }

    pub fn read_up_to(&self, participant: &str, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        tx(&mut inner, |me| me.set_read(participant, channel, number, now()))
    }

    pub fn latest(&self, channel: &str) -> Result<i64, ApiError> {
        db::latest_number(&self.locked().db, channel).q()
    }

    pub fn dispatches(&self, thread: &str) -> Result<i64, ApiError> {
        db::dispatches_in(&self.locked().db, thread).q()
    }

    /// The newest n messages of a place, oldest first.
    pub fn recent_rows(&self, channel: &str, n: i64) -> Result<Vec<MsgRow>, ApiError> {
        let mut rows = db::messages_before(&self.locked().db, channel, NO_NUMBER, n).q()?;
        rows.reverse();
        Ok(rows)
    }

    pub fn rows_after(&self, channel: &str, after: i64) -> Result<Vec<MsgRow>, ApiError> {
        db::messages_after(&self.locked().db, channel, after, 1000).q()
    }

    pub fn addressed_of(&self, row: &MsgRow) -> AddressedMessage {
        self.locked().addressed_of(row, &self.files)
    }

    /// How far the reader `name` has handled the events (watch_cursor).
    pub fn cursor_of(&self, name: &str) -> Result<i64, ApiError> {
        db::cursor_of(&self.locked().db, name).q()
    }

    pub fn move_cursor(&self, name: &str, seq: i64) -> Result<(), ApiError> {
        db::move_cursor(&self.locked().db, name, seq).q()
    }

    /// A place as an agent addresses it (`#general`, `#general/12`, `@name`).
    pub fn target_of(&self, channel: &str) -> Option<String> {
        let inner = self.locked();
        inner.model.channel(channel).map(|row| inner.target_of_channel(row))
    }

    pub fn orchestrator_in(&self, channel: &str) -> String {
        self.locked().orchestrator_in(channel)
    }

    pub fn default_channel(&self) -> String {
        self.locked().model.default_id()
    }

    /// The state's chat now.
    pub fn now(&self) -> Option<vibevalley_protocol::Chat> {
        self.hub.upgrade().and_then(|h| h.read(|s| s.chat.clone()))
    }

    // ----- directory.ts -----

    /// A refusal of removals: what still points at a channel.
    pub fn guard_removal(&self, guard: impl Fn(&str) -> Vec<String> + Send + Sync + 'static) {
        self.guards.write().unwrap_or_else(|e| e.into_inner()).push(Arc::new(guard));
    }

    pub fn channels(&self) -> Vec<Info> {
        self.locked().model.channels("channel").iter().map(info_of).collect()
    }

    pub fn channel_by_name(&self, name: &str) -> Option<Info> {
        let trimmed = name.trim();
        self.locked().model.channel_by_name(trimmed.strip_prefix('#').unwrap_or(trimmed)).map(info_of)
    }

    /// `topOf`: a thread's parent channel, or the default one.
    pub fn top_of(&self, channel: &str) -> Info {
        let inner = self.locked();
        inner.model.top_channel(channel).map(info_of).unwrap_or_else(|| Info {
            id: inner.model.default_id(),
            name: FIRST_CHANNEL.into(),
            description: String::new(),
            repo: String::new(),
            default: true,
        })
    }

    /// `addressOf`: (direct, target).
    pub fn address_of(&self, channel: &str) -> (bool, String) {
        let inner = self.locked();
        if let Some(row) = inner.model.channel(channel).filter(|r| r.r#type == "direct") {
            return (true, inner.target_of_channel(row));
        }
        (
            false,
            inner
                .model
                .top_channel(channel)
                .map(|t| inner.target_of_channel(t))
                .unwrap_or_else(|| "#general".into()),
        )
    }

    pub fn open_channel(&self, name: &str, description: &str, repo: &str) -> Result<Info, ApiError> {
        let mut inner = self.locked();
        let trimmed = name.trim();
        let clean = trimmed.strip_prefix('#').unwrap_or(trimmed).to_string();
        let taken: Vec<String> = inner.model.channels("channel").into_iter().filter_map(|r| r.name).collect();
        let problem = words::channel_name_problem(&clean, &taken);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let (desc, proj) = (optional(Some(description)), optional(Some(repo)));
        let id = new_id();
        let at = now();
        tx(&mut inner, |me| {
            db::create_channel(&me.db, &id, false, &clean, desc.as_deref(), proj.as_deref(), at).q()?;
            me.model.created(ChannelRow {
                name: Some(clean.clone()),
                description: desc.clone(),
                repo: proj.clone(),
                ..ChannelRow::empty(&id, "channel", at)
            });
            me.add_member(&id, DEFAULT_ORCHESTRATOR, "manual", 0)
        })?;
        self.publish_channel(&inner, &id)?;
        Ok(Info {
            id,
            name: clean,
            description: desc.unwrap_or_default(),
            repo: proj.unwrap_or_default(),
            default: false,
        })
    }

    /// `updateChannel`: a thread changes only its title.
    pub fn update_channel(&self, id: &str, upd: ChannelUpdate) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner
            .model
            .channel(id)
            .filter(|r| r.r#type != "direct")
            .cloned()
            .ok_or_else(|| no_channel(id))?;
        let only_name = upd.description.is_none() && upd.repo.is_none() && upd.category.is_none() && upd.before.is_none() && upd.members.is_none();
        if row.r#type == "thread" && !only_name {
            return Err(refused(t("server.channel.threadOnlyTitle", &[])));
        }
        let mut name = row.name.clone();
        if let Some(n) = &upd.name {
            let trimmed = n.trim();
            let clean = trimmed.strip_prefix('#').unwrap_or(trimmed);
            if row.r#type == "thread" {
                name = (!clean.is_empty()).then(|| head(clean, THREAD_TITLE_MAX * 2));
            } else {
                let taken: Vec<String> = inner
                    .model
                    .channels("channel")
                    .into_iter()
                    .filter(|c| c.id != id)
                    .filter_map(|c| c.name)
                    .collect();
                let problem = words::channel_name_problem(clean, &taken);
                if !problem.is_empty() {
                    return Err(refused(problem));
                }
                name = Some(clean.to_string());
            }
        }
        let desc = upd.description.as_deref().and_then(|d| optional(Some(d))).or(row.description.clone());
        let proj = match &upd.repo {
            Some(r) => optional(Some(r)),
            None => row.repo.clone(),
        };
        let category = match &upd.category {
            Some(c) => optional(Some(c)),
            None => row.category.clone(),
        };
        // Only an orchestrator is put in a channel: a helper is hired into a place, not seated in one.
        let wanted: Option<Vec<String>> = upd.members.as_ref().map(|ms| {
            let mut out: Vec<String> = vec![];
            for m in ms.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
                if !out.iter().any(|o| o == m) {
                    out.push(m.to_string());
                }
            }
            out
        });
        if let Some(not_one) = wanted.iter().flatten().find(|m| !inner.is_orchestrator_seat(m)) {
            return Err(refused(t("server.channel.notOrchestrator", &[("id", not_one.as_str().into())])));
        }
        let had = inner.model.members_of(id);
        let joining: Vec<String> = wanted.iter().flatten().filter(|m| !had.contains(m)).cloned().collect();
        let leaving: Vec<String> = match &wanted {
            None => vec![],
            Some(w) => had.iter().filter(|m| inner.is_orchestrator_seat(m) && !w.contains(m)).cloned().collect(),
        };
        let order: Option<Vec<String>> = upd.before.as_ref().map(|before| {
            let mut rest: Vec<String> = inner
                .model
                .channels("channel")
                .into_iter()
                .filter(|c| !c.is_default && c.id != id)
                .map(|c| c.id)
                .collect();
            let at = rest.iter().position(|c| c == before).unwrap_or(rest.len());
            rest.insert(at, id.to_string());
            rest
        });
        tx(&mut inner, |me| {
            if row.r#type == "channel" {
                db::update_channel(&me.db, id, desc.as_deref(), proj.as_deref()).q()?;
            }
            if name != row.name {
                db::rename_channel(&me.db, id, name.as_deref()).q()?;
            }
            if category != row.category {
                db::set_category(&me.db, id, category.as_deref()).q()?;
            }
            for m in &joining {
                me.add_member(id, m, "manual", 0)?;
            }
            let at = now();
            for m in &leaving {
                db::remove_member(&me.db, id, m, at).q()?;
                me.model.member_removed(id, m);
            }
            for (position, each) in order.iter().flatten().enumerate() {
                db::place_channel(&me.db, each, position as i64).q()?;
            }
            let row_type = row.r#type.clone();
            me.model.patch(id, |c| {
                if row_type == "channel" {
                    c.description = desc.clone();
                    c.repo = proj.clone();
                }
                c.name = name.clone();
                c.category = category.clone();
            });
            for (position, each) in order.iter().flatten().enumerate() {
                me.model.patch(each, |c| c.position = Some(position as i64));
            }
            Ok(())
        })?;
        for each in order.clone().unwrap_or_else(|| vec![id.to_string()]) {
            self.publish_channel(&inner, &each)?;
        }
        // Its threads are in the same channel: they show who is in it now too.
        if !joining.is_empty() || !leaving.is_empty() {
            for thread in inner.model.threads_of(id) {
                self.publish_channel(&inner, &thread.id)?;
            }
        }
        Ok(())
    }

    pub fn archive(&self, id: &str, on: bool) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner
            .model
            .channel(id)
            .filter(|r| r.r#type != "direct")
            .cloned()
            .ok_or_else(|| no_channel(id))?;
        if row.archived_at.is_some() == on {
            return Ok(());
        }
        if row.is_default {
            return Err(refused(t("server.channel.defaultStays", &[])));
        }
        let at = on.then(now);
        tx(&mut inner, |me| {
            db::set_archived(&me.db, id, at).q()?;
            me.model.patch(id, |c| c.archived_at = at);
            Ok(())
        })?;
        self.publish_channel(&inner, id)
    }

    /// `removable`: a channel nothing points at; (target, threads, said).
    fn removable(&self, inner: &Inner, id: &str) -> Result<(String, usize, i64), ApiError> {
        let row = inner.model.channel(id).filter(|r| r.r#type == "channel").ok_or_else(|| no_channel(id))?;
        if row.is_default {
            return Err(refused(t("server.channel.defaultStays", &[])));
        }
        let topics = db::topic_threads_in(&inner.db, id).q()?;
        let guards = self.guards.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut why: Vec<String> = guards.iter().flat_map(|g| g(id)).collect();
        if topics != 0 {
            why.push(t("server.channel.issuesThere", &[("n", topics.into())]));
        }
        if !why.is_empty() {
            return Err(refused(t("server.channel.inUse", &[("why", list(&why).into())])));
        }
        let threads = inner.model.threads_of(id);
        let said = row.last_number.unwrap_or(0) + threads.iter().map(|t| t.reply_count).sum::<i64>();
        Ok((inner.target_of_channel(row), threads.len(), said))
    }

    pub fn preview_remove_channel(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.locked();
        let (target, threads, said) = self.removable(&inner, id)?;
        Ok(Preview {
            does: vec![t(
                "server.channel.deletesChannel",
                &[("target", target.into()), ("threads", threads.into()), ("said", said.into())],
            )],
        })
    }

    pub fn remove_channel(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        self.removable(&inner, id)?;
        let mut gone: Vec<String> = vec![];
        for c in inner.model.channel(id).into_iter().cloned().chain(inner.model.threads_of(id)) {
            gone.push(inner.target_of_channel(&c));
        }
        tx(&mut inner, |me| {
            db::delete_channel(&me.db, id).q()?;
            me.model.removed(id);
            me.model.last_read.retain(|_, target| !gone.contains(target));
            Ok(())
        })?;
        self.apply(vec![Fact::ChannelRemoved(FactChannelRemoved { at: now(), id: id.into() })]);
        Ok(())
    }

    pub fn set_notify(&self, id: &str, notify: Notify) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(id).is_none() {
            return Err(no_channel(id));
        }
        tx(&mut inner, |me| {
            db::set_notify(&me.db, id, notify.as_str()).q()?;
            me.model.patch(id, |c| c.notify = notify.as_str().into());
            Ok(())
        })?;
        self.publish_channel(&inner, id)?;
        self.publish_user_mentions(&inner)
    }

    /// `notifyOf`: "none" on the thread or its channel silences both.
    pub fn notify_of(&self, id: &str) -> Notify {
        let inner = self.locked();
        let c = inner.model.channel(id);
        let top = c.and_then(|c| c.parent_id.as_deref()).and_then(|p| inner.model.channel(p));
        if c.is_some_and(|c| c.notify == "none") || top.is_some_and(|t| t.notify == "none") {
            return Notify::None;
        }
        match c.map(|c| c.notify.as_str()) {
            Some(n) if n != "all" => notify_of(n),
            _ => notify_of(top.map_or("all", |t| t.notify.as_str())),
        }
    }

    /// `createDirect`: the direct channel with a seated agent, made when
    /// there is none.
    pub fn create_direct(&self, peer: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if inner.model.participant(peer).is_none_or(|p| p.kind != "agent") {
            return Err(missing(t("server.channel.noProfileNamed", &[("key", peer.into())]), LookIn::Agent));
        }
        if let Some(had) = inner.model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer)) {
            return Ok(had.id);
        }
        let id = new_id();
        let at = now();
        tx(&mut inner, |me| {
            db::create_direct(&me.db, &id, peer, at).q()?;
            me.model.created(ChannelRow {
                peer_id: Some(peer.into()),
                ..ChannelRow::empty(&id, "direct", at)
            });
            Ok(())
        })?;
        self.publish_channel(&inner, &id)?;
        Ok(id)
    }

    pub fn mark_unread(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        let upto = (number - 1).max(0);
        tx(&mut inner, |me| {
            db::mark_unread(&me.db, channel, upto, now()).q()?;
            me.model.user_read_back(channel, upto);
            Ok(())
        })?;
        self.publish_channel(&inner, channel)?;
        self.publish_user_mentions(&inner)
    }

    pub fn make_default(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner.model.channel(id).cloned().ok_or_else(|| no_channel(id))?;
        if row.r#type != "channel" {
            return Err(refused(t("server.channel.defaultIsChannel", &[])));
        }
        let was = inner.model.default_id();
        if id == was {
            return Ok(());
        }
        tx(&mut inner, |me| {
            db::clear_default(&me.db).q()?;
            db::make_default(&me.db, id).q()?;
            me.model.default_moved(&was, id);
            Ok(())
        })?;
        self.publish_channel(&inner, &was)?;
        self.publish_channel(&inner, id)
    }

    // ----- mutations.ts' streams -----

    fn said(&self) -> flume::Receiver<ChatMessage> {
        let (tx, rx) = flume::unbounded();
        lock(&self.said).push(tx);
        rx
    }

    /// `follow`: what changed in a channel after revision `after`, then each
    /// change from now on; `Reset` when too far behind.
    pub fn follow(&self, channel: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let (live, missed) = {
            let inner = self.locked();
            if inner.model.channel(channel).is_none() {
                return Err(refused(t("server.channel.channelGone", &[])));
            }
            // Subscribed before the missed ones are read: nothing falls in between.
            let live = self.said();
            (live, db::messages_changed_after(&inner.db, channel, after, CATCH_UP_MAX as i64 + 1).q()?)
        };
        let channel = channel.to_string();
        std::thread::Builder::new()
            .name("vibevalley-chat-follow".into())
            .spawn(move || {
                if missed.len() > CATCH_UP_MAX {
                    sink.send(&ChannelEvent::Reset {});
                    return;
                }
                let upto = missed.last().map_or(after, |m| m.revision);
                for m in &missed {
                    if !sink.send(&ChannelEvent::Message { message: to_message(m) }) {
                        return;
                    }
                }
                relay(live, &sink, |m| m.channel == channel && m.revision > upto);
            })
            .map_err(internal)?;
        Ok(())
    }

    /// `reports`: the reports after the one with id `after` (the newest
    /// ones without it), then each one from now on.
    pub fn reports(&self, after: Option<String>, sink: Sink) -> Result<(), ApiError> {
        let (live, missed) = {
            let inner = self.locked();
            let live = self.said();
            let missed = match &after {
                None => {
                    let mut rows = db::recent_reports(&inner.db, LOG_KEEP).q()?;
                    rows.reverse();
                    rows
                }
                Some(a) => db::reports_after(&inner.db, a, CATCH_UP_MAX as i64 + 1).q()?,
            };
            (live, missed)
        };
        std::thread::Builder::new()
            .name("vibevalley-chat-reports".into())
            .spawn(move || {
                if missed.len() > CATCH_UP_MAX {
                    sink.send(&ChannelEvent::Reset {});
                    return;
                }
                let upto = missed.last().map(|m| m.id.clone()).or(after).unwrap_or_default();
                for m in &missed {
                    if !sink.send(&ChannelEvent::Message { message: to_message(m) }) {
                        return;
                    }
                }
                relay(live, &sink, |m| m.kind == MessageKind::Report && m.id > upto);
            })
            .map_err(internal)?;
        Ok(())
    }
}

/// Each message said that `keep` keeps, until the subscriber stops.
fn relay(live: flume::Receiver<ChatMessage>, sink: &Sink, keep: impl Fn(&ChatMessage) -> bool) {
    loop {
        if sink.stopped() {
            return;
        }
        match live.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(m) if keep(&m) => {
                if !sink.send(&ChannelEvent::Message { message: m }) {
                    return;
                }
            }
            Ok(_) | Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// A helper profile's seat in the chat, the peer of its direct channel.
pub fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

/// The orchestrators seated under their profiles' names, each with its
/// direct channel (watch.ts `seatOrchestrator`).
fn seat_orchestrator(chat: &Chat, agents: &Agents, agent: &vibevalley_protocol::Agent) -> Result<(), ApiError> {
    if !agents.profiles.is_orchestrator(&agent.id) {
        return Ok(());
    }
    let name = if agent.name.trim().is_empty() {
        t("server.channel.name.orchestrator", &[])
    } else {
        agent.name.trim().to_string()
    };
    chat.seat(&Seat {
        id: agent.id.clone(),
        name,
        agent: None,
        home: None,
    })?;
    chat.create_direct(&agent.id).map(|_| ())
}

/// `watch.direct`: the direct channel with a profile (by name or id).
pub fn direct(chat: &Chat, agents: &Agents, reference: &str) -> Result<String, ApiError> {
    let name = reference.trim();
    let p = &agents.profiles;
    let agent = p
        .named(name)
        .or_else(|| p.agent(name))
        .or_else(|| p.orchestrators().into_iter().find(|o| o.name == name))
        .ok_or_else(|| missing(t("server.channel.noProfileNamed", &[("key", reference.into())]), LookIn::Agent))?;
    if p.is_orchestrator(&agent.id) {
        seat_orchestrator(chat, agents, &agent)?;
        return chat.create_direct(&agent.id);
    }
    let seat = profile_id(&agent.id);
    chat.seat(&Seat {
        id: seat.clone(),
        name: agent.name.clone(),
        agent: Some(agent.id.clone()),
        home: None,
    })?;
    chat.create_direct(&seat)
}

/// `channel.*`, `channel.follow`, `channel.reports`; the orchestrators
/// seated now and whenever a profile is kept.
pub fn install(hub: &Hub, chat: Arc<Chat>, agents: Arc<Agents>, game: Option<Arc<crate::modules::game::Game>>) {
    for agent in agents.profiles.orchestrators() {
        if let Err(e) = seat_orchestrator(&chat, &agents, &agent) {
            eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
        }
    }
    {
        let (c, a) = (Arc::downgrade(&chat), Arc::downgrade(&agents));
        agents.profiles.when_kept(Arc::new(move |agent| match (c.upgrade(), a.upgrade()) {
            (Some(c), Some(a)) => seat_orchestrator(&c, &a, agent),
            _ => Ok(()),
        }));
    }

    hub.on::<ops::ChannelMessageSend>({
        let (c, a) = (chat.clone(), agents.clone());
        move |_, body| {
            if let (Some(station), Some(game)) = (body.station, &game) {
                game.want(station);
            }
            // A profile picked that is not there is not passed on.
            let blocks = c.quoted(body.blocks.as_deref().unwrap_or_default());
            let picked = body.agent.as_deref().and_then(|x| a.profiles.agent(x)).map(|x| x.id);
            c.say(Saying {
                text: body.text,
                channel: Some(body.id),
                send_key: body.send_key.unwrap_or_default(),
                picked: Some(Picked {
                    agent: picked,
                    repo: body.repo.filter(|r| !r.is_empty()),
                }),
                reply_to: body.reply_to,
                attachments: body.attachments.unwrap_or_default(),
                to: body.to,
                blocks,
                ..Saying::default()
            })
            .map(|_| ())
        }
    });
    hub.on::<ops::ChannelCreate>({
        let c = chat.clone();
        move |_, b| {
            c.open_channel(&b.name, b.description.as_deref().unwrap_or(""), b.repo.as_deref().unwrap_or(""))
                .map(|i| i.id)
        }
    });
    hub.on::<ops::ChannelUpdate>({
        let c = chat.clone();
        move |_, b| {
            c.update_channel(
                &b.id,
                ChannelUpdate {
                    description: b.description,
                    repo: b.repo,
                    name: b.name,
                    category: b.category,
                    before: b.before,
                    members: b.members,
                },
            )
        }
    });
    hub.on::<ops::ChannelArchiveSet>({
        let c = chat.clone();
        move |_, b| c.archive(&b.id, b.on)
    });
    hub.on::<ops::ChannelDelete>({
        let c = chat.clone();
        move |_, b| c.remove_channel(&b.id)
    });
    hub.on::<ops::ChannelPreviewDelete>({
        let c = chat.clone();
        move |_, b| c.preview_remove_channel(&b.id)
    });
    hub.on::<ops::ChannelNotifySet>({
        let c = chat.clone();
        move |_, b| c.set_notify(&b.id, b.notify)
    });
    hub.on::<ops::ChannelDirectCreate>({
        let (c, a) = (chat.clone(), agents.clone());
        move |_, b| direct(&c, &a, &b.agent)
    });
    hub.on::<ops::ChannelMarkUnread>({
        let c = chat.clone();
        move |_, b| c.mark_unread(&b.id, b.number)
    });
    hub.on::<ops::ChannelList>({
        let c = chat.clone();
        move |_, ()| c.list()
    });
    hub.on::<ops::ChannelUnreadList>({
        let c = chat.clone();
        move |_, ()| Ok(c.unread(USER_ID, None))
    });
    hub.on::<ops::ChannelDefaultSet>({
        let c = chat.clone();
        move |_, b| c.make_default(&b.id)
    });
    hub.on::<ops::ChannelMessageList>({
        let c = chat.clone();
        move |_, b| c.history(&b.id, b.before, b.limit)
    });
    hub.on::<ops::ChannelMarkRead>({
        let c = chat.clone();
        move |_, b| {
            c.mark_read(&b.id, b.number)
                .map_err(|e| ApiError::new(BizCode::ChannelNotFound, e.message).with_next(vec![LookIn::Channel.next()]))
        }
    });
    hub.on::<ops::ChannelMessageUpdate>({
        let c = chat.clone();
        move |_, b| c.edit(&b.id, &b.text, b.attachments.as_deref())
    });
    hub.on::<ops::ChannelMessageDelete>({
        let c = chat.clone();
        move |_, b| c.remove(&b.id)
    });
    hub.on::<ops::ChannelMessagePreviewDelete>({
        let c = chat.clone();
        move |_, b| c.preview_remove(&b.id)
    });
    hub.on::<ops::ChannelMessageSearch>({
        let c = chat.clone();
        move |_, b| c.search(&b.text, b.channel.as_deref())
    });
    hub.on::<ops::ChannelReactionSet>({
        let c = chat.clone();
        move |_, b| c.react(&b.id, USER_ID, &b.emoji, b.on)
    });
    hub.on::<ops::ChannelPinSet>({
        let c = chat.clone();
        move |_, b| c.pin(&b.id, b.on)
    });
    hub.on::<ops::ChannelPinList>({
        let c = chat.clone();
        move |_, b| c.pins(&b.id)
    });
    let thread_once = Arc::new(RequestKeys::<String>::default());
    hub.on::<ops::ChannelThreadCreate>({
        let c = chat.clone();
        move |_, b| thread_once.once(b.request_key.as_deref(), || c.thread_under(&b.id))
    });
    hub.on_subscription::<subscriptions::ChannelFollow>({
        let c = chat.clone();
        move |_, p, sink| c.follow(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ChannelReports>(move |_, p, sink| chat.reports(p.after, sink));
}
