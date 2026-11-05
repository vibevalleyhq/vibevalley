import { Schema } from "effect";

import { ArtifactCard, BlockRef, QuotedBlock } from "../artifact/schema";
import type { Codec } from "../codec";
import { ActorKind, MessageId, Outcome, SessionId, Spent } from "../common/schema";
import * as T from "../shapes";

export const MessageKind: Codec<T.MessageKind> = Schema.Literals(T.MessageKindValues);

export const Notify: Codec<T.Notify> = Schema.Literals(T.NotifyValues);

export const Embed: Codec<T.Embed> = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  description: Schema.String,
  site: Schema.String,
  image: Schema.String,
});

export const Reaction: Codec<T.Reaction> = Schema.Struct({ emoji: Schema.String, by: Schema.mutable(Schema.Array(Schema.String)) });

export const Attachment: Codec<T.Attachment> = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, size: Schema.Finite });

export const ChatMessage: Codec<T.ChatMessage> = Schema.Struct({
  id: MessageId,
  number: Schema.Finite,
  channel: Schema.String,
  from: Schema.String,
  fromKind: ActorKind,
  name: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  kind: MessageKind,
  text: Schema.String,
  mentions: Schema.mutable(Schema.Array(Schema.String)),
  session: Schema.optionalKey(SessionId),
  run: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Outcome),
  spent: Schema.optionalKey(Spent),
  spoken: Schema.Boolean,
  sendKey: Schema.optionalKey(Schema.String),
  at: Schema.Finite,
  revision: Schema.Finite,
  replyTo: Schema.optionalKey(Schema.Finite),
  edited: Schema.optionalKey(Schema.Finite),
  deleted: Schema.optionalKey(Schema.Finite),
  pinned: Schema.optionalKey(Schema.Finite),
  reactions: Schema.mutable(Schema.Array(Reaction)),
  attachments: Schema.mutable(Schema.Array(Attachment)),
  embeds: Schema.mutable(Schema.Array(Embed)),
  artifact: Schema.optionalKey(ArtifactCard),
  blocks: Schema.optionalKey(Schema.mutable(Schema.Array(QuotedBlock))),
});

export const ChannelType: Codec<T.ChannelType> = Schema.Literals(T.ChannelTypeValues);

export const SubjectKind: Codec<T.SubjectKind> = Schema.Literals(T.SubjectKindValues);

export const Channel: Codec<T.Channel> = Schema.Struct({
  id: Schema.String,
  type: ChannelType,
  default: Schema.Boolean,
  peer: Schema.optionalKey(Schema.String),
  orchestrator: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String),
  category: Schema.String,
  position: Schema.optionalKey(Schema.Finite),
  archived: Schema.optionalKey(Schema.Finite),
  notify: Schema.optionalKey(Notify),
  root: Schema.optionalKey(MessageId),
  rootNumber: Schema.optionalKey(Schema.Finite),
  name: Schema.optionalKey(Schema.String),
  description: Schema.String,
  project: Schema.optionalKey(Schema.String),
  subjectKind: Schema.optionalKey(SubjectKind),
  subjectId: Schema.optionalKey(Schema.String),
  lastNumber: Schema.optionalKey(Schema.Finite),
  replies: Schema.Finite,
  read: Schema.optionalKey(Schema.Finite),
  unread: Schema.optionalKey(Schema.Finite),
  title: Schema.String,
  last: Schema.optionalKey(Schema.Struct({ from: Schema.String, name: Schema.String, text: Schema.String, at: Schema.Finite })),
  at: Schema.Finite,
});

export const OwnerMention: Codec<T.OwnerMention> = Schema.Struct({
  message: ChatMessage,
  channel: Schema.String,
  address: Schema.String,
});

export const Chat: Codec<T.Chat> = Schema.Struct({
  channels: Schema.mutable(Schema.Array(Channel)),
  ownerMentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const ChannelEvent: Codec<T.ChannelEvent> = Schema.Union([Schema.TaggedStruct("Message", { message: ChatMessage }), Schema.TaggedStruct("Reset", {})]);

export const SayRequest: Codec<T.SayRequest> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  blocks: Schema.optionalKey(Schema.mutable(Schema.Array(BlockRef))),
  replyTo: Schema.optionalKey(Schema.Finite),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  station: Schema.optionalKey(Schema.Finite),
  agent: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const ChannelUpdate: Codec<T.ChannelUpdate> = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  orchestrator: Schema.optionalKey(Schema.String),
});

export const ChannelRequest: Codec<T.ChannelRequest> = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});

export const ChatReadRequest: Codec<T.ChatReadRequest> = Schema.Struct({
  number: Schema.Finite,
});

export const MessageEdit: Codec<T.MessageEdit> = Schema.Struct({
  id: MessageId,
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const NotifyRequest: Codec<T.NotifyRequest> = Schema.Struct({ id: Schema.String, notify: Notify });

export const ReactionSet: Codec<T.ReactionSet> = Schema.Struct({ id: MessageId, emoji: Schema.String, on: Schema.Boolean });

export const OnSet: Codec<T.OnSet> = Schema.Struct({ id: Schema.String, on: Schema.Boolean });

export const AttachmentUpload: Codec<T.AttachmentUpload> = Schema.Struct({ name: Schema.String, type: Schema.String, data: Schema.String });

export const MessageSearch: Codec<T.MessageSearch> = Schema.Struct({ text: Schema.String, channel: Schema.optionalKey(Schema.String) });

export const ChannelUnread: Codec<T.ChannelUnread> = Schema.Struct({
  channel: Schema.String,
  unread: Schema.Finite,
  mentionsYou: Schema.Boolean,
  latest: Schema.optionalKey(Schema.String),
});

export const MessageHit: Codec<T.MessageHit> = Schema.Struct({ message: ChatMessage, channel: Schema.String, address: Schema.String });
