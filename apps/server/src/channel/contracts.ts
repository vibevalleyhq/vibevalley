import { type Effect, Schema, type Scope, type Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "@/base/json.ts";
import { type ApiError } from "@/errors.ts";

import type * as qm from "../../db/generated/channel_message.sql.ts";
import { type ChannelRow } from "./model.ts";
import { type InboxMessage, type Picked } from "./wake.ts";

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
  readonly replyTo?: number;
  readonly attachments?: readonly string[];
  readonly picked?: Picked;
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

/** What came to an orchestrator in one channel, to wake it with. */
export interface OrchestratorNews {
  /** The orchestrator it came to, by its profile id. */
  readonly agent: string;
  readonly channel: string;
  readonly type: T.ChannelType;
  readonly target: string;
  readonly messages: InboxMessage[];
}

export interface Meta {
  run?: string;
  mentions?: string[];
  session?: T.SessionId;
  outcome?: T.Outcome;
  spent?: T.Spent;
  forTask?: boolean;
  code?: string;
  /** Said on a call: the orchestrator heard it there, so it wakes no one here. */
  spoken?: boolean;
  attachments?: T.Attachment[];
  embeds?: T.Embed[];
  /** The artifact it announces, as it was then (artifact/). */
  artifact?: T.ArtifactCard;
  picked?: Picked;
}

const MetaSchema: Schema.Codec<Meta, Wire<Meta>> = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  mentions: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(S.SessionId),
  outcome: Schema.optionalKey(S.Outcome),
  spent: Schema.optionalKey(S.Spent),
  forTask: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.String),
  spoken: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(S.Attachment))),
  embeds: Schema.optionalKey(Schema.mutable(Schema.Array(S.Embed))),
  artifact: Schema.optionalKey(S.ArtifactCard),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), project: Schema.optionalKey(Schema.String) })),
});

/** Anything unreadable is no meta. */
export const metaOf = (raw: string | null): Meta => jsonOrNone(MetaSchema)(raw) ?? {};

/** As Go's omitempty writes it: nothing empty kept. */
export const metaText = (m: Meta | undefined) =>
  m === undefined
    ? null
    : JSON.stringify(
        Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))),
      );

export type MsgRow = qm.MessageByIDResult;

/** {"emoji": [participant, …]}, as a message keeps them; anything unreadable is none. */
const ReactionsSchema = Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String)));
export const reactionsOf = (raw: string | null): Record<string, string[]> => jsonOrNone(ReactionsSchema)(raw) ?? {};
export const reactionsText = (r: Record<string, string[]>) => {
  const kept = Object.entries(r).filter(([, by]) => by.length > 0);
  return kept.length > 0 ? JSON.stringify(Object.fromEntries(kept)) : null;
};

export const senderKind = (kind: string): T.ActorKind => (kind === "owner" || kind === "orchestrator" || kind === "session" ? kind : "system");
export const messageKind = (kind: string): T.MessageKind => (kind === "dispatch" || kind === "report" || kind === "notice" ? kind : "chat");
export const channelType = (type: string): T.ChannelType => (type === "thread" || type === "direct" ? type : "channel");
export const subjectKind = (kind: string | null): T.SubjectKind | undefined => (kind === "issue" || kind === "graph" || kind === "talk" ? kind : undefined);

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
  };
}

export const notifyOf = (n: string): T.Notify => (n === "mentions" || n === "none" ? n : "all");

export const inboxMore = (
  row: Pick<MsgRow, "meta" | "reply_number"> & { edited_at?: number | null; deleted_at?: number | null },
  filesAt: (id: string) => string,
) => {
  const meta = metaOf(row.meta);
  const files = meta.attachments ?? [];
  return {
    ...(row.reply_number !== null ? { replyTo: row.reply_number } : {}),
    ...(row.edited_at != null && row.edited_at !== 0 ? { edited: true } : {}),
    ...(row.deleted_at != null && row.deleted_at !== 0 ? { deleted: true } : {}),
    ...(files.length > 0 ? { attachments: files.map((f) => ({ name: f.name, path: filesAt(f.id) })) } : {}),
    ...(meta.artifact && (row.deleted_at == null || row.deleted_at === 0)
      ? { artifact: { id: meta.artifact.id, title: meta.artifact.title, version: meta.artifact.version } }
      : {}),
    ...(meta.picked ? { picked: meta.picked } : {}),
  };
};

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
  id: string;
  number: number;
  recipients: string[];
  resetWake: string[];
  absent: string[];
  held: boolean;
  thread: string;
  /** A send with a key already written: nothing new is written or delivered. */
  again: boolean;
  /** The message as written (its mentions in its meta), or the one sent before with the same key. */
  row: MsgRow;
  ownerMentionsChanged?: boolean;
}

