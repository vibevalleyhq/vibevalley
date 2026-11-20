#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MessageKind {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "dispatch")]
    Dispatch,
    #[serde(rename = "report")]
    Report,
    #[serde(rename = "notice")]
    Notice,
}

impl MessageKind {
    pub const ALL: [MessageKind; 4] = [MessageKind::Chat, MessageKind::Dispatch, MessageKind::Report, MessageKind::Notice];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MessageKind::Chat => "chat",
            MessageKind::Dispatch => "dispatch",
            MessageKind::Report => "report",
            MessageKind::Notice => "notice",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Notify {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "mentions")]
    Mentions,
    #[serde(rename = "none")]
    None,
}

impl Notify {
    pub const ALL: [Notify; 3] = [Notify::All, Notify::Mentions, Notify::None];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Notify::All => "all",
            Notify::Mentions => "mentions",
            Notify::None => "none",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Embed {
    pub url: String,
    pub title: String,
    pub description: String,
    pub site: String,
    pub image: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    pub by: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
    pub number: i64,
    pub channel: String,
    pub from: String,
    pub actor: Actor,
    pub name: String,
    pub agent: Option<String>,
    pub kind: MessageKind,
    pub text: String,
    pub mentions: Vec<String>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
    pub session: Option<SessionId>,
    pub run: Option<String>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub outcome: Option<Outcome>,
    pub spent: Option<Spent>,
    pub spoken: bool,
    /// Client-supplied idempotency key echoed on user messages so pending UI rows reconcile.
    pub send_key: Option<String>,
    pub at: i64,
    /// Channel revision at last write; higher revision wins when reconciling copies.
    pub revision: i64,
    pub reply_to: Option<i64>,
    pub edited: Option<i64>,
    /// Timestamp of deletion; text and attachments are cleared while `number` is preserved.
    pub deleted: Option<i64>,
    pub pinned: Option<i64>,
    pub reactions: Vec<Reaction>,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    pub artifact: Option<ArtifactCard>,
    #[cfg_attr(feature = "ts-gen", ts(optional, type = "readonly QuotedBlock[]"))]
    pub blocks: Option<Vec<QuotedBlock>>,
    pub view_context: Option<ArtifactViewContext>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ChannelType {
    #[serde(rename = "channel")]
    Channel,
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "thread")]
    Thread,
}

