import { type Effect, type Scope, type Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type ChannelEnvelopeRow, type InboxMessage, type Meta, messageKind, metaOf, type Picked, reactionsOf, senderKind } from "@/base/chat.ts";
import { type ApiError } from "@/errors.ts";

import type * as qm from "../../db/generated/channel_message.sql.ts";
import { type ChannelRow } from "./model.ts";

export type {
  ChannelAudience,
  ChannelEnvelopeRow,
  ChannelRouteFact,
  ChannelRouteResult,
  IngressPurpose,
  Meta,
  OrchestratorNews,
  UnreadRow,
} from "@/base/chat.ts";
export type { InboxMessage, Picked } from "@/base/chat.ts";
export { channelType, inboxMore, messageKind, metaOf, metaText, notifyOf, reactionsOf, reactionsText, senderKind, subjectKind } from "@/base/chat.ts";
export type { Delivered, LaunchActivity, SessionNews } from "@/session/shapes.ts";

export type MsgRow = qm.MessageByIDResult;

export function toMessage(row: MsgRow): T.ChatMessage {
  const meta = metaOf(row.meta);
  return {
    id: S.messageId(row.id),
    number: row.number,
    channel: row.channel_id,
    from: row.sender_id,
    fromKind: senderKind(row.sender_kind),
    name: row.sender_name,
    ...(row.sender_agent ? { agent: row.sender_agent } : {}),
    kind: messageKind(row.kind),
    text: row.body,
    mentions: meta.mentions ?? [],
    ...(meta.session ? { session: meta.session } : {}),
    ...(meta.run ? { run: meta.run } : {}),
    ...(meta.outcome ? { outcome: meta.outcome } : {}),
    ...(meta.spent ? { spent: meta.spent } : {}),
    spoken: meta.spoken ?? false,
    ...(row.send_key && row.sender_id === ownerId ? { sendKey: row.send_key } : {}),
    at: row.created_at,
    revision: row.revision,
    ...(row.reply_number !== null ? { replyTo: row.reply_number } : {}),
    ...(row.edited_at !== null ? { edited: row.edited_at } : {}),
    ...(row.deleted_at !== null ? { deleted: row.deleted_at } : {}),
    ...(row.pinned_at !== null ? { pinned: row.pinned_at } : {}),
    reactions: Object.entries(reactionsOf(row.reactions)).map(([emoji, by]) => ({ emoji, by })),
    attachments: meta.attachments ?? [],
    embeds: meta.embeds ?? [],
    ...(meta.artifact && row.deleted_at === null ? { artifact: meta.artifact } : {}),
    ...(meta.blocks && meta.blocks.length > 0 && row.deleted_at === null ? { blocks: meta.blocks } : {}),
  };
}

export interface Info {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly project: string;
  readonly default: boolean;
}

export interface Spoken {
  readonly kind: "sent" | "held" | "confirm";
  readonly message?: T.ChatMessage;
  readonly target: string;
  readonly absent?: string[];
  readonly shown?: InboxMessage[];
  readonly more?: number;
  readonly lastRead?: string;
}

export interface SpeakOptions {
  readonly target?: string;
  readonly anyway?: boolean;
  readonly confirm?: boolean;
  /** The number of the message there it answers. */
  readonly reply?: number;
}

export interface SayMore {
  readonly source?: "connector" | "voice";
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
  readonly replyTo?: number;
  readonly attachments?: readonly string[];
  readonly picked?: Picked;
  /** The blocks the owner pointed at, to be read as they are now before the message is stored. */
  readonly blockRefs?: readonly T.BlockRef[];
  readonly blocks?: readonly T.QuotedBlock[];
}

export interface ReadOptions {
  readonly target?: string;
  readonly unread?: boolean;
  readonly before?: number;
  readonly limit?: number;
}

export interface ReadResult {
  readonly target: string;
  readonly messages: InboxMessage[];
  readonly older: boolean;
}

export interface EnvelopeResource {
  readonly message: T.ChatMessage;
  readonly attachments: readonly { readonly name: string; readonly path: string }[];
  readonly parent?: T.ChatMessage;
  readonly around: readonly T.ChatMessage[];
}

export const infoOf = (row: Pick<ChannelRow, "id" | "name" | "description" | "project" | "is_default">): Info => ({
  id: row.id,
  name: row.name ?? "",
  description: row.description ?? "",
  project: row.project ?? "",
  default: row.is_default,
});

export const optional = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

export interface ThreadSubject {
  readonly kind: T.SubjectKind;
  readonly id: string;
  readonly owner: string;
}

