import { Hub, mapConcurrent, type TaskGroup } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { everyone, userId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Inconsistent } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as qc from "#db/channel.sql.ts";
import * as qe from "#db/channel_event.sql.ts";
import * as qmn from "#db/channel_mention.sql.ts";
import * as qm from "#db/channel_message.sql.ts";

import {
  type ChannelEvent,
  type Committed,
  channelType,
  metaOf,
  metaText,
  type MsgRow,
  subjectKind,
  type Told,
  type Write,
  type Written,
  theRow,
} from "./contracts.ts";
import { linksIn, readEmbed } from "./embeds.ts";
import type { ChannelHub } from "./hub.ts";
import { mentionsIn } from "./mentions.ts";

export interface ChannelWritingDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly db: Db;
}

/** How many of those who named a speaker since it last spoke a caller is looked for among. */
const callersMax = 20;

/** tasks: the channel's own, so the work a message sets off ends with the service. */
export function channelWriting(deps: ChannelWritingDeps, r: ChannelHub, tasks: TaskGroup) {
  const { db, clock, log } = deps;
  const {
    store,
    orchestratorSeats,
    orchestratorInRow,
    isOrchestratorSeat,
    membersOfRow,
    publishChannel,
    publishUserMentions,
    publishMessage,
    readUpTo,
    change,
    placeOf,
  } = r;
  const toldHub = new Hub<Told>();
  const readers: ((seq: number) => Promise<void>)[] = [];
  /** A helper's seat in the chat: an agent's participant speaking for a profile, there until it leaves. */
  const isHelper = (p: { readonly kind: string; readonly agent_id: string | null; readonly left_at: number | null }) =>
    p.kind === "agent" && p.agent_id !== null && p.left_at === null;

  /** The chat's part of a message being written, in its transaction: who it names, and who follows the thread from it. */
  const settle = async (inserted: MsgRow): Promise<{ readonly row: MsgRow; readonly absent: string[] }> => {
    let row = inserted;
    const ch = store.channel(row.channel_id);
    if (!ch) throw new Inconsistent(`no channel ${row.channel_id}`);
    const meta = metaOf(row.meta);
    const orchestrators = orchestratorSeats();
    const here = orchestratorInRow(ch);
    // No one else is in a direct channel to be named.
    const mentions = ch.type === "direct" ? [] : mentionsIn(row.body, { here, orchestrators });
    // Who is here to be named: the orchestrators, the user, everyone, and the helpers seated and not gone.
    const present = new Set(
      store
        .participants()
        .filter(isHelper)
        .map((p) => p.id),
    );
    const known = new Set(store.participants().map((p) => p.id));
    const named: { id: string; how: "delivered" | "absent" | "unknown" }[] = [];
    for (const m of mentions) {
      const how = orchestrators.includes(m) || m === userId || m === everyone || present.has(m) ? "delivered" : known.has(m) ? "absent" : "unknown";
      named.push({ id: m, how });
      await qmn.insertMention(db.sql, { message_id: row.id, target_id: m, resolved: how });
    }
    if (mentions.length > 0) {
      row = { ...row, meta: metaText({ ...meta, mentions }) };
      await qm.updateMessageMeta(db.sql, { meta: row.meta, id: row.id });
    }
    if (ch.type === "thread") {
      // A dispatch handing the issue to its next session makes no one a member: the orchestrator would be woken by every word in it.
      if (row.sender_id !== "system" && row.kind !== "dispatch") await store.addMember(ch.id, row.sender_id, "replied", row.number);
      for (const m of named)
        if (m.how === "delivered" && (orchestrators.includes(m.id) || present.has(m.id))) await store.addMember(ch.id, m.id, "mentioned", row.number - 1);
    }
    return { row, absent: named.filter((m) => m.how !== "delivered").map((m) => m.id) };
  };

  /** A committed message with what the chat knows now of where it was said: what a reader routes on. */
  const committedFrom = (row: MsgRow, event: ChannelEvent): Committed | undefined => {
    const ch = store.channel(row.channel_id);
    if (!ch) return undefined;
    const kind = subjectKind(ch.subject_kind);
    const topic = ch.type !== "channel" && kind !== undefined && ch.subject_id !== null ? { kind, id: ch.subject_id } : undefined;
    return {
      event,
      row,
      place: placeOf(ch),
      channelName: (ch.parent_id !== null ? store.channel(ch.parent_id)?.name : undefined) ?? ch.name ?? "",
      mentions: metaOf(row.meta).mentions ?? [],
      channel: { type: channelType(ch.type), ...(ch.peer_id !== null ? { peer: ch.peer_id } : {}) },
      orchestrator: orchestratorInRow(ch),
      channelMembers: membersOfRow(ch),
      members: ch.type === "thread" ? store.membersOf(ch.id) : [],
      ...(topic ? { topic } : {}),
    };
  };

  /** A helper's words answer the session that last named it there since it last spoke: a session's seat, not an orchestrator's. */
  const answersOf = async (row: MsgRow): Promise<T.SessionId | undefined> => {
    if (row.kind !== "chat" || row.sender_kind !== "agent" || isOrchestratorSeat(row.sender_id)) return undefined;
    const callers = await qm.callersOf(db.sql, { speaker: row.sender_id, channel: row.channel_id, before: row.id, n: callersMax });
    const caller = callers.find((c) => {
      const p = store.participant(c.sender_id);
      return p !== undefined && p.kind === "agent" && p.agent_id !== null;
    });
    return caller === undefined ? undefined : sessionId(caller.sender_id);
  };

  /** Each event goes to the readers once it is committed, in the order committed (the chat's lock keeps it). */
  const tell = (told: Told) => db.afterCommit(() => toldHub.publish(told));

  /** The write that made `written` returns once every reader has handled its event (after the commit it may be inside). */
  const handled = async (written: { readonly event?: ChannelEvent }): Promise<void> => {
    const event = written.event;
    if (!event || readers.length === 0) return;
    await db.afterCommit(async () => {
      for (const reader of readers) await reader(event.seq);
    });
  };

  const write = async (w: Write): Promise<Written> => {
    const written = await store.tx(async (): Promise<Written> => {
      if (w.sendKey) {
        const seen = await qm.messageBySendKey(db.sql, { sender_id: w.from, send_key: w.sendKey });
        if (seen) return { absent: [], thread: "", again: true, row: seen };
      }
      // The row as MessageByID would read it back: the sender's name and kind are the participant's.
      const sender = store.participant(w.from);
      if (!sender) throw new Inconsistent(`no participant ${w.from}`);
      const id = newId();
      const meta = metaText(w.meta);
      const created_at = clock.now();
      const { revision } = theRow(await qc.bumpRevision(db.sql, { id: w.channel }), "BumpRevision");
      const { number } = theRow(
        await qm.insertMessage(db.sql, {
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
        "InsertMessage",
      );
      await store.touchChannel(w.channel, number);
      const { seq } = theRow(await qe.insertEvent(db.sql, { kind: "posted", channel_id: w.channel, message_id: id, at: created_at }), "InsertEvent");
      const inserted: MsgRow = {
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
      const { row, absent } = await settle(inserted);
      const out: Written = { absent, thread: "", again: false, row, event: { seq, kind: "posted", channel: w.channel, message: id, at: created_at } };
      if (w.readBy) await readUpTo(w.readBy, w.channel, number);
      if (w.member) await store.addMember(w.channel, w.member, "user", number);
      if (w.thread) out.thread = await store.threadFor({ id, number, channel: w.channel }, w.thread);
      return out;
    });
    if (written.again || !written.event) return written;
    const answers = await answersOf(written.row);
    const complete = { ...written, ...(answers ? { answers } : {}) };
    await after(w.channel, complete);
    const posted = committedFrom(complete.row, written.event);
    if (posted) await tell({ kind: "posted", posted });
    return complete;
  };

  /** The previews of a message's links, read after it is out (the server's own requests take seconds) and then put on
   * it as a change. */
  const embedLater = (row: MsgRow) => {
    const links = row.kind === "chat" && row.deleted_at === null ? linksIn(row.body) : [];
    if (links.length === 0) return;
    tasks.run("chat: link previews", () =>
      bestEffort(log, "chat: link previews", async () => {
        const found = (
          await mapConcurrent(links, 4, async (l) => {
            try {
              return await readEmbed(deps.fetch, l);
            } catch (cause) {
              log.warn("a link preview was not read", cause);
              return undefined;
            }
          })
        ).filter((e): e is T.Embed => e !== undefined);
        await store.locked(async () => {
          const now = await qm.messageByID(db.sql, { id: row.id });
          // Changed meanwhile: its words are not the ones read.
          if (!now || now.deleted_at !== null || now.body !== row.body) return;
          const meta = metaOf(now.meta);
          if (found.length === 0 && !meta.embeds) return;
          await change(now, (revision) => qm.setEmbeds(db.sql, { meta: metaText({ ...meta, embeds: found }), revision, id: now.id }));
        });
      }),
    );
  };

  const after = async (channel: string, written: Written): Promise<void> => {
    publishMessage(written.row, written.answers);
    embedLater(written.row);
    await publishChannel(channel);
    const meta = metaOf(written.row.meta);
    if (written.row.sender_id === userId || meta.mentions?.includes(userId) === true) await publishUserMentions();
    if (written.thread) await publishChannel(written.thread);
  };
  /** A removal, once it is committed, told to the readers. */
  const removed = (event: ChannelEvent) => tell({ kind: "removed", event });
  return {
    write,
    handled,
    embedLater,
    removed,
    committedFrom,
    committed: () => toldHub.subscribe(),
    awaitReader: (reader: (seq: number) => Promise<void>) => {
      readers.push(reader);
    },
    close: () => toldHub.end(),
  };
}
