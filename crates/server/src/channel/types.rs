use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, AgentRole, ApiError, ArtifactCard, ArtifactViewContext, Attachment, BizCode, ChannelType, ChatMessage, Embed, MessageKind, Notify, Outcome,
    Reaction, Spent, SubjectKind, USER_ID,
};

use crate::context::{LookIn, missing, refused as refuse};
use crate::service::channel::{ChannelRow, EventRow, MsgRow};

pub(super) const CHANNEL_EVENT_CAPACITY: usize = 1024;
/// The channel a new farm opens with.
pub(super) const FIRST_CHANNEL: &str = "general";
/// The state keeps these many channels; the database keeps all.
pub const KEEP_CHANNELS: i64 = 100;
pub(super) const THREAD_TITLE_MAX: usize = 24;
pub(super) const LAST_MAX: usize = 80;
pub(super) const SEARCH_MAX: i64 = 50;
pub(super) const RETRY_WINDOW_MS: i64 = 60_000;
pub(super) const HELD_SHOWN: usize = 3;
pub(super) const READ_LIMIT: i64 = 30;
pub(super) const SEND_KEY_MAX: usize = 64;
pub(super) const CALLERS_MAX: i64 = 20;
/// A follower further behind than this is told to start again.
pub const CATCH_UP_MAX: usize = 200;
pub(super) const LOG_KEEP: i64 = 80;
pub(super) const NO_NUMBER: i64 = i32::MAX as i64;

pub(super) fn refused(text: String) -> ApiError {
    refuse(BizCode::ChannelRefused, text)
}

pub(super) fn no_channel(id: &str) -> ApiError {
    missing(t("server.channel.noChannel", &[("id", id.into())]), LookIn::Channel)
}

/// A session woken by an agent's words is not woken by another's within
/// this; an orchestrator always is.
const AGENT_WAKE_COOLDOWN_MS: i64 = 60_000;

/// A helper profile's seat in the chat, the peer of its direct channel.
pub fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Mention,
    Everyone,
    OwnThread,
    Member,
    Channel,
    Direct,
    Addressed,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Mention => "mention",
            Reason::Everyone => "everyone",
            Reason::OwnThread => "own_thread",
            Reason::Member => "member",
            Reason::Channel => "channel",
            Reason::Direct => "direct",
            Reason::Addressed => "addressed",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "mention" => Reason::Mention,
            "everyone" => Reason::Everyone,
            "own_thread" => Reason::OwnThread,
            "member" => Reason::Member,
            "channel" => Reason::Channel,
            "direct" => Reason::Direct,
            _ => Reason::Addressed,
        }
    }
}

/// Which brake held a delivery back from waking its recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBy {
    HopLimit,
    Cooldown,
}

impl HeldBy {
    pub fn as_str(self) -> &'static str {
        match self {
            HeldBy::HopLimit => "hop_limit",
            HeldBy::Cooldown => "cooldown",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "hop_limit" => Some(HeldBy::HopLimit),
            "cooldown" => Some(HeldBy::Cooldown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryTargetKind {
    Session,
    Issue,
    Orchestrator,
    Direct,
}

impl DeliveryTargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryTargetKind::Session => "session",
            DeliveryTargetKind::Issue => "issue",
            DeliveryTargetKind::Orchestrator => "orchestrator",
            DeliveryTargetKind::Direct => "direct",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "session" => DeliveryTargetKind::Session,
            "issue" => DeliveryTargetKind::Issue,
            "orchestrator" => DeliveryTargetKind::Orchestrator,
            _ => DeliveryTargetKind::Direct,
        }
    }
}

/// A durable pending delivery written to `channel_delivery` on commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedDelivery {
    pub id: i64,
    pub message_id: String,
    pub channel_id: String,
    pub recipient_kind: DeliveryTargetKind,
    pub recipient_id: String,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

/// Non-blocking dispatch notification emitted after a message and its pending
/// `channel_delivery` rows commit.
#[derive(Debug, Clone)]
pub struct ChannelDispatched {
    pub committed: Arc<Committed>,
    pub deliveries: Vec<QueuedDelivery>,
}

/// The hops per place and each session's last wake by agents' words.
#[derive(Debug, Clone, Default)]
pub struct Reach {
    hops_in: HashMap<String, usize>,
    last_wake_of: HashMap<String, i64>,
}

impl Reach {
    pub fn user_spoke(&mut self, scope: &str) {
        self.hops_in.remove(scope);
    }

    pub fn hops(&self, scope: &str) -> usize {
        self.hops_in.get(scope).copied().unwrap_or(0)
    }

