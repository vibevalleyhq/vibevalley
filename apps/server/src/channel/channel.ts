import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect";
// Every message is written to the database first. Mailbox is handed each committed message directly: it turns the message into durable Session deliveries.

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { type ApiError, refused, lookIn, missing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { heldShown, type Envelope, retryWindowMs } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import { type Post, type PostOf, type SayMore, type Spoken, type Meta, metaOf, metaText, toMessage, envelopeMore, type ChannelService } from "./contracts.ts";
import { channelDirectory } from "./directory.ts";
import { channelHub, lastMax, lineOf } from "./hub.ts";
import { mentionOf, parseChatTarget } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { channelStreams } from "./mutations.ts";
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

export type { Info, Spoken, SayMore, Delivered } from "./contracts.ts";

export class Channel extends Context.Service<Channel, ChannelService>()("@vibevalley/server/channel/channel") {
  static readonly layer = Layer.effect(
    Channel,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const sessions = yield* Session;
  const mailbox = yield* Mailbox;
  const r = yield* channelHub;
  const dir = yield* channelDirectory(r);
  const w = yield* channelWriting(r);
  const th = yield* sessionThreads(r, w);
  const talk = yield* directTalk(r, w, th, (channel, text, code) => post({ _tag: "Notice", channel, text, code }));
  const {
    model,
    tx,
    locked,
    seat,
    said,
    userReadHub,
    channelTags,
    channelIdOf,
    directWith,
    sessionOf,
    targetOfRow,
    targetOfChannel,
    toChannel,
    counted,
    publishChannel,
    threadOfSession,
    threadFor,
    setRead,
    readThrough,
    messageOf,
    change,
    reacting,
    attachmentsOf,
    filesAt,
    inboxRows,
    envelopeOf,
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
      if (!agents.isOrchestrator(who) && who !== userId) {
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
    const name = parsed.kind === "channel" ? parsed.name : (target.trim().replace(/^#/u, "").split(":")[0] ?? "");
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

  const userSays = Effect.fnUntraced(function* (
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
    if (more.to !== undefined && !agents.isOrchestrator(more.to)) return yield* Effect.fail(refused(t("server.channel.notOrchestrator", { id: more.to })));
    // A channel as the user names it (general, #general, @fox) as well as by id; none is the default one.
    const where = channel === undefined || model.channel(channel) ? (channel ?? model.defaultId()) : yield* resolveTarget(userId, channel);
    if (!model.channel(where)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: where }), [lookIn.channel]));
    yield* answered(where, more.replyTo);
    const written = yield* write({
      channel: where,
      from: userId,
      kind: "chat",
      text: text.trim(),
      sendKey,
      readBy: userId,
      ...(more.replyTo !== undefined ? { replyTo: more.replyTo } : {}),
      ...(files.length > 0 || more.picked || (more.blocks?.length ?? 0) > 0 || source || responsePort || voiceMode || more.to !== undefined
        ? {
            meta: {
              ...(more.to !== undefined ? { ingressRecipient: more.to } : {}),
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
    return [...(yield* db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n })))].toReversed().map((m) => envelopeOf(m, target));
  });
  const postUser = Effect.fn("Channel.post", { attributes: { post: "User" } })(
    (p: PostOf<"User">) => userSays(p.text, p.channel, p.sendKey, p, p.source, p.responsePort, p.voiceMode),
    locked,
  );

  const postTell = Effect.fn("Channel.post", { attributes: { post: "Tell" } })(function* ({ from, session, text, sendKey }: PostOf<"Tell">) {
    const thread = yield* threadOfSession(session);
    if (!thread) {
      // Sent with no channel, so no thread to say it in: the session hears it as a trigger addressed to it alone.
      if (!sessions.isReachable(session)) return yield* Effect.fail(missing(t("server.channel.noHelper", { id: session }), [lookIn.session]));
      const channel = sessionOf(session)?.channel;
      const at = yield* Clock.currentTimeMillis;
      const speaker = sessionOf(from);
      const trigger = yield* mailbox.recordTrigger({
        source: "channel",
        key: sendKey || newId(at),
        actor:
          from === userId
            ? { kind: "user", id: userId }
            : { kind: "agent", role: agents.isOrchestrator(from) ? "orchestrator" : "worker", id: from, ...(speaker ? { name: speaker.name } : {}) },
        text: text.trim(),
        threads: [],
        addressed: "direct",
        ...(channel ? { replyChannel: channel } : {}),
        at,
      });
      yield* mailbox.receive({ _tag: "Trigger", trigger, to: { session } });
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
      ...(from === userId ? { readBy: userId } : {}),
    });
    return toMessage(written.row);
  }, locked);

  const postAgent = Effect.fn("Channel.post", { attributes: { post: "Agent" } })(function* ({
    from,
    text,
    ...opt
  }: PostOf<"Agent">): Effect.fn.Return<Spoken, ApiError> {
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
      const shown: Envelope[] = [];
      for (const id of unseen.slice(0, heldShown)) {
        const m = yield* db.one(qm.messageByID({ id }));
        if (!m) continue;
        shown.push(envelopeOf(m, target));
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
    const now2 = yield* Clock.currentTimeMillis;
    yield* setRead(from, channel, written.row.number, now2);
    return { kind: "sent", message: toMessage(written.row), target, absent: written.absent };
  }, locked);

  const postAnnounce = Effect.fn("Channel.post", { attributes: { post: "Announce" } })(function* ({
    from,
    channel,
    text,
    made,
    sendKey = "",
  }: PostOf<"Announce">) {
    const where = model.channel(channel) ? channel : yield* resolveTarget(from, channel);
    if (!model.channel(where)) return yield* Effect.fail(refused(t("server.channel.channelGone")));
    const run = sessions.runOf(from);
    if (agents.isOrchestrator(from)) yield* seat(from);
    const shown = "card" in made ? { artifact: made.card } : { attachments: yield* attachmentsOf(made.attachments) };
    const written = yield* write({
      channel: where,
      from,
      kind: "chat",
      text: text.trim(),
      meta: { ...(run ? { run } : {}), ...shown },
      sendKey,
      ...(from === userId ? { readBy: userId } : {}),
    });
    if (from !== userId) {
      const now = yield* Clock.currentTimeMillis;
      yield* setRead(from, where, written.row.number, now);
    }
    return toMessage(written.row);
  }, locked);

  const postCall = Effect.fn("Channel.post", { attributes: { post: "Call" } })(
    function* ({ from, text, sendKey }: PostOf<"Call">) {
      if (sendKey.length > sendKeyMax) return yield* Effect.fail(refused(t("server.channel.sendKeyLong")));
      if (!text.trim()) return false;
      const written = yield* write({
        channel: model.defaultId(),
        from,
        kind: "chat",
        text: text.trim(),
        meta: { spoken: true },
        sendKey,
        ...(from === userId ? { readBy: userId } : {}),
      });
      return written.again;
    },
    Effect.catchDefect((d) => Effect.as(Effect.logWarning(`chat: words said on a call: ${String(d)}`), false)),
    locked,
  );

  const postRun = Effect.fn("Channel.post", { attributes: { post: "Run" } })(function* ({ channel, text, run, from }: PostOf<"Run">) {
    if (!text.trim()) return;
    yield* locked(Effect.andThen(seat(from), write({ channel, from, kind: "chat", text, meta: run ? { run } : {} })));
  }, bestEffort("chat: a run's words"));

  const postNotice = Effect.fn("Channel.post", { attributes: { post: "Notice" } })(
    function* ({ channel, text, code, sendKey = "" }: PostOf<"Notice">) {
      return yield* write({ channel, from: "system", kind: "notice", text, meta: { code }, sendKey });
    },
    locked,
    bestEffort("chat: notice"),
  );

  // One door; each kind keeps its own checks and answer, and the overloads tie the answer to the kind.
  function post(p: PostOf<"User">): Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
  function post(p: PostOf<"Tell">): Effect.Effect<T.ChatMessage | undefined, ApiError>;
  function post(p: PostOf<"Agent">): Effect.Effect<Spoken, ApiError>;
  function post(p: PostOf<"Announce">): Effect.Effect<T.ChatMessage, ApiError>;
  function post(p: PostOf<"Call">): Effect.Effect<boolean, ApiError>;
  function post(p: PostOf<"Run"> | PostOf<"Notice">): Effect.Effect<void>;
  function post(p: Post): Effect.Effect<{ message: T.ChatMessage; again: boolean } | T.ChatMessage | Spoken | boolean | undefined | void, ApiError> {
    switch (p._tag) {
      case "User":
        return postUser(p);
      case "Tell":
        return postTell(p);
      case "Agent":
        return postAgent(p);
      case "Announce":
        return postAnnounce(p);
      case "Call":
        return postCall(p);
      case "Run":
        return postRun(p);
      case "Notice":
        return postNotice(p);
    }
  }

  const shape = Channel.of({
    post,
    userReads: Effect.map(PubSub.subscribe(userReadHub), Stream.fromSubscription),
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
        attachments: envelopeMore(message, filesAt).attachments ?? [],
        ...(parent === undefined ? {} : { parent: toMessage(parent) }),
        around: [...before, ...after].map(toMessage),
      };
    }),
    edit: Effect.fn("Channel.edit")(function* (id, text, keep) {
      const row = yield* messageOf(id);
      if (row.sender_id !== userId || row.kind !== "chat" || row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.notYours")));
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
      yield* mailbox.withdraw({ _tag: "Envelope", envelope: id });
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
    issueThreadId: Effect.fn("Channel.issueThreadId")(function* (issue) {
      return yield* Effect.sync(() => model.threadOfSubject("issue", issue) ?? null);
    }),
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
    placeOf: Effect.fn("Channel.placeOf")(function* (from, channel) {
      if (model.channel(channel)) return channel;
      return yield* resolveTarget(from, channel);
    }),
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
        if (participant !== userId && !agents.isOrchestrator(participant) && !sessions.isReachable(participant)) model.lastRead.delete(participant);
      model.lastRead.set(who, target);
      const oldest = rows[0];
      const older = oldest !== undefined && (yield* db.run(qm.messagesBefore({ channel_id: channel, number: oldest.number, n: 1 }))).length > 0;
      return { target, messages: rows.map((m) => envelopeOf(m, target)), older };
    }, locked),
    unread: Effect.fn("Channel.unread")(function* (who) {
      return yield* locked(
        inboxRows(who).pipe(
          Effect.map((rows) => rows.map(({ target, ...r }): T.ChannelUnread => ({ channel: target, ...r }))),
          Effect.catchCause((c) => Effect.as(Effect.logWarning(`chat: unread of ${who}: ${String(c)}`), [])),
        ),
      );
    }),
    list: Effect.fn("Channel.list")(function* () {
      return yield* Effect.forEach([...model.channels("channel"), ...model.channels("direct")], counted);
    }),
    history: Effect.fn("Channel.history")(function* (channel, before, limit) {
      // A channel as the user names it (general, #general, @fox) as well as by id.
      const at = model.channel(channel) ? channel : yield* resolveTarget(userId, channel);
      const rows = yield* db.run(qm.messagesBefore({ channel_id: at, number: before ?? 2147483647, n: Math.min(Math.max(limit ?? 50, 1), 200) }));
      return [...rows].toReversed().map(toMessage);
    }),
    markRead: Effect.fn("Channel.markRead")(function* (channel, seq) {
      if (!model.channel(channel)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]));
      yield* readThrough(userId, channel, seq);
      yield* publishChannel(channel);
    }, locked),
    threadOfSession,
    userInThread: Effect.map(
      core.subscribe,
      Stream.flatMap((e) =>
        e.type === "messageChanged" && e.thread && e.message.fromKind === "user" && e.message.kind === "chat"
          ? Stream.make({ thread: e.thread, message: e.message })
          : Stream.empty,
      ),
    ),
    ...dir,
    start,
  });
  const news2 = yield* sessions.news;
  yield* Effect.forkScoped(Stream.runForEach(news2, onSessionNews));
  const subscribe2 = yield* PubSub.subscribe(said);
  yield* Effect.forkScoped(Stream.runForEach(Stream.fromSubscription(subscribe2), onDirectMessage));
  const news = yield* mailbox.news;
  yield* Effect.forkScoped(
    Stream.runForEach(news, (change) => {
      switch (change._tag) {
        case "Consumed":
          return reacting(change.envelope, change.session, handedEmoji, true).pipe(Effect.asVoid, bestEffort(`chat: 👀 on ${change.envelope}`));
        case "Handed":
          return Effect.void;
        case "Braked":
          return Effect.gen(function* () {
            const where = (yield* shape.threadOfSession(change.session)) ?? model.defaultId();
            const name = sessions.sessionOf(change.session)?.name ?? change.session;
            yield* post({ _tag: "Notice", channel: where, text: t("server.channel.breaker", { name, failed: change.failed }), code: "wake_breaker" });
          }).pipe(bestEffort(`chat: wake breaker for ${change.session}`));
      }
    }),
  );
  return shape;
});

/** The chat's startup, after the sessions came back: their threads, and what waited for them. */
export const start = Layer.effectDiscard(Effect.flatMap(Channel, (c) => c.start));
