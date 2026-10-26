// The chat: the general channel 田头, the channels, and a thread under any message; every
// session's work is talked about in its issue's thread. Every message is written to the database first, in one
// transaction with who it goes to; only then does it become a fact. A delivery goes pending → announced → handed → seen;
// a session that closes or a turn that ends without a word puts what it was handed back to pending: given twice rather
// than lost. Everything that changes the chat runs one at a time.

import {
  type Chat,
  type ChatMessage,
  type Conversation,
  type ConversationKind,
  everyone,
  type FactLeft,
  type FactReport,
  generalName,
  orchestratorAgent,
  type MessageKind,
  type Outcome,
  type RunTrigger,
  type SenderKind,
  type Session,
  type Spent,
  type SubjectKind,
  type SessionId,
} from "@vibevalley/protocol";
import { sessionId, type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";
import { isBusy } from "@vibevalley/protocol/rules";
import { keepConversations, keepMessages, targetOf } from "./state.ts";
import { head } from "../base/text.ts";
import {
  agentWakeCooldownMs,
  busyNotice,
  channelNameProblem,
  chatAudience,
  type Delivery,
  heldShown,
  hopLimit,
  hopLimitText,
  type InboxMessage,
  mentionOf,
  mentionsIn,
  parseChatTarget,
  retryWindowMs,
  summaryConversations,
  type UnreadRow,
  wakeInput,
} from "./rules.ts";
import { Clock, Context, Effect, FiberMap, FiberSet, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect";
import { Settings } from "../base/config.ts";
import { Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { jsonOrNone } from "../base/json.ts";
import { Core } from "../core/core.ts";
import { WakeBreaker } from "./breaker.ts";
import { type ApiError, refused, lookIn, missing } from "../errors.ts";
import * as qc from "../../db/generated/channel_conversation.sql.ts";
import * as qd from "../../db/generated/channel_delivery.sql.ts";
import * as qf from "../../db/generated/channel_follow.sql.ts";
import * as qmn from "../../db/generated/channel_mention.sql.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import * as qp from "../../db/generated/channel_participant.sql.ts";
import * as qr from "../../db/generated/channel_read_cursor.sql.ts";
import * as qs from "../../db/generated/channel_seen_mark.sql.ts";

const reportMax = 1500;
const readLimit = 30;
/** The client's key for one send, so a retry of it is the same message. */
const sendKeyMax = 64;
/** Sorts after every uuidv7, for "since the last thing said". */
const afterAll = "\uffff";

export interface Info {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly project: string;
}

export interface Spoken {
  readonly kind: "sent" | "held" | "confirm";
  readonly message?: ChatMessage;
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

/** What came to the orchestrator in one conversation, to wake it with. */
export interface OrchestratorNews {
  readonly conversation: string;
  readonly target: string;
  readonly messages: InboxMessage[];
}

interface Meta {
  run?: string;
  mentions?: string[];
  session?: SessionId;
  outcome?: Outcome;
  spent?: Spent;
  forTask?: boolean;
  code?: string;
  /** Said on a call: the orchestrator heard it there, so it wakes no one here. */
  spoken?: boolean;
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
type ConvRow = qc.ConversationByIDResult;
type DeliveryRow = qd.OpenDeliveriesResult;

const senderKind = (kind: string): SenderKind => (kind === "user" || kind === "orchestrator" || kind === "agent" ? kind : "system");
const messageKind = (kind: string): MessageKind => (kind === "dispatch" || kind === "report" || kind === "notice" ? kind : "chat");
const conversationKind = (kind: string): ConversationKind => (kind === "thread" || kind === "channel" ? kind : "general");
const subjectKind = (kind: string | null): SubjectKind | undefined => (kind === "issue" || kind === "graph" || kind === "talk" ? kind : undefined);

function toMessage(row: MsgRow): ChatMessage {
  const meta = metaOf(row.meta);
  return {
    id: row.id,
    number: row.number,
    conversation: row.conversation_id,
    from: row.sender_id,
    fromKind: senderKind(row.sender_kind),
    name: row.sender_name,
    ...(row.sender_agent ? { agent: row.sender_agent } : {}),
    kind: messageKind(row.kind),
    text: row.body,
    final: row.final,
    ...(meta.mentions && meta.mentions.length > 0 ? { mentions: meta.mentions } : {}),
    ...(meta.session ? { session: meta.session } : {}),
    ...(meta.run ? { run: meta.run } : {}),
    ...(meta.outcome ? { outcome: meta.outcome } : {}),
    ...(meta.spent ? { spent: meta.spent } : {}),
    ...(meta.spoken ? { spoken: true } : {}),
    at: row.created_at,
  };
}

const inboxOf = (row: MsgRow, target: string): InboxMessage => ({
  id: row.id,
  number: row.number,
  target,
  from: row.sender_id,
  fromKind: senderKind(row.sender_kind),
  name: row.sender_name,
  text: row.body,
});

const infoOf = (row: Pick<ConvRow, "id" | "name" | "description" | "project">): Info => ({
  id: row.id,
  name: row.name ?? generalName,
  description: row.description ?? "",
  project: row.project ?? "",
});

const optional = (s: string | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

interface ThreadSubject {
  readonly kind: SubjectKind;
  readonly id: string;
  readonly owner: string;
}

/** What a session's work is talked about under: the issue it works, so every session on one issue shares a thread; a session sent for no issue has a talk thread of its own. */
const jobOf = (h: Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

interface Write {
  readonly id?: string;
  readonly conversation: string;
  readonly from: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly final: boolean;
  readonly meta?: Meta;
  readonly answers?: SessionId;
  readonly thread?: ThreadSubject;
  /** A participant who follows the conversation from this message on, in the same transaction. */
  readonly follow?: string;
  /** The client's key for one send: the same key from the same sender again is that message, not a new one. */
  readonly sendKey?: string;
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
  ownerMentionsChanged?: boolean;
}

export interface ChannelShape {
  readonly general: () => string;
  /** The owner's words; again: sendKey was sent before, and the message is that one. */
  readonly say: (text: string, conversation: string | undefined, sendKey: string) => Effect.Effect<{ message: ChatMessage; again: boolean }, ApiError>;
  /** Words to a session in its thread; with no thread the session hears them straight. */
  readonly tellSession: (from: string, session: string, text: string, sendKey: string) => Effect.Effect<ChatMessage | undefined, ApiError>;
  /** A session's or the orchestrator's words, through channel_say. */
  readonly speak: (from: string, text: string, opt?: SpeakOptions) => Effect.Effect<Spoken, ApiError>;
  /** Words said on a call, kept in 田头 as they were said; they wake no one. */
  readonly spoken: (from: string, text: string, sendKey: string) => Effect.Effect<boolean, ApiError>;
  /** The orchestrator's words as they stream: the same key again replaces them until final; delivered once final. */
  readonly orchestratorSays: (conversation: string, key: string, text: string, final: boolean, run: string) => Effect.Effect<void>;
  /** code names the kind, for dropping repeats. */
  readonly notice: (conversation: string, text: string, code: string) => Effect.Effect<void>;
  readonly read: (who: string, opt?: ReadOptions) => Effect.Effect<ReadResult, ApiError>;
  readonly inbox: (who: string) => Effect.Effect<UnreadRow[]>;
  readonly history: (conversation: string, before?: number, limit?: number) => Effect.Effect<ChatMessage[]>;
  /** A message's durable location; the recent state may hold neither the message nor its thread. */
  readonly messageLocation: (id: string) => Effect.Effect<{ readonly conversation: Conversation; readonly channel: string } | undefined>;
  readonly markRead: (conversation: string, seq: number) => Effect.Effect<void, ApiError>;
  /** The thread of the issue the session works (a talk thread of its own when it works none). */
  readonly jobThread: (session: string) => Effect.Effect<string | undefined>;
  /** The conversations and messages the core state holds now. */
  readonly now: () => Chat | undefined;
  /** Subscribed before it returns. */
  readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorNews>, never, Scope.Scope>;
  /** The owner's words said in full in a thread, whatever path they took in: what an issue hears its owner by.
   * Subscribed before it returns. */
  readonly ownerInThread: Effect.Effect<Stream.Stream<{ readonly thread: string; readonly message: ChatMessage }>, never, Scope.Scope>;
  /** What came to the orchestrator and does not wake it. */
  readonly orchestratorDigest: () => Effect.Effect<InboxMessage[]>;
  readonly channels: () => Effect.Effect<Info[]>;
  readonly openChannel: (name: string, description: string, project: string) => Effect.Effect<Info, ApiError>;
  /** description undefined or empty: as it was; project undefined: as it was, empty: none. */
  readonly updateChannel: (id: string, description: string | undefined, project: string | undefined) => Effect.Effect<void, ApiError>;
  readonly channelOf: (conversation: string) => Effect.Effect<Info>;
  readonly channelByName: (name: string) => Effect.Effect<Info | undefined>;
  /** Agent Sessions registers the helpers; until then a message for one waits. */
  readonly useHelpers: (helpers: Helpers) => void;
  /** Once the helpers on the farm are back: what waited for each goes to it now. */
  readonly helpersBack: Effect.Effect<void>;
  /** What a helper's launch did. */
  readonly activity: (a: LaunchActivity) => Effect.Effect<void>;
  /** Messages a helper took as input. */
  readonly consumed: (c: InputConsumed) => Effect.Effect<void>;
  /** A helper hired, reported or gone: a job opens, the report is posted in its thread, a job closes. */
  readonly sessionNews: (n: SessionNews) => Effect.Effect<void>;
}

export class Channels extends Context.Service<Channels, ChannelShape>()("vibevalley/Channel") {}

// ── the helpers: the participants that work (Agent Sessions registers them) ──

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
  | { readonly kind: "ended"; readonly id: string; readonly launch: string; readonly outcome: Outcome; readonly spoke: boolean }
  | { readonly kind: "closed"; readonly id: string; readonly launch: string }
  | { readonly kind: "compacting"; readonly id: string; readonly on: boolean };

/** The messages a helper took as input: they are seen. */
/** What happened to a helper, as the sessions tell it: the fact, and the session as it stood after it (none once it
 * left). */
export type SessionNews =
  | { readonly _tag: "hired"; readonly session: Session }
  | { readonly _tag: "reported"; readonly report: FactReport; readonly session: Session | undefined }
  | { readonly _tag: "left"; readonly left: FactLeft };

export interface InputConsumed {
  readonly session: string;
  readonly messages: string[];
}

/** The participants that work: the channels hand them what is said to them and hear what they did. The channels know a
 * helper by its id and nothing of how it works. */
export interface Helpers {
  /** On the farm now: it can be handed a message. */
  readonly present: (id: string) => boolean;
  readonly deliver: (id: string, text: string, by: RunTrigger) => Effect.Effect<Delivered>;
  /** The run a participant is in now (a helper's, the orchestrator's), for what it says; undefined between runs. */
  readonly currentRun: (id: string) => string | undefined;
  /** A helper's report, from what it last said in full. */
  readonly report: (id: string) => string;
  /** The helper working the issue now, if one is. */
  readonly onIssue: (issue: string) => string | undefined;
  /** A helper on the farm now, and all of them. */
  readonly sessionOf: (id: string) => Session | undefined;
  readonly presentSessions: () => readonly Session[];
}

export const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const config = yield* Settings;
  const core = yield* Core;
  let helpers: Helpers | undefined;
  const { run: db, one, inTx } = yield* Db;
  const lock = yield* Semaphore.make(1);
  const locked = <A, E>(e: Effect.Effect<A, E>) => lock.withPermits(1)(e);
  const orchestratorHub = yield* PubSub.unbounded<OrchestratorNews>();

  /** Nothing is slipped in while a session compacts its context. */
  const compacting = new Set<string>();
  const breaker = new WakeBreaker();
  const lastRead = new Map<string, string>();
  const streaming = new Map<string, string>();
  const names = new Map<string, string>();
  let closed = false;
  // Work set off by a timer belongs to this service: it ends with it and keeps its services.
  const forkHere = yield* FiberSet.makeRuntime<never>();

  /** Runs fn under the lock a little later, unless the chat has stopped. */
  /** What goes wrong in the background is logged, and the chat goes on with the next thing. */
  const logged =
    (what: string) =>
    <A, E>(e: Effect.Effect<A, E>) =>
      Effect.asVoid(e).pipe(Effect.catchCause((c) => Effect.logWarning(`chat: ${what}: ${String(c)}`)));
  // The waits are keyed fibers of this service's, so one can be called off (a notice gathering, when its session leaves);
  // once a wait is over, what it runs is handed to forkHere, and calling the wait off no longer cuts it short.
  const waits = yield* FiberMap.make<string>();
  const wait = yield* FiberMap.runtime(waits)<never>();
  const later = (key: string, ms: number, fn: () => Effect.Effect<void>) =>
    void wait(
      key,
      Effect.delay(
        Effect.sync(() => {
          if (!closed) void forkHere(locked(Effect.suspend(() => (closed ? Effect.void : fn()))).pipe(logged("later")));
        }),
        ms,
      ),
      { onlyIfMissing: true },
    );

  // ── the people and the channels ──

  for (const [id, kind, name] of [
    ["user", "user", "主人"],
    [orchestratorAgent, "orchestrator", "管家"],
    ["system", "system", "VibeValley"],
  ] as const)
    yield* db(qp.upsertParticipant({ id, kind, name, agent_id: null, runtime: null, joined_at: yield* Clock.currentTimeMillis }));
  let general = (yield* one(qc.generalID()))?.id ?? "";
  if (!general) {
    general = newId();
    yield* db(qc.createGeneral({ id: general, name: generalName, created_at: yield* Clock.currentTimeMillis }));
  }

  const loadChannels = Effect.gen(function* () {
    const rows = yield* db(qc.channels());
    for (const r of rows) if (r.name !== null) names.set(r.id, r.name);
    return rows;
  });
  yield* loadChannels;

  const channelTags = () => [...names.keys()].sort().map((id) => "#" + names.get(id));
  const channelOfSession = (h: Session) => (h.channel && names.has(h.channel) ? h.channel : general);
  const channelIdOf = (row: ConvRow) => (row.kind === "thread" ? (row.channel_id ?? general) : row.id);
  // Before the helpers are back there are none: a job opens for each once they are.
  const sessionOf = (id: string) => helpers?.sessionOf(id);
  const presentSessions = () => helpers?.presentSessions() ?? [];

  const targetOfRow = (kind: string, parentNumber: number | null, name: string | null, channelId: string | null, channelName: string | null) => {
    const conv = {
      kind: conversationKind(kind),
      ...(parentNumber !== null ? { parentNumber } : {}),
      ...((name ?? channelName) !== null ? { name: (name ?? channelName)! } : {}),
    } as Conversation;
    const channel = channelName ?? (channelId ? names.get(channelId) : undefined) ?? undefined;
    return targetOf(conv, channel || undefined);
  };
  const targetOfConv = (row: ConvRow) => targetOfRow(row.kind, row.parent_number, row.name, row.channel_id, null);

  const toConversation = Effect.fn("Channels.toConversation")(function* (row: ConvRow) {
    const read = yield* one(qr.readCursor({ participant_id: "user", conversation_id: row.id }));
    const sk = subjectKind(row.subject_kind);
    return {
      id: row.id,
      kind: conversationKind(row.kind),
      ...(row.parent_id !== null ? { parent: row.parent_id } : {}),
      ...(row.parent_number !== null ? { parentNumber: row.parent_number } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.project !== null ? { project: row.project } : {}),
      ...(row.channel_id !== null ? { channel: row.channel_id } : {}),
      ...(sk ? { subjectKind: sk } : {}),
      ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
      ...(row.last_number !== null ? { lastNumber: row.last_number } : {}),
      replies: row.reply_count,
      ...(read ? { read: read.read_number } : {}),
      at: row.created_at,
    };
  });

  const publishConversation = Effect.fn("Channels.publishConversation")(function* (id: string) {
    const row = yield* one(qc.conversationByID({ id }));
    if (row) yield* core.apply({ type: "conversation", conversation: yield* toConversation(row) });
  });

  const publishOwnerMentions = Effect.gen(function* () {
    const rows = yield* db(qm.ownerMentions());
    yield* core.apply({
      type: "ownerMentions",
      mentions: rows.map((r) => ({
        message: toMessage(r),
        channel: r.channel_id ?? general,
        address: targetOfRow(r.conversation_kind, r.parent_number, null, r.channel_id, r.channel_name),
      })),
    });
  });

  const publishMessage = Effect.fn("Channels.publishMessage")(function* (id: string, answers: SessionId | undefined) {
    const row = yield* one(qm.messageByID({ id }));
    if (!row) return;
    const conv = yield* one(qc.conversationByID({ id: row.conversation_id }));
    const thread = conv?.kind === "thread" && conv.subject_kind === "issue" && conv.subject_id ? conv.subject_id : undefined;
    yield* core.apply({ type: "message", message: toMessage(row), ...(thread ? { thread } : {}), ...(answers ? { answers } : {}) });
  });

  // ── threads ──

  const threadOf = (subject: ThreadSubject) => Effect.map(one(qc.threadOfSubject({ subject_kind: subject.kind, subject_id: subject.id })), (r) => r?.id);

  /** The one way from a session to its thread: through the issue it works, never by its own id, since the thread outlives it. */
  const threadOfSession = (session: string) => {
    const h = sessionOf(session);
    return h ? threadOf(jobOf(h)) : Effect.succeed(undefined);
  };

  /** Who a thread's words are for, worked out now rather than kept: the session on the issue, or a talk thread's own session. */
  const ownerOf = (conv: ConvRow): string => {
    if (conv.kind !== "thread" || !conv.subject_id) return "";
    if (conv.subject_kind === "issue") return helpers?.onIssue(conv.subject_id) ?? "";
    if (conv.subject_kind === "talk") return sessionOf(conv.subject_id) ? conv.subject_id : "";
    return "";
  };

  /** Inside the parent's transaction: a thread and its first follower appear together. */
  const threadFor = Effect.fn("Channels.threadFor")(function* (parent: { id: string; number: number; conversation: string }, subject: ThreadSubject) {
    const existing = yield* one(qc.threadByParent({ parent_id: parent.id }));
    if (existing) return existing.id;
    const id = newId();
    yield* db(
      qc.createThread({
        id,
        parent_id: parent.id,
        parent_number: parent.number,
        subject_kind: subject.kind,
        subject_id: subject.id || null,
        channel_id: parent.conversation,
        created_at: yield* Clock.currentTimeMillis,
      }),
    );
    if (subject.owner) yield* db(qf.follow({ conversation_id: id, participant_id: subject.owner, reason: "owner", from_number: parent.number }));
    return id;
  });

  // ── reading ──

  /** A read cursor subsumes individual seen marks and completes the same deliveries. */
  const readThrough = Effect.fnUntraced(
    function* (who: string, conversation: string, upto: number) {
      const now = yield* Clock.currentTimeMillis;
      yield* db(qr.setReadCursor({ participant_id: who, conversation_id: conversation, read_number: upto, updated_at: now }));
      yield* db(qs.pruneSeenMarks({ participant: who, conversation, upto }));
      yield* db(qd.seenUpTo({ at: now, recipient: who, upto, conversation }));
    },
    (effect, who) => inTx(effect).pipe(Effect.andThen(who === "user" ? publishOwnerMentions : Effect.void)),
  );

  /** Speaking acknowledges the launch's handed messages without advancing past unseen messages. */
  const heardLaunch = Effect.fnUntraced(
    function* (who: string, launch: string) {
      const seen = yield* db(qd.seenHanded({ seen_at: yield* Clock.currentTimeMillis, recipient_id: who, launch }));
      for (const r of seen) yield* db(qs.addSeenMark({ participant_id: who, message_id: r.message_id }));
    },
    (effect) => inTx(effect),
  );

  // ── writing ──

  const settle = Effect.fn("Channels.settle")(function* (id: string) {
    const row = (yield* one(qm.messageByID({ id })))!;
    const conv = (yield* one(qc.conversationByID({ id: row.conversation_id })))!;
    const meta = metaOf(row.meta);
    const mentions = mentionsIn(row.body);
    const sessionsNow = presentSessions();
    // Participants are sessions, agents and the owner alike: a mention is any of them.
    const present: readonly string[] = sessionsNow.map((h) => h.id);
    const known = new Set((yield* db(qp.participants())).map((p) => p.id));
    const named: { id: string; how: "delivered" | "absent" | "unknown" }[] = [];
    for (const m of mentions) {
      const how = m === orchestratorAgent || m === "user" || m === everyone || present.includes(m) ? "delivered" : known.has(m) ? "absent" : "unknown";
      named.push({ id: m, how });
      yield* db(qmn.insertMention({ message_id: row.id, target_id: m, resolved: how }));
    }
    if (mentions.length > 0) yield* db(qm.updateMessageMeta({ meta: metaText({ ...meta, mentions }), id: row.id }));
    let followers: string[] = [];
    if (conv.kind === "thread") {
      // A dispatch handing the issue to its next session makes no one a follower: the orchestrator would be woken by every word in it.
      if (row.sender_id !== "system" && row.kind !== "dispatch")
        yield* db(qf.follow({ conversation_id: conv.id, participant_id: row.sender_id, reason: "replied", from_number: row.number }));
      for (const m of named)
        if (m.how === "delivered" && (m.id === orchestratorAgent || present.includes(m.id)))
          yield* db(qf.follow({ conversation_id: conv.id, participant_id: m.id, reason: "mentioned", from_number: row.number - 1 }));
      followers = (yield* db(qf.followers({ conversation_id: conv.id }))).map((f) => f.participant_id);
    }
    const hops = (yield* db(qd.agentWakesSinceUser({ conversation: conv.id }))).n ?? 0;
    const now = yield* Clock.currentTimeMillis;
    const cooling: string[] = [];
    for (const h of sessionsNow) {
      const last = (yield* db(qd.lastAgentWake({ recipient_id: h.id }))).at ?? 0;
      if (now - last < agentWakeCooldownMs) cooling.push(h.id);
    }
    const audience = sessionsNow.filter((h) => conv.kind === "thread" || channelOfSession(h) === conv.id).map((h) => h.id);
    const deliveries = chatAudience({
      from: row.sender_id,
      fromKind: senderKind(row.sender_kind),
      kind: messageKind(row.kind),
      mentions,
      conversation: { kind: conversationKind(conv.kind) },
      threadOwner: ownerOf(conv),
      sessions: audience,
      present,
      followers,
      hops,
      cooling,
      broken: breaker.tripped(),
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
      forTask: !!meta.forTask,
      spoken: !!meta.spoken,
    });
    for (const d of deliveries)
      yield* db(
        qd.insertDelivery({ recipient_id: d.recipient, message_id: row.id, reason: d.reason, wakes: d.wakes, held_by: d.heldBy ?? null, created_at: now }),
      );
    const written: Written = { id: row.id, number: row.number, recipients: [], resetWake: [], absent: [], held: false, thread: "", again: false };
    written.ownerMentionsChanged = row.sender_id === "user" || mentions.includes("user");
    // The breaker is reset only after the message's transaction commits.
    if (row.sender_id === "user") written.resetWake = deliveries.filter((d) => d.wakes).map((d) => d.recipient);
    if (deliveries.some((d: Delivery) => d.heldBy === "hop_limit")) written.held = (yield* db(qm.holdNoticeSinceUser({ conversation: conv.id }))).n === 0;
    for (const d of deliveries) if (!d.heldBy && !written.recipients.includes(d.recipient)) written.recipients.push(d.recipient);
    written.absent = named.filter((m) => m.how !== "delivered").map((m) => m.id);
    return written;
  });

  const write = Effect.fnUntraced(function* (w: Write): Effect.fn.Return<Written> {
    const written = yield* inTx(
      Effect.gen(function* () {
        if (!w.id && w.sendKey) {
          const seen = yield* one(qm.messageBySendKey({ sender_id: w.from, send_key: w.sendKey }));
          if (seen) return { id: seen.id, number: seen.number, recipients: [], resetWake: [], absent: [], held: false, thread: "", again: true };
        }
        let id = w.id ?? "";
        let number: number;
        if (!id) {
          id = newId();
          number = (yield* db(
            qm.insertMessage({
              id,
              conversation: w.conversation,
              sender: w.from,
              kind: w.kind,
              body: w.text,
              final: w.final,
              meta: metaText(w.meta),
              send_key: w.sendKey || null,
              created_at: yield* Clock.currentTimeMillis,
            }),
          )).number;
          yield* db(qc.touchConversation({ number, id: w.conversation }));
        } else {
          yield* db(qm.updateMessageBody({ body: w.text, final: w.final, updated_at: yield* Clock.currentTimeMillis, id }));
          const row = yield* one(qm.messageByID({ id }));
          if (!row) return yield* Effect.die(new Error(`没有 ${id} 这条消息`));
          number = row.number;
        }
        const out: Written = w.final ? yield* settle(id) : { id, number, recipients: [], resetWake: [], absent: [], held: false, thread: "", again: false };
        out.id = id;
        out.number = number;
        if (w.follow) yield* db(qf.follow({ conversation_id: w.conversation, participant_id: w.follow, reason: "owner", from_number: number }));
        if (w.thread) out.thread = yield* threadFor({ id, number, conversation: w.conversation }, w.thread);
        return out;
      }),
    );
    if (!written.again) yield* after(w.conversation, written, w.answers);
    return written;
  });

  const after = Effect.fnUntraced(function* (conversation: string, written: Written, answers: SessionId | undefined): Effect.fn.Return<void> {
    for (const r of written.resetWake) breaker.reset(r);
    yield* publishMessage(written.id, answers);
    yield* publishConversation(conversation);
    if (written.ownerMentionsChanged) yield* publishOwnerMentions;
    if (written.thread) yield* publishConversation(written.thread);
    if (written.held) yield* write({ conversation, from: "system", kind: "notice", text: hopLimitText(hopLimit), final: true, meta: { code: "hop_limit" } });
    for (const r of written.recipients) yield* kick(r);
  });

  // ── delivering ──

  const deliveryTarget = (r: DeliveryRow) => targetOfRow(r.conversation_kind, r.parent_number, null, null, r.channel_name || null);
  const asInbox = (r: DeliveryRow): InboxMessage => ({
    id: r.message_id,
    number: r.number,
    target: deliveryTarget(r),
    from: r.sender_id,
    fromKind: senderKind(r.sender_kind),
    name: r.name,
    text: r.body,
  });

  const groupRows = (rows: readonly DeliveryRow[]) => {
    const out: { target: string; unread: number; mentionsYou: boolean; latest?: string }[] = [];
    for (const r of rows) {
      const target = deliveryTarget(r);
      let row = out.find((u) => u.target === target);
      if (!row) {
        row = { target, unread: 0, mentionsYou: false };
        out.push(row);
      }
      row.unread++;
      row.mentionsYou ||= r.reason === "mention" || r.reason === "everyone";
      row.latest = r.name;
    }
    return out as UnreadRow[];
  };

  const inboxRows = Effect.fn("Channels.inboxRows")(function* (who: string) {
    const h = sessionOf(who);
    const channel = h ? channelOfSession(h) : general;
    const rows = yield* db(qc.inboxOf({ participant: who, channel }));
    const out: UnreadRow[] = [];
    for (const r of rows.slice(0, summaryConversations)) {
      const latest = yield* one(qm.messageByNumber({ conversation_id: r.id, number: r.latest ?? 0 }));
      out.push({
        target: targetOfRow(r.kind, r.parent_number, null, null, r.channel_name || null),
        unread: r.unread ?? 0,
        mentionsYou: !!r.mentions_you,
        ...(latest ? { latest: latest.sender_name } : {}),
      });
    }
    return out;
  });

  const deliver = (recipient: string, text: string, message: string): Effect.Effect<Delivered> =>
    helpers ? helpers.deliver(recipient, text, { kind: "comment", message }) : Effect.succeed({ kind: "refused", reason: "帮工还没接回来" });

  const kick = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    const rows = yield* db(qd.openDeliveries({ recipient_id: recipient }));
    const waking = rows.filter((r) => r.wakes && r.held_by === null && (r.state === "pending" || r.state === "announced"));
    if (recipient === orchestratorAgent) {
      const byConversation = Map.groupBy(waking, (r) => r.conversation_id);
      const now = yield* Clock.currentTimeMillis;
      for (const [conversation, rs] of byConversation) {
        const messages = rs.map(asInbox);
        PubSub.publishUnsafe(orchestratorHub, { conversation, target: messages[0]!.target, messages });
        for (const r of rs) yield* db(qd.seenOne({ seen_at: now, recipient_id: orchestratorAgent, message_id: r.message_id }));
      }
      return;
    }
    const session = sessionOf(recipient);
    if (!session) return yield* db(qd.dropOpen({ dropped_why: "left", recipient_id: recipient }));
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
    for (const r of waking) yield* db(qd.markHanded({ launch: delivered.launch ?? "", handed_at: now, recipient_id: recipient, message_id: r.message_id }));
  });

  const notify = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    if (compacting.has(recipient)) return;
    const session = sessionOf(recipient);
    if (!session) return;
    if (!isBusy(session)) return yield* kick(recipient);
    const rows = (yield* db(qd.openDeliveries({ recipient_id: recipient }))).filter((r) => r.state === "pending" && r.held_by === null);
    if (rows.length === 0) return;
    const delivered = yield* deliver(recipient, busyNotice(groupRows(rows)), rows[0]!.message_id);
    if (delivered.kind === "refused") return;
    const now = yield* Clock.currentTimeMillis;
    for (const r of rows) yield* db(qd.markAnnounced({ launch: delivered.launch ?? "", announced_at: now, recipient_id: recipient, message_id: r.message_id }));
  });

  const onActivity = Effect.fnUntraced(function* (a: LaunchActivity): Effect.fn.Return<void> {
    if (closed) return;
    switch (a.kind) {
      case "spoke":
        breaker.spoke(a.id);
        return yield* heardLaunch(a.id, a.launch);
      case "ended": {
        if (!a.spoke) {
          const rolled = yield* db(qd.rollbackHanded({ recipient_id: a.id }));
          if (rolled.length > 0) {
            const { count: failed, tripped } = breaker.failed(a.id);
            if (tripped) {
              const where = (yield* threadOfSession(a.id)) ?? general;
              const name = sessionOf(a.id)?.name ?? a.id;
              yield* write({
                conversation: where,
                from: "system",
                kind: "notice",
                text: `${name} 连续 ${failed} 次一叫醒就失败了，先不再叫它；你直接给它带句话会再试。`,
                final: true,
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
        yield* db(qd.rollbackHanded({ recipient_id: a.id }));
        return yield* db(qd.rollbackAnnounced({ recipient_id: a.id, launch: a.launch }));
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
    Effect.forEach(input.messages, (id) => db(qd.seenOne({ seen_at: clock.currentTimeMillisUnsafe(), recipient_id: input.session, message_id: id })), {
      discard: true,
    });

  // ── sessions coming and going ──

  const openJob = Effect.fn("Channels.openJob")(function* (h: Session) {
    yield* db(
      qp.upsertParticipant({ id: h.id, kind: "agent", name: h.name, agent_id: h.agent, runtime: h.runtime, joined_at: yield* Clock.currentTimeMillis }),
    );
    const job = jobOf(h);
    const thread = yield* threadOf(job);
    if (thread) return yield* handedOn(h, thread);
    const channel = channelOfSession(h);
    const latest = (yield* db(qm.latestNumber({ conversation_id: channel }))).n ?? 0;
    yield* db(qr.setReadCursor({ participant_id: h.id, conversation_id: channel, read_number: latest, updated_at: yield* Clock.currentTimeMillis }));
    const what = h.graph?.task
      ? `做计划 ${h.graph.id} 的「${h.graph.task}」`
      : h.graph
        ? "拆计划 " + h.graph.id
        : h.refining
          ? "看代码，起草这张工单"
          : head(h.brief.replace(/\s+/g, " "), 80);
    yield* write({
      conversation: channel,
      from: orchestratorAgent,
      kind: "dispatch",
      text: `派 @${h.id}（${h.name}）去 ${h.project ?? "项目"}：${what}`,
      final: true,
      meta: { session: h.id },
      thread: job,
    });
  });

  /**
   * The issue already has its thread (reopened, or sent to another session): the next session is told of in it and follows
   * it, in one transaction, so a restart neither says it twice nor leaves it out.
   */
  const handedOn = Effect.fn("Channels.handedOn")(function* (h: Session, thread: string) {
    const followers = (yield* db(qf.followers({ conversation_id: thread }))).map((f) => f.participant_id);
    if (followers.includes(h.id)) return;
    const channel = channelOfSession(h);
    const latest = (yield* db(qm.latestNumber({ conversation_id: channel }))).n ?? 0;
    yield* db(qr.setReadCursor({ participant_id: h.id, conversation_id: channel, read_number: latest, updated_at: yield* Clock.currentTimeMillis }));
    // Each dispatch of the issue is in its thread but the first, which the thread hangs under: this is the one after.
    const nth = ((yield* db(qm.dispatchesIn({ conversation_id: thread }))).n ?? 0) + 2;
    const text = h.refining ? `这张工单交给 @${h.id}（${h.name}）再起草一版` : `这张工单交给 @${h.id}（${h.name}）接着做，第 ${nth} 次派活`;
    yield* write({ conversation: thread, from: orchestratorAgent, kind: "dispatch", text, final: true, meta: { session: h.id }, follow: h.id });
  });

  const sessionsLeft = Effect.gen(function* () {
    const on = new Set<string>(presentSessions().map((h) => h.id));
    const now = yield* Clock.currentTimeMillis;
    for (const p of yield* db(qp.participants())) {
      if (p.kind !== "agent" || p.left_at !== null || on.has(p.id)) continue;
      yield* db(qp.participantLeft({ left_at: now, id: p.id }));
      yield* db(qd.dropOpen({ dropped_why: "left", recipient_id: p.id }));
      yield* FiberMap.remove(waits, `notice:${p.id}`);
      breaker.reset(p.id);
    }
  });

  const postReport = Effect.fn("Channels.postReport")(function* (
    id: string,
    outcome: Outcome,
    summary: string,
    spent: Spent | undefined,
    run: string | undefined,
  ) {
    const w = sessionOf(id);
    if (!w || outcome === "interrupted") return;
    const thread = yield* threadOfSession(id);
    if (!thread) return;
    const said = outcome === "completed" ? (helpers?.report(id) ?? "") : "";
    const meta: Meta = { outcome, ...(spent ? { spent } : {}), forTask: !!w.graph, ...(run ? { run } : {}) };
    yield* write({ conversation: thread, from: id, kind: "report", text: head(said || summary, reportMax), final: true, meta });
  });

  // ── coming back ──

  yield* locked(
    Effect.gen(function* () {
      // A word half said when the server stopped is as said as it got; whatever was handed and not seen goes back.
      yield* db(qm.finalizeAll({ updated_at: yield* Clock.currentTimeMillis }));
      yield* db(qd.rollbackAll());
      const convs = yield* db(qc.recentConversations({ n: keepConversations }));
      for (const c of [...convs].reverse()) yield* core.apply({ type: "conversation", conversation: yield* toConversation(c) });
      const msgs = yield* db(qm.recentMessages({ n: keepMessages }));
      for (const m of [...msgs].reverse()) yield* core.apply({ type: "message", message: toMessage(m) });
      yield* publishOwnerMentions;
    }),
  );

  // The sessions' news: hired and left open and close jobs, a report is posted in the thread. One at a time, before the
  // next.
  const onSessionNews = (n: SessionNews) =>
    locked(
      Effect.suspend(() => {
        if (closed) return Effect.void;
        switch (n._tag) {
          case "hired":
            return Effect.forEach(presentSessions(), (h) => openJob(h).pipe(Effect.catchCause((c) => Effect.logWarning(`chat: ${h.id}'s job: ${String(c)}`))), {
              discard: true,
            });
          case "left":
            return sessionsLeft;
          case "reported":
            return postReport(n.report.id, n.report.outcome, n.report.summary, n.report.spent, n.report.run);
        }
      }),
    ).pipe(logged(`after ${n._tag}`));
  // Once the helpers are back: each on the farm has its job, and whatever was waiting for one goes to it.
  const helpersBack = locked(
    Effect.gen(function* () {
      for (const h of presentSessions()) yield* openJob(h).pipe(Effect.catchCause((c) => Effect.logWarning(`chat: ${h.id}'s job: ${String(c)}`)));
      for (const p of yield* db(qp.participants())) if (p.kind === "agent" && p.left_at === null) yield* kick(p.id);
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  /** A target as who would mean it: empty is a session's own thread (or 田头), a channel by name, or a thread by its parent's number. */
  const resolveTarget = Effect.fnUntraced(function* (who: string, target: string): Effect.fn.Return<string, ApiError> {
    if (!target.trim()) {
      if (who !== orchestratorAgent && who !== "user") {
        const own = yield* threadOfSession(who);
        if (own) return own;
      }
      return general;
    }
    const parsed = parseChatTarget(target);
    if (!parsed) return yield* Effect.fail(refused(`不认识这个地方：${target}（写 #<频道>，比如 #田头；或 #<频道>:<消息号>）`));
    let channel = general;
    const name = parsed.kind === "channel" ? parsed.name : target.trim().replace(/^#/, "").split(":")[0]!;
    if (name) {
      const found = yield* one(qc.channelByName({ name }));
      if (!found) return yield* Effect.fail(missing(`没有叫 #${name} 的频道。有：${channelTags().join("、")}`, [lookIn.channel]));
      channel = found.id;
    }
    if (parsed.kind === "channel") return channel;
    const parent = yield* one(qm.messageByNumber({ conversation_id: channel, number: parsed.parent }));
    if (!parent) return yield* Effect.fail(refused(`频道里没有 ${parsed.parent} 这条消息`));
    const thread = yield* inTx(threadFor({ id: parent.id, number: parent.number, conversation: parent.conversation_id }, { kind: "talk", id: "", owner: "" }));
    yield* publishConversation(thread);
    return thread;
  });

  const messageOrFail = (id: string) =>
    Effect.flatMap(one(qm.messageByID({ id })), (row) => (row ? Effect.succeed(row) : Effect.fail(refused("写进去了，但读不回来"))));

  const shape: ChannelShape = {
    now: () => core.state().chat,
    general: () => general,
    messageLocation: Effect.fn("Channels.messageLocation")(function* (id) {
      const message = yield* one(qm.messageByID({ id }));
      if (!message) return undefined;
      const row = yield* one(qc.conversationByID({ id: message.conversation_id }));
      return row ? { conversation: yield* toConversation(row), channel: channelIdOf(row) } : undefined;
    }),
    say: (text, conversation, sendKey) =>
      locked(
        Effect.gen(function* () {
          if (!text.trim()) return yield* Effect.fail(refused("没说什么"));
          if (sendKey.length > sendKeyMax) return yield* Effect.fail(refused("sendKey 太长"));
          const where = conversation ?? general;
          if (!(yield* one(qc.conversationByID({ id: where })))) return yield* Effect.fail(missing(`没有 ${where} 这个对话`, [lookIn.channel]));
          const written = yield* write({ conversation: where, from: "user", kind: "chat", text: text.trim(), final: true, sendKey });
          if (written.again) return { message: toMessage(yield* messageOrFail(written.id)), again: true };
          yield* readThrough("user", where, written.number);
          yield* publishConversation(where);
          if (written.absent.length > 0) yield* core.notice("warn", written.absent.map((m) => mentionOf[m] ?? "@" + m).join("、") + " 不在场，没送到");
          return { message: toMessage(yield* messageOrFail(written.id)), again: false };
        }),
      ),
    tellSession: (from, session, text, sendKey) =>
      locked(
        Effect.gen(function* () {
          const thread = yield* threadOfSession(session);
          if (!thread) {
            // Sent with no channel, so no thread to say it in: the session hears it straight.
            if (!helpers?.present(session)) return yield* Effect.fail(missing(`没有 ${session} 这个帮工`, [lookIn.session]));
            yield* helpers.deliver(session, text.trim(), { kind: "comment" });
            return undefined;
          }
          const run = helpers?.currentRun(from);
          const written = yield* write({ conversation: thread, from, kind: "chat", text: text.trim(), final: true, meta: run ? { run } : {}, sendKey });
          if (from === "user") yield* readThrough("user", thread, written.number);
          return toMessage(yield* messageOrFail(written.id));
        }),
      ),
    speak: (from, text, opt = {}) =>
      locked(
        Effect.gen(function* () {
          const words = text.trim();
          if (!words) return yield* Effect.fail(refused("没说什么"));
          const conversation = yield* resolveTarget(from, opt.target ?? "");
          const row = yield* one(qc.conversationByID({ id: conversation }));
          if (!row) return yield* Effect.fail(refused("找不到这个对话"));
          const target = targetOfConv(row);
          // A retry of the same words is the same message.
          const again = yield* one(
            qm.recentDuplicate({ sender_id: from, conversation_id: conversation, body: words, since: (yield* Clock.currentTimeMillis) - retryWindowMs }),
          );
          if (again) {
            const m = yield* one(qm.messageByID({ id: again.id }));
            if (m) return { kind: "sent", message: toMessage(m), target, absent: [] };
          }
          // Posting on a channel right after reading a thread: confirm once.
          const last = lastRead.get(from) ?? "";
          if (row.kind !== "thread" && !opt.confirm && last && last !== target) return { kind: "confirm", target, lastRead: last };
          // Newer messages it has not seen: show them instead of sending.
          const unseen = (yield* db(qm.unseenIn({ conversation, participant: from }))).map((r) => r.id);
          if (unseen.length > 0 && !opt.anyway) {
            const now = yield* Clock.currentTimeMillis;
            const shown: InboxMessage[] = [];
            for (const id of unseen.slice(0, heldShown)) {
              const m = yield* one(qm.messageByID({ id }));
              if (!m) continue;
              shown.push(inboxOf(m, target));
              yield* db(qs.addSeenMark({ participant_id: from, message_id: m.id }));
              yield* db(qd.seenOne({ seen_at: now, recipient_id: from, message_id: m.id }));
            }
            if (shown.length === unseen.length)
              yield* db(qr.setReadCursor({ participant_id: from, conversation_id: conversation, read_number: shown.at(-1)!.number, updated_at: now }));
            return { kind: "held", target, shown: shown.reverse(), more: unseen.length - shown.length };
          }
          // calledBy finds only participants of kind agent, and those are sessions (their ids are session ids).
          const caller = from !== orchestratorAgent ? (yield* one(qm.calledBy({ speaker: from, conversation, before: afterAll })))?.sender_id : undefined;
          const answers = caller === undefined ? undefined : sessionId(caller);
          const run = helpers?.currentRun(from);
          const written = yield* write({
            conversation,
            from,
            kind: "chat",
            text: words,
            final: true,
            ...(answers ? { answers } : {}),
            meta: run ? { run } : {},
          });
          yield* db(
            qr.setReadCursor({ participant_id: from, conversation_id: conversation, read_number: written.number, updated_at: yield* Clock.currentTimeMillis }),
          );
          return { kind: "sent", message: toMessage(yield* messageOrFail(written.id)), target, absent: written.absent };
        }),
      ),
    spoken: (from, text, sendKey) =>
      locked(
        Effect.gen(function* () {
          if (sendKey.length > sendKeyMax) return yield* Effect.fail(refused("sendKey 太长"));
          if (!text.trim()) return false;
          const written = yield* write({ conversation: general, from, kind: "chat", text: text.trim(), final: true, meta: { spoken: true }, sendKey });
          if (written.again) return true;
          if (from === "user") yield* readThrough("user", general, written.number);
          yield* publishConversation(general);
          return false;
        }).pipe(Effect.catchDefect((d) => Effect.as(Effect.logWarning(`chat: words said on a call: ${String(d)}`), false))),
      ),
    orchestratorSays: (conversation, key, text, final, run) =>
      locked(
        Effect.gen(function* () {
          const id = streaming.get(key);
          if (!id && !text.trim() && !final) return;
          const written = yield* write({ ...(id ? { id } : {}), conversation, from: orchestratorAgent, kind: "chat", text, final, meta: run ? { run } : {} });
          if (final) streaming.delete(key);
          else streaming.set(key, written.id);
        }),
      ).pipe(logged("the orchestrator's words")),
    notice: (conversation, text, code) =>
      locked(write({ conversation, from: "system", kind: "notice", text, final: true, meta: { code } })).pipe(logged("notice")),
    read: (who, opt = {}) =>
      locked(
        Effect.gen(function* () {
          const conversation = yield* resolveTarget(who, opt.target ?? "");
          const row = yield* one(qc.conversationByID({ id: conversation }));
          if (!row) return yield* Effect.fail(refused("找不到这个对话"));
          const target = targetOfConv(row);
          const limit = opt.limit ? Math.min(Math.max(opt.limit, 1), 100) : readLimit;
          const cursor = (yield* one(qr.readCursor({ participant_id: who, conversation_id: conversation })))?.read_number ?? 0;
          const rows = opt.unread
            ? yield* db(qm.messagesAfter({ conversation_id: conversation, number: cursor, n: limit }))
            : [...(yield* db(qm.messagesBefore({ conversation_id: conversation, number: opt.before || 2147483647, n: limit })))].reverse();
          if (rows.length > 0 && !opt.before) yield* readThrough(who, conversation, rows.at(-1)!.number);
          lastRead.set(who, target);
          const older = rows.length > 0 && (yield* db(qm.messagesBefore({ conversation_id: conversation, number: rows[0]!.number, n: 1 }))).length > 0;
          return { target, messages: rows.map((m) => inboxOf(m, target)), older };
        }),
      ),
    inbox: (who) =>
      locked(inboxRows(who).pipe(Effect.catchCause((c) => Effect.as(Effect.logWarning(`chat: inbox of ${who}: ${String(c)}`), [] as UnreadRow[])))),
    history: (conversation, before, limit) =>
      Effect.map(db(qm.messagesBefore({ conversation_id: conversation, number: before ?? 2147483647, n: Math.min(Math.max(limit ?? 50, 1), 200) })), (rows) =>
        [...rows].reverse().map(toMessage),
      ),
    markRead: (conversation, seq) =>
      locked(
        Effect.gen(function* () {
          if (!(yield* one(qc.conversationByID({ id: conversation })))) return yield* Effect.fail(missing(`没有 ${conversation} 这个对话`, [lookIn.channel]));
          yield* readThrough("user", conversation, seq);
          yield* publishConversation(conversation);
        }),
      ),
    jobThread: threadOfSession,
    forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
    ownerInThread: Effect.map(
      core.subscribe,
      Stream.flatMap((e) =>
        e.type === "message" && e.thread && e.message.fromKind === "user" && e.message.kind === "chat" && e.message.final
          ? Stream.make({ thread: e.thread, message: e.message })
          : Stream.empty,
      ),
    ),
    orchestratorDigest: () =>
      locked(
        Effect.map(db(qd.openDeliveries({ recipient_id: orchestratorAgent })), (rows) => rows.filter((r) => !(r.wakes && r.held_by === null)).map(asInbox)),
      ),
    channels: () => Effect.map(loadChannels, (rows) => rows.map(infoOf)),
    openChannel: (name, description, project) =>
      locked(
        Effect.gen(function* () {
          const clean = name.trim().replace(/^#/, "");
          const rows = yield* loadChannels;
          const problem = channelNameProblem(
            clean,
            rows.flatMap((r) => (r.name !== null ? [r.name] : [])),
          );
          if (problem) return yield* Effect.fail(refused(problem));
          const desc = optional(description);
          const proj = optional(project);
          const id = newId();
          yield* db(qc.createChannel({ id, name: clean, description: desc, project: proj, created_at: yield* Clock.currentTimeMillis }));
          names.set(id, clean);
          yield* publishConversation(id);
          return infoOf({ id, name: clean, description: desc, project: proj });
        }),
      ),
    updateChannel: (id, description, project) =>
      locked(
        Effect.gen(function* () {
          const row = yield* one(qc.conversationByID({ id }));
          if (!row || row.kind === "thread") return yield* Effect.fail(missing(`没有 ${id} 这个频道`, [lookIn.channel]));
          const desc = (description !== undefined ? optional(description) : null) ?? row.description;
          const proj = project !== undefined ? optional(project) : row.project;
          yield* db(qc.updateChannel({ description: desc, project: proj, id }));
          yield* publishConversation(id);
        }),
      ),
    channelOf: Effect.fn("Channels.channelOf")(function* (conversation) {
      const row = yield* one(qc.conversationByID({ id: conversation }));
      const channel = yield* one(qc.conversationByID({ id: row ? channelIdOf(row) : general }));
      return channel ? infoOf(channel) : { id: general, name: generalName, description: "", project: "" };
    }),
    channelByName: Effect.fn("Channels.channelByName")(function* (name) {
      const found = yield* one(qc.channelByName({ name: name.trim().replace(/^#/, "") }));
      if (!found) return undefined;
      const row = yield* one(qc.conversationByID({ id: found.id }));
      return row ? infoOf(row) : undefined;
    }),
    useHelpers: (h) => void (helpers = h),
    helpersBack,
    activity: (a) => locked(onActivity(a)).pipe(logged(`${a.id} ${a.kind}`)),
    consumed: (c) => locked(consumed(c)).pipe(logged(`input consumed by ${c.session}`)),
    sessionNews: onSessionNews,
  };
  return shape;
});

export const layer = Layer.effect(Channels, make);
