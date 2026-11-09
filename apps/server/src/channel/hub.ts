import { Clock, Effect, PubSub, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { head } from "#/base/clip.ts";
import { newId } from "#/base/ids.ts";
import { scopedPubSub } from "#/base/pubsub.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { type Envelope } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import * as qc from "#db/channel.sql.ts";
import * as qf from "#db/channel_follow.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import {
  type MsgRow,
  senderKind,
  channelType,
  subjectKind,
  toMessage,
  notifyOf,
  envelopeMore,
  type ThreadSubject,
  subjectOf,
  type ChannelEnvelopeRow,
} from "./contracts.ts";
import { keepChannels, targetOf } from "./messages.ts";
import { channelAttachments, messageMutations } from "./mutations.ts";
import { ChatModel, type ChannelRow } from "./rooms.ts";

/** The channel a new farm opens with. */
const firstChannelName = "general";
/** A helper profile as the chat knows it: apart from the orchestrator and its sessions. */
export const profileId = (agent: string) => `profile:${agent}`;
/** A thread named by the message it hangs under shows this much of it. */
export const threadTitleMax = 24;
/** How much of a channel's newest message a list shows. */
export const lastMax = 80;
/** The first n units of text, on one line. */
export const lineOf = (text: string, n: number) => head(oneLine(text).trim(), n);

