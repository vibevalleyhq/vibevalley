import { z } from "zod";

import type { Subscription } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Inconsistent } from "#/base/errors.ts";
import { jsonText, storedJsonOrUndefined } from "#/base/json.ts";
import { actorOfParticipant, type Envelope, type Meta, metaOf, type Picked } from "#/modules/mailbox/envelope.ts";
import type * as qm from "#db/channel_message.sql.ts";

import { type ChannelRow } from "./rooms.ts";

export type { ChannelAudience, ChannelEnvelopeRow, ChannelHearers, Meta } from "#/modules/mailbox/envelope.ts";
export type { Envelope, Picked } from "#/modules/mailbox/envelope.ts";
export { actorOfParticipant, channelType, envelopeMore, metaOf, metaText } from "#/modules/mailbox/envelope.ts";
export type { Delivered, SessionNews } from "#/modules/session/signals.ts";

export type MsgRow = qm.MessageByIDResult;

const ReactionsSchema = z.record(z.string(), z.array(z.string()));
type Reactions = Record<string, string[]>;
const decodeReactions = storedJsonOrUndefined(ReactionsSchema, "channel_message.reactions");
export const reactionsOf = (raw: string | null): Reactions => decodeReactions(raw) ?? {};
export const reactionsText = (r: Reactions) => {
  const kept = Object.entries(r).filter(([, by]) => by.length > 0);
  return kept.length > 0 ? jsonText(Object.fromEntries(kept)) : null;
};

export const messageKind = (kind: string): T.MessageKind => S.MessageKind.safeParse(kind).data ?? "chat";
export const subjectKind = (kind: string | null): NonNullable<T.Channel["subjectKind"]> | undefined =>
  kind !== null ? S.SubjectKind.safeParse(kind).data : undefined;
export const notifyOf = (n: string): T.Notify => S.Notify.safeParse(n).data ?? "all";

/** A row a statement always gives (an insert's returning, a count): none is the database disagreeing with itself. */
export const theRow = <A>(row: A | undefined, query: string): A => {
  if (row === undefined) throw new Inconsistent(`${query} gave no row`);
  return row;
};

