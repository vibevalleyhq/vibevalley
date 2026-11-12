// Every message is written to the database with a numbered event; the event goes to the readers (the watch) once it is
// committed, and the write returns once they have handled it.
import { type Subscription, TaskGroup } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";

import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";
import * as qe from "#db/channel_event.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";
import * as qs from "#db/channel_seen.sql.ts";

import {
  type AddressedMessage,
  type ChannelEvent,
  type ChannelService,
  envelopeMore,
  type Meta,
  metaOf,
  metaText,
  type Noticing,
  type Picked,
  type Posting,
  type Saying,
  type Speaking,
  type Spoken,
  theRow,
  type Written,
  toMessage,
} from "./contracts.ts";
import { channelDirectory } from "./directory.ts";
import { makeChannelHub, lastMax, lineOf } from "./hub.ts";
import { mentionOf, parseChatTarget } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { channelStreams } from "./mutations.ts";
import { channelWriting } from "./writing.ts";

const refused = refuseIn(BizCode.ChannelRefused);

const searchMax = 50;
/** Identical text from the same sender and channel within this window is treated as a retry. */
const retryWindowMs = 60_000;
/** How many of the messages a speaker has not seen are shown instead of sending its words. */
const heldShown = 3;
const readLimit = 30;
/** A follower further behind than this reads the room's newest page instead of every message since. */
export { catchUpMax } from "./mutations.ts";
/** The client's key for one send, so a retry of it is the same message. */
const sendKeyMax = 64;

export type { Spoken } from "./contracts.ts";

export type Channel = ChannelService;

