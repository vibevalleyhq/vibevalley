// Every message is written to the database with a numbered event; the event goes to the readers (the watch) once it is
// committed, and the write returns once they have handled it.
import { Hub, TaskGroup } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { bounded, type Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import * as qc from "#db/channel.sql.ts";
import * as qe from "#db/channel_event.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";
import * as qs from "#db/channel_seen.sql.ts";

import {
  type AddressedMessage,
  actorOf,
  type ChannelEvent,
  type ChannelHub,
  type ChannelService,
  type ChannelWatchPort,
  channelType,
  envelopeMore,
  type Meta,
  metaOf,
  metaText,
  type MsgRow,
  notifyOf,
  type Noticing,
  type Picked,
  type Place,
  type Posting,
  reactionsOf,
  reactionsText,
  type Saying,
  type Speaking,
  type Spoken,
  subjectKind,
  theRow,
  type ThreadSubject,
  threadTitleMax,
  toMessage,
  type UserRead,
  type Written,
} from "./contracts.ts";
import { channelDirectory } from "./directory.ts";
import { mentionOf, parseChatTarget } from "./mentions.ts";
import { keepChannels, parseSearch, targetOf } from "./messages.ts";
import { type ChannelRow, type ChannelStore, makeChannelStore } from "./store.ts";
import { channelWriting } from "./writing.ts";

const refused = refuseIn(BizCode.ChannelRefused);

const searchMax = 50;
/** Identical text from the same sender and channel within this window is treated as a retry. */
const retryWindowMs = 60_000;
/** How many of the messages a speaker has not seen are shown instead of sending its words. */
const heldShown = 3;
const readLimit = 30;
/** A follower further behind than this reads the room's newest page instead of every message since. */
export const catchUpMax = 200;
const logKeep = 80;
/** The client's key for one send, so a retry of it is the same message. */
const sendKeyMax = 64;
/** How many places a participant's unread lists. */
const unreadMax = 20;
/** How much of a channel's newest message a list shows. */
const lastMax = 80;
const emojiPattern = /^\S{1,16}$/u;

const lineOf = (text: string, n: number) => head(oneLine(text).trim(), n);
const asEvent = (message: T.ChatMessage): T.ChannelEvent => ({ _tag: "Message", message });

function messageMutations(deps: { readonly db: Db; readonly clock: Time }, said: Hub<T.ChatMessage>, publishChannel: (id: string) => Promise<void>) {
  const { db, clock } = deps;
  const messageOf = async (id: T.MessageId) => {
    const row = await qm.messageByID(db.sql, { id });
    if (!row) throw missing(t("server.channel.noMessageId", { id }), [lookIn.channel]);
    return row;
  };

  /** One message changed, in one transaction with the channel's next revision. then it goes to whoever follows its channel as it now is. */
  const change = async (row: MsgRow, work: (revision: number, now: number) => Promise<unknown>) => {
    const now = clock.now();
    await db.tx(async () => {
      const { revision } = theRow(await qc.bumpRevision(db.sql, { id: row.channel_id }), "BumpRevision");
      await work(revision, now);
    });
    const updated = await qm.messageByID(db.sql, { id: row.id });
    const message = toMessage(updated ?? row);
    said.publish(message);
    await publishChannel(row.channel_id);
    return message;
  };

  /** add only adds: a reaction already there is then kept. */
  // Setting the reaction as it already is writes nothing: a retried set is no new revision for every follower.
  const reacting = async (id: T.MessageId, who: string, emoji: string, on: boolean) => {
    const e = emoji.trim();
    if (!emojiPattern.test(e)) throw refused(t("server.channel.badEmoji"));
    const row = await messageOf(id);
    if (row.deleted_at !== null) throw refused(t("server.channel.messageGone"));
    const r = reactionsOf(row.reactions);
    const by = r[e] ?? [];
    if (by.includes(who) === on) return toMessage(row);
    r[e] = on ? [...by, who] : by.filter((x) => x !== who);
    return change(row, (revision) => qm.setReactions(db.sql, { reactions: reactionsText(r), revision, id }));
  };

  return { messageOf, change, reacting };
}

function channelStreams(
  deps: { readonly db: Db; readonly log: Logger },
  store: Pick<ChannelStore, "channel">,
  said: Hub<T.ChatMessage>,
): Pick<ChannelService, "follow" | "reports"> {
  const { db, log } = deps;
  return {
    follow: async function* (channel, after, signal) {
      if (!store.channel(channel)) throw refused(t("server.channel.channelGone"));
      // Subscribed before the missed ones are read: nothing changed in between falls through, and what both have is
      // dropped by its revision.
      const live = said.subscribe();
      try {
        const missed = await qm.messagesChangedAfter(db.sql, { channel_id: channel, revision: after, n: catchUpMax + 1 });
        if (missed.length > catchUpMax) {
          yield { _tag: "Reset" };
          return;
        }
        const upto = missed.at(-1)?.revision ?? after;
        for (const m of missed) yield asEvent(toMessage(m));
        for await (const m of bounded(live, "chat.follow", log, 64, signal)) if (m.channel === channel && m.revision > upto) yield asEvent(m);
      } finally {
        live.close();
      }
    },
    reports: async function* (after, signal) {
      const live = said.subscribe();
      try {
        const missed =
          after === undefined
            ? [...(await qm.recentReports(db.sql, { n: logKeep }))].toReversed()
            : await qm.reportsAfter(db.sql, { after, n: catchUpMax + 1 });
        if (missed.length > catchUpMax) {
          yield { _tag: "Reset" };
          return;
        }
        const upto = missed.at(-1)?.id ?? after ?? "";
        for (const m of missed) yield asEvent(toMessage(m));
        for await (const m of bounded(live, "chat.reports", log, 64, signal)) if (m.kind === "report" && m.id > upto) yield asEvent(m);
      } finally {
        live.close();
      }
    },
  };
}

/** The chat's shared state and the ways it is told: the store, the hubs of what was said and read, and the frames. */
async function makeChannelHub(deps: { readonly clock: Time; readonly db: Db; readonly core: Core; readonly attachment: Attachment }): Promise<ChannelHub> {
  const { core, db, clock } = deps;
  const store = await makeChannelStore(deps);
  // Every message once written, for the rooms: each follower reads it through a bounded relay of its own.
  const said = new Hub<T.ChatMessage>();
  const userReadHub = new Hub<UserRead>();

  /** An orchestrator: an agent seated to speak as itself, for no other profile (the layers above seat them), not gone. */
  const isOrchestratorSeat = (id: string) => {
    const p = store.participant(id);
    return p?.kind === "agent" && p.agent_id === null && p.left_at === null;
  };
  const orchestratorSeats = () =>
    store
      .participants()
      .filter((p) => isOrchestratorSeat(p.id))
      .map((p) => p.id);

  /** A place's channel or direct channel: itself, or the one a thread hangs in. */
  const topOfRow = (row: ChannelRow | undefined): ChannelRow | undefined =>
    row?.type === "thread" ? topOfRow(row.parent_id !== null ? store.channel(row.parent_id) : undefined) : row;
  /** Who is in the channel a place is in; a direct channel has its other one instead. */
  const membersOfRow = (row: ChannelRow | undefined): string[] => {
    const top = topOfRow(row);
    return top === undefined || top.type === "direct" ? [] : store.membersOf(top.id);
  };
  /** The orchestrator a place's words go to when they name no one: a direct channel's peer when it is one; otherwise the
   * default orchestrator when it is a member, the first orchestrator member, or the default orchestrator. */
  const orchestratorInRow = (row: ChannelRow | undefined): string => {
    const top = topOfRow(row);
    if (top?.type === "direct") return top.peer_id !== null && isOrchestratorSeat(top.peer_id) ? top.peer_id : defaultOrchestrator;
    const members = membersOfRow(row);
    if (members.includes(defaultOrchestrator)) return defaultOrchestrator;
    return members.find(isOrchestratorSeat) ?? defaultOrchestrator;
  };

  /** A channel's name; none for a thread or what is not there. */
  const channelName = (id: string) => {
    const c = store.channel(id);
    return c && c.type !== "thread" ? (c.name ?? undefined) : undefined;
  };
  const channelTags = () =>
    store
      .channels()
      .flatMap((c) => (c.name !== null ? [c] : []))
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => "#" + c.name);
  const channelIdOf = (row: ChannelRow) => (row.type === "thread" ? (row.parent_id ?? row.id) : row.id);
  /** Where the user talks with peer alone, from either side. */
  const directWith = (who: string, other: string) => {
    const peer = who === userId ? other : other === userId ? who : "";
    return store.channels("direct").find((c) => c.peer_id === peer);
  };

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
    const read = store.userReadIn(row.id);
    const sk = subjectKind(row.subject_kind);
    return {
      id: row.id,
      type: channelType(row.type),
      default: row.is_default,
      ...(row.peer_id !== null ? { peer: row.peer_id } : {}),
      orchestrator: orchestratorInRow(row),
      ...(row.type === "direct" ? {} : { members: store.membersOf(row.id) }),
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

  /** What a page lists a channel with: the user's unread there, and a thread's title when its subject does not
   * name it (a page keeps no messages to name it by). */
  const counted = async (row: ChannelRow) => {
    // Set to none it counts nothing; to mentions, only what names the user and is not handled yet.
    const n =
      row.notify === "none"
        ? 0
        : row.notify === "mentions"
          ? (await qm.userMentions(db.sql)).filter((m) => m.channel_id === row.id).length
          : theRow(await qm.userUnread(db.sql, { channel_id: row.id, read_number: store.userReadIn(row.id) ?? 0 }), "UserUnread").n;
    const sk = subjectKind(row.subject_kind);
    let title = "";
    if (row.type === "thread" && row.name) title = row.name;
    else if (row.type === "direct" && row.peer_id) title = store.participant(row.peer_id)?.name ?? "";
    else if (row.type === "thread" && sk === "talk" && row.subject_id) title = store.participant(row.subject_id)?.name ?? "";
    // Any other thread (one opened under a message, with no session of its own) by the message it hangs under.
    if (!title && row.type === "thread" && row.root_id) title = lineOf((await qm.messageByID(db.sql, { id: row.root_id }))?.body ?? "", threadTitleMax);
    const last =
      row.last_number != null && row.last_number !== 0 ? await qm.messageByNumber(db.sql, { channel_id: row.id, number: row.last_number }) : undefined;
    return toChannel(row, n ?? 0, title, last);
  };

  const publishChannel = async (id: string) => {
    const row = store.channel(id);
    if (row) {
      const channel = await counted(row);
      // A metadata change can read a message's number before the message's own fact is applied.
      const published = store.publishedNumber(id);
      const last = published !== undefined && (channel.lastNumber ?? 0) > published ? published : channel.lastNumber;
      core.apply({ type: "channelChanged", channel: { ...channel, ...(last === undefined ? {} : { lastNumber: last }) } });
    }
  };

  const publishUserMentions = async () => {
    // A place set to none tells the user of nothing, its mentions included.
    const quiet = (id: string | null) => id !== null && store.channel(id)?.notify === "none";
    const rows = (await qm.userMentions(db.sql)).filter((r) => !quiet(r.channel_id) && !quiet(r.top_id));
    core.apply({
      type: "userMentionsChanged",
      mentions: rows.map((r) => ({
        message: toMessage(r),
        channel: r.top_id ?? store.defaultId(),
        address: targetOfRow(r.channel_type, r.root_number, null, r.top_id, r.channel_name),
      })),
    });
  };

  const publishMessage = (row: MsgRow, answers: T.SessionId | undefined) => {
    const ch = store.channel(row.channel_id);
    const thread = ch?.type !== "channel" && ch?.subject_kind === "issue" && ch.subject_id ? ch.subject_id : undefined;
    const message = toMessage(row);
    core.apply({ type: "messageChanged", message, ...(thread ? { thread } : {}), ...(answers ? { answers } : {}) });
    store.notePublished(row.channel_id, row.number);
    said.publish(message);
  };

  const threadOf = (subject: ThreadSubject) => store.threadOfSubject(subject.kind, subject.id);

  /** Where an empty target means for a participant: the home it was given, while that place is there. */
  const homeOf = (participant: string): string | undefined => {
    const home = store.participant(participant)?.home_id ?? null;
    return home !== null && store.channel(home) ? home : undefined;
  };

  /** Tool reads advance the cursor; passive input consumption belongs to Session receipts. */
  const readUpTo = (who: string, channel: string, upto: number) => store.setRead(who, channel, upto, clock.now());
  const readThrough = async (who: string, channel: string, upto: number) => {
    await store.tx(() => readUpTo(who, channel, upto));
    if (who === userId) {
      userReadHub.publish({ channel, number: upto, at: clock.now() });
      await publishUserMentions();
    }
  };

  const { messageOf, change, reacting } = messageMutations({ db, clock }, said, publishChannel);

  const files = deps.attachment;
  const filesAt = files.pathOf;
  const attachmentsOf = files.of;
  /** A participant's unread, as a wake-up and an inbox list them: the channel given, or the one its home is in (or the default one), and
   * the threads it follows, newest first, at most unreadMax. */
  const unreadOf = async (who: string, inChannel?: string): Promise<T.ChannelUnread[]> => {
    const home = homeOf(who);
    const channel = inChannel ?? (home !== undefined ? topOfRow(store.channel(home))?.id : undefined) ?? store.defaultId();
    return (await qc.unreadOf(db.sql, { participant: who, channel })).slice(0, unreadMax).map((row) => ({
      channel: targetOf({ type: channelType(row.type), ...(row.root_number !== null ? { rootNumber: row.root_number } : {}) }, row.channel_name || ""),
      unread: row.unread,
      mentionsYou: row.mentions_you,
      ...(row.latest_sender_name ? { latest: row.latest_sender_name } : {}),
    }));
  };

  await store.locked(async () => {
    const recent = await qc.recentChannels(db.sql, { n: keepChannels });
    for (const c of [...recent].toReversed()) core.apply({ type: "channelChanged", channel: await counted(c) });
    await publishUserMentions();
  });

  const placeOf = (row: ChannelRow): Place => {
    const kind = subjectKind(row.subject_kind);
    return {
      id: row.id,
      type: channelType(row.type),
      peer: row.peer_id,
      parent: row.parent_id,
      name: row.name,
      lastNumber: row.last_number ?? 0,
      ...(row.root_id !== null && row.root_number !== null ? { root: { id: row.root_id, number: row.root_number } } : {}),
      ...(kind !== undefined && row.subject_id !== null ? { topic: { kind, id: row.subject_id } } : {}),
    };
  };

  const addressedOf = (row: MsgRow): AddressedMessage => {
    const place = store.channel(row.channel_id);
    return {
      id: S.messageId(row.id),
      number: row.number,
      target: place ? targetOfChannel(place) : "",
      from: row.sender_id,
      actor: actorOf(row.sender_kind, row.sender_agent, row.sender_id, row.sender_name),
      name: row.sender_name,
      text: row.body,
      ...envelopeMore(row, filesAt),
    };
  };
  return {
    store,
    said,
    userReadHub,
    isOrchestratorSeat,
    orchestratorSeats,
    orchestratorInRow,
    membersOfRow,
    channelTags,
    channelIdOf,
    directWith,
    targetOfRow,
    targetOfChannel,
    toChannel,
    counted,
    publishChannel,
    publishUserMentions,
    publishMessage,
    threadOf,
    homeOf,
    topOfRow,
    readUpTo,
    readThrough,
    change,
    messageOf,
    reacting,
    attachmentsOf,
    filesAt,
    unreadOf,
    addressedOf,
    placeOf,
    /** Readers of the hubs see their end. */
    close: () => {
      said.end();
      userReadHub.end();
    },
  };
}

export type { ChannelWatchPort, Spoken } from "./contracts.ts";

export type Channel = ChannelService;

export interface ChannelDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly db: Db;
  readonly core: Core;
  readonly attachment: Attachment;
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
        ...(more.viewContext ? { viewContext: more.viewContext } : {}),
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

  const watchPort: ChannelWatchPort = {
    committed: w.committed,
    events: async (after, n = 1000) =>
      (await qe.eventsAfter(db.sql, { after, n })).map((e) => ({
        seq: e.seq,
        kind: e.kind === "removed" ? "removed" : "posted",
        channel: e.channel_id,
        message: S.messageId(e.message_id),
        at: e.at,
      })),
    committedOf: (message) =>
      store.locked(async () => {
        const row = await qm.messageByID(db.sql, { id: message });
        const e = await qe.eventOf(db.sql, { message_id: message });
        if (!row || !e || row.deleted_at !== null) return undefined;
        return committedFrom(row, { seq: e.seq, kind: "posted", channel: e.channel_id, message: S.messageId(e.message_id), at: e.at });
      }),
    awaitReader: w.awaitReader,
    seat: (p) => store.locked(() => store.tx(() => store.seat(p))),
    leave: (participant) => store.locked(() => store.markParticipantLeft(participant, clock.now())),
    participants: () =>
      store.participants().map((p) => ({ id: p.id, kind: p.kind, name: p.name, agent: p.agent_id, home: p.home_id, left: p.left_at !== null })),
    createDirect: dir.createDirect,
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
    userReads: () => userReadHub.subscribe(),
    userReceipt: async (id) => {
      const row = await qm.messageByID(db.sql, { id });
      if (!row || row.deleted_at !== null) return undefined;
      const receipt = await qm.notificationReceipt(db.sql, { id });
      if (!receipt) return undefined;
      return { message: toMessage(row), readAt: receipt.read_at, superseded: receipt.superseded };
    },
    userReadReports: async () => (await qm.userReadReports(db.sql)).map((r) => ({ from: r.sender_id, at: r.created_at, readAt: r.updated_at })),
    notifyOf: dir.notifyOf,
  };

  const shape: Channel = {
    say,
    speak,
    post,
    notice,
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
    openThreadAbout: (kind, id, title, channel) =>
      store.locked(async () => {
        const existing = store.threadOfSubject(kind, id);
        if (existing) return existing;
        const where = channel ?? store.defaultId();
        if (store.channel(where)?.type !== "channel") throw refused(t("server.channel.threadOnlyInChannel"));
        const written = await write({
          channel: where,
          from: "system",
          kind: "notice",
          text: title,
          thread: { kind, id, owner: "" },
        });
        return written.thread;
      }),
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
    ...dir,
    ...watchPort,
    close: async () => {
      await tasks.close();
      w.close();
      r.close();
    },
  };

  return shape;
}
