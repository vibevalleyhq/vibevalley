import { z } from "zod";

import type { Subscription } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Inconsistent } from "#/base/errors.ts";
import { jsonText, storedJsonOrUndefined } from "#/base/json.ts";
import { type ChannelEnvelopeRow, type Envelope, type Meta, metaOf, type Picked } from "#/modules/session/envelope.ts";
import type * as qm from "#db/channel_message.sql.ts";

import { type ChannelRow } from "./rooms.ts";

export type { ChannelAudience, ChannelEnvelopeRow, ChannelHearers, Meta } from "#/modules/session/envelope.ts";
export type { Envelope, Picked } from "#/modules/session/envelope.ts";
export { channelType, envelopeMore, metaOf, metaText } from "#/modules/session/envelope.ts";
export type { Delivered } from "#/modules/session/signals.ts";

export type MsgRow = qm.MessageByIDResult;

/** Who said a message, as the page shows it: an agent's seat that speaks for a profile is a helper's, one that does not
 * is an assistant's (a profile speaking as itself). */
export const actorOf = (kind: T.ActorKind, agent: string | null, id: string, name?: string): T.Actor =>
  kind === "agent"
    ? { kind: "agent", id, role: agent !== null ? "worker" : "orchestrator", ...(name !== undefined ? { name } : {}) }
    : { kind, id, ...(name !== undefined ? { name } : {}) };

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
    actor: actorOf(row.sender_kind, row.sender_agent, row.sender_id, row.sender_name),
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