impl ChannelType {
    pub const ALL: [ChannelType; 3] = [ChannelType::Channel, ChannelType::Direct, ChannelType::Thread];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelType::Channel => "channel",
            ChannelType::Direct => "direct",
            ChannelType::Thread => "thread",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SubjectKind {
    #[serde(rename = "issue")]
    Issue,
    #[serde(rename = "talk")]
    Talk,
}

impl SubjectKind {
    pub const ALL: [SubjectKind; 2] = [SubjectKind::Issue, SubjectKind::Talk];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Issue => "issue",
            SubjectKind::Talk => "talk",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelLast {
    pub from: String,
    pub name: String,
    pub text: String,
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub r#type: ChannelType,
    /// Fallback destination when no channel is specified (e.g. connectors, voice calls); true on exactly one channel.
    pub default: bool,
    pub peer: Option<String>,
    /// Resolved orchestrator profile id for unaddressed @orchestrator mentions or delegated work in this place.
    pub orchestrator: Option<String>,
    pub members: Option<Vec<String>>,
    pub parent: Option<String>,
    pub category: String,
    /// Sidebar sort order (ascending); omitted sorts after placed channels.
    pub position: Option<i64>,
    pub archived: Option<i64>,
    pub notify: Notify,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::MessageId>"))]
    pub root: Option<MessageId>,
    pub root_number: Option<i64>,
    pub name: Option<String>,
    pub description: String,
    pub repo: Option<String>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub subject_kind: Option<SubjectKind>,
    pub subject_id: Option<String>,
    pub last_number: Option<i64>,
    pub replies: i64,
    pub read: Option<i64>,
    /// Count of non-notice messages from others after `read`; omitted when 0.
    pub unread: Option<i64>,
    pub title: String,
    pub last: Option<ChannelLast>,
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct UserMention {
    pub message: ChatMessage,
    pub channel: String,
    pub address: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub channels: Vec<Channel>,
    pub user_mentions: Vec<UserMention>,
}

/// `Reset` is emitted when the subscriber falls too far behind to catch up incrementally.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum ChannelEvent {
    #[serde(rename = "Message", rename_all = "camelCase")]
    Message { message: ChatMessage },
    #[serde(rename = "Reset")]
    Reset {},
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SayRequest {
    pub id: String,
    pub text: String,
    pub blocks: Option<Vec<BlockRef>>,
    pub view_context: Option<ArtifactViewContext>,
    pub reply_to: Option<i64>,
    pub attachments: Option<Vec<String>>,
    pub station: Option<i64>,
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub send_key: Option<String>,
    /// Orchestrator profile id that alone receives this message (e.g. `/imagegen`).
    pub to: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdate {
    pub description: Option<String>,
    pub repo: Option<String>,
    pub name: Option<String>,
    /// "" removes the channel from its category.
    pub category: Option<String>,
    /// Sidebar placement before this channel id; "" places it last.
    pub before: Option<String>,
    /// Orchestrator profile ids only.
    pub members: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelRequest {
    pub name: String,
    pub description: Option<String>,
    pub repo: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChatReadRequest {
    pub number: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MessageEdit {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
    pub text: String,
    /// Omit to keep all existing attachments; pass a subset to remove the rest.
    pub attachments: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub id: String,
    pub notify: Notify,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ReactionSet {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
    pub emoji: String,
    pub on: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct OnSet {
    pub id: String,
    pub on: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MessageSearch {
    pub text: String,
    /// Searches this channel and its threads; omit to search the entire space.
    pub channel: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelUnread {
    /// Address format: `#channel`, `#channel:n` for threads, `@user` for direct channels.
    pub channel: String,
    pub unread: i64,
    pub mentions_you: bool,
    pub latest: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub message: ChatMessage,
    pub channel: String,
    pub address: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactMessageChanged {
    pub at: i64,
    pub message: ChatMessage,
    pub thread: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
    pub answers: Option<SessionId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactChannelChanged {
    pub at: i64,
    pub channel: Channel,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactChannelRemoved {
    pub at: i64,
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactUserMentionsChanged {
    pub at: i64,
    pub mentions: Vec<UserMention>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdateInput {
    pub id: String,
    pub description: Option<String>,
    pub repo: Option<String>,
    pub name: Option<String>,
    pub category: Option<String>,
    pub before: Option<String>,
    pub members: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelDefaultSetInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessageListInput {
    pub id: String,
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelMarkReadInput {
    pub id: String,
    pub number: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessageDeleteInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelPinSetInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
    pub on: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelPinListInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelThreadCreateInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::MessageId"))]
    pub id: MessageId,
    pub request_key: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelDirectCreateInput {
    pub agent: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChannelMarkUnreadInput {
    pub id: String,
    pub number: i64,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "channel";
    types: [MessageKind,
    Notify,
    Embed,
    Reaction,
    ChatMessage,
    ChannelType,
    SubjectKind,
    ChannelLast,
    Channel,
    UserMention,
    Chat,
    ChannelEvent,
    SayRequest,
    ChannelUpdate,
    ChannelRequest,
    ChatReadRequest,
    MessageEdit,
    NotifyRequest,
    ReactionSet,
    OnSet,
    MessageSearch,
    ChannelUnread,
    MessageHit,
    FactMessageChanged,
    FactChannelChanged,
    FactChannelRemoved,
    FactUserMentionsChanged,
    ChannelUpdateInput,
    ChannelDefaultSetInput,
    ChannelMessageListInput,
    ChannelMarkReadInput,
    ChannelMessageDeleteInput,
    ChannelPinSetInput,
    ChannelPinListInput,
    ChannelThreadCreateInput,
    ChannelDirectCreateInput,
    ChannelMarkUnreadInput];
    aliases: [];
}
