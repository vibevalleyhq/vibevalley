import { type Effect, Formatter, Schema, type Scope, type Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError } from "#/base/errors.ts";
import { jsonOrNone } from "#/base/json.ts";
import { type Envelope, type Meta, metaOf, type Picked, speakerOf } from "#/mailbox/envelope.ts";
import type * as qm from "#db/channel_message.sql.ts";

import { type ChannelRow } from "./rooms.ts";

export type { ChannelAudience, ChannelEnvelopeRow, ChannelHearers, Meta } from "#/mailbox/envelope.ts";
export type { Envelope, Picked } from "#/mailbox/envelope.ts";
export { channelType, envelopeMore, metaOf, metaText, speakerOf } from "#/mailbox/envelope.ts";
export type { Delivered, SessionNews } from "#/session/signals.ts";

export type MsgRow = qm.MessageByIDResult;

/** {"emoji": [participant, …]}, as a message keeps them; anything unreadable is none. */
const ReactionsSchema = Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String)));
type Reactions = Record<string, string[]>;
export const reactionsOf = (raw: string | null): Reactions => jsonOrNone(ReactionsSchema)(raw) ?? {};
export const reactionsText = (r: Reactions) => {
  const kept = Object.entries(r).filter(([, by]) => by.length > 0);
  return kept.length > 0 ? Formatter.formatJson(Object.fromEntries(kept)) : null;
};

export const messageKind = (kind: string): T.MessageKind => (Schema.is(S.MessageKind)(kind) ? kind : "chat");
export const subjectKind = (kind: string | null): T.SubjectKind | undefined => (kind !== null && Schema.is(S.SubjectKind)(kind) ? kind : undefined);
export const notifyOf = (n: string): T.Notify => (Schema.is(S.Notify)(n) ? n : "all");