export function toMessage(row: MsgRow): T.ChatMessage {
  const meta = metaOf(row.meta);
  return {
    id: S.messageId(row.id),
    number: row.number,
    channel: row.channel_id,
    from: row.sender_id,
    actor: actorOfParticipant(row.sender_kind, row.sender_role, row.sender_id, row.sender_name),
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
  readonly kind: NonNullable<T.Channel["subjectKind"]>;
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
  (p: PostOf<"User">): Promise<{ message: T.ChatMessage; again: boolean }>;
  (p: PostOf<"Tell">): Promise<T.ChatMessage | undefined>;
  (p: PostOf<"Agent">): Promise<Spoken>;
  (p: PostOf<"Announce">): Promise<T.ChatMessage>;
  (p: PostOf<"Call">): Promise<boolean>;
  (p: PostOf<"Run"> | PostOf<"Notice">): Promise<void>;
}

export interface Written {
  absent: string[];
  heldNotice: string;
  thread: string;
  again: boolean;
  row: MsgRow;
}

/** A read of the user's: where, up to which number, when. */
export interface UserRead {
  readonly channel: string;
  readonly number: number;
  readonly at: number;
}

/** Refusals are ApiErrors (thrown). */
export interface ChannelService {
  /** Each read of the user's from now on. */
  readonly userReads: () => Subscription<UserRead>;
  readonly defaultChannel: () => string;
  readonly makeDefault: (id: string) => Promise<void>;
  readonly user: (input: UserInput) => Promise<{ message: T.ChatMessage; again: boolean }>;
  readonly say: (text: string, pick: Picked, channel: string | undefined, sendKey: string, more?: SayMore) => Promise<void>;
  readonly post: PostDoor;
  /** Edits do not wake participants. */
  readonly edit: (id: T.MessageId, text: string, keep?: readonly string[]) => Promise<T.ChatMessage>;
  /** Clears content and withdraws pending deliveries while preserving the message number. */
  readonly remove: (id: T.MessageId) => Promise<void>;
  readonly previewRemove: (id: T.MessageId) => Promise<T.Preview>;
  readonly react: (id: T.MessageId, who: string, emoji: string, on: boolean) => Promise<T.ChatMessage>;
  readonly pin: (id: T.MessageId, on: boolean) => Promise<T.ChatMessage>;
  readonly pins: (channel: string) => Promise<T.ChatMessage[]>;
  readonly threadUnder: (id: T.MessageId) => Promise<string>;
  readonly issueThread: (issue: string, title: string, channel?: string) => Promise<string>;
  readonly issueThreadId: (issue: string) => Promise<string | null>;
  readonly issueMessages: (issue: string) => Promise<Envelope[]>;
  readonly search: (text: string, channel?: string) => Promise<T.MessageHit[]>;
  /** `""` resolves to `from`'s own session thread, or the default channel. */
  readonly placeOf: (from: string, channel: string) => Promise<string>;
  readonly read: (who: string, opt?: ReadOptions) => Promise<ReadResult>;
  readonly unread: (who: string) => Promise<T.ChannelUnread[]>;
  readonly list: () => Promise<T.Channel[]>;
  readonly history: (channel: string, before?: number, limit?: number) => Promise<T.ChatMessage[]>;
  /** Reads from DB because `SpaceState.chat` retains only recent channels. */
  readonly messageLocation: (id: T.MessageId) => Promise<{ readonly channel: T.Channel; readonly top: string } | undefined>;
  readonly envelopeResource: (id: T.MessageId) => Promise<EnvelopeResource | undefined>;
  readonly markRead: (channel: string, seq: number) => Promise<void>;
  readonly threadOfSession: (session: string) => Promise<string | undefined>;
  readonly now: () => T.Chat | undefined;
  /** What changed in channel after revision `after`, then each change from now on. Emits `Reset` when more than
   * `catchUpMax` revisions were missed. A channel that is not there is refused (an ApiError) by the first `next()`,
   * before any event. */
  readonly follow: (channel: string, after: number, signal?: AbortSignal) => AsyncIterable<T.ChannelEvent>;
  /** The reports after the one with id `after` (the newest ones without it), then each one from now on. */
  readonly reports: (after?: string, signal?: AbortSignal) => AsyncIterable<T.ChannelEvent>;
  /** What the user says in a thread, from now on: subscribed before it returns. */
  readonly userInThread: () => Subscription<{ readonly thread: string; readonly message: T.ChatMessage }>;
  readonly channels: () => Promise<Info[]>;
  readonly openChannel: (name: string, description: string, repo: string) => Promise<Info>;
  /** `description` undefined or `""` keeps existing; `repo` undefined keeps existing, `""` clears it. */
  readonly updateChannel: (id: string, upd: T.ChannelUpdate) => Promise<void>;
  readonly archive: (id: string, on: boolean) => Promise<void>;
  readonly removeChannel: (id: string) => Promise<void>;
  readonly previewRemoveChannel: (id: string) => Promise<T.Preview>;
  readonly setNotify: (id: string, notify: T.Notify) => Promise<void>;
  /** `"none"` on either the thread or its parent channel silences both. */
  readonly notifyOf: (id: string) => T.Notify;
  readonly direct: (agent: string) => Promise<string>;
  readonly orchestratorIn: (channel: string) => string;
  readonly markUnread: (channel: string, number: number) => Promise<void>;
  /** Parent channel for a thread, or the default channel for a direct conversation. */
  readonly topOf: (channel: string) => Promise<Info>;
  readonly addressOf: (channel: string) => Promise<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Promise<Info | undefined>;
  /** Must run after sessions are restored on startup. */
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
}