    pub fn cooling(&self, of: &[String], at: i64) -> Vec<String> {
        of.iter()
            .filter(|s| self.last_wake_of.get(*s).is_some_and(|last| at - last < AGENT_WAKE_COOLDOWN_MS))
            .cloned()
            .collect()
    }

    pub fn woke(&mut self, scope: &str, session: &str, at: i64) {
        let last = self.last_wake_of.entry(session.to_string()).or_insert(0);
        *last = (*last).max(at);
        *self.hops_in.entry(scope.to_string()).or_insert(0) += 1;
    }

    pub fn left(&mut self, session: &str) {
        self.last_wake_of.remove(session);
    }

    pub fn channel_removed(&mut self, channel: &str) {
        self.hops_in.remove(&format!("channel:{channel}"));
    }
}

pub(super) fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// The first n UTF-16 units, never half a pair (`head` in clip.ts).
pub(super) fn head(s: &str, n: usize) -> String {
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
pub(super) fn optional(s: Option<&str>) -> Option<String> {
    let text = s.unwrap_or("").trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The profile and repo the user picked for what they said.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

fn is_empty_opt_str(v: &Option<String>) -> bool {
    v.as_deref().is_none_or(str::is_empty)
}

fn is_empty_opt_vec<T>(v: &Option<Vec<T>>) -> bool {
    v.as_ref().is_none_or(Vec::is_empty)
}

fn is_not_true(v: &Option<bool>) -> bool {
    !matches!(v, Some(true))
}

fn is_empty_opt_value(v: &Option<Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Bool(b)) => !*b,
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

/// `channel_message.meta`. Written with empty values left out, as
/// VibeValley's `metaText` does.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub run: Option<String>,
    #[serde(default, skip_serializing_if = "is_empty_opt_vec")]
    pub mentions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spent: Option<Spent>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "is_not_true")]
    pub spoken: Option<bool>,
    #[serde(default, skip_serializing_if = "is_empty_opt_vec")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default, skip_serializing_if = "is_empty_opt_vec")]
    pub embeds: Option<Vec<Embed>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactCard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_context: Option<ArtifactViewContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picked: Option<Picked>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub ingress_source: Option<String>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub ingress_recipient: Option<String>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub issue: Option<String>,
    #[serde(default, skip_serializing_if = "is_empty_opt_value")]
    pub trigger: Option<Value>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub response_port: Option<String>,
    #[serde(default, skip_serializing_if = "is_empty_opt_str")]
    pub voice_mode: Option<String>,
}

/// `metaOf`: one that does not read is none.
pub fn meta_of(raw: Option<&str>) -> Meta {
    raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default()
}

/// `metaText`: empty strings, false and empty lists left out.
pub fn meta_text(m: Option<&Meta>) -> Option<String> {
    m.and_then(|meta| serde_json::to_string(meta).ok())
}

/// Reactions in the order they came: `{"emoji": ["participant", …]}`.
pub(super) fn reactions_of(raw: Option<&str>) -> Vec<(String, Vec<String>)> {
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

pub(super) fn reactions_text(r: &[(String, Vec<String>)]) -> Option<String> {
    let kept: Vec<String> = r
        .iter()
        .filter(|(_, by)| !by.is_empty())
        .filter_map(|(e, by)| Some(format!("{}:{}", serde_json::to_string(e).ok()?, serde_json::to_string(by).ok()?)))
        .collect();
    (!kept.is_empty()).then(|| format!("{{{}}}", kept.join(",")))
}

pub(super) fn message_kind(kind: &str) -> MessageKind {
    MessageKind::ALL.into_iter().find(|v| v.as_str() == kind).unwrap_or(MessageKind::Chat)
}

pub(super) fn channel_type(kind: &str) -> ChannelType {
    ChannelType::ALL.into_iter().find(|v| v.as_str() == kind).unwrap_or(ChannelType::Channel)
}

pub(super) fn subject_kind(kind: Option<&str>) -> Option<SubjectKind> {
    let kind = kind?;
    SubjectKind::ALL.into_iter().find(|v| v.as_str() == kind)
}

pub(super) fn notify_of(n: &str) -> Notify {
    Notify::ALL.into_iter().find(|v| v.as_str() == n).unwrap_or(Notify::All)
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
        view_context: meta.view_context.filter(|_| !gone),
    }
}

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
    pub view_context: Option<ArtifactViewContext>,
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