/** What a session's work is talked about under: the issue it works, so every session on one issue shares a thread; a session sent for no issue has a talk thread of its own. */
export const subjectOf = (h: T.Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

export interface Write {
  readonly channel: string;
  readonly from: string;
  readonly kind: T.MessageKind;
  readonly text: string;
  readonly meta?: Meta;
  readonly answers?: T.SessionId;
  readonly thread?: ThreadSubject;
  /** A participant who follows the channel from this message on, in the same transaction. */
  readonly follow?: string;
  /** The client's key for one send: the same key from the same sender again is that message, not a new one. */
  readonly sendKey?: string;
  /** The number of the message in the same channel it answers. */
  readonly replyTo?: number;
  /** Who has read up to this message once it is written (the owner, of its own words), in the same transaction. */
  readonly readBy?: string;
}

export interface Written {
  absent: string[];
  heldNotice: string;
  received: readonly { readonly session: string; readonly envelope: string }[];
  thread: string;
  /** A send with a key already written: nothing new is written or delivered. */
  again: boolean;
  /** The message as written (its mentions in its meta), or the one sent before with the same key. */
  row: MsgRow;
}

export interface ChannelHandoffSubject {
  readonly kind: "issue" | "session" | "chat";
  readonly id: string;
}

export interface ChannelService {
  readonly replayDelivery: (row: ChannelEnvelopeRow) => Effect.Effect<void>;
  readonly ownerReads: Effect.Effect<Stream.Stream<{ readonly channel: string; readonly number: number; readonly at: number }>, never, Scope.Scope>;
  readonly handoffSubject: (message: string) => Effect.Effect<ChannelHandoffSubject | undefined>;
  /** The channel what names none goes to (ChatMessage.channel, a connector's, a call's). */
  readonly defaultChannel: () => string;
  readonly makeDefault: (id: string) => Effect.Effect<void, ApiError>;
  /** The owner's words; again: sendKey was sent before, and the message is that one. */
  readonly say: (
    text: string,
    channel: string | undefined,
    sendKey: string,
    more?: SayMore,
  ) => Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
  /** The owner's own chat words, changed. Changes tell and wake nobody. */
  readonly edit: (id: T.MessageId, text: string, keep?: readonly string[]) => Effect.Effect<T.ChatMessage, ApiError>;
  /** Any message: its words, files and reactions go, its number stays, and what it had still to hand is dropped. */
  readonly remove: (id: T.MessageId) => Effect.Effect<void, ApiError>;
  readonly previewRemove: (id: T.MessageId) => Effect.Effect<T.Preview, ApiError>;
  /** A participant's reaction on or off; as it already is, the message is returned unchanged. */
  readonly react: (id: T.MessageId, who: string, emoji: string, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
  /** Pinned or not; as it already is, the message is returned unchanged. */
  readonly pin: (id: T.MessageId, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
  readonly pins: (channel: string) => Effect.Effect<T.ChatMessage[], ApiError>;
  /** The thread under a channel's message, opened if it has none. */
  readonly threadUnder: (id: T.MessageId) => Effect.Effect<string, ApiError>;
  readonly issueThread: (issue: string, title: string, channel?: string) => Effect.Effect<string, ApiError>;
  readonly issueMessages: (issue: string) => Effect.Effect<InboxMessage[]>;
  readonly search: (text: string, channel?: string) => Effect.Effect<T.MessageHit[], ApiError>;
  readonly attach: (upload: T.AttachmentUpload) => Effect.Effect<T.Attachment, ApiError>;
  readonly attachment: (id: string) => Effect.Effect<{ readonly path: string; readonly type: string; readonly name: string } | undefined>;
  /** Words to a session in its thread; with no thread the session hears them straight. */
  readonly tellSession: (from: string, session: string, text: string, sendKey: string) => Effect.Effect<T.ChatMessage | undefined, ApiError>;
  /** A session's or the orchestrator's words, through channel_message_send. */
  readonly speak: (from: string, text: string, opt?: SpeakOptions) => Effect.Effect<Spoken, ApiError>;
  /** The channel's id for a channel given by id or as a target ("#name", a thread), or from's own place when "": a
   * session's own thread, else the default channel. */
  readonly placeOf: (from: string, channel: string) => Effect.Effect<string, ApiError>;
  /** Words that announce an artifact (artifact/), with its card, said as from (the owner, a session or an orchestrator) in
   * a channel placeOf names. Never held for unseen messages, as speak's are: it answers none of them. */
  readonly announce: (from: string, channel: string, text: string, card: T.ArtifactCard) => Effect.Effect<T.ChatMessage, ApiError>;
  /** Words said on a call, kept in the default channel as they were said; they wake no one. */
  readonly spoken: (from: string, text: string, sendKey: string) => Effect.Effect<boolean, ApiError>;
  /** An orchestrator's words (from: its profile id), one whole message each: it shows once said in full. */
  readonly orchestratorSays: (channel: string, text: string, run: string, from: string) => Effect.Effect<void>;
  /** code names the kind, for dropping repeats. */
  readonly notice: (channel: string, text: string, code: string) => Effect.Effect<void>;
  readonly read: (who: string, opt?: ReadOptions) => Effect.Effect<ReadResult, ApiError>;
  /** The places who has not read all of, the newest first, by their addresses. */
  readonly unread: (who: string) => Effect.Effect<T.ChannelUnread[]>;
  /** Every channel and direct channel as a page lists them, the default first. */
  readonly list: () => Effect.Effect<T.Channel[]>;
  readonly history: (channel: string, before?: number, limit?: number) => Effect.Effect<T.ChatMessage[]>;
  /** A message's durable location; the recent state may hold neither the message nor its thread. */
  readonly messageLocation: (id: T.MessageId) => Effect.Effect<{ readonly channel: T.Channel; readonly top: string } | undefined>;
  readonly envelopeResource: (id: T.MessageId) => Effect.Effect<EnvelopeResource | undefined>;
  readonly markRead: (channel: string, seq: number) => Effect.Effect<void, ApiError>;
  /** Its direct conversation, issue thread, or standalone talk thread. */
  readonly threadOfSession: (session: string) => Effect.Effect<string | undefined>;
  /** The channels the core state holds now. */
  readonly now: () => T.Chat | undefined;
  /** What is said in a channel after the message numbered after, then what is said there from now on; Reset when
   * more than catchUpMax were missed. A follower too slow for what is said ends, and comes back with its number. */
  readonly follow: (channel: string, after: number) => Stream.Stream<T.ChannelEvent, ApiError>;
  /** The turn reports anywhere after the one with this id, or the newest logKeep when absent, then each from now on. */
  readonly reports: (after?: string) => Stream.Stream<T.ChannelEvent>;
  /** The owner's words said in full in a thread, whatever path they took in: what an issue hears its owner by.
   * Subscribed before it returns. */
  readonly ownerInThread: Effect.Effect<Stream.Stream<{ readonly thread: string; readonly message: T.ChatMessage }>, never, Scope.Scope>;
  readonly channels: () => Effect.Effect<Info[]>;
  readonly openChannel: (name: string, description: string, project: string) => Effect.Effect<Info, ApiError>;
  /** description undefined or empty: as it was; project undefined: as it was, empty: none. */
  /** Each field given changes: a channel's description, project, name, group and place; a thread's title. */
  readonly updateChannel: (id: string, upd: T.ChannelUpdate) => Effect.Effect<void, ApiError>;
  /** Archived or not; as it already is, nothing changes. */
  readonly archive: (id: string, on: boolean) => Effect.Effect<void, ApiError>;
  readonly removeChannel: (id: string) => Effect.Effect<void, ApiError>;
  readonly previewRemoveChannel: (id: string) => Effect.Effect<T.Preview, ApiError>;
  readonly setNotify: (id: string, notify: T.Notify) => Effect.Effect<void, ApiError>;
  /** How much of a place counts for the owner: none when it or its channel is set to none, else its own level, else its channel's. */
  readonly notifyOf: (id: string) => T.Notify;
  readonly direct: (agent: string) => Effect.Effect<string, ApiError>;
  /** The orchestrator a place is looked after by: a channel's own, its thread's channel's, a direct channel's peer when
   * that is an orchestrator, else the default one. */
  readonly orchestratorOf: (channel: string) => string;
  /** The newest messages of a channel, oldest first, as an agent reads them. */
  readonly recent: (channel: string, n: number) => Effect.Effect<InboxMessage[]>;
  readonly markUnread: (channel: string, number: number) => Effect.Effect<void, ApiError>;
  /** The channel a place is in: a thread's, or the default one for a direct channel, which holds no work. */
  readonly topOf: (channel: string) => Effect.Effect<Info>;
  /** How the orchestrator writes the place it answers in: a direct channel's own address, else its channel's. */
  readonly addressOf: (channel: string) => Effect.Effect<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Effect.Effect<Info | undefined>;
  /** The chat's startup, after the sessions came back: their threads, and what waited for them. */
  readonly start: Effect.Effect<void, ApiError>;
}
