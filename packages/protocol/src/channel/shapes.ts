import type { AgentRole } from "../agent/shapes";
import type { ArtifactCard, BlockRef, QuotedBlock } from "../artifact/shapes";
import type { Attachment } from "../attachment/shapes";
import type { ActorKind, MessageId, Outcome, SessionId, Spent } from "../common/shapes";

export const MessageKindValues = ["chat", "dispatch", "report", "notice"] as const;
export type MessageKind = (typeof MessageKindValues)[number];

export interface ChatMessage {
  id: MessageId;
  number: number;
  channel: string;
  from: string;
  fromKind: ActorKind;
  /** The speaking agent's role, when fromKind is agent. */
  fromRole?: AgentRole;
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
  /** The key the user's send carried, on the user's own messages: a page knows its line by it. */
  sendKey?: string;
  at: number;
  /** Its channel's revision when it was last written or changed: of two copies, the higher one is now. */
  revision: number;
  /** The number of the message in the same channel it answers. */
  replyTo?: number;
  /** When its words were last changed. */
  edited?: number;
  /** Deleted then: its words and attachments are gone, its number stays. */
  deleted?: number;
  pinned?: number;
  /** In the order they first came. */
  reactions: Reaction[];
  attachments: Attachment[];
  /** Previews of the links in its words, as the server read them. */
  embeds: Embed[];
  /** The artifact it announces, as it was at that version (docs/subsystems/artifact.md). */
  artifact?: ArtifactCard;
  /** The blocks it points at, as they read when it was sent. */
  blocks?: readonly QuotedBlock[];
}

export interface Embed {
  url: string;
  title: string;
  description: string;
  site: string;
  /** An image the page shows for it, at its own address on the web. */
  image: string;
}

export const NotifyValues = ["all", "mentions", "none"] as const;
export type Notify = (typeof NotifyValues)[number];

export interface Reaction {
  emoji: string;
  /** Participants, in the order they reacted. */
  by: string[];
}

export const ChannelTypeValues = ["channel", "direct", "thread"] as const;
export type ChannelType = (typeof ChannelTypeValues)[number];

export const SubjectKindValues = ["issue", "talk"] as const;
export type SubjectKind = (typeof SubjectKindValues)[number];

export interface Channel {
  id: string;
  type: ChannelType;
  /** The farm's default channel: what names no channel goes there (a connector's, a call's). One channel is. */
  default: boolean;
  /** A direct channel's other participant: an orchestrator, or a helper profile. The user talks with it there alone. */
  peer?: string;
  /** The orchestrator in the place, by its profile id, as the server resolves it: a direct channel's other one, else one
   * of the members of the channel it is in, else the default one. What names no orchestrator in particular there (a
   * generic @ of it, work left to one) goes to it. */
  orchestrator?: string;
  /** Who is in a channel or follows a thread, by participant id: what is said there to no one in particular goes to them. */
  members?: string[];
  /** A thread's channel. */
  parent?: string;
  /** A channel's group in the sidebar. */
  category: string;
  /** Its place in the sidebar, lowest first; none comes after the placed. */
  position?: number;
  archived?: number;
  /** What of it counts for the user; absent is all. */
  notify: Notify;
  /** The message a thread hangs under, and its number there. */
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
  /** What the user has not read here: others' messages past read, notices left out; absent when none. */
  unread?: number;
  /** A thread not on an issue, by the server: a talk thread's session, else the head of the message it hangs under. */
  title: string;
  /** The newest message, as a list shows it under the channel. */
  last?: ChannelLast;
  at: number;
}

/** A place a participant has not read all of, as channel.unread.list gives it to its caller. */
export interface ChannelUnread {
  /** Its address: #channel, #channel:n for a thread, @user for the orchestrator's direct channel. */
  channel: string;
  unread: number;
  /** Something there names the caller. */
  mentionsYou: boolean;
  /** Who said the newest message there. */
  latest?: string;
}

export interface ChannelLast {
  from: string;
  name: string;
  /** Its head, on one line. */
  text: string;
  at: number;
}

export interface UserMention {
  message: ChatMessage;
  channel: string;
  address: string;
}

/** The channels, not what is said in them: a page follows a channel for that (rpc.ts). */
export interface Chat {
  channels: Channel[];
  userMentions: UserMention[];
}

/** What a channel's follower gets: each message said there, by its number; Reset when it is too far behind to catch up. */
export type ChannelEvent = ChannelMessage | ChannelReset;

export interface ChannelMessage {
  _tag: "Message";
  message: ChatMessage;
}

export interface ChannelReset {
  _tag: "Reset";
}

export interface SayRequest {
  /** The channel it is said in. */
  id: string;
  text: string;
  /** Blocks of a blocks artifact this message points at. */
  blocks?: BlockRef[];
  /** The number of the message there it answers. */
  replyTo?: number;
  /** Ids from attachment.create. */
  attachments?: string[];
  station?: number;
  agent?: string;
  repo?: string;
  sendKey?: string;
  /** The orchestrator it is said to, by profile id: only it hears it (a skill asked of the orchestrator in the place, /imagegen). */
  to?: string;
}

export interface ChannelUpdate {
  description?: string;
  repo?: string;
  /** A channel's name (unique, written in its address), or a thread's title. */
  name?: string;
  /** A channel's group; empty takes it out of one. */
  category?: string;
  /** Placed before this channel in the sidebar; empty is last. */
  before?: string;
  /** The agents in the channel, by profile id: what is said there to no one in particular goes to them. Only orchestrators can be. */
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
  /** The files it keeps: absent keeps them all, a shorter list takes the others off. */
  attachments?: string[];
}

export interface NotifyRequest {
  id: string;
  notify: Notify;
}

/** The user's reaction on (added) or off (taken back); setting it as it already is changes nothing. */
export interface ReactionSet {
  id: MessageId;
  emoji: string;
  on: boolean;
}

/** A channel archived (on), or not; setting it as it already is changes nothing. */
export interface OnSet {
  id: string;
  on: boolean;
}

export interface MessageSearch {
  text: string;
  /** A channel: it and its threads; none is the whole farm. */
  channel?: string;
}

/** A message found, with where it is: the channel it is in (or a thread's channel) and its address there. */
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

/** A channel deleted, and its threads with it. */
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
