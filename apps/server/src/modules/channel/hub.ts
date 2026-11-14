import { Hub } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import * as qc from "#db/channel.sql.ts";
import * as qm from "#db/channel_message.sql.ts";

import {
  type MsgRow,
  actorOf,
  channelType,
  subjectKind,
  toMessage,
  notifyOf,
  envelopeMore,
  type ThreadSubject,
  type AddressedMessage,
  type Place,
  theRow,
  type UserRead,
} from "./contracts.ts";
import { keepChannels, targetOf } from "./messages.ts";
import { messageMutations } from "./mutations.ts";
import type { ChannelRow } from "./rooms.ts";
import { makeChannelStore } from "./store.ts";

/** A thread named by the message it hangs under shows this much of it. */
export const threadTitleMax = 24;
/** How many places a participant's unread lists. */
const unreadMax = 20;
/** How much of a channel's newest message a list shows. */
export const lastMax = 80;
/** The first n units of text, on one line. */
export const lineOf = (text: string, n: number) => head(oneLine(text).trim(), n);

export interface ChannelHubDeps {
  readonly clock: Time;
  readonly db: Db;
  readonly core: Core;
  readonly attachment: Attachment;
}

/** The chat's shared state and the ways it is told: the store, the hubs of what was said and read, and the frames. */
export async function makeChannelHub(deps: ChannelHubDeps) {
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

export type ChannelHub = Awaited<ReturnType<typeof makeChannelHub>>;