/// Unified channel event broadcast after commit.
#[derive(Debug, Clone)]
pub enum ChannelEvent {
    Posted(Box<Committed>),
    Edited(ChatMessage),
    Removed { event: EventRow, message: ChatMessage },
    Reacted(ChatMessage),
    Pinned(ChatMessage),
    UserRead { channel: String, upto: i64, at: i64 },
}

/// Message insert/edit event stream consumed by downstream domains (e.g. library indexing, game/session hooks).
#[derive(Debug, Clone)]
pub enum ChannelMessageEvent {
    Posted {
        message: ChatMessage,
        thread_issue_id: Option<String>,
        answers: Option<String>,
    },
    Edited(ChatMessage),
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
    pub view_context: Option<ArtifactViewContext>,
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

pub(super) fn info_of(row: &ChannelRow) -> Info {
    Info {
        id: row.id.clone(),
        name: row.name.clone().unwrap_or_default(),
        description: row.description.clone().unwrap_or_default(),
        repo: row.repo.clone().unwrap_or_default(),
        default: row.is_default,
    }
}

pub(super) struct Write {
    pub(super) channel: String,
    pub(super) from: String,
    pub(super) kind: MessageKind,
    pub(super) text: String,
    pub(super) meta: Option<Meta>,
    pub(super) thread: Option<ThreadSubject>,
    pub(super) member: Option<String>,
    pub(super) send_key: Option<String>,
    pub(super) reply_to: Option<i64>,
    pub(super) read_by: Option<String>,
}

impl Write {
    pub(super) fn new(channel: &str, from: &str, kind: MessageKind, text: &str) -> Write {
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

pub(super) struct Written {
    pub(super) absent: Vec<String>,
    pub(super) answers: Option<String>,
    pub(super) thread: String,
    pub(super) again: bool,
    pub(super) row: MsgRow,
    pub(super) event: Option<EventRow>,
    pub(super) deliveries: Vec<QueuedDelivery>,
    pub(super) hop_limit_hit: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_text_omits_empty_values_and_round_trips() {
        assert_eq!(meta_text(None), None);
        assert_eq!(meta_text(Some(&Meta::default())).as_deref(), Some("{}"));

        let empty_vals = Meta {
            run: Some(String::new()),
            mentions: Some(vec![]),
            spoken: Some(false),
            attachments: Some(vec![]),
            embeds: Some(vec![]),
            trigger: Some(Value::Bool(false)),
            ..Meta::default()
        };
        assert_eq!(meta_text(Some(&empty_vals)).as_deref(), Some("{}"));

        let full = Meta {
            run: Some("r1".into()),
            mentions: Some(vec!["a1".into()]),
            spoken: Some(true),
            outcome: Some(Outcome::Completed),
            picked: Some(Picked {
                agent: Some("ag".into()),
                repo: None,
            }),
            ..Meta::default()
        };
        let encoded = meta_text(Some(&full)).unwrap();
        let decoded = meta_of(Some(&encoded));
        assert_eq!(decoded.run.as_deref(), Some("r1"));
        assert_eq!(decoded.mentions, Some(vec!["a1".into()]));
        assert_eq!(decoded.spoken, Some(true));
        assert_eq!(decoded.outcome, Some(Outcome::Completed));
        assert_eq!(decoded.picked.and_then(|p| p.agent).as_deref(), Some("ag"));
    }

    #[test]
    fn typed_wire_enum_parsers_match_all_variants_and_fallbacks() {
        for k in MessageKind::ALL {
            assert_eq!(message_kind(k.as_str()), k);
        }
        assert_eq!(message_kind("unknown"), MessageKind::Chat);

        for t in ChannelType::ALL {
            assert_eq!(channel_type(t.as_str()), t);
        }
        assert_eq!(channel_type("unknown"), ChannelType::Channel);

        for s in SubjectKind::ALL {
            assert_eq!(subject_kind(Some(s.as_str())), Some(s));
        }
        assert_eq!(subject_kind(Some("unknown")), None);
        assert_eq!(subject_kind(None), None);

        for n in Notify::ALL {
            assert_eq!(notify_of(n.as_str()), n);
        }
        assert_eq!(notify_of("unknown"), Notify::All);
    }

    #[test]
    fn reactions_text_and_of_preserve_order() {
        let input = vec![("👍".into(), vec!["u1".into()]), ("👀".into(), vec![])];
        let encoded = reactions_text(&input).unwrap();
        assert_eq!(reactions_of(Some(&encoded)), vec![("👍".into(), vec!["u1".into()])]);
        assert_eq!(reactions_text(&[("👀".into(), vec![])]), None);
    }
}
