// Every message is written to the database first. Mailbox is handed each committed message directly: it turns the message into durable Session deliveries.
import { type Subscription, TaskGroup } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";
import { heldShown, type Envelope, type Picked, retryWindowMs } from "#/modules/session/envelope.ts";
import type { Session } from "#/modules/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import { type Post, type PostOf, type SayMore, type Spoken, type Meta, metaOf, metaText, toMessage, envelopeMore, type ChannelService } from "./contracts.ts";
import { channelDirectory } from "./directory.ts";
import { makeChannelHub, lastMax, lineOf } from "./hub.ts";
import { mentionOf, parseChatTarget } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { channelStreams } from "./mutations.ts";
import { directTalk } from "./talk.ts";
import { sessionThreads } from "./threads.ts";
import { channelWriting } from "./writing.ts";

const refused = refuseIn(BizCode.ChannelRefused);

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

export type { Spoken, Delivered } from "./contracts.ts";

export type Channel = ChannelService;

export interface ChannelDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly attachment: Attachment;
  readonly session: Session;
}

/** A subscription's values that keep, as f makes them (undefined: dropped). */
function mapped<A, B>(sub: Subscription<A>, f: (a: A) => B | undefined): Subscription<B> {
  const next = async (signal?: AbortSignal): Promise<IteratorResult<B>> => {
    for (;;) {
      const r = await sub.next(signal);
      if (r.done === true) return { done: true, value: undefined };
      const b = f(r.value);
      if (b !== undefined) return { done: false, value: b };
    }
  };
  return {
    next,
    drain: () =>
      sub.drain().flatMap((a) => {
        const b = f(a);
        return b === undefined ? [] : [b];
      }),
    size: () => sub.size(),
    close: () => sub.close(),
    [Symbol.dispose]: () => sub.close(),
    [Symbol.asyncIterator]: () => ({
      next: () => next(),
      return: () => {
        sub.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
}

export async function makeChannel(deps: ChannelDeps): Promise<Channel> {
  const { core, agent: agents, db, clock, session: sessions } = deps;
  const log = deps.log.child("channel");
  const tasks = new TaskGroup({ name: "channel", onError: (task, e) => log.warn(`${task} failed`, e) });
  const own = { ...deps, log };
  const r = await makeChannelHub(own);
  const dir = channelDirectory(own, r);
  const w = channelWriting(own, r, tasks);
  const th = sessionThreads(own, r, w);
  const talk = directTalk(own, r, w, th, (channel, text, code) => post({ _tag: "Notice", channel, text, code }), tasks);
  const {
    store,
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

  /** A target as who would mean it: empty is a session's own thread (or the default channel), a channel by name, or a thread by its parent's number. */
  const resolveTarget = async (who: string, target: string): Promise<string> => {
    if (!target.trim()) {
      if (!agents.isOrchestrator(who) && who !== userId) {
        const own = await threadOfSession(who);
        if (own) return own;
      }
      return store.defaultId();
    }
    const parsed = parseChatTarget(target);
    if (!parsed) throw refused(t("server.channel.badTarget", { target }));
    if (parsed.kind === "direct") {
      const direct = directWith(who, parsed.peer);
      if (!direct) throw refused(t("server.channel.noDirect", { target: target.trim() }));
      return direct.id;
    }
    let channel = store.defaultId();
    const name = parsed.kind === "channel" ? parsed.name : (target.trim().replace(/^#/u, "").split(":")[0] ?? "");
    if (name) {
      const found = store.channelByName(name);
      if (!found) throw missing(t("server.channel.noChannelNamed", { name, tags: list(channelTags()) }), [lookIn.channel]);
      channel = found.id;
    }
    if (parsed.kind === "channel") return channel;
    const root = await qm.messageByNumber(db.sql, { channel_id: channel, number: parsed.root });
    if (!root) throw refused(t("server.channel.noMessage", { n: parsed.root }));
    const thread = await store.tx(() => store.threadFor({ id: root.id, number: root.number, channel: root.channel_id }, { kind: "talk", id: "", owner: "" }));
    await publishChannel(thread);
    return thread;
  };

  const answered = async (channel: string, number: number | undefined) => {
    if (number === undefined) return;
    if (!(await qm.messageByNumber(db.sql, { channel_id: channel, number }))) throw refused(t("server.channel.noMessage", { n: number }));
  };

  const userSays = async (
    text: string,
    channel: string | undefined,
    sendKey: string,
    more: SayMore,
    source: Meta["ingressSource"],
    responsePort?: string,
    voiceMode?: Meta["voiceMode"],
  ): Promise<{ message: T.ChatMessage; again: boolean }> => {
    const files = await attachmentsOf(more.attachments ?? []);
    if (!text.trim() && files.length === 0) throw refused(t("server.channel.empty"));
    if (sendKey.length > sendKeyMax) throw refused(t("server.channel.sendKeyLong"));
    if (more.to !== undefined && !agents.isOrchestrator(more.to)) throw refused(t("server.channel.notOrchestrator", { id: more.to }));
    // A channel as the user names it (general, #general, @fox) as well as by id; none is the default one.
    const where = channel === undefined || store.channel(channel) ? (channel ?? store.defaultId()) : await resolveTarget(userId, channel);
    if (!store.channel(where)) throw missing(t("server.channel.noChannel", { id: where }), [lookIn.channel]);
    await answered(where, more.replyTo);
    const written = await write({
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
      core.notice(
        "warn",
        t("server.channel.absent", { who: list(written.absent.map((mention) => mentionOf(mention) ?? "@" + mention)), n: written.absent.length }),
      );
    return { message: toMessage(written.row), again: false };
  };

  const recent = async (channel: string, n: number): Promise<Envelope[]> => {
    const row = store.channel(channel);
    if (!row) return [];
    const target = targetOfChannel(row);
    return [...(await qm.messagesBefore(db.sql, { channel_id: channel, number: 2147483647, n }))].toReversed().map((m) => envelopeOf(m, target));
  };
  const postUser = (p: PostOf<"User">) => store.locked(() => userSays(p.text, p.channel, p.sendKey, p, p.source, p.responsePort, p.voiceMode));

  const postTell = ({ from, session, text, sendKey }: PostOf<"Tell">) =>
    store.locked(async (): Promise<T.ChatMessage | undefined> => {
      const thread = await threadOfSession(session);
      if (!thread) {
        // Sent with no channel, so no thread to say it in: the session hears it as a trigger addressed to it alone.
        if (!sessions.isReachable(session)) throw missing(t("server.channel.noHelper", { id: session }), [lookIn.session]);
        const channel = sessionOf(session)?.channel;
        const at = clock.now();
        const speaker = sessionOf(from);
        const trigger = await sessions.recordTrigger({
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
        await sessions.receive({ _tag: "Trigger", trigger, to: { session } });
        return undefined;
      }
      const run = sessions.runOf(from);
      const written = await write({
        channel: thread,
        from,
        kind: "chat",
        text: text.trim(),
        meta: run ? { run } : {},
        sendKey,
        ...(from === userId ? { readBy: userId } : {}),
      });
      return toMessage(written.row);
    });

  const postAgent = ({ from, text, ...opt }: PostOf<"Agent">) =>
    store.locked(async (): Promise<Spoken> => {
      const words = text.trim();
      if (!words) throw refused(t("server.channel.empty"));
      const channel = await resolveTarget(from, opt.target ?? "");
      const row = store.channel(channel);
      if (!row) throw refused(t("server.channel.channelGone"));
      const target = targetOfChannel(row);
      // A retry of the same words is the same message.
      const again = await qm.recentDuplicate(db.sql, { sender_id: from, channel_id: channel, body: words, since: clock.now() - retryWindowMs });
      if (again) {
        const m = await qm.messageByID(db.sql, { id: again.id });
        if (m) return { kind: "sent", message: toMessage(m), target, absent: [] };
      }
      // Posting on a channel right after reading a thread: confirm once.
      const last = store.lastReadOf(from);
      if (row.type !== "thread" && opt.confirm !== true && last && last !== target) return { kind: "confirm", target, lastRead: last };
      // Newer messages it has not seen: show them instead of sending.
      const unseen = (await qm.unseenIn(db.sql, { channel, participant: from })).map((r) => r.id);
      if (unseen.length > 0 && opt.anyway !== true) {
        const now = clock.now();
        const shown: Envelope[] = [];
        for (const id of unseen.slice(0, heldShown)) {
          const m = await qm.messageByID(db.sql, { id });
          if (!m) continue;
          shown.push(envelopeOf(m, target));
        }
        const newest = shown.at(-1);
        if (newest) await store.setRead(from, channel, newest.number, now);
        return { kind: "held", target, shown, more: unseen.length - shown.length };
      }
      // calledBy finds only participants of kind agent, and those are sessions (their ids are session ids).
      const caller = !agents.isOrchestrator(from) ? (await qm.calledBy(db.sql, { speaker: from, channel, before: afterAll }))?.sender_id : undefined;
      const answers = caller === undefined ? undefined : sessionId(caller);
      const run = sessions.runOf(from);
      if (agents.isOrchestrator(from)) await store.seat(from);
      await answered(channel, opt.reply);
      const written = await write({
        channel,
        from,
        kind: "chat",
        text: words,
        ...(answers ? { answers } : {}),
        ...(opt.reply !== undefined ? { replyTo: opt.reply } : {}),
        meta: run ? { run } : {},
      });
      const now2 = clock.now();
      await store.setRead(from, channel, written.row.number, now2);
      return { kind: "sent", message: toMessage(written.row), target, absent: written.absent };
    });

  const postAnnounce = ({ from, channel, text, made, sendKey = "" }: PostOf<"Announce">) =>
    store.locked(async () => {
      const where = store.channel(channel) ? channel : await resolveTarget(from, channel);
      if (!store.channel(where)) throw refused(t("server.channel.channelGone"));
      const run = sessions.runOf(from);
      if (agents.isOrchestrator(from)) await store.seat(from);
      const shown = "card" in made ? { artifact: made.card } : { attachments: await attachmentsOf(made.attachments) };
      const written = await write({
        channel: where,
        from,
        kind: "chat",
        text: text.trim(),
        meta: { ...(run ? { run } : {}), ...shown },
        sendKey,
        ...(from === userId ? { readBy: userId } : {}),
      });
      if (from !== userId) {
        const now = clock.now();
        await store.setRead(from, where, written.row.number, now);
      }
      return toMessage(written.row);
    });

  const postCall = ({ from, text, sendKey }: PostOf<"Call">) =>
    store.locked(async () => {
      if (sendKey.length > sendKeyMax) throw refused(t("server.channel.sendKeyLong"));
      if (!text.trim()) return false;
      try {
        const written = await write({
          channel: store.defaultId(),
          from,
          kind: "chat",
          text: text.trim(),
          meta: { spoken: true },
          sendKey,
          ...(from === userId ? { readBy: userId } : {}),
        });
        return written.again;
      } catch (d) {
        if (d instanceof ApiError) throw d;
        // Words said on a call are best kept, never a reason the call fails: the call goes on without them.
        log.warn(`chat: words said on a call: ${String(d)}`);
        return false;
      }
    });

  const postRun = ({ channel, text, run, from }: PostOf<"Run">) =>
    bestEffort(log, "chat: a run's words", async () => {
      if (!text.trim()) return;
      await store.locked(async () => {
        await store.seat(from);
        await write({ channel, from, kind: "chat", text, meta: run ? { run } : {} });
      });
    });

  const postNotice = ({ channel, text, code, sendKey = "" }: PostOf<"Notice">) =>
    bestEffort(log, "chat: notice", () => store.locked(() => write({ channel, from: "system", kind: "notice", text, meta: { code }, sendKey })));

  // One door; each kind keeps its own checks and answer, and the overloads tie the answer to the kind.
  function post(p: PostOf<"User">): Promise<{ message: T.ChatMessage; again: boolean }>;
  function post(p: PostOf<"Tell">): Promise<T.ChatMessage | undefined>;
  function post(p: PostOf<"Agent">): Promise<Spoken>;
  function post(p: PostOf<"Announce">): Promise<T.ChatMessage>;
  function post(p: PostOf<"Call">): Promise<boolean>;
  function post(p: PostOf<"Run"> | PostOf<"Notice">): Promise<void>;
  function post(p: Post): Promise<{ message: T.ChatMessage; again: boolean } | T.ChatMessage | Spoken | boolean | undefined | void> {
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

  const shape: Channel = {
    user: (input) => {
      core.open();
      return post({
        _tag: "User",
        text: input.text,
        channel: input.channel,
        sendKey: input.envelope,
        source: input.source,
        ...(input.picked ? { picked: input.picked } : {}),
        ...(input.responsePort ? { responsePort: input.responsePort } : {}),
        ...(input.voiceMode ? { voiceMode: input.voiceMode } : {}),
      });
    },
    say: async (text, pick, channel, sendKey, more) => {
      const a = pick.agent ? agents.agent(pick.agent) : undefined;
      const picked: Picked = { ...(a ? { agent: a.id } : {}), ...(pick.repo?.trim() ? { repo: pick.repo.trim() } : {}) };
      core.open();
      await post({
        _tag: "User",
        text,
        channel,
        sendKey,
        ...more,
        ...(picked.agent || picked.repo ? { picked } : {}),
      });
    },
    post,
    userReads: () => userReadHub.subscribe(),
    now: () => core.state().chat,
    ...channelStreams(own, store, said),
    defaultChannel: () => store.defaultId(),
    messageLocation: async (id) => {
      const message = await qm.messageByID(db.sql, { id });
      if (!message) return undefined;
      const row = store.channel(message.channel_id);
      return row ? { channel: toChannel(row), top: channelIdOf(row) } : undefined;
    },
    envelopeResource: async (id) => {
      const message = await qm.messageByID(db.sql, { id });
      if (!message) return undefined;
      const before = [...(await qm.messagesBefore(db.sql, { channel_id: message.channel_id, number: message.number, n: 5 }))].toReversed();
      const after = await qm.messagesAfter(db.sql, { channel_id: message.channel_id, number: message.number, n: 5 });
      const parent =
        message.reply_number === null ? undefined : await qm.messageByNumber(db.sql, { channel_id: message.channel_id, number: message.reply_number });
      return {
        message: toMessage(message),
        attachments: envelopeMore(message, filesAt).attachments ?? [],
        ...(parent === undefined ? {} : { parent: toMessage(parent) }),
        around: [...before, ...after].map(toMessage),
      };
    },
    edit: (id, text, keep) =>
      store.locked(async () => {
        const row = await messageOf(id);
        if (row.sender_id !== userId || row.kind !== "chat" || row.deleted_at !== null) throw refused(t("server.channel.notYours"));
        const meta = metaOf(row.meta);
        const files = keep === undefined ? (meta.attachments ?? []) : (meta.attachments ?? []).filter((a) => keep.includes(a.id));
        const words = text.trim();
        if (!words && files.length === 0) throw refused(t("server.channel.empty"));
        if (words === row.body && files.length === (meta.attachments ?? []).length) return toMessage(row);
        const changed = await change(row, async (revision, now) => {
          await qm.editMessage(db.sql, { body: words, at: now, revision, id });
          if (files.length !== (meta.attachments ?? []).length) await qm.setEmbeds(db.sql, { meta: metaText({ ...meta, attachments: files }), revision, id });
        });
        if (words !== row.body) embedLater({ ...row, body: words });
        return changed;
      }),
    remove: (id) =>
      store.locked(async () => {
        const row = await messageOf(id);
        if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
        await change(row, (revision, now) => qm.deleteMessage(db.sql, { at: now, revision, id }));
        await sessions.withdraw({ _tag: "Envelope", envelope: id });
      }),
    previewRemove: async (id) => {
      const row = await messageOf(id);
      if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
      const ch = store.channel(row.channel_id);
      const waiting = await sessions.waitingOn(id);
      return {
        does: [
          t("server.channel.deletes", { target: ch ? targetOfChannel(ch) : "", number: row.number, name: row.sender_name, text: lineOf(row.body, lastMax) }),
          ...(waiting > 0 ? [t("server.channel.deletesDeliveries", { n: waiting })] : []),
        ],
      };
    },
    react: (id, who, emoji, on) => store.locked(() => reacting(id, who, emoji, on)),
    pin: (id, on) =>
      store.locked(async () => {
        const row = await messageOf(id);
        if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
        if ((row.pinned_at !== null) === on) return toMessage(row);
        return change(row, (revision, now) => qm.setPinned(db.sql, { pinned_at: on ? now : null, revision, id }));
      }),
    pins: async (channel) => {
      if (!store.channel(channel)) throw missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]);
      return (await qm.pinnedIn(db.sql, { channel_id: channel })).map(toMessage);
    },
    threadUnder: (id) =>
      store.locked(async () => {
        const row = await messageOf(id);
        if (store.channel(row.channel_id)?.type !== "channel") throw refused(t("server.channel.threadOnlyInChannel"));
        const thread = await store.tx(() => store.threadFor({ id: row.id, number: row.number, channel: row.channel_id }, { kind: "talk", id: "", owner: "" }));
        await publishChannel(thread);
        return thread;
      }),
    issueThread: (issue, title, channel) =>
      store.locked(async () => {
        const existing = store.threadOfSubject("issue", issue);
        if (existing) return existing;
        const where = channel ?? store.defaultId();
        if (store.channel(where)?.type !== "channel") throw refused(t("server.channel.threadOnlyInChannel"));
        const written = await write({
          channel: where,
          from: "system",
          kind: "notice",
          text: title,
          thread: { kind: "issue", id: issue, owner: "" },
        });
        return written.thread;
      }),
    issueThreadId: async (issue) => store.threadOfSubject("issue", issue) ?? null,
    issueMessages: async (issue) => {
      const thread = store.threadOfSubject("issue", issue);
      if (!thread) return [];
      return recent(thread, 50);
    },
    search: async (text, channel) => {
      const q = parseSearch(text);
      if (!q.words && !q.from && !q.in && q.has.length === 0 && q.before === undefined && q.after === undefined) throw refused(t("server.channel.empty"));
      let scope = channel ?? "";
      if (q.in) {
        const named = store.channelByName(q.in);
        if (!named) throw missing(t("server.channel.noChannelNamed", { name: q.in, tags: list(channelTags()) }), [lookIn.channel]);
        scope = named.id;
      }
      const rows = await qm.searchMessages(db.sql, {
        text: q.words,
        channel: scope,
        sender: q.from ?? "",
        has_file: q.has.includes("file"),
        has_image: q.has.includes("image"),
        has_link: q.has.includes("link"),
        after: q.after ?? 0,
        before: q.before ?? Number.MAX_SAFE_INTEGER,
        n: searchMax,
      });
      return rows.map((r) => ({
        message: toMessage(r),
        channel: r.top_id ?? r.channel_id,
        address: targetOfRow(r.channel_type, r.root_number, null, r.top_id, r.channel_name),
      }));
    },
    placeOf: async (from, channel) => {
      if (store.channel(channel)) return channel;
      return resolveTarget(from, channel);
    },
    read: (who, opt = {}) =>
      store.locked(async () => {
        const channel = await resolveTarget(who, opt.target ?? "");
        const row = store.channel(channel);
        if (!row) throw refused(t("server.channel.channelGone"));
        const target = targetOfChannel(row);
        const limit = opt.limit != null && opt.limit !== 0 ? Math.min(Math.max(opt.limit, 1), 100) : readLimit;
        const cursor = (await qr.readCursor(db.sql, { participant_id: who, channel_id: channel }))?.read_number ?? 0;
        const rows =
          opt.unread === true
            ? await qm.messagesAfter(db.sql, { channel_id: channel, number: cursor, n: limit })
            : [...(await qm.messagesBefore(db.sql, { channel_id: channel, number: opt.before ?? 2147483647, n: limit }))].toReversed();
        const newest = rows.at(-1);
        if (newest && (opt.before == null || opt.before === 0)) await readThrough(who, channel, newest.number);
        store.rememberReadTarget(
          who,
          target,
          (participant) => participant === userId || agents.isOrchestrator(participant) || sessions.isReachable(participant),
        );
        const oldest = rows[0];
        const older = oldest !== undefined && (await qm.messagesBefore(db.sql, { channel_id: channel, number: oldest.number, n: 1 })).length > 0;
        return { target, messages: rows.map((m) => envelopeOf(m, target)), older };
      }),
    unread: (who) =>
      store.locked(async () => {
        try {
          return (await inboxRows(who)).map(({ target, ...r }): T.ChannelUnread => ({ channel: target, ...r }));
        } catch (c) {
          // What is unread is a hint for the one asking: none, said in the log, rather than a failed turn.
          log.warn(`chat: unread of ${who}: ${String(c)}`);
          return [];
        }
      }),
    list: async () => {
      const out: T.Channel[] = [];
      for (const row of [...store.channels("channel"), ...store.channels("direct")]) out.push(await counted(row));
      return out;
    },
    history: async (channel, before, limit) => {
      // A channel as the user names it (general, #general, @fox) as well as by id.
      const at = store.channel(channel) ? channel : await resolveTarget(userId, channel);
      const rows = await qm.messagesBefore(db.sql, { channel_id: at, number: before ?? 2147483647, n: Math.min(Math.max(limit ?? 50, 1), 200) });
      return [...rows].toReversed().map(toMessage);
    },
    markRead: (channel, seq) =>
      store.locked(async () => {
        if (!store.channel(channel)) throw missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]);
        await readThrough(userId, channel, seq);
        await publishChannel(channel);
      }),
    threadOfSession,
    userInThread: () =>
      mapped(core.subscribe(), (e) =>
        e.type === "messageChanged" && e.thread && e.message.actor.kind === "user" && e.message.kind === "chat"
          ? { thread: e.thread, message: e.message }
          : undefined,
      ),
    ...dir,
    boot: start,
    close: async () => {
      th.close();
      await tasks.close();
      r.close();
    },
  };

  // Subscribed now, so nothing told after the service is made is missed; each read one at a time, in order.
  const sessionNews = sessions.news();
  tasks.run("chat: session news", async (signal) => {
    try {
      for (let n = await sessionNews.next(signal); n.done !== true; n = await sessionNews.next(signal)) await onSessionNews(n.value);
    } finally {
      sessionNews.close();
    }
  });
  const directs = said.subscribe();
  tasks.run("chat: direct messages", async (signal) => {
    try {
      for (let m = await directs.next(signal); m.done !== true; m = await directs.next(signal)) onDirectMessage(m.value);
    } finally {
      directs.close();
    }
  });
  const deliveries = sessions.deliveries();
  tasks.run("chat: delivery news", async (signal) => {
    try {
      for (let n = await deliveries.next(signal); n.done !== true; n = await deliveries.next(signal)) {
        const change = n.value;
        switch (change._tag) {
          case "Consumed":
            await bestEffort(log, `chat: 👀 on ${change.envelope}`, () => reacting(change.envelope, change.session, handedEmoji, true));
            break;
          case "Handed":
            break;
          case "Braked":
            await bestEffort(log, `chat: wake breaker for ${change.session}`, async () => {
              const where = (await shape.threadOfSession(change.session)) ?? store.defaultId();
              const name = sessions.sessionOf(change.session)?.name ?? change.session;
              await post({ _tag: "Notice", channel: where, text: t("server.channel.breaker", { name, failed: change.failed }), code: "wake_breaker" });
            });
            break;
        }
      }
    } finally {
      deliveries.close();
    }
  });
  return shape;
}
