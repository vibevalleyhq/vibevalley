import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect";
// Every message is written to the database first. Mailbox is handed each committed message directly: it turns the message into durable Session deliveries.

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { head } from "#/base/clip.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { type ApiError, refused, lookIn, missing } from "#/errors.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { heldShown, type InboxMessage, retryWindowMs } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import * as qc from "#db/channel.sql.ts";
import * as qf from "#db/channel_follow.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import { channelNameProblem, mentionOf, parseChatTarget } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { channelStreams } from "./mutations.ts";
import { channelRecords, lastMax, lineOf, profileId, threadTitleMax } from "./records.ts";
import { directTalk } from "./talk.ts";
import { sessionThreads } from "./threads.ts";
import { channelWriting } from "./writing.ts";

const searchMax = 50;
/** What a participant says by reacting when a message that wakes it is handed to it. */
const handedEmoji = "👀";
const readLimit = 30;
/** A follower further behind than this reads the room's newest page instead of every message since. */
export { catchUpMax } from "./mutations.ts";
/** The client's key for one send, so a retry of it is the same message. */
const sendKeyMax = 64;
/** Sorts after every uuidv7, for "since the last thing said". */
const afterAll = "\uffff";

import { type SayMore, type Spoken, type Meta, metaOf, metaText, toMessage, notifyOf, inboxMore, infoOf, optional, type ChannelService } from "./contracts.ts";
export type { Info, Spoken, SayMore, OrchestratorNews, Delivered, LaunchActivity } from "./contracts.ts";

