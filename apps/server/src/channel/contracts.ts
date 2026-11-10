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

/** `{"emoji": [participant, ...]}`; unreadable JSON decodes as `{}`. */
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
  readonly reply?: number;
}

export type Made = { readonly card: T.ArtifactCard } | { readonly attachments: readonly string[] };

export interface UserInput {
  readonly source: "connector" | "voice";
  readonly channel?: string;
  readonly envelope: string;
  readonly text: string;
  readonly picked?: Picked;
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
}

export interface SayMore {
  readonly source?: "connector" | "voice";
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
  readonly replyTo?: number;
  readonly attachments?: readonly string[];
  readonly picked?: Picked;
  readonly blocks?: readonly T.QuotedBlock[];
  /** Delivers only to this orchestrator instead of channel members. */
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

/** Keyed by `issue` when working one so reassigned sessions reuse the same issue thread. */
export const subjectOf = (h: T.Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

export interface Write {
  readonly channel: string;
  readonly from: string;
  readonly kind: T.MessageKind;
  readonly text: string;
  readonly meta?: Meta;
  readonly answers?: T.SessionId;
  readonly thread?: ThreadSubject;
  /** Added as a channel member in the same transaction. */
  readonly member?: string;
  readonly sendKey?: string;
  readonly replyTo?: number;
  /** Advances this participant's read cursor in the same transaction. */
  readonly readBy?: string;
}

export type Post =
  | ({ readonly _tag: "User"; readonly text: string; readonly channel?: string | undefined; readonly sendKey: string } & SayMore)
  /** Delivered in the session's thread, or directly when it has none. */
  | { readonly _tag: "Tell"; readonly from: string; readonly session: string; readonly text: string; readonly sendKey: string }
  | ({ readonly _tag: "Agent"; readonly from: string; readonly text: string } & SpeakOptions)
  | { readonly _tag: "Announce"; readonly from: string; readonly channel: string; readonly text: string; readonly made: Made; readonly sendKey?: string }
  /** Recorded in the default channel without waking anyone. */
  | { readonly _tag: "Call"; readonly from: string; readonly text: string; readonly sendKey: string }
  | { readonly _tag: "Run"; readonly from: string; readonly channel: string; readonly text: string; readonly run: string }
  /** `code` deduplicates repeated system notices. */
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
  again: boolean;
  row: MsgRow;
}

export interface ChannelService {
  readonly userReads: Effect.Effect<Stream.Stream<{ readonly channel: string; readonly number: number; readonly at: number }>, never, Scope.Scope>;
  readonly defaultChannel: () => string;
  readonly makeDefault: (id: string) => Effect.Effect<void, ApiError>;
  readonly user: (input: UserInput) => Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
  readonly say: (text: string, pick: Picked, channel: string | undefined, sendKey: string, more?: SayMore) => Effect.Effect<void, ApiError>;
  readonly post: PostDoor;
  /** Edits do not wake participants. */
  readonly edit: (id: T.MessageId, text: string, keep?: readonly string[]) => Effect.Effect<T.ChatMessage, ApiError>;
  /** Clears content and withdraws pending deliveries while preserving the message number. */
  readonly remove: (id: T.MessageId) => Effect.Effect<void, ApiError>;
  readonly previewRemove: (id: T.MessageId) => Effect.Effect<T.Preview, ApiError>;
  readonly react: (id: T.MessageId, who: string, emoji: string, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
  readonly pin: (id: T.MessageId, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
  readonly pins: (channel: string) => Effect.Effect<T.ChatMessage[], ApiError>;
  readonly threadUnder: (id: T.MessageId) => Effect.Effect<string, ApiError>;
  readonly issueThread: (issue: string, title: string, channel?: string) => Effect.Effect<string, ApiError>;
  readonly issueThreadId: (issue: string) => Effect.Effect<string | null>;
  readonly issueMessages: (issue: string) => Effect.Effect<Envelope[]>;
  readonly search: (text: string, channel?: string) => Effect.Effect<T.MessageHit[], ApiError>;
  /** `""` resolves to `from`'s own session thread, or the default channel. */
  readonly placeOf: (from: string, channel: string) => Effect.Effect<string, ApiError>;
  readonly read: (who: string, opt?: ReadOptions) => Effect.Effect<ReadResult, ApiError>;
  readonly unread: (who: string) => Effect.Effect<T.ChannelUnread[]>;
  readonly list: () => Effect.Effect<T.Channel[]>;
  readonly history: (channel: string, before?: number, limit?: number) => Effect.Effect<T.ChatMessage[], ApiError>;
  /** Reads from DB because `SpaceState.chat` retains only recent channels. */
  readonly messageLocation: (id: T.MessageId) => Effect.Effect<{ readonly channel: T.Channel; readonly top: string } | undefined>;
  readonly envelopeResource: (id: T.MessageId) => Effect.Effect<EnvelopeResource | undefined>;
  readonly markRead: (channel: string, seq: number) => Effect.Effect<void, ApiError>;
  readonly threadOfSession: (session: string) => Effect.Effect<string | undefined>;
  readonly now: () => T.Chat | undefined;
  /** Emits `Reset` when more than `catchUpMax` revisions were missed. */
  readonly follow: (channel: string, after: number) => Stream.Stream<T.ChannelEvent, ApiError>;
  readonly reports: (after?: string) => Stream.Stream<T.ChannelEvent>;
  /** Subscribed before the outer `Effect` resolves. */
  readonly userInThread: Effect.Effect<Stream.Stream<{ readonly thread: string; readonly message: T.ChatMessage }>, never, Scope.Scope>;
  readonly channels: () => Effect.Effect<Info[]>;
  readonly openChannel: (name: string, description: string, repo: string) => Effect.Effect<Info, ApiError>;
  /** `description` undefined or `""` keeps existing; `repo` undefined keeps existing, `""` clears it. */
  readonly updateChannel: (id: string, upd: T.ChannelUpdate) => Effect.Effect<void, ApiError>;
  readonly archive: (id: string, on: boolean) => Effect.Effect<void, ApiError>;
  readonly removeChannel: (id: string) => Effect.Effect<void, ApiError>;
  readonly previewRemoveChannel: (id: string) => Effect.Effect<T.Preview, ApiError>;
  readonly setNotify: (id: string, notify: T.Notify) => Effect.Effect<void, ApiError>;
  /** `"none"` on either the thread or its parent channel silences both. */
  readonly notifyOf: (id: string) => T.Notify;
  readonly direct: (agent: string) => Effect.Effect<string, ApiError>;
  readonly orchestratorIn: (channel: string) => string;
  readonly markUnread: (channel: string, number: number) => Effect.Effect<void, ApiError>;
  /** Parent channel for a thread, or the default channel for a direct conversation. */
  readonly topOf: (channel: string) => Effect.Effect<Info>;
  readonly addressOf: (channel: string) => Effect.Effect<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Effect.Effect<Info | undefined>;
  /** Must run after sessions are restored on startup. */
  readonly start: Effect.Effect<void, ApiError>;
}