export interface ChannelDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly db: Db;
  readonly core: Core;
  readonly attachment: Attachment;
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
  const { core, db, clock } = deps;
  const log = deps.log.child("channel");
  const tasks = new TaskGroup({ name: "channel", onError: (task, e) => log.warn(`${task} failed`, e) });
  const own = { ...deps, log };
  const r = await makeChannelHub(own);
  const dir = channelDirectory(own, r);
  const w = channelWriting(own, r, tasks);
  const {
    store,
    isOrchestratorSeat,
    said,
    userReadHub,
    channelTags,
    channelIdOf,
    directWith,
    homeOf,
    targetOfRow,
    targetOfChannel,
    toChannel,
    counted,
    publishChannel,
    readThrough,
    messageOf,
    change,
    reacting,
    attachmentsOf,
    filesAt,
    unreadOf,
    addressedOf,
    placeOf,
  } = r;
  const { write, handled, embedLater, removed, committedFrom } = w;

  /** A target as who would mean it: empty is a session's own thread (or the default channel), a channel by name, or a thread by its parent's number. */
  const resolveTarget = async (who: string, target: string): Promise<string> => {
    if (!target.trim()) return homeOf(who) ?? store.defaultId();
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

  const say = async ({ text, channel, sendKey, source, responsePort, voiceMode, ...more }: Saying) => {
    const written = await store.locked(async (): Promise<Written> => {
      core.open();
      const files = await attachmentsOf(more.attachments ?? []);
      if (!text.trim() && files.length === 0) throw refused(t("server.channel.empty"));
      if (sendKey.length > sendKeyMax) throw refused(t("server.channel.sendKeyLong"));
      if (more.to !== undefined && !isOrchestratorSeat(more.to)) throw refused(t("server.channel.notOrchestrator", { id: more.to }));
      // A channel as the user names it (general, #general, @fox) as well as by id; none is the default one.
      const where = channel === undefined || store.channel(channel) ? (channel ?? store.defaultId()) : await resolveTarget(userId, channel);
      if (!store.channel(where)) throw missing(t("server.channel.noChannel", { id: where }), [lookIn.channel]);
      await answered(where, more.replyTo);
      const picked: Picked = {
        ...(more.picked?.agent ? { agent: more.picked.agent } : {}),
        ...(more.picked?.repo?.trim() ? { repo: more.picked.repo.trim() } : {}),
      };
      const meta: Meta = {
        ...(more.to !== undefined ? { ingressRecipient: more.to } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        ...(picked.agent || picked.repo ? { picked } : {}),
        ...((more.blocks?.length ?? 0) > 0 ? { blocks: more.blocks } : {}),
        ...(source ? { ingressSource: source } : {}),
        ...(source === "voice" ? { spoken: true } : {}),
        ...(responsePort ? { responsePort } : {}),
        ...(voiceMode ? { voiceMode } : {}),
      };
      const written = await write({
        channel: where,
        from: userId,
        kind: "chat",
        text: text.trim(),
        sendKey,
        readBy: userId,
        ...(more.replyTo !== undefined ? { replyTo: more.replyTo } : {}),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      });
      if (!written.again && written.absent.length > 0)
        core.notice(
          "warn",
          t("server.channel.absent", { who: list(written.absent.map((mention) => mentionOf(mention) ?? "@" + mention)), n: written.absent.length }),
        );
      return written;
    });
    await handled(written);
    return { message: toMessage(written.row), again: written.again };
  };

  const recent = async (channel: string, n: number): Promise<AddressedMessage[]> => {
    if (!store.channel(channel)) return [];
    return [...(await qm.messagesBefore(db.sql, { channel_id: channel, number: 2147483647, n }))].toReversed().map(addressedOf);
  };
  const speak = async ({ from, text, run, ...opt }: Speaking): Promise<Spoken> => {
    let written: Written | undefined;
    const spoken = await store.locked(async (): Promise<Spoken> => {
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
        const shown: AddressedMessage[] = [];
        for (const id of unseen.slice(0, heldShown)) {
          const m = await qm.messageByID(db.sql, { id });
          if (!m) continue;
          shown.push(addressedOf(m));
        }
        const newest = shown.at(-1);
        if (newest) await store.setRead(from, channel, newest.number, now);
        return { kind: "held", target, shown, more: unseen.length - shown.length };
      }
      await answered(channel, opt.reply);
      written = await write({
        channel,
        from,
        kind: "chat",
        text: words,
        ...(opt.reply !== undefined ? { replyTo: opt.reply } : {}),
        meta: run ? { run } : {},
      });
      await store.setRead(from, channel, written.row.number, clock.now());
      return { kind: "sent", message: toMessage(written.row), target, absent: written.absent };
    });
    if (written) await handled(written);
    return spoken;
  };

  const post = async ({ from, channel, text, run, sendKey = "", made, spoken }: Posting) => {
    const written = await store.locked(async (): Promise<Written> => {
      if (sendKey.length > sendKeyMax) throw refused(t("server.channel.sendKeyLong"));
      if (!text.trim() && made === undefined) throw refused(t("server.channel.empty"));
      const where = store.channel(channel) ? channel : await resolveTarget(from, channel);
      if (!store.channel(where)) throw refused(t("server.channel.channelGone"));
      const shown = made === undefined ? {} : "card" in made ? { artifact: made.card } : { attachments: await attachmentsOf(made.attachments) };
      return write({
        channel: where,
        from,
        kind: "chat",
        text: text.trim(),
        meta: { ...(run ? { run } : {}), ...(spoken === true ? { spoken } : {}), ...shown },
        sendKey,
        readBy: from,
      });
    });
    await handled(written);
    return { message: toMessage(written.row), again: written.again };
  };

  const notice = ({ channel, text, code, sendKey = "", untilUserSpeaks }: Noticing) =>
    bestEffort(log, "chat: notice", () =>
      store.locked(async () => {
        if (untilUserSpeaks === true && theRow(await qm.noticeSinceUser(db.sql, { channel, code }), "NoticeSinceUser").n > 0) return;
        await write({ channel, from: "system", kind: "notice", text, meta: { code }, sendKey });
      }),
    );

  const shape: Channel = {
    say,
    speak,
    post,
    notice,
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
    remove: async (id) => {
      const event = await store.locked(async () => {
        const row = await messageOf(id);
        if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
        let event: ChannelEvent | undefined;
        await change(row, async (revision, now) => {
          await qm.deleteMessage(db.sql, { at: now, revision, id });
          const { seq } = theRow(await qe.insertEvent(db.sql, { kind: "removed", channel_id: row.channel_id, message_id: id, at: now }), "InsertEvent");
          event = { seq, kind: "removed", channel: row.channel_id, message: id, at: now };
        });
        if (event) await removed(event);
        return event;
      });
      if (event) await handled({ event });
    },
    previewRemove: async (id) => {
      const row = await messageOf(id);
      if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
      const ch = store.channel(row.channel_id);
      return {
        does: [
          t("server.channel.deletes", { target: ch ? targetOfChannel(ch) : "", number: row.number, name: row.sender_name, text: lineOf(row.body, lastMax) }),
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
        store.rememberReadTarget(who, target, (participant) => store.participant(participant)?.left_at === null);
        const oldest = rows[0];
        const older = oldest !== undefined && (await qm.messagesBefore(db.sql, { channel_id: channel, number: oldest.number, n: 1 })).length > 0;
        return { target, messages: rows.map(addressedOf), older };
      }),
    unread: (who, channel) =>
      store.locked(async () => {
        try {
          return await unreadOf(who, channel);
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
    homeOf: async (participant) => homeOf(participant),
    userReceipt: async (id) => {
      const row = await qm.messageByID(db.sql, { id });
      if (!row || row.deleted_at !== null) return undefined;
      const receipt = await qm.notificationReceipt(db.sql, { id });
      if (!receipt) return undefined;
      return { message: toMessage(row), readAt: receipt.read_at, superseded: receipt.superseded };
    },
    userReadReports: async () => (await qm.userReadReports(db.sql)).map((r) => ({ from: r.sender_id, at: r.created_at, readAt: r.updated_at })),
    committed: w.committed,
    events: async (after, n = 1000) =>
      (await qe.eventsAfter(db.sql, { after, n })).map((e) => ({
        seq: e.seq,
        kind: e.kind === "removed" ? "removed" : "posted",
        channel: e.channel_id,
        message: e.message_id,
        at: e.at,
      })),
    committedOf: (message) =>
      store.locked(async () => {
        const row = await qm.messageByID(db.sql, { id: message });
        const e = await qe.eventOf(db.sql, { message_id: message });
        if (!row || !e || row.deleted_at !== null) return undefined;
        return committedFrom(row, { seq: e.seq, kind: "posted", channel: e.channel_id, message: e.message_id, at: e.at });
      }),
    awaitReader: w.awaitReader,
    seat: (p) => store.locked(() => store.tx(() => store.seat(p))),
    leave: (participant) => store.locked(() => store.markParticipantLeft(participant, clock.now())),
    participants: () =>
      store.participants().map((p) => ({ id: p.id, kind: p.kind, name: p.name, agent: p.agent_id, home: p.home_id, left: p.left_at !== null })),
    addFollower: (channel, participant) =>
      store.locked(async () => {
        const row = store.channel(channel);
        if (row) await store.tx(() => store.addMember(channel, participant, "user", row.last_number ?? 0));
      }),
    membersOf: (channel) => store.membersOf(channel),
    threadAbout: (kind, id) => store.threadOfSubject(kind, id),
    place: (id) => {
      const row = store.channel(id);
      return row ? placeOf(row) : undefined;
    },
    markSeen: async (participant, message) => {
      await qs.markSeen(db.sql, { participant_id: participant, message_id: message, seen_at: clock.now() });
    },
    readUpTo: (participant, channel, number) => store.locked(() => store.tx(() => store.setRead(participant, channel, number, clock.now()))),
    latest: async (channel) => theRow(await qm.latestNumber(db.sql, { channel_id: channel }), "LatestNumber").n ?? 0,
    dispatches: async (thread) => theRow(await qm.dispatchesIn(db.sql, { channel_id: thread }), "DispatchesIn").n ?? 0,
    recentRows: async (channel, n) => [...(await qm.messagesBefore(db.sql, { channel_id: channel, number: 2147483647, n }))].toReversed(),
    rowsAfter: (channel, after) => qm.messagesAfter(db.sql, { channel_id: channel, number: after, n: 1000 }),
    addressedOf,
    note: async (n) => {
      const written = await store.locked(() =>
        write({
          channel: n.channel,
          from: n.from,
          kind: n.kind,
          text: n.text,
          meta: n.meta,
          ...(n.topic ? { thread: n.topic } : {}),
          ...(n.member ? { member: n.member } : {}),
        }),
      );
      await handled(written);
      return { thread: written.thread };
    },
    userInThread: () =>
      mapped(core.subscribe(), (e) =>
        e.type === "messageChanged" && e.thread && e.message.actor.kind === "user" && e.message.kind === "chat"
          ? { thread: e.thread, message: e.message }
          : undefined,
      ),
    ...dir,
    close: async () => {
      await tasks.close();
      w.close();
      r.close();
    },
  };

  return shape;
}