export class Channel extends Context.Service<Channel, ChannelService>()("vibevalley/Channel") {
  static readonly layer = Layer.effect(
    Channel,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const sessions = yield* Session;
  const mailbox = yield* Mailbox;
  const r = yield* channelRecords;
  const w = yield* channelWriting(r);
  const th = yield* sessionThreads(r, w);
  const talk = yield* directTalk(r, w, th, (channel, text, code) => shape.notice(channel, text, code));
  const {
    model,
    reload,
    tx,
    locked,
    said,
    ownerReadHub,
    seat,
    orchestratorOfRow,
    channelTags,
    channelOfSession,
    channelIdOf,
    directWith,
    sessionOf,
    presentSessions,
    targetOfRow,
    targetOfChannel,
    toChannel,
    counted,
    publishChannel,
    publishOwnerMentions,
    threadOfSession,
    threadFor,
    setRead,
    readThrough,
    messageOf,
    change,
    reacting,
    attachmentsOf,
    filesAt,
    attach,
    attachment,
    inboxRows,
    inboxOf,
  } = r;
  const { write, embedLater } = w;
  const { onSessionNews, start } = th;
  const { onDirectMessage } = talk;
  const core = yield* Core;
  const agents = yield* Agent;
  const db = yield* Db;

  /** A target as who would mean it: empty is a session's own thread (or the default channel), a channel by name, or a thread by its parent's number. */
  const resolveTarget = Effect.fnUntraced(function* (who: string, target: string): Effect.fn.Return<string, ApiError> {
    if (!target.trim()) {
      if (!agents.isOrchestrator(who) && who !== ownerId) {
        const own = yield* threadOfSession(who);
        if (own) return own;
      }
      return model.defaultId();
    }
    const parsed = parseChatTarget(target);
    if (!parsed) return yield* Effect.fail(refused(t("server.channel.badTarget", { target })));
    if (parsed.kind === "direct") {
      const direct = directWith(who, parsed.peer);
      if (!direct) return yield* Effect.fail(refused(t("server.channel.noDirect", { target: target.trim() })));
      return direct.id;
    }
    let channel = model.defaultId();
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

  const answered = Effect.fnUntraced(function* (channel: string, number: number | undefined) {
    if (number === undefined) return;
    if (!(yield* db.one(qm.messageByNumber({ channel_id: channel, number })))) return yield* Effect.fail(refused(t("server.channel.noMessage", { n: number })));
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
    // A channel as the owner names it (general, #general, @fox) as well as by id; none is the default one.
    const where = channel === undefined || model.channel(channel) ? (channel ?? model.defaultId()) : yield* resolveTarget(ownerId, channel);
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

  const recent = Effect.fn("Channel.recent")(function* (channel: string, n: number) {
    const row = model.channel(channel);
    if (!row) return [];
    const target = targetOfChannel(row);
    return [...(yield* db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n })))].toReversed().map((m) => inboxOf(m, target));
  });
  const shape = Channel.of({
    ownerReads: Effect.map(PubSub.subscribe(ownerReadHub), Stream.fromSubscription),
    now: () => core.state().chat,
    ...channelStreams(db, model, said),
    defaultChannel: () => model.defaultId(),
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
          if (files.length !== (meta.attachments ?? []).length) yield* db.run(qm.setEmbeds({ meta: metaText({ ...meta, attachments: files }), revision, id }));
        }),
      );
      if (words !== row.body) embedLater({ ...row, body: words });
      return changed;
    }, locked),
    remove: Effect.fn("Channel.remove")(function* (id) {
      const row = yield* messageOf(id);
      if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
      yield* change(row, (revision, now) => db.run(qm.deleteMessage({ at: now, revision, id })));
      yield* mailbox.dropEnvelope(id);
    }, locked),
    previewRemove: Effect.fn("Channel.previewRemove")(function* (id) {
      const row = yield* messageOf(id);
      if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
      const ch = model.channel(row.channel_id);
      const waiting = yield* mailbox.waitingOn(id);
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
      const where = channel ?? model.defaultId();
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
      return yield* recent(thread, 50);
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
        yield* mailbox.deliverDirect(session, text.trim(), channel, from === ownerId);
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
      const last = model.lastRead.get(from) ?? "";
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
          channel: model.defaultId(),
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
      for (const participant of model.lastRead.keys())
        if (participant !== ownerId && !agents.isOrchestrator(participant) && !sessions.present(participant)) model.lastRead.delete(participant);
      model.lastRead.set(who, target);
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
      // A channel as the owner names it (general, #general, @fox) as well as by id.
      const at = model.channel(channel) ? channel : yield* resolveTarget(ownerId, channel);
      const rows = yield* db.run(qm.messagesBefore({ channel_id: at, number: before ?? 2147483647, n: Math.min(Math.max(limit ?? 50, 1), 200) }));
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
        e.type === "messageChanged" && e.thread && e.message.fromKind === "owner" && e.message.kind === "chat"
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
      for (const [who, target] of model.lastRead) if (gone.has(target)) model.lastRead.delete(who);
      yield* core.apply({ type: "channelRemoved", id });
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
      const was = model.defaultId();
      if (id === was) return;
      yield* tx(Effect.andThen(db.run(qc.clearDefault()), db.run(qc.makeDefault({ id }))));
      model.defaultMoved(was, id);
      yield* publishChannel(was);
      yield* publishChannel(id);
    }, locked),
    topOf: Effect.fn("Channel.topOf")((channel) =>
      Effect.sync(() => {
        const row = model.channel(channel);
        const top = model.channel(row && row.type !== "direct" ? channelIdOf(row) : model.defaultId());
        return infoOf(top ?? model.channel(model.defaultId())!);
      }),
    ),
    addressOf: Effect.fn("Channel.addressOf")((channel) =>
      Effect.sync(() => {
        const row = model.channel(channel);
        if (row?.type === "direct") return { direct: true, target: targetOfChannel(row) };
        const top = model.channel(row ? channelIdOf(row) : model.defaultId()) ?? model.channel(model.defaultId())!;
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
  yield* Effect.forkScoped(
    Stream.runForEach(yield* mailbox.consumed, ({ session, message }) =>
      reacting(message, session, handedEmoji, true).pipe(Effect.asVoid, bestEffort(`chat: 👀 on ${message}`)),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(yield* mailbox.breakerNotices, ({ session, failed }) =>
      Effect.gen(function* () {
        const where = (yield* shape.threadOfSession(session)) ?? model.defaultId();
        const name = sessions.sessionOf(session)?.name ?? session;
        yield* shape.notice(where, t("server.channel.breaker", { name, failed }), "wake_breaker");
      }).pipe(bestEffort(`chat: wake breaker for ${session}`)),
    ),
  );
  return shape;
});

/** The chat's startup, after the sessions came back: their threads, and what waited for them. */
export const start = Layer.effectDiscard(Effect.flatMap(Channel, (c) => c.start));
