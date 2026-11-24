use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_protocol::{
    Actor, AgentRole, ArtifactCard, ArtifactViewContext, Attachment, ChannelType, ChatMessage, Embed, MessageKind, Notify, Outcome, QuotedBlock, Reaction,
    Spent, SubjectKind, USER_ID,
};

use super::dispatch::QueuedDelivery;
use crate::service::channel::{ChannelRow, EventRow, MsgRow};

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
    pub view_context: Option<ArtifactViewContext>,
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
        .map(|(e, by)| format!("{}:{}", Value::from(e.as_str()), serde_json::to_string(by).unwrap_or_default()))
        .collect();
    (!kept.is_empty()).then(|| format!("{{{}}}", kept.join(",")))
}

pub(super) fn message_kind(kind: &str) -> MessageKind {
    serde_json::from_value(Value::from(kind)).unwrap_or(MessageKind::Chat)
}

pub(super) fn channel_type(kind: &str) -> ChannelType {
    serde_json::from_value(Value::from(kind)).unwrap_or(ChannelType::Channel)
}

pub(super) fn subject_kind(kind: Option<&str>) -> Option<SubjectKind> {
    serde_json::from_value(Value::from(kind?)).ok()
}

pub(super) fn notify_of(n: &str) -> Notify {
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
    pub blocks: Option<Vec<QuotedBlock>>,
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
    pub blocks: Vec<QuotedBlock>,
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
