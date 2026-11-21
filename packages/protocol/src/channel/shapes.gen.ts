// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ArtifactCard, ArtifactViewContext, BlockRef, QuotedBlock } from "../artifact/shapes.gen";
import type { Attachment } from "../attachment/shapes.gen";
import type { Actor, MessageId, Outcome, SessionId, Spent } from "../common/shapes.gen";

export const MessageKindValues = ["chat", "dispatch", "report", "notice"] as const;
export type MessageKind = (typeof MessageKindValues)[number];

export type ChannelSummary = { unreadTotal: number, unreadUnder: { [key in string]: number }, };

export const NotifyValues = ["all", "mentions", "none"] as const;
export type Notify = (typeof NotifyValues)[number];

export type Embed = { url: string, title: string, description: string, site: string, image: string, };

export type Reaction = { emoji: string, by: Array<string>, };

export type ChatMessage = { id: MessageId, number: number, channel: string, from: string, actor: Actor, name: string, agent?: string, kind: MessageKind, text: string, mentions: Array<string>, session?: SessionId, run?: string, outcome: Outcome | null, spent?: Spent, spoken: boolean,
/**
 * Client-supplied idempotency key echoed on user messages so pending UI rows reconcile.
 */
sendKey?: string, at: number,
/**
 * Channel revision at last write; higher revision wins when reconciling copies.
 */
revision: number, replyTo?: number, edited?: number,
/**
 * Timestamp of deletion; text and attachments are cleared while `number` is preserved.
 */
deleted?: number, pinned?: number, reactions: Array<Reaction>, attachments: Array<Attachment>, embeds: Array<Embed>, artifact?: ArtifactCard, blocks?: readonly QuotedBlock[], viewContext?: ArtifactViewContext, };

export const ChannelTypeValues = ["channel", "direct", "thread"] as const;
export type ChannelType = (typeof ChannelTypeValues)[number];

export const SubjectKindValues = ["issue", "talk"] as const;
export type SubjectKind = (typeof SubjectKindValues)[number];

export type ChannelLast = { from: string, name: string, text: string, at: number, };

export type Channel = { id: string, type: ChannelType,
/**
 * Fallback destination when no channel is specified (e.g. connectors, voice calls); true on exactly one channel.
 */
default: boolean, peer?: string,
/**
 * Resolved orchestrator profile id for unaddressed @orchestrator mentions or delegated work in this place.
 */
orchestrator?: string, members?: Array<string>, parent?: string, category: string,
/**
 * Sidebar sort order (ascending); omitted sorts after placed channels.
 */
position?: number, archived?: number, notify: Notify, root?: MessageId, rootNumber?: number, name?: string, description: string, repo?: string, subjectKind: SubjectKind | null, subjectId?: string, lastNumber?: number, replies: number, read?: number,
/**
 * Count of non-notice messages from others after `read`; omitted when 0.
 */
unread?: number, title: string, last?: ChannelLast, at: number, };

export type UserMention = { message: ChatMessage, channel: string, address: string, };

export type Chat = { channels: Array<Channel>, userMentions: Array<UserMention>, };

/**
 * `Reset` is emitted when the subscriber falls too far behind to catch up incrementally.
 */
export type ChannelEvent = { "_tag": "Message", message: ChatMessage, } | { "_tag": "Reset", };

export type SayRequest = { id: string, text: string, blocks?: Array<BlockRef>, viewContext?: ArtifactViewContext, replyTo?: number, attachments?: Array<string>, station?: number, agent?: string, repo?: string, sendKey?: string,
/**
 * Orchestrator profile id that alone receives this message (e.g. `/imagegen`).
 */
to?: string, };

export type ChannelUpdate = { description?: string, repo?: string, name?: string,
/**
 * "" removes the channel from its category.
 */
category?: string,
/**
 * Sidebar placement before this channel id; "" places it last.
 */
before?: string,
/**
 * Orchestrator profile ids only.
 */
members?: Array<string>, };

export type ChannelRequest = { name: string, description?: string, repo?: string, };

export type ChatReadRequest = { number: number, };

export type MessageEdit = { id: MessageId, text: string,
/**
 * Omit to keep all existing attachments; pass a subset to remove the rest.
 */
attachments?: Array<string>, };

export type NotifyRequest = { id: string, notify: Notify, };

export type ReactionSet = { id: MessageId, emoji: string, on: boolean, };

export type OnSet = { id: string, on: boolean, };

export type MessageSearch = { text: string,
/**
 * Searches this channel and its threads; omit to search the entire space.
 */
channel?: string, };

export type ChannelUnread = {
/**
 * Address format: `#channel`, `#channel:n` for threads, `@user` for direct channels.
 */
channel: string, unread: number, mentionsYou: boolean, latest?: string, };

export type MessageHit = { message: ChatMessage, channel: string, address: string, };

export type FactMessageChanged = { "type": "messageChanged", at: number, message: ChatMessage, thread?: string, answers?: SessionId, };

export type FactChannelChanged = { "type": "channelChanged", at: number, channel: Channel, };

export type FactChannelRemoved = { "type": "channelRemoved", at: number, id: string, };

export type FactUserMentionsChanged = { "type": "userMentionsChanged", at: number, mentions: Array<UserMention>, };

export type ChannelUpdateInput = { id: string, description?: string, repo?: string, name?: string, category?: string, before?: string, members?: Array<string>, };

export type ChannelDefaultSetInput = { id: string, };

export type ChannelMessageListInput = { id: string, before?: number, limit?: number, };

export type ChannelMarkReadInput = { id: string, number: number, };

export type ChannelMessageDeleteInput = { id: MessageId, };

export type ChannelPinSetInput = { id: MessageId, on: boolean, };

export type ChannelPinListInput = { id: string, };

export type ChannelThreadCreateInput = { id: MessageId, requestKey?: string, };

export type ChannelDirectCreateInput = { agent: string, };

export type ChannelMarkUnreadInput = { id: string, number: number, };
