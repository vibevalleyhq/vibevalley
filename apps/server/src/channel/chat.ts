// Every message is written to the database first, in one transaction with who it goes to; only then does it become a
// fact. A delivery goes pending → announced → handed → seen; a session that closes or a turn that ends without a word puts
// what it was handed back to pending: given twice rather than lost. Everything that changes the chat runs one at a time.

import { createHash } from "node:crypto";
import { join } from "node:path";

import { Clock, Context, Effect, FiberMap, FiberSet, FileSystem, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect";
import { HttpClient } from "effect/http";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { everyone, defaultOrchestrator, ownerId, attachmentMax } from "@vibevalley/protocol";
import { isBusy, oneLine } from "@vibevalley/protocol/rules";
import { sessionId, type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { head } from "@/base/clip.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { bounded } from "@/core/bounded.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, refused, lookIn, missing, Inconsistent } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { writeOnce } from "@/infra/files.ts";
import { bestEffort } from "@/infra/log.ts";

import * as qc from "../../db/generated/channel.sql.ts";
import * as qa from "../../db/generated/channel_attachment.sql.ts";
import * as qd from "../../db/generated/channel_delivery.sql.ts";
import * as qf from "../../db/generated/channel_follow.sql.ts";
import * as qmn from "../../db/generated/channel_mention.sql.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import * as qp from "../../db/generated/channel_participant.sql.ts";
import * as qr from "../../db/generated/channel_read_cursor.sql.ts";
import * as qs from "../../db/generated/channel_seen_mark.sql.ts";
import { agentWakeCooldownMs, chatAudience, type Delivery, hopLimit, hopLimitText, Audience } from "./audience.ts";
import { WakeBreaker } from "./breaker.ts";
import { Deliveries, type DeliveryRow } from "./deliveries.ts";
import { linksIn, readEmbed } from "./embeds.ts";
import { keepChannels, targetOf } from "./folded.ts";
import { mentionOf, mentionsIn } from "./mentions.ts";
import { ChatModel, type ChannelRow } from "./model.ts";
import { busyNotice, wakeInput } from "./prompts.ts";
import { parseSearch } from "./search.ts";
import { channelNameProblem, parseChatTarget } from "./targets.ts";
import { heldShown, type InboxMessage, type Picked, retryWindowMs, summaryChannels, type UnreadRow } from "./wake.ts";

/** The channel a new farm opens with. */
const firstChannelName = "general";

const reportMax = 1500;
const searchMax = 50;
const emojiPattern = /^\S{1,16}$/u;
/** A helper profile as the chat knows it: apart from the orchestrator and its sessions. */
const profileId = (agent: string) => `profile:${agent}`;
/** What a participant says by reacting when a message that wakes it is handed to it. */
const handedEmoji = "👀";
const readLimit = 30;
/** A follower further behind than this reads the room's newest page instead of every message since. */
export const catchUpMax = 200;
/** The reports a new reader of the farm's log starts from. */
const logKeep = 80;
/** A thread named by the message it hangs under shows this much of it. */
const threadTitleMax = 24;
/** How much of a channel's newest message a list shows. */
const lastMax = 80;
/** The first n units of text, on one line. */
const lineOf = (text: string, n: number) => head(oneLine(text).trim(), n);
/** The client's key for one send, so a retry of it is the same message. */
const sendKeyMax = 64;
/** Sorts after every uuidv7, for "since the last thing said". */
const afterAll = "\uffff";

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

interface Meta {
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
const metaOf = (raw: string | null): Meta => jsonOrNone(MetaSchema)(raw) ?? {};

/** As Go's omitempty writes it: nothing empty kept. */
const metaText = (m: Meta | undefined) =>
  m === undefined
    ? null
    : JSON.stringify(
        Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))),
      );

type MsgRow = qm.MessageByIDResult;

/** {"emoji": [participant, …]}, as a message keeps them; anything unreadable is none. */
const ReactionsSchema = Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String)));
const reactionsOf = (raw: string | null): Record<string, string[]> => jsonOrNone(ReactionsSchema)(raw) ?? {};
const reactionsText = (r: Record<string, string[]>) => {
  const kept = Object.entries(r).filter(([, by]) => by.length > 0);
  return kept.length > 0 ? JSON.stringify(Object.fromEntries(kept)) : null;
};

const senderKind = (kind: string): T.ActorKind => (kind === "owner" || kind === "orchestrator" || kind === "session" ? kind : "system");
const messageKind = (kind: string): T.MessageKind => (kind === "dispatch" || kind === "report" || kind === "notice" ? kind : "chat");
const channelType = (type: string): T.ChannelType => (type === "thread" || type === "direct" ? type : "channel");
const subjectKind = (kind: string | null): T.SubjectKind | undefined => (kind === "issue" || kind === "graph" || kind === "talk" ? kind : undefined);

