import type { ArtifactCard, BlockRef, QuotedBlock } from "../artifact/shapes";
import type { Attachment } from "../attachment/shapes";
import type { Actor, MessageId, Outcome, SessionId, Spent } from "../common/shapes";

export const MessageKindValues = ["chat", "dispatch", "report", "notice"] as const;
export type MessageKind = (typeof MessageKindValues)[number];

export interface ChatMessage {
  id: MessageId;
  number: number;
  channel: string;
  from: string;
  actor: Actor;
  name: string;
  agent?: string;
  kind: MessageKind;
  text: string;
  mentions: string[];
  session?: SessionId;
  run?: string;
  outcome: Outcome | null;
  spent?: Spent;
  spoken: boolean;
  /** Client-supplied idempotency key echoed on user messages so pending UI rows reconcile. */
  sendKey?: string;
  at: number;
  /** Channel revision at last write; higher revision wins when reconciling copies. */
  revision: number;
  replyTo?: number;
  edited?: number;
  /** Timestamp of deletion; text and attachments are cleared while `number` is preserved. */
  deleted?: number;
  pinned?: number;
  reactions: Reaction[];
  attachments: Attachment[];
  embeds: Embed[];
  artifact?: ArtifactCard;
  blocks?: readonly QuotedBlock[];
}

export interface Embed {
  url: string;
  title: string;
  description: string;
  site: string;
  image: string;
}

export const NotifyValues = ["all", "mentions", "none"] as const;
export type Notify = (typeof NotifyValues)[number];

export interface Reaction {
  emoji: string;
  by: string[];
}

export const ChannelTypeValues = ["channel", "direct", "thread"] as const;
export type ChannelType = (typeof ChannelTypeValues)[number];

export const SubjectKindValues = ["issue", "talk"] as const;
export type SubjectKind = (typeof SubjectKindValues)[number];

export interface Channel {
  id: string;
  type: ChannelType;
  /** Fallback destination when no channel is specified (e.g. connectors, voice calls); true on exactly one channel. */
  default: boolean;
  peer?: string;
  /** Resolved orchestrator profile id for unaddressed @orchestrator mentions or delegated work in this place. */
  orchestrator?: string;
  members?: string[];
  parent?: string;
  category: string;
  /** Sidebar sort order (ascending); omitted sorts after placed channels. */
  position?: number;
  archived?: number;
  notify: Notify;
  root?: MessageId;
  rootNumber?: number;
  name?: string;
  description: string;
  repo?: string;
  subjectKind: SubjectKind | null;
  subjectId?: string;
  lastNumber?: number;
  replies: number;
  read?: number;
  /** Count of non-notice messages from others after `read`; omitted when 0. */
  unread?: number;
  title: string;
  last?: ChannelLast;
  at: number;
}

export interface ChannelUnread {
  /** Address format: `#channel`, `#channel:n` for threads, `@user` for direct channels. */
  channel: string;
  unread: number;
  mentionsYou: boolean;
  latest?: string;
}

interface ChannelLast {
  from: string;
  name: string;
  text: string;
  at: number;
}

export interface UserMention {
  message: ChatMessage;
  channel: string;
  address: string;
}

export interface Chat {
  channels: Channel[];
  userMentions: UserMention[];
}

/** `Reset` is emitted when the subscriber falls too far behind to catch up incrementally. */
export type ChannelEvent = ChannelMessage | ChannelReset;

interface ChannelMessage {
  _tag: "Message";
  message: ChatMessage;
}

interface ChannelReset {
  _tag: "Reset";
}

export interface SayRequest {
  id: string;
  text: string;
  blocks?: BlockRef[];
  replyTo?: number;
  attachments?: string[];
  station?: number;
  agent?: string;
  repo?: string;
  sendKey?: string;
  /** Orchestrator profile id that alone receives this message (e.g. `/imagegen`). */
  to?: string;
}

export interface ChannelUpdate {
  description?: string;
  repo?: string;
  name?: string;
  /** "" removes the channel from its category. */
  category?: string;
  /** Sidebar placement before this channel id; "" places it last. */
  before?: string;
  /** Orchestrator profile ids only. */
  members?: string[];
}

export interface ChannelRequest {
  name: string;
  description?: string;
  repo?: string;
}

export interface ChatReadRequest {
  number: number;
}

export interface MessageEdit {
  id: MessageId;
  text: string;
  /** Omit to keep all existing attachments; pass a subset to remove the rest. */
  attachments?: string[];
}

export interface NotifyRequest {
  id: string;
  notify: Notify;
}

export interface ReactionSet {
  id: MessageId;
  emoji: string;
  on: boolean;
}

export interface OnSet {
  id: string;
  on: boolean;
}

export interface MessageSearch {
  text: string;
  /** Searches this channel and its threads; omit to search the entire space. */
  channel?: string;
}

export interface MessageHit {
  message: ChatMessage;
  channel: string;
  address: string;
}

export interface FactMessageChanged {
  type: "messageChanged";
  at: number;
  message: ChatMessage;
  thread?: string;
  answers?: SessionId;
}

export interface FactChannelChanged {
  type: "channelChanged";
  at: number;
  channel: Channel;
}

export interface FactChannelRemoved {
  type: "channelRemoved";
  at: number;
  id: string;
}

export interface FactUserMentionsChanged {
  type: "userMentionsChanged";
  at: number;
  mentions: UserMention[];
}
