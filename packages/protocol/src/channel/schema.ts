import { z } from "zod";

import { ArtifactCard, ArtifactViewContext } from "../artifact/schema";
import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import { Actor, MessageId, Outcome, SessionId, Spent } from "../common/schema";
import * as T from "./shapes.gen";

const MessageKind = z.enum(T.MessageKindValues) satisfies Codec<T.MessageKind>;

export const Notify = z.enum(T.NotifyValues) satisfies Codec<T.Notify>;

export const Embed = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  site: z.string(),
  image: z.string(),
}) satisfies Codec<T.Embed>;

const Reaction = z.object({ emoji: z.string(), by: z.array(z.string()) }) satisfies Codec<T.Reaction>;

export const ChatMessage = z.object({
  id: MessageId,
  number: z.number(),
  channel: z.string(),
  from: z.string(),
  actor: Actor,
  name: z.string(),
  agent: z.exactOptional(z.string()),
  kind: MessageKind,
  text: z.string(),
  mentions: z.array(z.string()),
  session: z.exactOptional(SessionId),
  run: z.exactOptional(z.string()),
  outcome: Outcome.nullable(),
  spent: z.exactOptional(Spent),
  spoken: z.boolean(),
  sendKey: z.exactOptional(z.string()),
  at: z.number(),
  revision: z.number(),
  replyTo: z.exactOptional(z.number()),
  edited: z.exactOptional(z.number()),
  deleted: z.exactOptional(z.number()),
  pinned: z.exactOptional(z.number()),
  reactions: z.array(Reaction),
  attachments: z.array(Attachment),
  embeds: z.array(Embed),
  artifact: z.exactOptional(ArtifactCard),
  viewContext: z.exactOptional(ArtifactViewContext),
}) satisfies Codec<T.ChatMessage>;

const ChannelType = z.enum(T.ChannelTypeValues) satisfies Codec<T.ChannelType>;

const SubjectKind = z.enum(T.SubjectKindValues) satisfies Codec<T.SubjectKind>;

export const Channel = z.object({
  id: z.string(),
  type: ChannelType,
  default: z.boolean(),
  peer: z.exactOptional(z.string()),
  orchestrator: z.exactOptional(z.string()),
  members: z.exactOptional(z.array(z.string())),
  parent: z.exactOptional(z.string()),
  category: z.string(),
  position: z.exactOptional(z.number()),
  archived: z.exactOptional(z.number()),
  notify: Notify,
  root: z.exactOptional(MessageId),
  rootNumber: z.exactOptional(z.number()),
  name: z.exactOptional(z.string()),
  description: z.string(),
  repo: z.exactOptional(z.string()),
  subjectKind: SubjectKind.nullable(),
  subjectId: z.exactOptional(z.string()),
  lastNumber: z.exactOptional(z.number()),
  replies: z.number(),
  read: z.exactOptional(z.number()),
  unread: z.exactOptional(z.number()),
  title: z.string(),
  last: z.exactOptional(z.object({ from: z.string(), name: z.string(), text: z.string(), at: z.number() })),
  at: z.number(),
}) satisfies Codec<T.Channel>;

const UserMention = z.object({
  message: ChatMessage,
  channel: z.string(),
  address: z.string(),
}) satisfies Codec<T.UserMention>;

export const Chat = z.object({
  channels: z.array(Channel),
  userMentions: z.array(UserMention),
}) satisfies Codec<T.Chat>;

export const ChannelSummary = z.object({
  unreadTotal: z.number(),
  unreadUnder: z.record(z.string(), z.number()),
}) satisfies Codec<T.ChannelSummary>;

export const ChannelEvent = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Message"), message: ChatMessage }),
  z.object({ _tag: z.literal("Reset") }),
]) satisfies Codec<T.ChannelEvent>;

export const ChannelCommand = z.object({
  name: z.string(),
  args: z.string(),
}) satisfies Codec<T.ChannelCommand>;

export const SayRequest = z.object({
  id: z.string(),
  text: z.string(),
  viewContext: z.exactOptional(ArtifactViewContext),
  replyTo: z.exactOptional(z.number()),
  attachments: z.exactOptional(z.array(z.string())),
  station: z.exactOptional(z.number()),
  agent: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  sendKey: z.exactOptional(z.string()),
  to: z.exactOptional(z.string()),
  command: z.exactOptional(ChannelCommand),
}) satisfies Codec<T.SayRequest>;

export const ChannelUpdate = z.object({
  description: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  category: z.exactOptional(z.string()),
  before: z.exactOptional(z.string()),
  members: z.exactOptional(z.array(z.string())),
}) satisfies Codec<T.ChannelUpdate>;

export const ChannelRequest = z.object({
  name: z.string(),
  description: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
}) satisfies Codec<T.ChannelRequest>;

export const ChatReadRequest = z.object({
  number: z.number(),
}) satisfies Codec<T.ChatReadRequest>;

export const MessageEdit = z.object({
  id: MessageId,
  text: z.string(),
  attachments: z.exactOptional(z.array(z.string())),
}) satisfies Codec<T.MessageEdit>;

export const NotifyRequest = z.object({ id: z.string(), notify: Notify }) satisfies Codec<T.NotifyRequest>;

export const ReactionSet = z.object({ id: MessageId, emoji: z.string(), on: z.boolean() }) satisfies Codec<T.ReactionSet>;

export const OnSet = z.object({ id: z.string(), on: z.boolean() }) satisfies Codec<T.OnSet>;

export const MessageSearch = z.object({ text: z.string(), channel: z.exactOptional(z.string()) }) satisfies Codec<T.MessageSearch>;

export const ChannelUnread = z.object({
  channel: z.string(),
  unread: z.number(),
  mentionsYou: z.boolean(),
  latest: z.exactOptional(z.string()),
}) satisfies Codec<T.ChannelUnread>;

export const MessageHit = z.object({ message: ChatMessage, channel: z.string(), address: z.string() }) satisfies Codec<T.MessageHit>;