export interface ChannelService {
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
  readonly markRead: (channel: string, seq: number) => Effect.Effect<void, ApiError>;
  /** The thread of the issue the session works (a talk thread of its own when it works none). */
  readonly threadOfSession: (session: string) => Effect.Effect<string | undefined>;
  /** The channels the core state holds now. */
  readonly now: () => T.Chat | undefined;
  /** What is said in a channel after the message numbered after, then what is said there from now on; Reset when
   * more than catchUpMax were missed. A follower too slow for what is said ends, and comes back with its number. */
  readonly follow: (channel: string, after: number) => Stream.Stream<T.ChannelEvent, ApiError>;
  /** The turn reports anywhere after the one with this id, or the newest logKeep when absent, then each from now on. */
  readonly reports: (after?: string) => Stream.Stream<T.ChannelEvent>;
  /** Subscribed before it returns. */
  readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorNews>, never, Scope.Scope>;
  /** The owner's words said in full in a thread, whatever path they took in: what an issue hears its owner by.
   * Subscribed before it returns. */
  readonly ownerInThread: Effect.Effect<Stream.Stream<{ readonly thread: string; readonly message: T.ChatMessage }>, never, Scope.Scope>;
  /** What came to the orchestrator and does not wake it. */
  readonly orchestratorDigest: (agent: string) => Effect.Effect<InboxMessage[]>;
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
  /** The owner's direct channel with a profile (a helper's, or an orchestrator's), made if there is none. */
  readonly openDirect: (agent: { readonly id: string; readonly name: string }) => Effect.Effect<string>;
  /** An orchestrator's direct channel with the owner; "" when it has none yet. */
  readonly orchestratorDirect: (agent: string) => string;
  /** The orchestrator a place is looked after by: a channel's own, its thread's channel's, a direct channel's peer when
   * that is an orchestrator, else the default one. */
  readonly orchestratorOf: (channel: string) => string;
  /** A profile's direct channel is its talk issue's thread from now on. */
  readonly linkTalk: (channel: string, issue: string) => Effect.Effect<void>;
  /** The newest messages of a channel, oldest first, as an agent reads them. */
  readonly recent: (channel: string, n: number) => Effect.Effect<InboxMessage[]>;
  readonly markUnread: (channel: string, number: number) => Effect.Effect<void, ApiError>;
  /** The channel a place is in: a thread's, or the default one for a direct channel, which holds no work. */
  readonly topOf: (channel: string) => Effect.Effect<Info>;
  /** How the orchestrator writes the place it answers in: a direct channel's own address, else its channel's. */
  readonly addressOf: (channel: string) => Effect.Effect<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Effect.Effect<Info | undefined>;
  /** Agent Sessions registers the helpers; until then a message for one waits. */
  readonly useHelpers: (helpers: Helpers) => void;
  /** Once the helpers on the farm are back: what waited for each goes to it now. */
  readonly helpersBack: Effect.Effect<void>;
  /** What a helper's launch did. */
  readonly activity: (a: LaunchActivity) => Effect.Effect<void>;
  /** Messages a helper took as input. */
  readonly consumed: (c: InputConsumed) => Effect.Effect<void>;
  /** A helper hired, reported or gone: its thread opens, the report is posted in it, its thread closes. */
  readonly sessionNews: (n: SessionNews) => Effect.Effect<void>;
}

/** What came of handing a helper a message. */
export interface Delivered {
  readonly kind: "run" | "steered" | "queued" | "refused";
  readonly launch?: string;
  readonly woke?: boolean;
  readonly reason?: string;
}

/** What a helper's launch did, as the channels hear it: it spoke, its turn ended or closed, it compacts. */
export type LaunchActivity =
  | { readonly kind: "spoke"; readonly id: string; readonly launch: string }
  | { readonly kind: "ended"; readonly id: string; readonly launch: string; readonly outcome: T.Outcome; readonly spoke: boolean }
  | { readonly kind: "closed"; readonly id: string; readonly launch: string }
  | { readonly kind: "compacting"; readonly id: string; readonly on: boolean };

/** The messages a helper took as input: they are seen. */
/** What happened to a helper, as the sessions tell it: the fact, and the session as it stood after it (none once it
 * left). */
export type SessionNews =
  | { readonly _tag: "hired"; readonly session: T.Session }
  | { readonly _tag: "reported"; readonly report: T.FactReport; readonly session: T.Session | undefined }
  | { readonly _tag: "left"; readonly left: T.FactLeft };

export interface InputConsumed {
  readonly session: string;
  readonly messages: string[];
}

/** The participants that work: the channels hand them what is said to them and hear what they did. The channels know a
 * helper by its id and nothing of how it works. */
export interface Helpers {
  /** On the farm now: it can be handed a message. */
  readonly present: (id: string) => boolean;
  readonly deliver: (id: string, text: string, by: T.RunTrigger) => Effect.Effect<Delivered>;
  /** The run a participant is in now (a helper's, the orchestrator's), for what it says; undefined between runs. */
  readonly currentRun: (id: string) => string | undefined;
  /** A helper's report, from what it last said in full. */
  readonly report: (id: string) => string;
  /** The helper working the issue now, if one is. */
  readonly onIssue: (issue: string) => string | undefined;
  /** A helper on the farm now, and all of them. */
  readonly sessionOf: (id: string) => T.Session | undefined;
  readonly presentSessions: () => readonly T.Session[];
}