function toMessage(row: MsgRow): T.ChatMessage {
  const meta = metaOf(row.meta);
  return {
    id: row.id,
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

const notifyOf = (n: string): T.Notify => (n === "mentions" || n === "none" ? n : "all");

const inboxMore = (row: Pick<MsgRow, "meta" | "reply_number"> & { edited_at?: number | null; deleted_at?: number | null }, filesAt: (id: string) => string) => {
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

const infoOf = (row: Pick<ChannelRow, "id" | "name" | "description" | "project" | "is_default">): Info => ({
  id: row.id,
  name: row.name ?? "",
  description: row.description ?? "",
  project: row.project ?? "",
  default: row.is_default,
});

const optional = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

interface ThreadSubject {
  readonly kind: T.SubjectKind;
  readonly id: string;
  readonly owner: string;
}

/** What a session's work is talked about under: the issue it works, so every session on one issue shares a thread; a session sent for no issue has a talk thread of its own. */
const subjectOf = (h: T.Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

interface Write {
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

interface Written {
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

export class Channel extends Context.Service<
  Channel,
  {
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
    readonly edit: (id: string, text: string, keep?: readonly string[]) => Effect.Effect<T.ChatMessage, ApiError>;
    /** Any message: its words, files and reactions go, its number stays, and what it had still to hand is dropped. */
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** A participant's reaction on or off; as it already is, the message is returned unchanged. */
    readonly react: (id: string, who: string, emoji: string, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
    /** Pinned or not; as it already is, the message is returned unchanged. */
    readonly pin: (id: string, on: boolean) => Effect.Effect<T.ChatMessage, ApiError>;
    readonly pins: (channel: string) => Effect.Effect<T.ChatMessage[], ApiError>;
    /** The thread under a channel's message, opened if it has none. */
    readonly threadUnder: (id: string) => Effect.Effect<string, ApiError>;
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
    readonly messageLocation: (id: string) => Effect.Effect<{ readonly channel: T.Channel; readonly top: string } | undefined>;
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
>()("vibevalley/Channel") {
  static readonly layer = Layer.effect(
    Channel,
    Effect.suspend(() => make),
  );
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

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const config = yield* ServerConfig;
  const core = yield* Core;
  const http = yield* HttpClient.HttpClient;
  const agents = yield* Agent;
  let helpers: Helpers | undefined;
  const db = yield* Db;
  const fs = yield* FileSystem.FileSystem;
  const model = new ChatModel();
  const reach = new Audience();
  const open = new Deliveries();
  const follow = (channel: string, participant: string, reason: qf.FollowParams["reason"], from: number) =>
    Effect.andThen(
      db.run(qf.follow({ channel_id: channel, participant_id: participant, reason, from_number: from })),
      Effect.sync(() => reach.followed(channel, participant)),
    );
  const reload = Effect.gen(function* () {
    model.load(yield* db.run(qc.allChannels()), yield* db.run(qp.participants()), yield* db.run(qr.readCursorsOf({ participant_id: ownerId })));
    reach.load(
      yield* db.run(qf.allFollows()),
      yield* db.run(qd.agentWakesByChannel()),
      yield* db.run(qd.lastAgentWakes()),
      yield* db.run(qm.ownerLastMessages()),
    );
    open.load(yield* db.run(qd.allOpenDeliveries()));
  });
  /** A transaction that tells the model what it changes as it goes: if it fails, those changes are not in the database,
   * so the model is read again from it. */
  const tx = <A, E>(work: Effect.Effect<A, E>) => db.inTx(work).pipe(Effect.onError(() => Effect.ignoreCause(reload)));
  const lock = yield* Semaphore.make(1);
  const locked = <A, E>(e: Effect.Effect<A, E>) => lock.withPermits(1)(e);
  const orchestratorHub = yield* scopedPubSub<OrchestratorNews>();
  // Every message once written, for the rooms: each follower reads it through a bounded relay of its own.
  const said = yield* scopedPubSub<T.ChatMessage>();

  /** Nothing is slipped in while a session compacts its context. */
  const compacting = new Set<string>();
  const breaker = new WakeBreaker();
  const lastRead = new Map<string, string>();
  let closed = false;
  // Work set off by a timer belongs to this service: it ends with it and keeps its services.
  const forkHere = yield* FiberSet.makeRuntime();

  // The waits are keyed fibers of this service's, so one can be called off (a notice gathering, when its session leaves);
  // once a wait is over, what it runs is handed to forkHere, and calling the wait off no longer cuts it short.
  const waits = yield* FiberMap.make<string>();
  const wait = yield* FiberMap.runtime(waits)();
  /** Runs fn under the lock a little later, unless the chat has stopped. */
  const later = (key: string, ms: number, fn: () => Effect.Effect<void>) =>
    void wait(
      key,
      Effect.delay(
        Effect.sync(() => {
          if (!closed) void forkHere(locked(Effect.suspend(() => (closed ? Effect.void : fn()))).pipe(bestEffort("chat: later")));
        }),
        ms,
      ),
      { onlyIfMissing: true },
    );

  for (const [id, kind, name] of [
    [ownerId, "owner", t("server.channel.name.owner")],
    ["system", "system", "VibeValley"],
  ] as const)
    yield* db.run(qp.upsertParticipant({ id, kind, name, agent_id: null, runtime: null, joined_at: yield* Clock.currentTimeMillis }));
  /** An orchestrator is a participant by its profile id, under its profile's name as it is when it speaks. */
  const seat = Effect.fnUntraced(function* (id: string) {
    const name = agents.agent(id)?.name.trim() || t("server.channel.name.orchestrator");
    if (model.participant(id)?.name === name && model.participant(id)?.kind === "orchestrator") return;
    const joined: qp.UpsertParticipantParams = { id, kind: "orchestrator", name, agent_id: null, runtime: null, joined_at: yield* Clock.currentTimeMillis };
    yield* db.run(qp.upsertParticipant(joined));
    model.joined(joined);
  });
  const orchestratorIds = () => agents.orchestrators().map((a) => a.id);
  for (const id of orchestratorIds()) yield* seat(id);
  let defaultId = (yield* db.one(qc.defaultID()))?.id ?? "";
  if (!defaultId) {
    defaultId = newId();
    yield* db.run(
      qc.createChannel({
        id: defaultId,
        is_default: true,
        name: firstChannelName,
        description: null,
        project: null,
        created_at: yield* Clock.currentTimeMillis,
      }),
    );
  }
  for (const id of orchestratorIds()) yield* db.run(qc.createDirect({ id: newId(), peer_id: id, created_at: yield* Clock.currentTimeMillis }));
  yield* reload;

  const orchestratorOfRow = (row: ChannelRow | undefined): string => {
    if (!row) return defaultOrchestrator;
    if (row.type === "thread") return orchestratorOfRow(row.parent_id !== null ? model.channel(row.parent_id) : undefined);
    const own = row.type === "direct" ? row.peer_id : row.orchestrator;
    // One no longer an orchestrator (its profile gone or made a helper) looks after nothing: the default one does.
    return own && agents.isOrchestrator(own) ? own : defaultOrchestrator;
  };

  /** A channel's name; none for a thread or what is not there. */
  const channelName = (id: string) => {
    const c = model.channel(id);
    return c && c.type !== "thread" ? (c.name ?? undefined) : undefined;
  };
  const channelTags = () =>
    model
      .channels()
      .flatMap((c) => (c.name !== null ? [c] : []))
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => "#" + c.name);
  const channelOfSession = (h: T.Session) => (h.channel && channelName(h.channel) !== undefined ? h.channel : defaultId);
  const channelIdOf = (row: ChannelRow) => (row.type === "thread" ? row.parent_id! : row.id);
  /** Where the owner talks with peer alone, from either side. */
  const directWith = (who: string, other: string) => {
    const peer = who === ownerId ? other : other === ownerId ? who : "";
    return model.channels("direct").find((c) => c.peer_id === peer);
  };
  // Before the helpers are back there are none: each one's thread opens once they are.
  const sessionOf = (id: string) => helpers?.sessionOf(id);
  const presentSessions = () => helpers?.presentSessions() ?? [];

  const targetOfRow = (type: string, rootNumber: number | null, name: string | null, channelId: string | null, channelNameOf: string | null) => {
    const shown = name ?? channelNameOf;
    const ch = {
      type: channelType(type),
      ...(rootNumber !== null ? { rootNumber } : {}),
      ...(shown !== null ? { name: shown } : {}),
    };
    const channel = channelNameOf ?? (channelId ? channelName(channelId) : undefined) ?? undefined;
    return targetOf(ch, channel ?? "");
  };
  const targetOfChannel = (row: ChannelRow) => targetOfRow(row.type, row.root_number, row.name, row.parent_id, null);

  const toChannel = (row: ChannelRow, unread = 0, title = "", last?: MsgRow): T.Channel => {
    const read = model.ownerReadIn(row.id);
    const sk = subjectKind(row.subject_kind);
    return {
      id: row.id,
      type: channelType(row.type),
      default: row.is_default,
      ...(row.peer_id !== null ? { peer: row.peer_id } : {}),
      orchestrator: orchestratorOfRow(row),
      category: row.category ?? "",
      ...(row.position !== null ? { position: row.position } : {}),
      ...(row.archived_at !== null ? { archived: row.archived_at } : {}),
      ...(row.notify !== "all" ? { notify: notifyOf(row.notify) } : {}),
      ...(row.root_id !== null ? { root: row.root_id } : {}),
      ...(row.root_number !== null ? { rootNumber: row.root_number } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      description: row.description ?? "",
      ...(row.project !== null ? { project: row.project } : {}),
      ...(row.parent_id !== null ? { parent: row.parent_id } : {}),
      ...(sk ? { subjectKind: sk } : {}),
      ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
      ...(row.last_number !== null ? { lastNumber: row.last_number } : {}),
      replies: row.reply_count,
      ...(read !== undefined ? { read } : {}),
      ...(unread > 0 ? { unread } : {}),
      title: title,
      ...(last ? { last: { from: last.sender_id, name: last.sender_name, text: lineOf(last.body, lastMax), at: last.created_at } } : {}),
      at: row.created_at,
    };
  };

  /** What a page lists a channel with: the owner's unread there, and a thread's title when its subject does not
   * name it (a page keeps no messages to name it by). */
  const counted = Effect.fnUntraced(function* (row: ChannelRow) {
    // Set to none it counts nothing; to mentions, only what names the owner and is not handled yet.
    const n =
      row.notify === "none"
        ? 0
        : row.notify === "mentions"
          ? (yield* db.run(qm.ownerMentions())).filter((m) => m.channel_id === row.id).length
          : (yield* db.run(qm.ownerUnread({ channel_id: row.id, read_number: model.ownerReadIn(row.id) ?? 0 }))).n;
    const sk = subjectKind(row.subject_kind);
    let title = "";
    if (row.type === "thread" && row.name) title = row.name;
    else if (row.type === "direct" && row.peer_id) title = model.participant(row.peer_id)?.name ?? "";
    else if (row.type === "thread" && sk === "talk" && row.subject_id) title = model.participant(row.subject_id)?.name ?? "";
    // Any other thread (one opened under a message, with no session of its own) by the message it hangs under.
    if (!title && row.type === "thread" && row.root_id) title = lineOf((yield* db.one(qm.messageByID({ id: row.root_id })))?.body ?? "", threadTitleMax);
    const last =
      row.last_number != null && row.last_number !== 0 ? yield* db.one(qm.messageByNumber({ channel_id: row.id, number: row.last_number })) : undefined;
    return toChannel(row, n ?? 0, title, last);
  });

  const publishChannel = Effect.fnUntraced(function* (id: string) {
    const row = model.channel(id);
    if (row) yield* core.apply({ type: "channel", channel: yield* counted(row) });
  });

  const publishOwnerMentions = Effect.gen(function* () {
    // A place set to none tells the owner of nothing, its mentions included.
    const quiet = (id: string | null) => id !== null && model.channel(id)?.notify === "none";
    const rows = (yield* db.run(qm.ownerMentions())).filter((r) => !quiet(r.channel_id) && !quiet(r.top_id));
    yield* core.apply({
      type: "ownerMentions",
      mentions: rows.map((r) => ({
        message: toMessage(r),
        channel: r.top_id ?? defaultId,
        address: targetOfRow(r.channel_type, r.root_number, null, r.top_id, r.channel_name),
      })),
    });
  });

  const publishMessage = Effect.fn("Channel.publishMessage")(function* (row: MsgRow, answers: T.SessionId | undefined) {
    const ch = model.channel(row.channel_id);
    const thread = ch?.type !== "channel" && ch?.subject_kind === "issue" && ch.subject_id ? ch.subject_id : undefined;
    const message = toMessage(row);
    yield* core.apply({ type: "message", message, ...(thread ? { thread } : {}), ...(answers ? { answers } : {}) });
    yield* PubSub.publish(said, message);
  });

  const threadOf = (subject: ThreadSubject) => Effect.sync(() => model.threadOfSubject(subject.kind, subject.id));

  /** The one way from a session to its thread: through the issue it works, never by its own id, since the thread outlives it. */
  const threadOfSession = Effect.fnUntraced(function* (session: string) {
    const h = sessionOf(session);
    return h ? yield* threadOf(subjectOf(h)) : undefined;
  });

  /** Who a thread's words are for, worked out now rather than kept: the session on the issue, or a talk thread's own session. */
  const ownerOf = (ch: ChannelRow): string => {
    if (ch.type === "channel" || !ch.subject_id) return "";
    if (ch.subject_kind === "issue") return helpers?.onIssue(ch.subject_id) ?? "";
    if (ch.subject_kind === "talk") return sessionOf(ch.subject_id) ? ch.subject_id : "";
    return "";
  };

  /** Inside the root message's transaction: a thread and its first follower appear together. */
  const threadFor = Effect.fn("Channel.threadFor")(function* (root: { id: string; number: number; channel: string }, subject: ThreadSubject) {
    const existing = model.threadOfRoot(root.id);
    if (existing) return existing;
    const id = newId();
    const created_at = yield* Clock.currentTimeMillis;
    const thread = {
      id,
      root_id: root.id,
      root_number: root.number,
      subject_kind: subject.kind,
      subject_id: subject.id || null,
      parent_id: root.channel,
    };
    yield* db.run(qc.createThread({ ...thread, created_at }));
    model.created({
      ...thread,
      type: "thread",
      is_default: false,
      last_number: null,
      reply_count: 0,
      created_at,
      name: null,
      description: null,
      project: null,
      peer_id: null,
      revision: 0,
      category: null,
      position: null,
      archived_at: null,
      notify: "all",
      orchestrator: null,
    });
    if (subject.owner) yield* follow(id, subject.owner, "owner", root.number);
    return id;
  });

  const setRead = (who: string, channel: string, upto: number, now: number) =>
    Effect.andThen(
      db.run(qr.setReadCursor({ participant_id: who, channel_id: channel, read_number: upto, updated_at: now })),
      Effect.sync(() => {
        if (who === ownerId) model.ownerReadTo(channel, upto);
      }),
    );

  /** A read cursor subsumes individual seen marks and completes the same deliveries. Inside a transaction. */
  const readUpTo = Effect.fnUntraced(function* (who: string, channel: string, upto: number) {
    const now = yield* Clock.currentTimeMillis;
    yield* setRead(who, channel, upto, now);
    yield* db.run(qs.pruneSeenMarks({ participant: who, channel, upto }));
    yield* db.run(qd.seenUpTo({ at: now, recipient: who, upto, channel }));
    open.seenUpTo(who, channel, upto);
  });
  const readThrough = (who: string, channel: string, upto: number) =>
    tx(readUpTo(who, channel, upto)).pipe(Effect.andThen(who === ownerId ? publishOwnerMentions : Effect.void));

  /** Speaking acknowledges the launch's handed messages without advancing past unseen messages. */
  const heardLaunch = Effect.fnUntraced(
    function* (who: string, launch: string) {
      const seen = yield* db.run(qd.seenHanded({ seen_at: yield* Clock.currentTimeMillis, recipient_id: who, launch }));
      for (const r of seen) {
        open.seen(who, r.message_id);
        yield* db.run(qs.addSeenMark({ participant_id: who, message_id: r.message_id }));
      }
    },
    (effect) => tx(effect),
  );

  const settle = Effect.fn("Channel.settle")(function* (inserted: MsgRow) {
    let row = inserted;
    const ch = model.channel(row.channel_id);
    if (!ch) return yield* Effect.die(new Inconsistent({ message: `no channel ${row.channel_id}` }));
    const meta = metaOf(row.meta);
    const orchestrators = orchestratorIds();
    const here = orchestratorOfRow(ch);
    // No one else is in a direct channel to be named.
    const mentions = ch.type === "direct" ? [] : mentionsIn(row.body, { here, orchestrators });
    const sessionsNow = presentSessions();
    // Participants are sessions, agents and the owner alike: a mention is any of them.
    const present: readonly string[] = sessionsNow.map((h) => h.id);
    const known = new Set(model.participants().map((p) => p.id));
    const named: { id: string; how: "delivered" | "absent" | "unknown" }[] = [];
    for (const m of mentions) {
      const how = orchestrators.includes(m) || m === ownerId || m === everyone || present.includes(m) ? "delivered" : known.has(m) ? "absent" : "unknown";
      named.push({ id: m, how });
      yield* db.run(qmn.insertMention({ message_id: row.id, target_id: m, resolved: how }));
    }
    if (mentions.length > 0) {
      row = { ...row, meta: metaText({ ...meta, mentions }) };
      yield* db.run(qm.updateMessageMeta({ meta: row.meta, id: row.id }));
    }
    let followers: string[] = [];
    if (ch.type === "thread") {
      // A dispatch handing the issue to its next session makes no one a follower: the orchestrator would be woken by every word in it.
      if (row.sender_id !== "system" && row.kind !== "dispatch") yield* follow(ch.id, row.sender_id, "replied", row.number);
      for (const m of named)
        if (m.how === "delivered" && (orchestrators.includes(m.id) || present.includes(m.id))) yield* follow(ch.id, m.id, "mentioned", row.number - 1);
      followers = reach.followers(ch.id);
    }
    const hops = reach.hops(ch.id);
    const now = yield* Clock.currentTimeMillis;
    const cooling: string[] = [];
    for (const h of sessionsNow) {
      const last = reach.lastWake(h.id);
      if (now - last < agentWakeCooldownMs) cooling.push(h.id);
    }
    const audience = sessionsNow.filter((h) => ch.type === "thread" || channelOfSession(h) === ch.id).map((h) => h.id);
    const deliveries = chatAudience({
      from: row.sender_id,
      fromKind: senderKind(row.sender_kind),
      kind: messageKind(row.kind),
      mentions,
      channel: { type: channelType(ch.type), ...(ch.peer_id !== null ? { peer: ch.peer_id } : {}) },
      orchestrator: here,
      orchestrators,
      threadOwner: ownerOf(ch),
      sessions: audience,
      present,
      followers,
      hops,
      cooling,
      broken: breaker.tripped(),
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
      forTask: !(meta.forTask !== true),
      spoken: !(meta.spoken !== true),
    });
    for (const d of deliveries) {
      yield* db.run(
        qd.insertDelivery({ recipient_id: d.recipient, message_id: row.id, reason: d.reason, wakes: d.wakes, held_by: d.heldBy ?? null, created_at: now }),
      );
      open.inserted(d.recipient, {
        message_id: row.id,
        number: row.number,
        reason: d.reason,
        wakes: d.wakes,
        held_by: d.heldBy ?? null,
        state: "pending",
        launch: null,
        channel_id: ch.id,
        sender_id: row.sender_id,
        kind: row.kind,
        body: row.body,
        meta: row.meta,
        reply_number: row.reply_number,
        created_at: row.created_at,
        name: row.sender_name,
        sender_kind: row.sender_kind,
        channel_type: ch.type,
        root_id: ch.root_id,
        root_number: ch.root_number,
        subject_kind: ch.subject_kind,
        subject_id: ch.subject_id,
        // As OpenDeliveries reads it: the thread's channel's name, else the channel's own.
        channel_name: (ch.parent_id !== null ? model.channel(ch.parent_id)?.name : undefined) ?? ch.name ?? "",
      });
      reach.delivered({
        channel: ch.id,
        message: row.id,
        recipient: d.recipient,
        senderKind: row.sender_kind,
        recipientKind: model.participant(d.recipient)?.kind ?? "",
        wakes: d.wakes,
        held: d.heldBy !== undefined,
        at: now,
      });
    }
    const written: Written = { id: row.id, number: row.number, recipients: [], resetWake: [], absent: [], held: false, thread: "", again: false, row };
    written.ownerMentionsChanged = row.sender_id === ownerId || mentions.includes(ownerId);
    // The breaker is reset only after the message's transaction commits.
    if (row.sender_id === ownerId) written.resetWake = deliveries.filter((d) => d.wakes).map((d) => d.recipient);
    if (deliveries.some((d: Delivery) => d.heldBy === "hop_limit")) written.held = (yield* db.run(qm.holdNoticeSinceUser({ channel: ch.id }))).n === 0;
    for (const d of deliveries) if (!d.heldBy && !written.recipients.includes(d.recipient)) written.recipients.push(d.recipient);
    written.absent = named.filter((m) => m.how !== "delivered").map((m) => m.id);
    return written;
  });

  const write = Effect.fnUntraced(function* (w: Write): Effect.fn.Return<Written> {
    const written = yield* tx(
      Effect.gen(function* () {
        if (w.sendKey) {
          const seen = yield* db.one(qm.messageBySendKey({ sender_id: w.from, send_key: w.sendKey }));
          if (seen) return { id: seen.id, number: seen.number, recipients: [], resetWake: [], absent: [], held: false, thread: "", again: true, row: seen };
        }
        // The row as MessageByID would read it back: the sender's name and kind are the participant's.
        const sender = model.participant(w.from);
        if (!sender) return yield* Effect.die(new Inconsistent({ message: `no participant ${w.from}` }));
        const id = newId();
        const meta = metaText(w.meta);
        const created_at = yield* Clock.currentTimeMillis;
        const { revision } = yield* db.run(qc.bumpRevision({ id: w.channel }));
        const { number } = yield* db.run(
          qm.insertMessage({
            id,
            channel: w.channel,
            sender: w.from,
            kind: w.kind,
            body: w.text,
            meta,
            send_key: w.sendKey || null,
            created_at,
            revision,
            reply_number: w.replyTo ?? null,
          }),
        );
        yield* db.run(qc.touchChannel({ number, id: w.channel }));
        model.touched(w.channel, number);
        if (w.from === ownerId) reach.ownerSpoke(w.channel, id);
        const row: MsgRow = {
          id,
          channel_id: w.channel,
          number,
          sender_id: w.from,
          kind: w.kind,
          body: w.text,
          meta,
          send_key: w.sendKey || null,
          created_at,
          sender_name: sender.name,
          sender_kind: sender.kind,
          sender_agent: sender.agent_id,
          revision,
          reply_number: w.replyTo ?? null,
          edited_at: null,
          deleted_at: null,
          pinned_at: null,
          reactions: null,
        };
        const out: Written = yield* settle(row);
        if (w.readBy) yield* readUpTo(w.readBy, w.channel, number);
        if (w.follow) yield* follow(w.channel, w.follow, "owner", number);
        if (w.thread) out.thread = yield* threadFor({ id, number, channel: w.channel }, w.thread);
        return out;
      }),
    );
    if (!written.again) yield* after(w.channel, written, w.answers);
    return written;
  });

  /** The previews of a message's links, read after it is out (the server's own requests take seconds) and then put on
   * it as a change. */
  const embedLater = (row: MsgRow) => {
    const links = row.kind === "chat" && row.deleted_at === null ? linksIn(row.body) : [];
    if (links.length === 0) return;
    void forkHere(
      Effect.gen(function* () {
        const found = (yield* Effect.forEach(
          links,
          (l) =>
            readEmbed(l).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.catchCause((cause) => Effect.as(Effect.logWarning("a link preview was not read", cause), undefined)),
            ),
          { concurrency: "unbounded" },
        )).filter((e): e is T.Embed => e !== undefined);
        yield* locked(
          Effect.gen(function* () {
            const now = yield* db.one(qm.messageByID({ id: row.id }));
            // Changed meanwhile: its words are not the ones read.
            if (!now || now.deleted_at !== null || now.body !== row.body) return;
            const meta = metaOf(now.meta);
            if (found.length === 0 && !meta.embeds) return;
            yield* change(now, (revision) => db.run(qm.setEmbeds({ meta: metaText({ ...meta, embeds: found }), revision, id: now.id })));
          }),
        );
      }).pipe(bestEffort("chat: link previews")),
    );
  };

  const after = Effect.fnUntraced(function* (channel: string, written: Written, answers: T.SessionId | undefined): Effect.fn.Return<void> {
    for (const r of written.resetWake) breaker.reset(r);
    yield* publishMessage(written.row, answers);
    embedLater(written.row);
    yield* publishChannel(channel);
    if (written.ownerMentionsChanged === true) yield* publishOwnerMentions;
    if (written.thread) yield* publishChannel(written.thread);
    if (written.held) yield* write({ channel, from: "system", kind: "notice", text: hopLimitText(hopLimit), meta: { code: "hop_limit" } });
    for (const r of written.recipients) yield* kick(r);
  });

  const deliveryTarget = (r: DeliveryRow) => targetOfRow(r.channel_type, r.root_number, null, null, r.channel_name || null);
  const asInbox = (r: DeliveryRow): InboxMessage => ({
    id: r.message_id,
    number: r.number,
    target: deliveryTarget(r),
    from: r.sender_id,
    fromKind: senderKind(r.sender_kind),
    name: r.name,
    text: r.body,
    ...inboxMore(r, filesAt),
  });

  const groupRows = (rows: readonly DeliveryRow[]): UnreadRow[] => {
    // A Map keeps the order targets were first met in.
    const out = new Map<string, UnreadRow>();
    for (const r of rows) {
      const target = deliveryTarget(r);
      const was = out.get(target);
      const mentions = r.reason === "mention" || r.reason === "everyone";
      out.set(target, { target, unread: (was?.unread ?? 0) + 1, mentionsYou: (was?.mentionsYou ?? false) || mentions, latest: r.name });
    }
    return [...out.values()];
  };

  const inboxRows = Effect.fn("Channel.inboxRows")(function* (who: string) {
    const h = sessionOf(who);
    const channel = h ? channelOfSession(h) : defaultId;
    const rows = yield* db.run(qc.inboxOf({ participant: who, channel }));
    const out: UnreadRow[] = [];
    for (const r of rows.slice(0, summaryChannels)) {
      const latest = yield* db.one(qm.messageByNumber({ channel_id: r.id, number: r.latest ?? 0 }));
      out.push({
        target: targetOfRow(r.type, r.root_number, null, null, r.channel_name || null),
        unread: r.unread ?? 0,
        mentionsYou: !(r.mentions_you !== true),
        ...(latest ? { latest: latest.sender_name } : {}),
      });
    }
    return out;
  });

  const deliver = (recipient: string, text: string, message: string): Effect.Effect<Delivered> =>
    helpers ? helpers.deliver(recipient, text, { kind: "comment", message }) : Effect.succeed({ kind: "refused", reason: t("server.channel.notBack") });

  const kick = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    const rows = open.of(recipient);
    const waking = rows.filter((r) => r.wakes && r.held_by === null && (r.state === "pending" || r.state === "announced"));
    if (agents.isOrchestrator(recipient)) {
      const byChannel = Map.groupBy(waking, (r) => r.channel_id);
      const now = yield* Clock.currentTimeMillis;
      for (const [channel, rs] of byChannel) {
        const messages = rs.map(asInbox);
        PubSub.publishUnsafe(orchestratorHub, { agent: recipient, channel, type: channelType(rs[0]!.channel_type), target: messages[0]!.target, messages });
        for (const r of rs) {
          yield* db.run(qd.seenOne({ seen_at: now, recipient_id: recipient, message_id: r.message_id }));
          open.seen(recipient, r.message_id);
          yield* received(recipient, r.message_id);
        }
      }
      return;
    }
    const session = sessionOf(recipient);
    if (!session) {
      yield* db.run(qd.dropOpen({ dropped_why: "left", recipient_id: recipient }));
      return open.dropped(recipient);
    }
    if (isBusy(session)) {
      // Gathered for a moment: a burst of messages is one notice.
      if (rows.some((r) => r.state === "pending" && r.held_by === null)) later(`notice:${recipient}`, config.chat.noticeBatchMs, () => notify(recipient));
      return;
    }
    if (waking.length === 0 || breaker.isOpen(recipient)) return;
    const messages = waking.map(asInbox);
    const others = (yield* inboxRows(recipient)).filter((o) => !messages.some((m) => m.target === o.target));
    const delivered = yield* deliver(recipient, wakeInput(messages, others), waking[0]!.message_id);
    if (delivered.kind === "refused") return yield* Effect.logInfo(`chat: ${recipient} not woken: ${delivered.reason}`);
    const now = yield* Clock.currentTimeMillis;
    for (const r of waking) {
      yield* db.run(qd.markHanded({ launch: delivered.launch ?? "", handed_at: now, recipient_id: recipient, message_id: r.message_id }));
      open.handed(recipient, r.message_id, delivered.launch ?? "");
      yield* received(recipient, r.message_id);
    }
  });

  const notify = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    if (compacting.has(recipient)) return;
    const session = sessionOf(recipient);
    if (!session) return;
    if (!isBusy(session)) return yield* kick(recipient);
    const rows = open.of(recipient).filter((r) => r.state === "pending" && r.held_by === null);
    if (rows.length === 0) return;
    const delivered = yield* deliver(recipient, busyNotice(groupRows(rows)), rows[0]!.message_id);
    if (delivered.kind === "refused") return;
    const now = yield* Clock.currentTimeMillis;
    for (const r of rows) {
      yield* db.run(qd.markAnnounced({ launch: delivered.launch ?? "", announced_at: now, recipient_id: recipient, message_id: r.message_id }));
      open.announced(recipient, r.message_id, delivered.launch ?? "");
    }
  });

  const onActivity = Effect.fnUntraced(function* (a: LaunchActivity): Effect.fn.Return<void> {
    if (closed) return;
    switch (a.kind) {
      case "spoke":
        breaker.spoke(a.id);
        return yield* heardLaunch(a.id, a.launch);
      case "ended": {
        if (!a.spoke) {
          const rolled = yield* db.run(qd.rollbackHanded({ recipient_id: a.id }));
          open.handedBack(a.id);
          if (rolled.length > 0) {
            const { count: failed, tripped } = breaker.failed(a.id);
            if (tripped) {
              const where = (yield* threadOfSession(a.id)) ?? defaultId;
              const name = sessionOf(a.id)?.name ?? a.id;
              yield* write({
                channel: where,
                from: "system",
                kind: "notice",
                text: t("server.channel.breaker", { name, failed }),
                meta: { code: "wake_breaker" },
              });
            }
            // Not straight away: what failed may fail again.
            later(`wake:${a.id}`, config.chat.retryWakeMs, () => kick(a.id));
            return;
          }
        }
        return yield* kick(a.id);
      }
      case "closed":
        yield* db.run(qd.rollbackHanded({ recipient_id: a.id }));
        open.handedBack(a.id);
        yield* db.run(qd.rollbackAnnounced({ recipient_id: a.id, launch: a.launch }));
        return open.announcedBack(a.id, a.launch);
      case "compacting":
        if (a.on) compacting.add(a.id);
        else {
          compacting.delete(a.id);
          yield* kick(a.id);
        }
    }
  });

  /** Reading a digest only proposes context; the execution acknowledges what it actually took. */
  const consumed = (input: InputConsumed) =>
    Effect.forEach(
      input.messages,
      (id) =>
        Effect.andThen(
          db.run(qd.seenOne({ seen_at: clock.currentTimeMillisUnsafe(), recipient_id: input.session, message_id: id })),
          Effect.sync(() => open.seen(input.session, id)),
        ),
      { discard: true },
    );

  const openThread = Effect.fn("Channel.openThread")(function* (h: T.Session) {
    const joined: qp.UpsertParticipantParams = {
      id: h.id,
      kind: "session",
      name: h.name,
      agent_id: h.agent,
      runtime: h.runtime,
      joined_at: yield* Clock.currentTimeMillis,
    };
    yield* db.run(qp.upsertParticipant(joined));
    model.joined(joined);
    const subject = subjectOf(h);
    const thread = yield* threadOf(subject);
    if (thread) return yield* handedOn(h, thread);
    const channel = channelOfSession(h);
    const latest = (yield* db.run(qm.latestNumber({ channel_id: channel }))).n ?? 0;
    yield* setRead(h.id, channel, latest, yield* Clock.currentTimeMillis);
    const what = h.graph?.task
      ? t("server.channel.dispatch.step", { graph: h.graph.id, task: h.graph.task })
      : h.graph
        ? t("server.channel.dispatch.split", { graph: h.graph.id })
        : h.refining
          ? t("server.channel.dispatch.draft")
          : head(h.brief.replace(/\s+/gu, " "), 80);
    // The dispatch note is the farm's, under the name of the orchestrator that looks after the channel.
    const by = orchestratorOfRow(model.channel(channel));
    yield* seat(by);
    yield* write({
      channel: channel,
      from: by,
      kind: "dispatch",
      text: t("server.channel.dispatch.sent", { id: h.id, name: h.name, project: h.project ?? t("server.channel.dispatch.project"), what }),
      meta: { session: h.id },
      thread: subject,
    });
  });

  /**
   * The issue already has its thread (reopened, or sent to another session): the next session is told of in it and follows
   * it, in one transaction, so a restart neither says it twice nor leaves it out.
   */
  const handedOn = Effect.fn("Channel.handedOn")(function* (h: T.Session, thread: string) {
    const followers = reach.followers(thread);
    if (followers.includes(h.id)) return;
    // A profile's talk: the session that answers there is not told of in it; it only follows.
    if (model.channel(thread)?.type === "direct") return yield* follow(thread, h.id, "owner", model.channel(thread)?.last_number ?? 0);
    const channel = channelOfSession(h);
    const latest = (yield* db.run(qm.latestNumber({ channel_id: channel }))).n ?? 0;
    yield* setRead(h.id, channel, latest, yield* Clock.currentTimeMillis);
    // Each dispatch of the issue is in its thread but the first, which the thread hangs under: this is the one after.
    const nth = ((yield* db.run(qm.dispatchesIn({ channel_id: thread }))).n ?? 0) + 2;
    const text = h.refining
      ? t("server.channel.dispatch.redraft", { id: h.id, name: h.name })
      : t("server.channel.dispatch.handedOn", { id: h.id, name: h.name, nth });
    const by = orchestratorOfRow(model.channel(thread));
    yield* seat(by);
    yield* write({ channel: thread, from: by, kind: "dispatch", text, meta: { session: h.id }, follow: h.id });
  });

  const sessionsLeft = Effect.gen(function* () {
    const on = new Set<string>(presentSessions().map((h) => h.id));
    const now = yield* Clock.currentTimeMillis;
    for (const p of model.participants()) {
      if (p.kind !== "session" || p.left_at !== null || on.has(p.id)) continue;
      yield* db.run(qp.participantLeft({ left_at: now, id: p.id }));
      model.left(p.id, now);
      yield* db.run(qd.dropOpen({ dropped_why: "left", recipient_id: p.id }));
      open.dropped(p.id);
      yield* db.run(qf.unfollowAllOf({ at: now, participant_id: p.id }));
      reach.left(p.id);
      lastRead.delete(p.id);
      yield* FiberMap.remove(waits, `notice:${p.id}`);
      breaker.reset(p.id);
    }
  });

  const postReport = Effect.fn("Channel.postReport")(function* (
    id: string,
    outcome: T.Outcome,
    summary: string,
    spent: T.Spent | undefined,
    run: string | undefined,
  ) {
    const w = sessionOf(id);
    if (!w || outcome === "interrupted") return;
    const thread = yield* threadOfSession(id);
    if (!thread) return;
    const said = outcome === "completed" ? (helpers?.report(id) ?? "") : "";
    const meta: Meta = { outcome, ...(spent ? { spent } : {}), forTask: !!w.graph, ...(run ? { run } : {}) };
    yield* write({ channel: thread, from: id, kind: "report", text: head(said || summary, reportMax), meta });
  });

  yield* locked(
    Effect.gen(function* () {
      // Whatever was handed and not seen goes back.
      yield* db.run(qd.rollbackAll());
      open.load(yield* db.run(qd.allOpenDeliveries()));
      const recent = yield* db.run(qc.recentChannels({ n: keepChannels }));
      for (const c of [...recent].toReversed()) yield* core.apply({ type: "channel", channel: yield* counted(c) });
      yield* publishOwnerMentions;
    }),
  );

  // The sessions' news: hired and left open and close threads, a report is posted in the thread. One at a time, before the
  // next.
  const onSessionNews = Effect.fnUntraced(function* (n: SessionNews) {
    yield* locked(
      Effect.suspend(() => {
        if (closed) return Effect.void;
        switch (n._tag) {
          case "hired":
            return Effect.forEach(presentSessions(), (h) => openThread(h).pipe(bestEffort(`chat: ${h.id}'s thread`)), {
              discard: true,
            });
          case "left":
            return sessionsLeft;
          case "reported":
            return postReport(n.report.id, n.report.outcome, n.report.summary, n.report.spent, n.report.run);
        }
      }),
    ).pipe(bestEffort(`chat: after ${n._tag}`));
  });
  // Once the helpers are back: each present one has its thread, and whatever was waiting for one goes to it.
  const helpersBack = locked(
    Effect.gen(function* () {
      for (const h of presentSessions()) yield* openThread(h).pipe(bestEffort(`chat: ${h.id}'s thread`));
      for (const p of model.participants()) if (p.kind === "session" && p.left_at === null) yield* kick(p.id);
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  /** A target as who would mean it: empty is a session's own thread (or the default channel), a channel by name, or a thread by its parent's number. */
  const resolveTarget = Effect.fnUntraced(function* (who: string, target: string): Effect.fn.Return<string, ApiError> {
    if (!target.trim()) {
      if (!agents.isOrchestrator(who) && who !== ownerId) {
        const own = yield* threadOfSession(who);
        if (own) return own;
      }
      return defaultId;
    }
    const parsed = parseChatTarget(target);
    if (!parsed) return yield* Effect.fail(refused(t("server.channel.badTarget", { target })));
    if (parsed.kind === "direct") {
      const direct = directWith(who, parsed.peer);
      if (!direct) return yield* Effect.fail(refused(t("server.channel.noDirect", { target: target.trim() })));
      return direct.id;
    }
    let channel = defaultId;
    const name = parsed.kind === "channel" ? parsed.name : target.trim().replace(/^#/u, "").split(":")[0]!;
    if (name) {
      const found = model.channelByName(name);
      if (!found) return yield* Effect.fail(missing(t("server.channel.noChannelNamed", { name, tags: list(channelTags()) }), [lookIn.channel]));
      channel = found.id;
    }
    if (parsed.kind === "channel") return channel;
    const root = yield* db.one(qm.messageByNumber({ channel_id: channel, number: parsed.root }));
    if (!root) return yield* Effect.fail(refused(t("server.channel.noMessage", { n: parsed.root })));
    const thread = yield* tx(threadFor({ id: root.id, number: root.number, channel: root.channel_id }, { kind: "talk", id: "", owner: "" }));
    yield* publishChannel(thread);
    return thread;
  });

  const filesDir = join(config.home, "attachments");
  const filesAt = (id: string) => join(filesDir, id);
  const inboxOf = (row: MsgRow, target: string): InboxMessage => ({
    id: row.id,
    number: row.number,
    target,
    from: row.sender_id,
    fromKind: senderKind(row.sender_kind),
    name: row.sender_name,
    text: row.body,
    ...inboxMore(row, filesAt),
  });

  const answered = Effect.fnUntraced(function* (channel: string, number: number | undefined) {
    if (number === undefined) return;
    if (!(yield* db.one(qm.messageByNumber({ channel_id: channel, number })))) return yield* Effect.fail(refused(t("server.channel.noMessage", { n: number })));
  });

  const attachmentsOf = Effect.fnUntraced(function* (ids: readonly string[]) {
    const out: T.Attachment[] = [];
    for (const id of new Set(ids)) {
      const a = yield* db.one(qa.attachmentByID({ id }));
      if (!a) return yield* Effect.fail(missing(t("server.channel.noAttachment", { id }), [lookIn.channel]));
      out.push(a);
    }
    return out;
  });

  const messageOf = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(qm.messageByID({ id }));
    if (!row) return yield* Effect.fail(missing(t("server.channel.noMessageId", { id }), [lookIn.channel]));
    return row;
  });

  /** One message changed, in one transaction with the channel's next revision; then it goes to whoever follows its
   * channel as it now is. A change is not news: no fact, no delivery, no wake. */
  const change = Effect.fnUntraced(function* (row: MsgRow, work: (revision: number, now: number) => Effect.Effect<void>) {
    const now = yield* Clock.currentTimeMillis;
    yield* tx(
      Effect.gen(function* () {
        const { revision } = yield* db.run(qc.bumpRevision({ id: row.channel_id }));
        yield* work(revision, now);
      }),
    );
    const message = toMessage((yield* db.one(qm.messageByID({ id: row.id })))!);
    yield* PubSub.publish(said, message);
    yield* publishChannel(row.channel_id);
    return message;
  });

  /** add only adds: a reaction already there is then kept. */
  // Setting the reaction as it already is writes nothing: a retried set is no new revision for every follower.
  const reacting = Effect.fnUntraced(function* (id: string, who: string, emoji: string, on: boolean) {
    const e = emoji.trim();
    if (!emojiPattern.test(e)) return yield* Effect.fail(refused(t("server.channel.badEmoji")));
    const row = yield* messageOf(id);
    if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
    const r = reactionsOf(row.reactions);
    const by = r[e] ?? [];
    if (by.includes(who) === on) return toMessage(row);
    r[e] = on ? [...by, who] : by.filter((x) => x !== who);
    return yield* change(row, (revision) => db.run(qm.setReactions({ reactions: reactionsText(r), revision, id })));
  });

  const received = (recipient: string, message: string) => reacting(message, recipient, handedEmoji, true).pipe(bestEffort(`chat: 👀 on ${message}`));

  /** A channel nothing points at any more; refused with what still does. */
  const removable = Effect.fnUntraced(function* (id: string) {
    const row = model.channel(id);
    if (!row || row.type !== "channel") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
    if (row.is_default) return yield* Effect.fail(refused(t("server.channel.defaultStays")));
    if (presentSessions().some((h) => channelOfSession(h) === id))
      return yield* Effect.fail(refused(t("server.channel.inUse", { why: t("server.channel.helpersThere") })));
    const used = yield* db.run(qc.channelInUse({ id }));
    const why = [
      used.crons != null && used.crons !== 0 ? t("server.channel.cronsThere", { n: used.crons }) : "",
      used.connectors != null && used.connectors !== 0 ? t("server.channel.connectorsThere") : "",
      used.queued != null && used.queued !== 0 ? t("server.channel.queuedThere", { n: used.queued }) : "",
      used.issue_threads != null && used.issue_threads !== 0 ? t("server.channel.issuesThere", { n: used.issue_threads }) : "",
    ].filter(Boolean);
    if (why.length > 0) return yield* Effect.fail(refused(t("server.channel.inUse", { why: list(why) })));
    const threads = model.threadsOf(id);
    const said = (row.last_number ?? 0) + threads.reduce((n, thread) => n + thread.reply_count, 0);
    return { target: targetOfChannel(row), threads: threads.length, said };
  });

  const shape = Channel.of({
    now: () => core.state().chat,
    follow: (channel, after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!model.channel(channel)) return yield* Effect.fail(refused(t("server.channel.channelGone")));
          // Subscribed before the missed ones are read: nothing changed in between falls through, and what both have is
          // dropped by its revision.
          const live = yield* PubSub.subscribe(said);
          const missed = yield* db.run(qm.messagesChangedAfter({ channel_id: channel, revision: after, n: catchUpMax + 1 }));
          if (missed.length > catchUpMax) return Stream.succeed<T.ChannelEvent>({ _tag: "Reset" });
          const upto = missed.at(-1)?.revision ?? after;
          const here = bounded(Stream.fromSubscription(live).pipe(Stream.filter((m) => m.channel === channel && m.revision > upto)), "chat.follow");
          return Stream.concat(Stream.fromIterable(missed.map(toMessage)), here).pipe(Stream.map((message): T.ChannelEvent => ({ _tag: "Message", message })));
        }),
      ),
    reports: (after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const live = yield* PubSub.subscribe(said);
          const missed =
            after === undefined
              ? [...(yield* db.run(qm.recentReports({ n: logKeep })))].toReversed()
              : yield* db.run(qm.reportsAfter({ after, n: catchUpMax + 1 }));
          if (missed.length > catchUpMax) return Stream.succeed<T.ChannelEvent>({ _tag: "Reset" });
          const upto = missed.at(-1)?.id ?? after ?? "";
          const here = bounded(Stream.fromSubscription(live).pipe(Stream.filter((m) => m.kind === "report" && m.id > upto)), "chat.reports");
          return Stream.concat(Stream.fromIterable(missed.map(toMessage)), here).pipe(Stream.map((message): T.ChannelEvent => ({ _tag: "Message", message })));
        }),
      ),
    defaultChannel: () => defaultId,
    messageLocation: Effect.fn("Channel.messageLocation")(function* (id) {
      const message = yield* db.one(qm.messageByID({ id }));
      if (!message) return undefined;
      const row = model.channel(message.channel_id);
      return row ? { channel: toChannel(row), top: channelIdOf(row) } : undefined;
    }),
    say: Effect.fn("Channel.say")(function* (text, channel, sendKey, more = {}) {
      const files = yield* attachmentsOf(more.attachments ?? []);
      if (!text.trim() && files.length === 0) return yield* Effect.fail(refused(t("server.channel.empty")));
      if (sendKey.length > sendKeyMax) return yield* Effect.fail(refused(t("server.channel.sendKeyLong")));
      const where = channel ?? defaultId;
      if (!model.channel(where)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: where }), [lookIn.channel]));
      yield* answered(where, more.replyTo);
      const written = yield* write({
        channel: where,
        from: ownerId,
        kind: "chat",
        text: text.trim(),
        sendKey,
        readBy: ownerId,
        ...(more.replyTo !== undefined ? { replyTo: more.replyTo } : {}),
        ...(files.length > 0 || more.picked
          ? { meta: { ...(files.length > 0 ? { attachments: files } : {}), ...(more.picked ? { picked: more.picked } : {}) } }
          : {}),
      });
      if (written.again) return { message: toMessage(written.row), again: true };
      if (written.absent.length > 0)
        yield* core.notice("warn", t("server.channel.absent", { who: list(written.absent.map((m) => mentionOf(m) ?? "@" + m)), n: written.absent.length }));
      return { message: toMessage(written.row), again: false };
    }, locked),
    edit: Effect.fn("Channel.edit")(function* (id, text, keep) {
      const row = yield* messageOf(id);
      if (row.sender_id !== ownerId || row.kind !== "chat" || row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.notYours")));
      const meta = metaOf(row.meta);
      const files = keep === undefined ? (meta.attachments ?? []) : (meta.attachments ?? []).filter((a) => keep.includes(a.id));
      const words = text.trim();
      if (!words && files.length === 0) return yield* Effect.fail(refused(t("server.channel.empty")));
      if (words === row.body && files.length === (meta.attachments ?? []).length) return toMessage(row);
      const changed = yield* change(row, (revision, now) =>
        Effect.gen(function* () {
          yield* db.run(qm.editMessage({ body: words, at: now, revision, id }));
          if (files.length !== (meta.attachments ?? []).length) yield* db.run(qm.setEmbeds({ meta: metaText({ ...meta, attachments: files }), revision, id }));
        }),
      );
      if (words !== row.body) embedLater({ ...row, body: words });
      return changed;
    }, locked),
    remove: Effect.fn("Channel.remove")(function* (id) {
      const row = yield* messageOf(id);
      if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
      yield* change(row, (revision, now) =>
        Effect.gen(function* () {
          yield* db.run(qm.deleteMessage({ at: now, revision, id }));
          for (const d of yield* db.run(qd.dropOpenOf({ message_id: id }))) open.seen(d.recipient_id, id);
        }),
      );
    }, locked),
    previewRemove: Effect.fn("Channel.previewRemove")(function* (id) {
      const row = yield* messageOf(id);
      if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
      const ch = model.channel(row.channel_id);
      const waiting = (yield* db.run(qd.waitingOn({ message_id: id }))).length;
      return {
        does: [
          t("server.channel.deletes", { target: ch ? targetOfChannel(ch) : "", number: row.number, name: row.sender_name, text: lineOf(row.body, lastMax) }),
          ...(waiting > 0 ? [t("server.channel.deletesDeliveries", { n: waiting })] : []),
        ],
      };
    }),
    react: Effect.fn("Channel.react")(function* (id, who, emoji, on) {
      return yield* locked(reacting(id, who, emoji, on));
    }),
    pin: Effect.fn("Channel.pin")(function* (id, on) {
      const row = yield* messageOf(id);
      if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
      if ((row.pinned_at !== null) === on) return toMessage(row);
      return yield* change(row, (revision, now) => db.run(qm.setPinned({ pinned_at: on ? now : null, revision, id })));
    }, locked),
    pins: Effect.fn("Channel.pins")(function* (channel) {
      if (!model.channel(channel)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]));
      return (yield* db.run(qm.pinnedIn({ channel_id: channel }))).map(toMessage);
    }),
    threadUnder: Effect.fn("Channel.threadUnder")(function* (id) {
      const row = yield* messageOf(id);
      if (model.channel(row.channel_id)?.type !== "channel") return yield* Effect.fail(refused(t("server.channel.threadOnlyInChannel")));
      const thread = yield* tx(threadFor({ id: row.id, number: row.number, channel: row.channel_id }, { kind: "talk", id: "", owner: "" }));
      yield* publishChannel(thread);
      return thread;
    }, locked),
    search: Effect.fn("Channel.search")(function* (text, channel) {
      const q = parseSearch(text);
      if (!q.words && !q.from && !q.in && q.has.length === 0 && q.before === undefined && q.after === undefined)
        return yield* Effect.fail(refused(t("server.channel.empty")));
      let scope = channel ?? "";
      if (q.in) {
        const named = model.channelByName(q.in);
        if (!named) return yield* Effect.fail(missing(t("server.channel.noChannelNamed", { name: q.in, tags: list(channelTags()) }), [lookIn.channel]));
        scope = named.id;
      }
      const rows = yield* db.run(
        qm.searchMessages({
          text: q.words,
          channel: scope,
          sender: q.from ?? "",
          has_file: q.has.includes("file"),
          has_image: q.has.includes("image"),
          has_link: q.has.includes("link"),
          after: q.after ?? 0,
          before: q.before ?? Number.MAX_SAFE_INTEGER,
          n: searchMax,
        }),
      );
      return rows.map((r) => ({
        message: toMessage(r),
        channel: r.top_id ?? r.channel_id,
        address: targetOfRow(r.channel_type, r.root_number, null, r.top_id, r.channel_name),
      }));
    }),
    attach: Effect.fn("Channel.attach")(function* (upload) {
      const name = upload.name.trim() || "file";
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length === 0) return yield* Effect.fail(refused(t("server.channel.emptyFile")));
      if (bytes.length > attachmentMax) return yield* Effect.fail(refused(t("server.channel.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) })));
      const id = createHash("sha256").update(bytes).digest("hex");
      yield* writeOnce(filesAt(id), bytes).pipe(
        Effect.mapError((e) => refused(e.message)),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const type = upload.type.trim() || "application/octet-stream";
      yield* db.run(qa.insertAttachment({ id, name, type, size: bytes.length, created_at: yield* Clock.currentTimeMillis }));
      return { id, name, type, size: bytes.length };
    }),
    attachment: Effect.fn("Channel.attachment")(function* (id) {
      const a = yield* db.one(qa.attachmentByID({ id }));
      return a ? { path: filesAt(a.id), type: a.type, name: a.name } : undefined;
    }),
    tellSession: Effect.fn("Channel.tellSession")(function* (from, session, text, sendKey) {
      const thread = yield* threadOfSession(session);
      if (!thread) {
        // Sent with no channel, so no thread to say it in: the session hears it straight.
        if (helpers?.present(session) !== true) return yield* Effect.fail(missing(t("server.channel.noHelper", { id: session }), [lookIn.session]));
        yield* helpers.deliver(session, text.trim(), { kind: "comment" });
        return undefined;
      }
      const run = helpers?.currentRun(from);
      const written = yield* write({
        channel: thread,
        from,
        kind: "chat",
        text: text.trim(),
        meta: run ? { run } : {},
        sendKey,
        ...(from === ownerId ? { readBy: ownerId } : {}),
      });
      return toMessage(written.row);
    }, locked),
    speak: Effect.fn("Channel.speak")(function* (from, text, opt = {}): Effect.fn.Return<Spoken, ApiError> {
      const words = text.trim();
      if (!words) return yield* Effect.fail(refused(t("server.channel.empty")));
      const channel = yield* resolveTarget(from, opt.target ?? "");
      const row = model.channel(channel);
      if (!row) return yield* Effect.fail(refused(t("server.channel.channelGone")));
      const target = targetOfChannel(row);
      // A retry of the same words is the same message.
      const again = yield* db.one(
        qm.recentDuplicate({ sender_id: from, channel_id: channel, body: words, since: (yield* Clock.currentTimeMillis) - retryWindowMs }),
      );
      if (again) {
        const m = yield* db.one(qm.messageByID({ id: again.id }));
        if (m) return { kind: "sent", message: toMessage(m), target, absent: [] };
      }
      // Posting on a channel right after reading a thread: confirm once.
      const last = lastRead.get(from) ?? "";
      if (row.type !== "thread" && opt.confirm !== true && last && last !== target) return { kind: "confirm", target, lastRead: last };
      // Newer messages it has not seen: show them instead of sending.
      const unseen = (yield* db.run(qm.unseenIn({ channel, participant: from }))).map((r) => r.id);
      if (unseen.length > 0 && opt.anyway !== true) {
        const now = yield* Clock.currentTimeMillis;
        const shown: InboxMessage[] = [];
        for (const id of unseen.slice(0, heldShown)) {
          const m = yield* db.one(qm.messageByID({ id }));
          if (!m) continue;
          shown.push(inboxOf(m, target));
          yield* db.run(qs.addSeenMark({ participant_id: from, message_id: m.id }));
          yield* db.run(qd.seenOne({ seen_at: now, recipient_id: from, message_id: m.id }));
          open.seen(from, m.id);
        }
        const newest = shown.at(-1);
        if (newest && shown.length === unseen.length) yield* setRead(from, channel, newest.number, now);
        return { kind: "held", target, shown: shown.toReversed(), more: unseen.length - shown.length };
      }
      // calledBy finds only participants of kind agent, and those are sessions (their ids are session ids).
      const caller = !agents.isOrchestrator(from) ? (yield* db.one(qm.calledBy({ speaker: from, channel, before: afterAll })))?.sender_id : undefined;
      const answers = caller === undefined ? undefined : sessionId(caller);
      const run = helpers?.currentRun(from);
      if (agents.isOrchestrator(from)) yield* seat(from);
      yield* answered(channel, opt.reply);
      const written = yield* write({
        channel,
        from,
        kind: "chat",
        text: words,
        ...(answers ? { answers } : {}),
        ...(opt.reply !== undefined ? { replyTo: opt.reply } : {}),
        meta: run ? { run } : {},
      });
      yield* setRead(from, channel, written.number, yield* Clock.currentTimeMillis);
      return { kind: "sent", message: toMessage(written.row), target, absent: written.absent };
    }, locked),
    placeOf: Effect.fn("Channel.placeOf")(function* (from, channel) {
      if (model.channel(channel)) return channel;
      return yield* resolveTarget(from, channel);
    }),
    announce: Effect.fn("Channel.announce")(function* (from, channel, text, card) {
      const where = model.channel(channel) ? channel : yield* resolveTarget(from, channel);
      if (!model.channel(where)) return yield* Effect.fail(refused(t("server.channel.channelGone")));
      const run = helpers?.currentRun(from);
      if (agents.isOrchestrator(from)) yield* seat(from);
      const written = yield* write({
        channel: where,
        from,
        kind: "chat",
        text: text.trim(),
        meta: { ...(run ? { run } : {}), artifact: card },
        ...(from === ownerId ? { readBy: ownerId } : {}),
      });
      if (from !== ownerId) yield* setRead(from, where, written.number, yield* Clock.currentTimeMillis);
      return toMessage(written.row);
    }, locked),
    spoken: Effect.fn("Channel.spoken")(
      function* (from, text, sendKey) {
        if (sendKey.length > sendKeyMax) return yield* Effect.fail(refused(t("server.channel.sendKeyLong")));
        if (!text.trim()) return false;
        const written = yield* write({
          channel: defaultId,
          from,
          kind: "chat",
          text: text.trim(),
          meta: { spoken: true },
          sendKey,
          ...(from === ownerId ? { readBy: ownerId } : {}),
        });
        return written.again;
      },
      Effect.catchDefect((d) => Effect.as(Effect.logWarning(`chat: words said on a call: ${String(d)}`), false)),
      locked,
    ),
    orchestratorSays: Effect.fn("Channel.orchestratorSays")(function* (channel, text, run, from) {
      if (!text.trim()) return;
      yield* locked(Effect.andThen(seat(from), write({ channel, from, kind: "chat", text, meta: run ? { run } : {} })));
    }, bestEffort("chat: the orchestrator's words")),
    notice: Effect.fn("Channel.notice")(
      function* (channel, text, code) {
        return yield* write({ channel, from: "system", kind: "notice", text, meta: { code } });
      },
      locked,
      bestEffort("chat: notice"),
    ),
    read: Effect.fn("Channel.read")(function* (who, opt = {}) {
      const channel = yield* resolveTarget(who, opt.target ?? "");
      const row = model.channel(channel);
      if (!row) return yield* Effect.fail(refused(t("server.channel.channelGone")));
      const target = targetOfChannel(row);
      const limit = opt.limit != null && opt.limit !== 0 ? Math.min(Math.max(opt.limit, 1), 100) : readLimit;
      const cursor = (yield* db.one(qr.readCursor({ participant_id: who, channel_id: channel })))?.read_number ?? 0;
      const rows =
        opt.unread === true
          ? yield* db.run(qm.messagesAfter({ channel_id: channel, number: cursor, n: limit }))
          : [...(yield* db.run(qm.messagesBefore({ channel_id: channel, number: opt.before ?? 2147483647, n: limit })))].toReversed();
      const newest = rows.at(-1);
      if (newest && (opt.before == null || opt.before === 0)) yield* readThrough(who, channel, newest.number);
      lastRead.set(who, target);
      const older = rows.length > 0 && (yield* db.run(qm.messagesBefore({ channel_id: channel, number: rows[0]!.number, n: 1 }))).length > 0;
      return { target, messages: rows.map((m) => inboxOf(m, target)), older };
    }, locked),
    unread: Effect.fn("Channel.unread")(function* (who) {
      return yield* locked(
        inboxRows(who).pipe(
          Effect.map((rows) => rows.map(({ target, ...r }): T.ChannelUnread => ({ channel: target, ...r }))),
          Effect.catchCause((c) => Effect.as(Effect.logWarning(`chat: unread of ${who}: ${String(c)}`), [] as T.ChannelUnread[])),
        ),
      );
    }),
    list: Effect.fn("Channel.list")(function* () {
      return yield* Effect.forEach([...model.channels("channel"), ...model.channels("direct")], counted);
    }),
    history: Effect.fn("Channel.history")(function* (channel, before, limit) {
      const rows = yield* db.run(qm.messagesBefore({ channel_id: channel, number: before ?? 2147483647, n: Math.min(Math.max(limit ?? 50, 1), 200) }));
      return [...rows].toReversed().map(toMessage);
    }),
    markRead: Effect.fn("Channel.markRead")(function* (channel, seq) {
      if (!model.channel(channel)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]));
      yield* readThrough(ownerId, channel, seq);
      yield* publishChannel(channel);
    }, locked),
    threadOfSession,
    forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
    ownerInThread: Effect.map(
      core.subscribe,
      Stream.flatMap((e) =>
        e.type === "message" && e.thread && e.message.fromKind === "owner" && e.message.kind === "chat"
          ? Stream.make({ thread: e.thread, message: e.message })
          : Stream.empty,
      ),
    ),
    orchestratorDigest: Effect.fn("Channel.orchestratorDigest")(
      (agent) =>
        Effect.sync(() =>
          open
            .of(agent)
            .filter((r) => !(r.wakes && r.held_by === null))
            .map(asInbox),
        ),
      locked,
    ),
    channels: Effect.fn("Channel.channels")(() => Effect.sync(() => model.channels().map(infoOf))),
    openChannel: Effect.fn("Channel.openChannel")(function* (name, description, project) {
      const clean = name.trim().replace(/^#/u, "");
      const rows = model.channels();
      const problem = channelNameProblem(
        clean,
        rows.flatMap((r) => (r.name !== null ? [r.name] : [])),
      );
      if (problem) return yield* Effect.fail(refused(problem));
      const desc = optional(description);
      const proj = optional(project);
      const id = newId();
      const created_at = yield* Clock.currentTimeMillis;
      yield* db.run(qc.createChannel({ id, is_default: false, name: clean, description: desc, project: proj, created_at }));
      model.created({
        id,
        type: "channel",
        is_default: false,
        root_id: null,
        root_number: null,
        subject_kind: null,
        subject_id: null,
        last_number: null,
        reply_count: 0,
        created_at,
        name: clean,
        description: desc,
        project: proj,
        parent_id: null,
        peer_id: null,
        revision: 0,
        category: null,
        position: null,
        archived_at: null,
        notify: "all",
        orchestrator: null,
      });
      yield* publishChannel(id);
      return infoOf({ id, name: clean, description: desc, project: proj, is_default: false });
    }, locked),
    updateChannel: Effect.fn("Channel.updateChannel")(function* (id, upd) {
      const row = model.channel(id);
      if (!row || row.type === "direct") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
      const onlyName =
        upd.description === undefined && upd.project === undefined && upd.category === undefined && upd.before === undefined && upd.orchestrator === undefined;
      if (row.type === "thread" && !onlyName) return yield* Effect.fail(refused(t("server.channel.threadOnlyTitle")));
      let name = row.name;
      if (upd.name !== undefined) {
        const clean = upd.name.trim().replace(/^#/u, "");
        if (row.type === "thread") name = clean ? head(clean, threadTitleMax * 2) : null;
        else {
          const problem = channelNameProblem(
            clean,
            model.channels().flatMap((c) => (c.name !== null && c.id !== id ? [c.name] : [])),
          );
          if (problem) return yield* Effect.fail(refused(problem));
          name = clean;
        }
      }
      const desc = (upd.description !== undefined ? optional(upd.description) : null) ?? row.description;
      const proj = upd.project !== undefined ? optional(upd.project) : row.project;
      const category = upd.category !== undefined ? optional(upd.category) : row.category;
      // The default orchestrator is kept as none, so a channel follows whichever is the default.
      const wanted = upd.orchestrator?.trim();
      if (wanted && !agents.isOrchestrator(wanted)) return yield* Effect.fail(refused(t("server.channel.notOrchestrator", { id: wanted })));
      const orchestrator = wanted === undefined ? row.orchestrator : wanted && wanted !== defaultOrchestrator ? wanted : null;
      // Placed before another channel: every channel but the default gets its place again, in order.
      const order =
        upd.before === undefined
          ? undefined
          : (() => {
              const rest = model
                .channels()
                .filter((c) => !c.is_default && c.id !== id)
                .map((c) => c.id);
              const at = rest.indexOf(upd.before);
              rest.splice(at < 0 ? rest.length : at, 0, id);
              return rest;
            })();
      yield* tx(
        Effect.gen(function* () {
          if (row.type === "channel") yield* db.run(qc.updateChannel({ description: desc, project: proj, id }));
          if (name !== row.name) yield* db.run(qc.renameChannel({ name, id }));
          if (category !== row.category) yield* db.run(qc.setCategory({ category, id }));
          if (orchestrator !== row.orchestrator) yield* db.run(qc.setOrchestrator({ orchestrator, id }));
          for (const [position, each] of (order ?? []).entries()) yield* db.run(qc.placeChannel({ position, id: each }));
        }),
      );
      if (row.type === "channel") model.channelUpdated(id, desc, proj);
      model.patched(id, { name, category, orchestrator });
      for (const [position, each] of (order ?? []).entries()) model.patched(each, { position });
      for (const each of order ?? [id]) yield* publishChannel(each);
      // Its threads are looked after by the same orchestrator: they show the new one too.
      if (orchestrator !== row.orchestrator) for (const item of model.threadsOf(id)) yield* publishChannel(item.id);
    }, locked),
    archive: Effect.fn("Channel.archive")(function* (id, on) {
      const row = model.channel(id);
      if (!row || row.type === "direct") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
      if ((row.archived_at !== null) === on) return;
      if (row.is_default) return yield* Effect.fail(refused(t("server.channel.defaultStays")));
      const archived_at = on ? yield* Clock.currentTimeMillis : null;
      yield* db.run(qc.setArchived({ archived_at, id }));
      model.patched(id, { archived_at });
      yield* publishChannel(id);
    }, locked),
    previewRemoveChannel: Effect.fn("Channel.previewRemoveChannel")(function* (id) {
      const r = yield* removable(id);
      return { does: [t("server.channel.deletesChannel", { target: r.target, threads: r.threads, said: r.said })] };
    }),
    removeChannel: Effect.fn("Channel.removeChannel")(function* (id) {
      yield* removable(id);
      const gone = model.channel(id);
      yield* tx(
        Effect.gen(function* () {
          yield* db.run(qm.deleteMessagesIn({ id }));
          yield* db.run(qf.deleteFollowsIn({ id }));
          yield* db.run(qr.deleteCursorsIn({ id }));
          yield* db.run(qc.deleteThreadsOf({ id }));
          yield* db.run(qc.deleteChannel({ id }));
        }),
      );
      yield* reload;
      if (gone) for (const [who, target] of lastRead) if (target === targetOfChannel(gone)) lastRead.delete(who);
      yield* core.apply({ type: "channelGone", id });
    }, locked),
    setNotify: Effect.fn("Channel.setNotify")(function* (id, notify) {
      if (!model.channel(id)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
      yield* db.run(qc.setNotify({ notify, id }));
      model.patched(id, { notify });
      yield* publishChannel(id);
      yield* publishOwnerMentions;
    }, locked),
    openDirect: Effect.fn("Channel.openDirect")(function* (agent) {
      // An orchestrator is its own participant everywhere; a helper profile is one only here, apart from its sessions.
      const mine = agents.isOrchestrator(agent.id);
      const peer = mine ? agent.id : profileId(agent.id);
      if (mine) yield* seat(agent.id);
      else {
        const joined: qp.UpsertParticipantParams = {
          id: peer,
          kind: "profile",
          name: agent.name,
          agent_id: agent.id,
          runtime: null,
          joined_at: yield* Clock.currentTimeMillis,
        };
        yield* db.run(qp.upsertParticipant(joined));
        model.joined(joined);
      }
      const had = model.channels("direct").find((c) => c.peer_id === peer);
      if (had) return had.id;
      const id = newId();
      yield* db.run(qc.createDirect({ id, peer_id: peer, created_at: yield* Clock.currentTimeMillis }));
      yield* reload;
      yield* publishChannel(id);
      return id;
    }, locked),
    orchestratorDirect: (agent) => model.channels("direct").find((c) => c.peer_id === agent)?.id ?? "",
    orchestratorOf: (channel) => orchestratorOfRow(model.channel(channel)),
    linkTalk: Effect.fn("Channel.linkTalk")(function* (channel, issue) {
      yield* db.run(qc.setSubject({ subject_id: issue, id: channel }));
      yield* reload;
      yield* publishChannel(channel);
    }, locked),
    recent: Effect.fn("Channel.recent")(function* (channel, n) {
      const row = model.channel(channel);
      if (!row) return [];
      const target = targetOfChannel(row);
      return [...(yield* db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n })))].toReversed().map((m) => inboxOf(m, target));
    }),
    notifyOf: (id) => {
      const c = model.channel(id);
      const top = c?.parent_id ? model.channel(c.parent_id) : undefined;
      if (c?.notify === "none" || top?.notify === "none") return "none";
      return notifyOf(c?.notify !== "all" ? (c?.notify ?? "all") : (top?.notify ?? "all"));
    },
    markUnread: Effect.fn("Channel.markUnread")(function* (channel, number) {
      if (!model.channel(channel)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]));
      const upto = Math.max(0, number - 1);
      yield* db.run(qr.markUnread({ channel_id: channel, read_number: upto, updated_at: yield* Clock.currentTimeMillis }));
      model.ownerReadBack(channel, upto);
      yield* publishChannel(channel);
      yield* publishOwnerMentions;
    }, locked),
    makeDefault: Effect.fn("Channel.makeDefault")(function* (id) {
      const row = model.channel(id);
      if (!row) return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
      if (row.type !== "channel") return yield* Effect.fail(refused(t("server.channel.defaultIsChannel")));
      if (id === defaultId) return;
      const was = defaultId;
      yield* tx(Effect.andThen(db.run(qc.clearDefault()), db.run(qc.makeDefault({ id }))));
      model.defaultMoved(was, id);
      defaultId = id;
      yield* publishChannel(was);
      yield* publishChannel(id);
    }, locked),
    topOf: Effect.fn("Channel.topOf")((channel) =>
      Effect.sync(() => {
        const row = model.channel(channel);
        const top = model.channel(row && row.type !== "direct" ? channelIdOf(row) : defaultId);
        return infoOf(top ?? model.channel(defaultId)!);
      }),
    ),
    addressOf: Effect.fn("Channel.addressOf")((channel) =>
      Effect.sync(() => {
        const row = model.channel(channel);
        if (row?.type === "direct") return { direct: true, target: targetOfChannel(row) };
        const top = model.channel(row ? channelIdOf(row) : defaultId) ?? model.channel(defaultId)!;
        return { direct: false, target: targetOfChannel(top) };
      }),
    ),
    channelByName: Effect.fn("Channel.channelByName")((name) =>
      Effect.sync(() => {
        const found = model.channelByName(name.trim().replace(/^#/u, ""));
        return found ? infoOf(found) : undefined;
      }),
    ),
    useHelpers: (h) => void (helpers = h),
    helpersBack,
    activity: Effect.fnUntraced(function* (a) {
      yield* locked(onActivity(a)).pipe(bestEffort(`chat: ${a.id} ${a.kind}`));
    }),
    consumed: Effect.fnUntraced(function* (c) {
      yield* locked(consumed(c)).pipe(bestEffort(`chat: input consumed by ${c.session}`));
    }),
    sessionNews: onSessionNews,
  });
  return shape;
});