export const channelHub = Effect.gen(function* () {
  const core = yield* Core;
  const agents = yield* Agent;
  const db = yield* Db;
  const mailbox = yield* Mailbox;
  const sessions = yield* Session;
  const model = new ChatModel();
  const follow = (channel: string, participant: string, reason: qf.FollowParams["reason"], from: number) =>
    Effect.andThen(
      db.run(qf.follow({ channel_id: channel, participant_id: participant, reason, from_number: from })),
      Effect.sync(() => model.followed(channel, participant)),
    );
  const reload = Effect.gen(function* () {
    const channels = yield* db.run(qc.allChannels());
    const participants2 = yield* db.run(qp.participants());
    const cursorsOf = yield* db.run(qr.readCursorsOf({ participant_id: ownerId }));
    const follows = yield* db.run(qf.allFollows());
    model.load(channels, participants2, cursorsOf, follows);
  });
  /** A transaction that tells the model what it changes as it goes: if it fails, those changes are not in the database,
   * so the model is read again from it. */
  const tx = <A, E>(work: Effect.Effect<A, E>) => db.inTx(work).pipe(Effect.onError(() => Effect.ignoreCause(reload, { log: "Warn" })));
  const lock = yield* Semaphore.make(1);
  const locked = <A, E>(e: Effect.Effect<A, E>) => lock.withPermits(1)(e);
  // Every message once written, for the rooms: each follower reads it through a bounded relay of its own.
  const said = yield* scopedPubSub<T.ChatMessage>();
  const ownerReadHub = yield* scopedPubSub<{ readonly channel: string; readonly number: number; readonly at: number }>();

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
    if (model.participant(id)?.name === name && model.participant(id)?.kind === "orchestrator") return;
    const joined: qp.UpsertParticipantParams = { id, kind: "orchestrator", name, agent_id: null, runtime: null, joined_at: yield* Clock.currentTimeMillis };
    yield* db.run(qp.upsertParticipant(joined));
    model.joined(joined);
  });
  const orchestratorIds = () => agents.orchestrators().map((a) => a.id);
  yield* Effect.forEach(orchestratorIds(), (id) => seat(id), { discard: true });
  if (!(yield* db.one(qc.defaultID())))
    yield* db.run(
      qc.createChannel({
        id: newId(),
        is_default: true,
        name: firstChannelName,
        description: null,
        repo: null,
        created_at: yield* Clock.currentTimeMillis,
      }),
    );
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
  const talkSession = (channel: string) => workers().find((h) => directOfSession(h) === channel);
  const channelOfSession = (h: T.Session) => directOfSession(h) ?? (h.channel && channelName(h.channel) !== undefined ? h.channel : model.defaultId());
  const channelIdOf = (row: ChannelRow) => (row.type === "thread" ? (row.parent_id ?? row.id) : row.id);
  /** Where the owner talks with peer alone, from either side. */
  const directWith = (who: string, other: string) => {
    const peer = who === ownerId ? other : other === ownerId ? who : "";
    return model.channels("direct").find((c) => c.peer_id === peer);
  };
  const sessionOf = (id: string) => sessions.sessionOf(id);
  const workers = () => sessions.workers();

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
      notify: notifyOf(row.notify),
      ...(row.root_id !== null ? { root: S.messageId(row.root_id) } : {}),
      ...(row.root_number !== null ? { rootNumber: row.root_number } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      description: row.description ?? "",
      ...(row.repo !== null ? { repo: row.repo } : {}),
      ...(row.parent_id !== null ? { parent: row.parent_id } : {}),
      subjectKind: sk ?? null,
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
    if (row) {
      const channel = yield* counted(row);
      // A metadata change can read a message's number before the message's own fact is applied.
      const published = model.publishedNumber(id);
      const last = published !== undefined && (channel.lastNumber ?? 0) > published ? published : channel.lastNumber;
      yield* core.apply({ type: "channelChanged", channel: { ...channel, ...(last === undefined ? {} : { lastNumber: last }) } });
    }
  });

  const publishOwnerMentions = Effect.gen(function* () {
    // A place set to none tells the owner of nothing, its mentions included.
    const quiet = (id: string | null) => id !== null && model.channel(id)?.notify === "none";
    const rows = (yield* db.run(qm.ownerMentions())).filter((r) => !quiet(r.channel_id) && !quiet(r.top_id));
    yield* core.apply({
      type: "ownerMentionsChanged",
      mentions: rows.map((r) => ({
        message: toMessage(r),
        channel: r.top_id ?? model.defaultId(),
        address: targetOfRow(r.channel_type, r.root_number, null, r.top_id, r.channel_name),
      })),
    });
  });

  const publishMessage = Effect.fn("Channel.publishMessage")(function* (row: MsgRow, answers: T.SessionId | undefined) {
    const ch = model.channel(row.channel_id);
    const thread = ch?.type !== "channel" && ch?.subject_kind === "issue" && ch.subject_id ? ch.subject_id : undefined;
    const message = toMessage(row);
    yield* core.apply({ type: "messageChanged", message, ...(thread ? { thread } : {}), ...(answers ? { answers } : {}) });
    model.notePublished(row.channel_id, row.number);
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
      repo: null,
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

  const { filesAt, attachmentsOf, attach, attachment } = yield* channelAttachments;
  const deliveryTarget = (r: ChannelEnvelopeRow) => targetOfRow(r.channel_type, r.root_number, null, null, r.channel_name || null);
  const asEnvelope = (r: ChannelEnvelopeRow): Envelope => ({
    id: r.envelope_id,
    number: r.number,
    target: deliveryTarget(r),
    from: r.sender_id,
    fromKind: senderKind(r.sender_kind),
    name: r.name,
    text: r.body,
    ...envelopeMore(r, filesAt),
  });

  const inboxRows = Effect.fn("Channel.deliveryUnread")(function* (who: string) {
    const h = sessionOf(who);
    const channel = h ? channelOfSession(h) : model.defaultId();
    return yield* mailbox.unreadSummary(who, channel);
  });

  yield* locked(
    Effect.gen(function* () {
      const recent = yield* db.run(qc.recentChannels({ n: keepChannels }));
      yield* Effect.forEach([...recent].toReversed(), (c) => Effect.flatMap(counted(c), (channel) => core.apply({ type: "channelChanged", channel })), {
        discard: true,
      });
      yield* publishOwnerMentions;
    }),
  );

  const envelopeOf = (row: MsgRow, target: string): Envelope => ({
    id: S.messageId(row.id),
    number: row.number,
    target,
    from: row.sender_id,
    fromKind: senderKind(row.sender_kind),
    name: row.sender_name,
    text: row.body,
    ...envelopeMore(row, filesAt),
  });
  return {
    model,
    follow,
    reload,
    tx,
    locked,
    said,
    ownerReadHub,
    seat,
    orchestratorIds,
    orchestratorOfRow,
    channelTags,
    directOfSession,
    talkSession,
    channelOfSession,
    channelIdOf,
    directWith,
    sessionOf,
    workers,
    targetOfRow,
    targetOfChannel,
    toChannel,
    counted,
    publishChannel,
    publishOwnerMentions,
    publishMessage,
    threadOf,
    threadOfSession,
    ownerOf,
    threadFor,
    setRead,
    readUpTo,
    readThrough,
    change,
    messageOf,
    reacting,
    channelEnvelope,
    messageRow,
    attachmentsOf,
    filesAt,
    attach,
    attachment,
    asEnvelope,
    inboxRows,
    envelopeOf,
  };
});

export type ChannelHub = Effect.Success<typeof channelHub>;