export function toMessage(row: MsgRow): T.ChatMessage {
  const meta = metaOf(row.meta);
  return {
    id: S.messageId(row.id),
    number: row.number,
    channel: row.channel_id,
    from: row.sender_id,
    ...speakerOf(row.sender_kind),
    name: row.sender_name,
    ...(row.sender_agent ? { agent: row.sender_agent } : {}),
    kind: messageKind(row.kind),
    text: row.body,
    mentions: meta.mentions ?? [],
    ...(meta.session ? { session: meta.session } : {}),
    ...(meta.run ? { run: meta.run } : {}),
    outcome: meta.outcome ?? null,
    ...(meta.spent ? { spent: meta.spent } : {}),
    spoken: meta.spoken ?? false,
    ...(row.send_key && row.sender_id === userId ? { sendKey: row.send_key } : {}),
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
  readonly repo: string;
  readonly default: boolean;
}

export interface Spoken {
  readonly kind: "sent" | "held" | "confirm";
  readonly message?: T.ChatMessage;
  readonly target: string;
  readonly absent?: string[];
  readonly shown?: Envelope[];
  readonly more?: number;
  readonly lastRead?: string;
}

interface SpeakOptions {
  readonly target?: string;
  readonly anyway?: boolean;
  readonly confirm?: boolean;
  /** The number of the message there it answers. */
  readonly reply?: number;
}

/** What an announcement shows: an artifact's card, or attachments by id. */
export type Made = { readonly card: T.ArtifactCard } | { readonly attachments: readonly string[] };

export interface SayMore {
  readonly source?: "connector" | "voice";
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
  readonly replyTo?: number;
  readonly attachments?: readonly string[];
  readonly picked?: Picked;
  /** The blocks the user pointed at, to be read as they are now before the message is stored. */
  readonly blockRefs?: readonly T.BlockRef[];
  readonly blocks?: readonly T.QuotedBlock[];
  /** The orchestrator it is said to: only it hears it. */
  readonly to?: string;
}

interface ReadOptions {
  readonly target?: string;
  readonly unread?: boolean;
  readonly before?: number;
  readonly limit?: number;
}

interface ReadResult {
  readonly target: string;
  readonly messages: Envelope[];
  readonly older: boolean;
}

interface EnvelopeResource {
  readonly message: T.ChatMessage;
  readonly attachments: readonly { readonly name: string; readonly path: string }[];
  readonly parent?: T.ChatMessage;
  readonly around: readonly T.ChatMessage[];
}

export const infoOf = (row: Pick<ChannelRow, "id" | "name" | "description" | "repo" | "is_default">): Info => ({
  id: row.id,
  name: row.name ?? "",
  description: row.description ?? "",
  repo: row.repo ?? "",
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

/** What a session's work is talked about under: the issue it works, so every session on one issue shares a thread. */
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
  readonly member?: string;
  /** The client's key for one send: the same key from the same sender again is that message, not a new one. */
  readonly sendKey?: string;
  /** The number of the message in the same channel it answers. */
  readonly replyTo?: number;
  /** Who has read up to this message once it is written (the user, of its own words), in the same transaction. */
  readonly readBy?: string;
}

/** Words written into a place, by who writes them; each kind keeps its own checks and its own answer. */
export type Post =
  /** The user's words; again: sendKey was sent before, and the message is that one. channel undefined: the default one. */
  | ({ readonly _tag: "User"; readonly text: string; readonly channel?: string | undefined; readonly sendKey: string } & SayMore)
  /** Words to a session in its thread; with no thread the session hears them straight. */
  | { readonly _tag: "Tell"; readonly from: string; readonly session: string; readonly text: string; readonly sendKey: string }
  /** A session's or the orchestrator's words, through channel_message_send: a retry is that message, unseen words are shown first. */
  | ({ readonly _tag: "Agent"; readonly from: string; readonly text: string } & SpeakOptions)
  /** Words that announce what was made, with it: an artifact's card (artifact/) or a made file's attachments (media/), said as from
   * (the user, a session or an orchestrator) in a channel placeOf names. A sendKey said before is that message again. */
  | { readonly _tag: "Announce"; readonly from: string; readonly channel: string; readonly text: string; readonly made: Made; readonly sendKey?: string }
  /** Words said on a call, kept in the default channel as they were said; they wake no one. */
  | { readonly _tag: "Call"; readonly from: string; readonly text: string; readonly sendKey: string }
  /** The words a run of an agent hosted here said (from: its profile id), one whole message each: it shows once said in full. */
  | { readonly _tag: "Run"; readonly from: string; readonly channel: string; readonly text: string; readonly run: string }
  /** The farm's own notice; code names the kind, for dropping repeats. */
  | { readonly _tag: "Notice"; readonly channel: string; readonly text: string; readonly code: string; readonly sendKey?: string };

export type PostOf<Tag extends Post["_tag"]> = Extract<Post, { readonly _tag: Tag }>;

/** Each kind of post with its answer; Run and Notice are best effort and never fail. */
export interface PostDoor {
  (p: PostOf<"User">): Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
  (p: PostOf<"Tell">): Effect.Effect<T.ChatMessage | undefined, ApiError>;
  (p: PostOf<"Agent">): Effect.Effect<Spoken, ApiError>;
  (p: PostOf<"Announce">): Effect.Effect<T.ChatMessage, ApiError>;
  (p: PostOf<"Call">): Effect.Effect<boolean, ApiError>;
  (p: PostOf<"Run"> | PostOf<"Notice">): Effect.Effect<void>;
}

export interface Written {
  absent: string[];
  heldNotice: string;
  thread: string;
  /** A send with a key already written: nothing new is written or delivered. */
  again: boolean;
  /** The message as written (its mentions in its meta), or the one sent before with the same key. */
  row: MsgRow;
}

export interface ChannelService {
  readonly userReads: Effect.Effect<Stream.Stream<{ readonly channel: string; readonly number: number; readonly at: number }>, never, Scope.Scope>;
  /** The channel what names none goes to (ChatMessage.channel, a connector's, a call's). */
  readonly defaultChannel: () => string;
  readonly makeDefault: (id: string) => Effect.Effect<void, ApiError>;
  /** Words written into a place: one door, and what is checked and answered depends on who writes them (Post). */
  readonly post: PostDoor;
  /** The user's own chat words, changed. Changes tell and wake nobody. */
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
  readonly issueThreadId: (issue: string) => Effect.Effect<string | null>;
  readonly issueMessages: (issue: string) => Effect.Effect<Envelope[]>;
  readonly search: (text: string, channel?: string) => Effect.Effect<T.MessageHit[], ApiError>;
  /** The channel's id for a channel given by id or as a target ("#name", a thread), or from's own place when "": a
   * session's own thread, else the default channel. */
  readonly placeOf: (from: string, channel: string) => Effect.Effect<string, ApiError>;
  readonly read: (who: string, opt?: ReadOptions) => Effect.Effect<ReadResult, ApiError>;
  /** The places who has not read all of, the newest first, by their addresses. */
  readonly unread: (who: string) => Effect.Effect<T.ChannelUnread[]>;
  /** Every channel and direct channel as a page lists them, the default first. */
  readonly list: () => Effect.Effect<T.Channel[]>;
  readonly history: (channel: string, before?: number, limit?: number) => Effect.Effect<T.ChatMessage[], ApiError>;
  /** A message's durable location; the recent state may hold neither the message nor its thread. */
  readonly messageLocation: (id: T.MessageId) => Effect.Effect<{ readonly channel: T.Channel; readonly top: string } | undefined>;
  readonly envelopeResource: (id: T.MessageId) => Effect.Effect<EnvelopeResource | undefined>;
  readonly markRead: (channel: string, seq: number) => Effect.Effect<void, ApiError>;
  /** Its direct conversation, issue thread, or standalone talk thread. */
  readonly threadOfSession: (session: string) => Effect.Effect<string | undefined>;
  /** The channels the core state holds now. */
  readonly now: () => T.Chat | undefined;
  /** What is said in a channel after the message numbered after, then what is said there from now on. Reset when more than catchUpMax were missed. */
  readonly follow: (channel: string, after: number) => Stream.Stream<T.ChannelEvent, ApiError>;
  /** The turn reports anywhere after the one with this id, or the newest logKeep when absent, then each from now on. */
  readonly reports: (after?: string) => Stream.Stream<T.ChannelEvent>;
  /** The user's words said in full in a thread, whatever path they took in: what an issue hears the user by.
   * Subscribed before it returns. */
  readonly userInThread: Effect.Effect<Stream.Stream<{ readonly thread: string; readonly message: T.ChatMessage }>, never, Scope.Scope>;
  readonly channels: () => Effect.Effect<Info[]>;
  readonly openChannel: (name: string, description: string, repo: string) => Effect.Effect<Info, ApiError>;
  /** description undefined or empty: as it was; repo undefined: as it was, empty: none. */
  readonly updateChannel: (id: string, upd: T.ChannelUpdate) => Effect.Effect<void, ApiError>;
  /** Archived or not; as it already is, nothing changes. */
  readonly archive: (id: string, on: boolean) => Effect.Effect<void, ApiError>;
  readonly removeChannel: (id: string) => Effect.Effect<void, ApiError>;
  readonly previewRemoveChannel: (id: string) => Effect.Effect<T.Preview, ApiError>;
  readonly setNotify: (id: string, notify: T.Notify) => Effect.Effect<void, ApiError>;
  /** How much of a place counts for the user: none when it or its channel is set to none, else its own level, else its channel's. */
  readonly notifyOf: (id: string) => T.Notify;
  readonly direct: (agent: string) => Effect.Effect<string, ApiError>;
  /** The orchestrator in a place (mailbox/envelope.ts orchestratorIn): who work left to an orchestrator there goes to. */
  readonly orchestratorIn: (channel: string) => string;
  readonly markUnread: (channel: string, number: number) => Effect.Effect<void, ApiError>;
  /** The channel a place is in: a thread's, or the default one for a direct channel, which holds no work. */
  readonly topOf: (channel: string) => Effect.Effect<Info>;
  /** How the orchestrator writes the place it answers in: a direct channel's own address, else its channel's. */
  readonly addressOf: (channel: string) => Effect.Effect<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Effect.Effect<Info | undefined>;
  /** The chat's startup, after the sessions came back: their threads, and what waited for them. */
  readonly start: Effect.Effect<void, ApiError>;
}