export interface Write {
  readonly channel: string;
  readonly from: string;
  readonly kind: T.MessageKind;
  readonly text: string;
  readonly meta?: Meta;
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
  /** Said in the speaker's home (the place an empty target means), as `from` (its run, if any). */
  | { readonly _tag: "Home"; readonly from: string; readonly home: string; readonly text: string; readonly sendKey: string; readonly run?: string }
  | ({ readonly _tag: "Agent"; readonly from: string; readonly text: string; readonly run?: string } & SpeakOptions)
  | {
      readonly _tag: "Announce";
      readonly from: string;
      readonly channel: string;
      readonly text: string;
      readonly made: Made;
      readonly sendKey?: string;
      readonly run?: string;
    }
  /** Recorded in the default channel without waking anyone. */
  | { readonly _tag: "Call"; readonly from: string; readonly text: string; readonly sendKey: string }
  | { readonly _tag: "Run"; readonly from: string; readonly channel: string; readonly text: string; readonly run: string }
  /** `code` deduplicates repeated system notices. */
  | { readonly _tag: "Notice"; readonly channel: string; readonly text: string; readonly code: string; readonly sendKey?: string };

export type PostOf<Tag extends Post["_tag"]> = Extract<Post, { readonly _tag: Tag }>;

/** Each kind of post with its answer; Run and Notice are best effort and never fail. */
export interface PostDoor {
  (p: PostOf<"User">): Promise<{ message: T.ChatMessage; again: boolean }>;
  (p: PostOf<"Home">): Promise<T.ChatMessage>;
  (p: PostOf<"Agent">): Promise<Spoken>;
  (p: PostOf<"Announce">): Promise<T.ChatMessage>;
  (p: PostOf<"Call">): Promise<boolean>;
  (p: PostOf<"Run"> | PostOf<"Notice">): Promise<void>;
}

/** An agent seated to speak in the chat: an assistant (a profile speaking as itself, no `agent`), or a helper speaking
 * for the profile `agent` (a session, a profile's seat in its direct channel). */
export interface Seat {
  readonly id: string;
  readonly name: string;
  readonly agent?: string;
  /** The place an empty target means for it; none keeps the one it had. */
  readonly home?: string;
}

export interface Participant {
  readonly id: string;
  readonly kind: T.ActorKind;
  readonly name: string;
  /** The profile it speaks for; none for the user, the farm and the assistants. */
  readonly agent: string | null;
  readonly home: string | null;
  readonly left: boolean;
}

export interface Place {
  readonly id: string;
  readonly type: T.ChannelType;
  readonly peer: string | null;
  readonly parent: string | null;
  readonly name: string | null;
  readonly lastNumber: number;
  readonly topic?: { readonly kind: NonNullable<T.Channel["subjectKind"]>; readonly id: string };
}

export interface Note {
  readonly channel: string;
  readonly from: string;
  readonly kind: "dispatch" | "report";
  readonly text: string;
  readonly meta: Meta;
  readonly topic?: ThreadSubject;
  readonly member?: string;
}

export interface Written {
  absent: string[];
  heldNotice: string;
  answers?: T.SessionId;
  thread: string;
  again: boolean;
  row: MsgRow;
}

/** One thing that happened in the chat, numbered in the order it was committed (channel_event). */
export interface ChannelEvent {
  readonly seq: number;
  readonly kind: "posted" | "removed";
  readonly channel: string;
  readonly message: string;
  readonly at: number;
}

/** A message just committed, with what the chat knows of where it was said: what the layers above route on. */
export interface Committed {
  readonly event: ChannelEvent;
  /** Told again at startup, after the reader's cursor: it may have been handled before the farm stopped. */
  readonly replayed: boolean;
  readonly row: ChannelEnvelopeRow;
  readonly mentions: readonly string[];
  readonly channel: Pick<T.Channel, "type" | "peer">;
  /** The orchestrator in the channel the place is in. */
  readonly orchestrator: string;
  readonly channelMembers: readonly string[];
  /** A thread's members, the ones it named included. */
  readonly members: readonly string[];
  /** The place's topic, for a thread kept about something outside the chat. */
  readonly topic?: { readonly kind: NonNullable<T.Channel["subjectKind"]>; readonly id: string };
}

/** What an observer asks the chat to say after the message it was told of. */
export interface Followup {
  /** The hop limit's notice: said once by the farm (code hop_limit), until the user next speaks there. */
  readonly hopLimit?: string;
  /** The session whose call the message answers (it named the speaker since the speaker last spoke), told with it. */
  readonly answers?: T.SessionId;
}

/** Told each committed event in order, under the chat's lock, before the write that made it returns: it must not
 * call back into the chat's locked members. A throw (not an ApiError) fails that write; the event stays to replay. */
export interface ChannelObserver {
  readonly posted: (c: Committed) => Promise<Followup | undefined>;
  readonly removed: (event: ChannelEvent) => Promise<void>;
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
  /** Who named `speaker` in a place since it last spoke there, before message `before`: newest first. */
  readonly callersOf: (speaker: string, channel: string, before: string) => Promise<readonly string[]>;
  /** The place an empty target means for a participant: the home the layers above gave it. */
  readonly homeOf: (participant: string) => Promise<string | undefined>;
  /** Each committed event from now on, told to `observer` (see ChannelObserver); one observer per chat. */
  readonly observe: (observer: ChannelObserver) => void;
  /** The events after `after`, oldest first, at most n. */
  readonly events: (after: number, n?: number) => Promise<ChannelEvent[]>;
  /** Tells the observer each event after `after` again, in order (Committed.replayed); one that fails is logged and passed. */
  readonly replay: (after: number, handled: (event: ChannelEvent) => Promise<void>) => Promise<void>;
  /** Seats an agent who speaks for the layers above under the name it goes by now; seated again if it left. */
  readonly seat: (seat: Seat) => Promise<void>;
  /** A participant gone: in nothing, never back. */
  readonly leave: (participant: string) => Promise<void>;
  readonly participants: () => readonly Participant[];
  /** Makes a participant a member of a place from its newest message on. */
  readonly addFollower: (channel: string, participant: string) => Promise<void>;
  readonly membersOf: (channel: string) => readonly string[];
  /** The thread kept about a topic, if one was opened. */
  readonly threadAbout: (kind: NonNullable<T.Channel["subjectKind"]>, id: string) => string | undefined;
  /** A place as the chat keeps it. */
  readonly place: (id: string) => Place | undefined;
  /** A message a participant took in outside the chat (handed to it): no longer unread or unseen for it. A message that
   * is not there marks nothing. */
  readonly markSeen: (participant: string, message: string) => Promise<void>;
  /** Sets where a participant has read up to in a place. */
  readonly readUpTo: (participant: string, channel: string, number: number) => Promise<void>;
  /** The newest message number in a place, 0 for none. */
  readonly latest: (channel: string) => Promise<number>;
  /** How many dispatch notes a thread has. */
  readonly dispatches: (thread: string) => Promise<number>;
  /** The newest n messages of a place, oldest first, as rows the layers above route. */
  readonly recentRows: (channel: string, n: number) => Promise<readonly MsgRow[]>;
  /** A place's messages after number `after`, oldest first. */
  readonly rowsAfter: (channel: string, after: number) => Promise<readonly MsgRow[]>;
  /** Tells the observers a committed message again, as when it was written (not as a replay). */
  readonly retell: (message: string) => Promise<void>;
  readonly envelopeRow: (row: MsgRow) => ChannelEnvelopeRow;
  readonly asEnvelope: (row: ChannelEnvelopeRow) => Envelope;
  readonly envelopeOf: (row: MsgRow, target: string) => Envelope;
  readonly targetOfPlace: (channel: string) => string;
  /** A note the farm writes for the layers above: a dispatch under the orchestrator's name, or a report; `topic` opens
   * the place's thread about it under the note, `member` follows the place from it. */
  readonly note: (n: Note) => Promise<{ readonly thread: string }>;
  /** Refused removals: each guard says what still points at a channel (none: nothing). */
  readonly guardRemoval: (guard: (channel: string) => Promise<readonly string[]>) => void;
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
  /** The direct channel with a seated agent (an assistant, a profile's seat), made when there is none. */
  readonly createDirect: (peer: string) => Promise<string>;
  readonly orchestratorIn: (channel: string) => string;
  readonly markUnread: (channel: string, number: number) => Promise<void>;
  /** Parent channel for a thread, or the default channel for a direct conversation. */
  readonly topOf: (channel: string) => Promise<Info>;
  readonly addressOf: (channel: string) => Promise<{ readonly direct: boolean; readonly target: string }>;
  readonly channelByName: (name: string) => Promise<Info | undefined>;
  readonly close: () => Promise<void>;
}
