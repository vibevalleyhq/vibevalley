import { Clock, Context, Deferred, Effect, FiberMap, FiberSet, Layer, PubSub, Semaphore, Stream } from "effect";
// Every message is written to the database first. Mailbox is assembled after Collaboration and registers the delivery
// port that turns the committed message fact into durable Session deliveries. Everything that changes the chat runs one
// at a time.
import { HttpClient } from "effect/http";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { everyone, defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { head } from "@/base/clip.ts";
import { newId } from "@/base/ids.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, refused, lookIn, missing, Inconsistent } from "@/errors.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { NotRecorded, Session } from "@/session/session.ts";

import * as qc from "../../db/generated/channel.sql.ts";
import * as qf from "../../db/generated/channel_follow.sql.ts";
import * as qmn from "../../db/generated/channel_mention.sql.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import * as qp from "../../db/generated/channel_participant.sql.ts";
import * as qr from "../../db/generated/channel_read_cursor.sql.ts";
import { channelAttachments } from "./attachments.ts";
import { Follows } from "./audience.ts";
import { linksIn, readEmbed } from "./embeds.ts";
import { keepChannels, targetOf } from "./folded.ts";
import { mentionOf, mentionsIn } from "./mentions.ts";
import { ChatModel, type ChannelRow } from "./model.ts";
import { messageMutations } from "./mutations.ts";
import { inboxLines, talkBrief } from "./prompts.ts";
import { parseSearch } from "./search.ts";
import { channelStreams } from "./streams.ts";
import { channelNameProblem, parseChatTarget } from "./targets.ts";
import { heldShown, type InboxMessage, retryWindowMs, summaryChannels, type UnreadRow } from "./wake.ts";

/** The channel a new farm opens with. */
const firstChannelName = "general";

const reportMax = 1500;
const searchMax = 50;
const talkContext = 12;
/** A helper profile as the chat knows it: apart from the orchestrator and its sessions. */
const profileId = (agent: string) => `profile:${agent}`;
/** What a participant says by reacting when a message that wakes it is handed to it. */
const handedEmoji = "👀";
const readLimit = 30;
/** A follower further behind than this reads the room's newest page instead of every message since. */
export { catchUpMax } from "./streams.ts";
/** The reports a new reader of the farm's log starts from. */

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

import {
  type SayMore,
  type Spoken,
  type Meta,
  metaOf,
  metaText,
  type MsgRow,
  senderKind,
  messageKind,
  channelType,
  subjectKind,
  toMessage,
  notifyOf,
  inboxMore,
  infoOf,
  optional,
  type ThreadSubject,
  subjectOf,
  type Write,
  type Written,
  type ChannelService,
  type ChannelDelivery,
  type ChannelEnvelopeRow,
  type ChannelRouteFact,
  type ChannelRouteResult,
  type SessionNews,
} from "./contracts.ts";
export type { Info, Spoken, SayMore, OrchestratorNews, Delivered, LaunchActivity } from "./contracts.ts";

export class Channel extends Context.Service<Channel, ChannelService>()("vibevalley/Channel") {
  static readonly layer = Layer.effect(
    Channel,
    Effect.gen(function* () {
      return yield* make(yield* Session);
    }),
  );
}

const make = (sessions: Session["Service"]) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const http = yield* HttpClient.HttpClient;
    const agents = yield* Agent;
    const db = yield* Db;
    const model = new ChatModel();
    const follows = new Follows();
    const follow = (channel: string, participant: string, reason: qf.FollowParams["reason"], from: number) =>
      Effect.andThen(
        db.run(qf.follow({ channel_id: channel, participant_id: participant, reason, from_number: from })),
        Effect.sync(() => follows.followed(channel, participant)),
      );
    const reload = Effect.gen(function* () {
      model.load(yield* db.run(qc.allChannels()), yield* db.run(qp.participants()), yield* db.run(qr.readCursorsOf({ participant_id: ownerId })));
      follows.load(yield* db.run(qf.allFollows()));
    });
    /** A transaction that tells the model what it changes as it goes: if it fails, those changes are not in the database,
     * so the model is read again from it. */
    const tx = <A, E>(work: Effect.Effect<A, E>) => db.inTx(work).pipe(Effect.onError(() => Effect.ignoreCause(reload)));
    const lock = yield* Semaphore.make(1);
    const locked = <A, E>(e: Effect.Effect<A, E>) => lock.withPermits(1)(e);
    // Every message once written, for the rooms: each follower reads it through a bounded relay of its own.
    const said = yield* scopedPubSub<T.ChatMessage>();
    const ownerReadHub = yield* scopedPubSub<{ readonly channel: string; readonly number: number; readonly at: number }>();
    const talkStarts = yield* FiberMap.make<string>();

    const lastRead = new Map<string, string>();
    let closed = false;
    let ingress: ((fact: ChannelRouteFact) => Effect.Effect<ChannelRouteResult>) | undefined;
    const deliveryHub = yield* scopedPubSub<ChannelDelivery>();
    const ask = <A>(build: (reply: Deferred.Deferred<A>) => ChannelDelivery): Effect.Effect<A> =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<A>();
        yield* PubSub.publish(deliveryHub, build(reply));
        return yield* Deferred.await(reply);
      });
    // Work set off by a timer belongs to this service: it ends with it and keeps its services.
    const forkHere = yield* FiberSet.makeRuntime();

    yield* Effect.forEach(
      [
        [ownerId, "owner", t("server.channel.name.owner")],
        ["system", "system", "VibeValley"],
      ] as const,
      ([id, kind, name]) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => db.run(qp.upsertParticipant({ id, kind, name, agent_id: null, runtime: null, joined_at: now }))),
      { discard: true },
    );
    /** An orchestrator is a participant by its profile id, under its profile's name as it is when it speaks. */
    const seat = Effect.fnUntraced(function* (id: string) {
      const agent = agents.agent(id);
      const name = agent?.name.trim() || t("server.channel.name.orchestrator");
      if (agent?.role === "orchestrator")
        yield* sessions
          .register({ id: agent.id, role: agent.role, agent: agent.id, name, runtime: agent.runtime, brief: agent.duty })
          .pipe(Effect.mapError((error) => refused(error.message)));
      if (model.participant(id)?.name === name && model.participant(id)?.kind === "orchestrator") return;
      const joined: qp.UpsertParticipantParams = { id, kind: "orchestrator", name, agent_id: null, runtime: null, joined_at: yield* Clock.currentTimeMillis };
      yield* db.run(qp.upsertParticipant(joined));
      model.joined(joined);
    });
    const orchestratorIds = () => agents.orchestrators().map((a) => a.id);
    yield* Effect.forEach(orchestratorIds(), (id) => seat(id), { discard: true });
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
    yield* Effect.forEach(
      orchestratorIds(),
      (id) => Effect.flatMap(Clock.currentTimeMillis, (now) => db.run(qc.createDirect({ id: newId(), peer_id: id, created_at: now }))),
      {
        discard: true,
      },
    );
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
    const directOfSession = (h: T.Session) => {
      const ch = h.channel ? model.channel(h.channel) : undefined;
      return !h.issue && ch?.type === "direct" && ch.peer_id === profileId(h.agent) ? ch.id : undefined;
    };
    const talkSession = (channel: string) => presentSessions().find((h) => directOfSession(h) === channel);
    const channelOfSession = (h: T.Session) => directOfSession(h) ?? (h.channel && channelName(h.channel) !== undefined ? h.channel : defaultId);
    const channelIdOf = (row: ChannelRow) => (row.type === "thread" ? row.parent_id! : row.id);
    /** Where the owner talks with peer alone, from either side. */
    const directWith = (who: string, other: string) => {
      const peer = who === ownerId ? other : other === ownerId ? who : "";
      return model.channels("direct").find((c) => c.peer_id === peer);
    };
    const sessionOf = (id: string) => sessions.sessionOf(id);
    const presentSessions = () => sessions.presentSessions();

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
        ...(row.root_id !== null ? { root: S.messageId(row.root_id) } : {}),
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

    const threadOfSession = Effect.fnUntraced(function* (session: string) {
      const h = sessionOf(session);
      return h ? (directOfSession(h) ?? (yield* threadOf(subjectOf(h)))) : undefined;
    });

    /** Who a thread's words are for, worked out now rather than kept: the session on the issue, or a talk thread's own session. */
    const ownerOf = (ch: ChannelRow): string => {
      if (ch.type === "direct") return talkSession(ch.id)?.id ?? "";
      if (ch.type === "channel" || !ch.subject_id) return "";
      if (ch.subject_kind === "issue") return sessions.onIssue(ch.subject_id) ?? "";
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

    /** Tool reads advance the cursor; passive input consumption belongs to Session receipts. */
    const readUpTo = Effect.fnUntraced(function* (who: string, channel: string, upto: number) {
      const now = yield* Clock.currentTimeMillis;
      yield* setRead(who, channel, upto, now);
    });
    const readThrough = Effect.fnUntraced(function* (who: string, channel: string, upto: number) {
      yield* tx(readUpTo(who, channel, upto));
      if (who === ownerId) {
        PubSub.publishUnsafe(ownerReadHub, { channel, number: upto, at: yield* Clock.currentTimeMillis });
        yield* publishOwnerMentions;
      }
    });

    const { messageOf, change, reacting } = messageMutations(db, tx, said, publishChannel);

    const channelEnvelope = (row: MsgRow): ChannelEnvelopeRow => {
      const channel = model.channel(row.channel_id);
      if (!channel) throw new Error(`no channel ${row.channel_id}`);
      return {
        envelope_id: row.id,
        number: row.number,
        channel_id: channel.id,
        sender_id: row.sender_id,
        kind: row.kind,
        body: row.body,
        meta: row.meta,
        reply_number: row.reply_number,
        created_at: row.created_at,
        name: row.sender_name,
        sender_kind: row.sender_kind,
        channel_type: channel.type,
        root_id: channel.root_id,
        root_number: channel.root_number,
        subject_kind: channel.subject_kind,
        subject_id: channel.subject_id,
        channel_name: (channel.parent_id !== null ? model.channel(channel.parent_id)?.name : undefined) ?? channel.name ?? "",
      };
    };

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
      yield* Effect.forEach(
        mentions,
        (m) =>
          Effect.gen(function* () {
            const how = orchestrators.includes(m) || m === ownerId || m === everyone || present.includes(m) ? "delivered" : known.has(m) ? "absent" : "unknown";
            named.push({ id: m, how });
            yield* db.run(qmn.insertMention({ message_id: row.id, target_id: m, resolved: how }));
          }),
        { discard: true },
      );
      if (mentions.length > 0) {
        row = { ...row, meta: metaText({ ...meta, mentions }) };
        yield* db.run(qm.updateMessageMeta({ meta: row.meta, id: row.id }));
      }
      let followers: string[] = [];
      if (ch.type === "thread") {
        // A dispatch handing the issue to its next session makes no one a follower: the orchestrator would be woken by every word in it.
        if (row.sender_id !== "system" && row.kind !== "dispatch") yield* follow(ch.id, row.sender_id, "replied", row.number);
        yield* Effect.forEach(
          named,
          (m) =>
            Effect.gen(function* () {
              if (m.how === "delivered" && (orchestrators.includes(m.id) || present.includes(m.id))) yield* follow(ch.id, m.id, "mentioned", row.number - 1);
            }),
          { discard: true },
        );
        followers = follows.followers(ch.id);
      }
      const audience = sessionsNow.filter((h) => ch.type === "thread" || channelOfSession(h) === ch.id).map((h) => h.id);
      const heard = {
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
        ...(meta.outcome ? { outcome: meta.outcome } : {}),
        spoken: meta.spoken === true && meta.ingressSource !== "voice",
      };
      const addressed = meta.ingressRecipient;
      const recipients = [...new Set([...present, ...orchestrators, ...(addressed ? [addressed] : [])])];
      const fact: ChannelRouteFact = {
        ...(meta.ingressSource ? { purpose: meta.ingressSource } : {}),
        row: channelEnvelope(row),
        audience: heard,
        ...(addressed ? { addressed } : {}),
        roles: Object.fromEntries(recipients.map((recipient) => [recipient, agents.isOrchestrator(recipient) ? "orchestrator" : "worker"])),
        kinds: Object.fromEntries(recipients.map((recipient) => [recipient, senderKind(model.participant(recipient)?.kind ?? "")])),
        ...(meta.outcome === undefined ? {} : { outcome: meta.outcome }),
      };
      if (!ingress) return yield* Effect.die(new Error("Channel ingress is not attached"));
      const routed = yield* ingress(fact);
      const written: Written = { absent: [], heldNotice: "", received: routed.received, thread: "", again: false, row };
      if (routed.heldNotice && (yield* db.run(qm.holdNoticeSinceUser({ channel: ch.id }))).n === 0) written.heldNotice = routed.heldNotice;
      written.absent = named.filter((m) => m.how !== "delivered").map((m) => m.id);
      return written;
    });

    const messageRow = (row: ChannelEnvelopeRow): MsgRow => ({
      id: row.envelope_id,
      channel_id: row.channel_id,
      number: row.number,
      sender_id: row.sender_id,
      kind: row.kind,
      body: row.body,
      meta: row.meta,
      send_key: null,
      created_at: row.created_at,
      sender_name: row.name,
      sender_kind: row.sender_kind,
      sender_agent: model.participant(row.sender_id)?.agent_id ?? null,
      revision: 0,
      reply_number: row.reply_number,
      edited_at: null,
      deleted_at: null,
      pinned_at: null,
      reactions: null,
    });

    const post = Effect.fnUntraced(function* (w: Write, heard: (row: MsgRow) => Effect.Effect<Written>): Effect.fn.Return<Written> {
      const written = yield* tx(
        Effect.gen(function* () {
          if (w.sendKey) {
            const seen = yield* db.one(qm.messageBySendKey({ sender_id: w.from, send_key: w.sendKey }));
            if (seen) return { absent: [], heldNotice: "", received: [], thread: "", again: true, row: seen };
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
          const out: Written = { absent: [], heldNotice: "", received: [], thread: "", again: false, row };
          if (w.readBy) yield* readUpTo(w.readBy, w.channel, number);
          if (w.follow) yield* follow(w.channel, w.follow, "owner", number);
          if (w.thread) out.thread = yield* threadFor({ id, number, channel: w.channel }, w.thread);
          return out;
        }),
      );
      if (written.again) return written;
      const routed = yield* heard(written.row);
      const complete = { ...routed, thread: written.thread };
      yield* after(w.channel, complete, w.answers);
      return complete;
    });

    /** Routing follows the committed message, so startup can replay an interrupted handoff. */
    const write = (w: Write) => post(w, settle);

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
      yield* publishMessage(written.row, answers);
      yield* Effect.forEach(
        written.received,
        ({ session, envelope }) => reacting(envelope, session, handedEmoji, true).pipe(Effect.asVoid, bestEffort(`chat: 👀 on ${envelope}`)),
        { discard: true },
      );
      embedLater(written.row);
      yield* publishChannel(channel);
      const meta = metaOf(written.row.meta);
      if (written.row.sender_id === ownerId || meta.mentions?.includes(ownerId) === true) yield* publishOwnerMentions;
      if (written.thread) yield* publishChannel(written.thread);
      if (written.heldNotice) yield* write({ channel, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
    });

    const { filesAt, attachmentsOf, attach, attachment } = yield* channelAttachments;
    const deliveryTarget = (r: ChannelEnvelopeRow) => targetOfRow(r.channel_type, r.root_number, null, null, r.channel_name || null);
    const asInbox = (r: ChannelEnvelopeRow): InboxMessage => ({
      id: r.envelope_id,
      number: r.number,
      target: deliveryTarget(r),
      from: r.sender_id,
      fromKind: senderKind(r.sender_kind),
      name: r.name,
      text: r.body,
      ...inboxMore(r, filesAt),
    });

    const inboxRows = Effect.fn("Channel.deliveryUnread")(function* (who: string) {
      const h = sessionOf(who);
      const channel = h ? channelOfSession(h) : defaultId;
      const rows = yield* db.run(qc.inboxOf({ participant: who, channel }));
      const out: UnreadRow[] = [];
      yield* Effect.forEach(
        rows.slice(0, summaryChannels),
        (r) =>
          Effect.gen(function* () {
            const latest = yield* db.one(qm.messageByNumber({ channel_id: r.id, number: r.latest ?? 0 }));
            out.push({
              target: targetOfRow(r.type, r.root_number, null, null, r.channel_name || null),
              unread: r.unread ?? 0,
              mentionsYou: !(r.mentions_you !== true),
              ...(latest ? { latest: latest.sender_name } : {}),
            });
          }),
        { discard: true },
      );
      return out;
    });

    const registerTalk = (session: T.Session, launch: string, snapshot: readonly MsgRow[]) =>
      locked(
        Effect.gen(function* () {
          const joined: qp.UpsertParticipantParams = {
            id: session.id,
            kind: "session",
            name: session.name,
            agent_id: session.agent,
            runtime: session.runtime,
            joined_at: yield* Clock.currentTimeMillis,
          };
          yield* db.attempt(qp.upsertParticipant(joined));
          yield* ask<void>((reply) => ({
            kind: "registerTalk",
            session: session.id,
            launch,
            at: joined.joined_at,
            rows: snapshot.filter((message) => message.sender_id === ownerId && message.kind === "chat" && message.deleted_at === null).map(channelEnvelope),
            reply,
          })).pipe(Effect.onError(() => Effect.ignoreCause(ask<void>((reply) => ({ kind: "restore", reply })))));
          model.joined(joined);
        }).pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause }))),
      );

    const startTalk = Effect.fnUntraced(function* (channel: string, agentId: string) {
      if (talkSession(channel)) return;
      const place = model.channel(channel);
      if (place?.type !== "direct") return;
      const agent = agents.agent(agentId);
      if (!agent) return;
      const problem = !agent.enabled
        ? t("server.channel.profileDisabled", { name: agent.name })
        : yield* Effect.map(sessions.makeRoom(agent.runtime, ""), (room) => ("refused" in room ? room.refused : undefined));
      if (problem) return yield* shape.notice(channel, t("server.channel.talkFailed", { why: problem }), "talk_refused");
      const snapshot = yield* locked(db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n: talkContext })));
      const ordered = snapshot.toReversed();
      const last = ordered.at(-1);
      const owner = ordered.findLast((m) => m.sender_id === ownerId && m.kind === "chat" && m.deleted_at === null);
      if (!owner) return;
      const target = targetOfChannel(place);
      const hired = yield* sessions.send(agent, talkBrief(agent.name, inboxLines(ordered.map((m) => inboxOf(m, target)))), "", {
        context: { kind: "channel", channel },
        envelopeIds: ordered
          .filter((message) => message.sender_id === ownerId && message.kind === "chat" && message.deleted_at === null)
          .map((message) => message.id),
        trigger: { kind: "comment", channel, message: owner.id },
        hiring: (session, launch) => registerTalk(session, launch, ordered),
      });
      if (!hired.session) {
        yield* locked(sessionsLeft);
        return yield* shape.notice(channel, t("server.channel.talkFailed", { why: hired.refused ?? "" }), "talk_refused");
      }
      const recipient = hired.session.id;
      yield* locked(
        Effect.gen(function* () {
          const missed = yield* db.run(qm.missingDirectDeliveries({ channel_id: channel, recipient_id: recipient, after_number: last?.number ?? 0 }));
          yield* Effect.forEach(missed, (row) => settle(row), { discard: true });
          yield* ask<void>((reply) => ({ kind: "kick", session: recipient, reply }));
        }),
      );
    });

    const onDirectMessage = Effect.fnUntraced(function* (message: T.ChatMessage) {
      if (message.fromKind !== "owner" || message.kind !== "chat") return;
      const channel = model.channel(message.channel);
      const peer = channel?.peer_id ? model.participant(channel.peer_id) : undefined;
      if (channel?.type !== "direct" || peer?.kind !== "profile" || !peer.agent_id) return;
      const session = talkSession(channel.id);
      if (session) return;
      yield* FiberMap.run(talkStarts, channel.id, startTalk(channel.id, peer.agent_id).pipe(bestEffort("chat: opening a direct context")), {
        onlyIfMissing: true,
      });
    });

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
      const direct = directOfSession(h);
      if (direct) return yield* handedOn(h, direct);
      const subject = subjectOf(h);
      const thread = yield* threadOf(subject);
      if (thread) return yield* handedOn(h, thread);
      const channel = channelOfSession(h);
      const latest = (yield* db.run(qm.latestNumber({ channel_id: channel }))).n ?? 0;
      yield* setRead(h.id, channel, latest, yield* Clock.currentTimeMillis);
      const what = h.refining ? t("server.channel.dispatch.draft") : head(h.brief.replace(/\s+/gu, " "), 80);
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
      const followers = follows.followers(thread);
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
        yield* ask<void>((reply) => ({ kind: "dropSession", session: p.id, reply }));
        yield* db.run(qf.unfollowAllOf({ at: now, participant_id: p.id }));
        follows.left(p.id);
        lastRead.delete(p.id);
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
      const said = outcome === "completed" ? sessions.reportOf(id) : "";
      const meta: Meta = { outcome, ...(spent ? { spent } : {}), ...(run ? { run } : {}) };
      yield* write({ channel: thread, from: id, kind: "report", text: head(said || summary, reportMax), meta });
    });

    yield* locked(
      Effect.gen(function* () {
        const recent = yield* db.run(qc.recentChannels({ n: keepChannels }));
        yield* Effect.forEach([...recent].toReversed(), (c) => Effect.flatMap(counted(c), (channel) => core.apply({ type: "channel", channel })), {
          discard: true,
        });
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
    // Once the helpers are back, Collaboration restores their threads; Mailbox wakes them after its own recovery.
    const start = locked(Effect.forEach(presentSessions(), (h) => openThread(h).pipe(bestEffort(`chat: ${h.id}'s thread`)), { discard: true }));
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

    const inboxOf = (row: MsgRow, target: string): InboxMessage => ({
      id: S.messageId(row.id),
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
      if (!(yield* db.one(qm.messageByNumber({ channel_id: channel, number }))))
        return yield* Effect.fail(refused(t("server.channel.noMessage", { n: number })));
    });

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

    const openDirect = Effect.fn("Channel.openDirect")(function* (agent: { readonly id: string; readonly name: string }) {
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
    }, locked);

    const ownerSays = Effect.fnUntraced(function* (
      text: string,
      channel: string | undefined,
      sendKey: string,
      more: SayMore,
      source: Meta["ingressSource"],
      responsePort?: string,
      voiceMode?: Meta["voiceMode"],
    ): Effect.fn.Return<{ message: T.ChatMessage; again: boolean }, ApiError> {
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
        ...(files.length > 0 || more.picked || (more.blocks?.length ?? 0) > 0 || source || responsePort || voiceMode
          ? {
              meta: {
                ...(files.length > 0 ? { attachments: files } : {}),
                ...(more.picked ? { picked: more.picked } : {}),
                ...((more.blocks?.length ?? 0) > 0 ? { blocks: more.blocks } : {}),
                ...(source ? { ingressSource: source } : {}),
                ...(source === "voice" ? { spoken: true } : {}),
                ...(responsePort ? { responsePort } : {}),
                ...(voiceMode ? { voiceMode } : {}),
              },
            }
          : {}),
      });
      if (written.again) return { message: toMessage(written.row), again: true };
      if (written.absent.length > 0)
        yield* core.notice(
          "warn",
          t("server.channel.absent", { who: list(written.absent.map((mention) => mentionOf(mention) ?? "@" + mention)), n: written.absent.length }),
        );
      return { message: toMessage(written.row), again: false };
    });

    const shape = Channel.of({
      attachIngress: (route) => {
        if (ingress) throw new Error("Channel ingress is already attached");
        ingress = route;
      },
      delivery: Effect.map(PubSub.subscribe(deliveryHub), Stream.fromSubscription),
      replayDelivery: Effect.fn("Channel.replayDelivery")(function* (row) {
        const written = yield* settle(messageRow(row));
        yield* Effect.forEach(
          written.received,
          ({ session, envelope }) => reacting(envelope, session, handedEmoji, true).pipe(Effect.asVoid, bestEffort(`chat: 👀 on ${envelope}`)),
          { discard: true },
        );
        if (written.heldNotice)
          yield* write({ channel: row.channel_id, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
      }, locked),
      deliveryMessage: asInbox,
      deliveryUnread: inboxRows,
      deliveryReceived: Effect.fn("Channel.deliveryReceived")(
        (session, envelope) => reacting(envelope, session, handedEmoji, true).pipe(Effect.asVoid, bestEffort(`chat: 👀 on ${envelope}`)),
        locked,
      ),
      ownerReads: Effect.map(PubSub.subscribe(ownerReadHub), Stream.fromSubscription),
      handoffSubject: Effect.fn("Channel.handoffSubject")(function* (message) {
        const row = yield* db.one(qm.messageByID({ id: message }));
        if (!row) return undefined;
        const own = model.channel(row.channel_id);
        const thread = own?.type === "thread" ? own : model.channel(model.threadOfRoot(row.id) ?? "");
        const subject = thread ?? own;
        switch (subject?.subject_kind) {
          case "issue":
            return subject.subject_id ? { kind: "issue", id: subject.subject_id } : { kind: "chat", id: row.channel_id };
          case "talk":
            return subject.subject_id ? { kind: "session", id: subject.subject_id } : { kind: "chat", id: row.channel_id };
          case null:
          case undefined:
            return { kind: "chat", id: row.channel_id };
        }
      }),
      now: () => core.state().chat,
      ...channelStreams(db, model, said),
      defaultChannel: () => defaultId,
      messageLocation: Effect.fn("Channel.messageLocation")(function* (id) {
        const message = yield* db.one(qm.messageByID({ id }));
        if (!message) return undefined;
        const row = model.channel(message.channel_id);
        return row ? { channel: toChannel(row), top: channelIdOf(row) } : undefined;
      }),
      envelopeResource: Effect.fn("Channel.envelopeResource")(function* (id) {
        const message = yield* db.one(qm.messageByID({ id }));
        if (!message) return undefined;
        const before = [...(yield* db.run(qm.messagesBefore({ channel_id: message.channel_id, number: message.number, n: 5 })))].toReversed();
        const after = yield* db.run(qm.messagesAfter({ channel_id: message.channel_id, number: message.number, n: 5 }));
        const parent =
          message.reply_number === null ? undefined : yield* db.one(qm.messageByNumber({ channel_id: message.channel_id, number: message.reply_number }));
        return {
          message: toMessage(message),
          attachments: inboxMore(message, filesAt).attachments ?? [],
          ...(parent === undefined ? {} : { parent: toMessage(parent) }),
          around: [...before, ...after].map(toMessage),
        };
      }),
      say: Effect.fn("Channel.say")(
        (text, channel, sendKey, more = {}) => ownerSays(text, channel, sendKey, more, more.source, more.responsePort, more.voiceMode),
        locked,
      ),
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
            if (files.length !== (meta.attachments ?? []).length)
              yield* db.run(qm.setEmbeds({ meta: metaText({ ...meta, attachments: files }), revision, id }));
          }),
        );
        if (words !== row.body) embedLater({ ...row, body: words });
        return changed;
      }, locked),
      remove: Effect.fn("Channel.remove")(function* (id) {
        const row = yield* messageOf(id);
        if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
        yield* change(row, (revision, now) => db.run(qm.deleteMessage({ at: now, revision, id })));
        yield* ask<readonly string[]>((reply) => ({ kind: "dropEnvelope", envelope: id, reply }));
      }, locked),
      previewRemove: Effect.fn("Channel.previewRemove")(function* (id) {
        const row = yield* messageOf(id);
        if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
        const ch = model.channel(row.channel_id);
        const waiting = yield* ask<number>((reply) => ({ kind: "waitingOn", envelope: id, reply }));
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
      issueThread: Effect.fn("Channel.issueThread")(function* (issue, title, channel) {
        const existing = model.threadOfSubject("issue", issue);
        if (existing) return existing;
        const where = channel ?? defaultId;
        if (model.channel(where)?.type !== "channel") return yield* Effect.fail(refused(t("server.channel.threadOnlyInChannel")));
        const written = yield* write({
          channel: where,
          from: "system",
          kind: "notice",
          text: title,
          thread: { kind: "issue", id: issue, owner: "" },
        });
        return written.thread;
      }, locked),
      issueMessages: Effect.fn("Channel.issueMessages")(function* (issue) {
        const thread = model.threadOfSubject("issue", issue);
        if (!thread) return [];
        return yield* shape.recent(thread, 50);
      }),
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
      attach,
      attachment,
      tellSession: Effect.fn("Channel.tellSession")(function* (from, session, text, sendKey) {
        const thread = yield* threadOfSession(session);
        if (!thread) {
          // Sent with no channel, so no thread to say it in: the session hears it straight.
          if (!sessions.present(session)) return yield* Effect.fail(missing(t("server.channel.noHelper", { id: session }), [lookIn.session]));
          const channel = sessionOf(session)?.channel;
          yield* ask<void>((reply) => ({ kind: "deliverDirect", session, text: text.trim(), channel, byOwner: from === ownerId, reply }));
          return undefined;
        }
        const run = sessions.runOf(from);
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
          }
          const newest = shown.at(-1);
          if (newest) yield* setRead(from, channel, newest.number, now);
          return { kind: "held", target, shown, more: unseen.length - shown.length };
        }
        // calledBy finds only participants of kind agent, and those are sessions (their ids are session ids).
        const caller = !agents.isOrchestrator(from) ? (yield* db.one(qm.calledBy({ speaker: from, channel, before: afterAll })))?.sender_id : undefined;
        const answers = caller === undefined ? undefined : sessionId(caller);
        const run = sessions.runOf(from);
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
        yield* setRead(from, channel, written.row.number, yield* Clock.currentTimeMillis);
        return { kind: "sent", message: toMessage(written.row), target, absent: written.absent };
      }, locked),
      placeOf: Effect.fn("Channel.placeOf")(function* (from, channel) {
        if (model.channel(channel)) return channel;
        return yield* resolveTarget(from, channel);
      }),
      announce: Effect.fn("Channel.announce")(function* (from, channel, text, card) {
        const where = model.channel(channel) ? channel : yield* resolveTarget(from, channel);
        if (!model.channel(where)) return yield* Effect.fail(refused(t("server.channel.channelGone")));
        const run = sessions.runOf(from);
        if (agents.isOrchestrator(from)) yield* seat(from);
        const written = yield* write({
          channel: where,
          from,
          kind: "chat",
          text: text.trim(),
          meta: { ...(run ? { run } : {}), artifact: card },
          ...(from === ownerId ? { readBy: ownerId } : {}),
        });
        if (from !== ownerId) yield* setRead(from, where, written.row.number, yield* Clock.currentTimeMillis);
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
        for (const participant of lastRead.keys())
          if (participant !== ownerId && !agents.isOrchestrator(participant) && !sessions.present(participant)) lastRead.delete(participant);
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
      ownerInThread: Effect.map(
        core.subscribe,
        Stream.flatMap((e) =>
          e.type === "message" && e.thread && e.message.fromKind === "owner" && e.message.kind === "chat"
            ? Stream.make({ thread: e.thread, message: e.message })
            : Stream.empty,
        ),
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
          upd.description === undefined &&
          upd.project === undefined &&
          upd.category === undefined &&
          upd.before === undefined &&
          upd.orchestrator === undefined;
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
            yield* Effect.forEach((order ?? []).entries(), ([position, each]) => db.run(qc.placeChannel({ position, id: each })), { discard: true });
          }),
        );
        if (row.type === "channel") model.channelUpdated(id, desc, proj);
        model.patched(id, { name, category, orchestrator });
        for (const [position, each] of (order ?? []).entries()) model.patched(each, { position });
        yield* Effect.forEach(order ?? [id], (each) => publishChannel(each), { discard: true });
        // Its threads are looked after by the same orchestrator: they show the new one too.
        if (orchestrator !== row.orchestrator) yield* Effect.forEach(model.threadsOf(id), (item) => publishChannel(item.id), { discard: true });
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
        const gone = new Set([model.channel(id), ...model.threadsOf(id)].flatMap((c) => (c ? [targetOfChannel(c)] : [])));
        yield* tx(
          Effect.gen(function* () {
            yield* db.run(qm.deleteThreadMessagesIn({ id }));
            yield* db.run(qf.deleteFollowsIn({ id }));
            yield* db.run(qr.deleteCursorsIn({ id }));
            yield* db.run(qc.deleteThreadsOf({ id }));
            yield* db.run(qm.deleteMessagesIn({ id }));
            yield* db.run(qc.deleteChannel({ id }));
          }),
        );
        yield* reload;
        for (const [who, target] of lastRead) if (gone.has(target)) lastRead.delete(who);
        yield* core.apply({ type: "channelGone", id });
      }, locked),
      setNotify: Effect.fn("Channel.setNotify")(function* (id, notify) {
        if (!model.channel(id)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
        yield* db.run(qc.setNotify({ notify, id }));
        model.patched(id, { notify });
        yield* publishChannel(id);
        yield* publishOwnerMentions;
      }, locked),
      orchestratorOf: (channel) => orchestratorOfRow(model.channel(channel)),
      direct: Effect.fn("Channel.direct")(function* (ref) {
        const name = ref.trim();
        const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
        if (!agent) return yield* Effect.fail(missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]));
        return yield* openDirect(agent);
      }),
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
      start,
    });
    yield* Effect.forkScoped(Stream.runForEach(yield* sessions.news, onSessionNews));
    yield* Effect.forkScoped(Stream.runForEach(Stream.fromSubscription(yield* PubSub.subscribe(said)), onDirectMessage));
    return shape;
  });

/** The chat's startup, after the sessions came back: their threads, and what waited for them. */
export const start = Layer.effectDiscard(Effect.flatMap(Channel, (c) => c.start));
