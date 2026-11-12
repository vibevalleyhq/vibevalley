import { mapConcurrent, type TaskGroup } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { everyone, userId } from "@vibevalley/protocol";

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
  type ChannelObserver,
  type Committed,
  channelType,
  metaOf,
  metaText,
  type MsgRow,
  subjectKind,
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

/** tasks: the channel's own, so the work a message sets off ends with the service. */
export function channelWriting(deps: ChannelWritingDeps, r: ChannelHub, tasks: TaskGroup) {
  const { db, clock, log } = deps;
  const { store, assistantIds, orchestratorInRow, membersOfRow, publishChannel, publishUserMentions, publishMessage, readUpTo, change, channelEnvelope } = r;
  const observers: ChannelObserver[] = [];
  /** A session's seat in the chat: an agent's participant hired to work, there until it leaves. */
  const isSession = (p: { readonly role: string | null; readonly runtime: string | null; readonly left_at: number | null }) =>
    p.role === "worker" && p.runtime !== null && p.left_at === null;
  /** The chat's part of a committed message (who it names, who follows the thread), then each observer's. */
  const settle = async (inserted: MsgRow, event: ChannelEvent, replayed: boolean): Promise<Written> => {
    let row = inserted;
    const ch = store.channel(row.channel_id);
    if (!ch) throw new Inconsistent(`no channel ${row.channel_id}`);
    const meta = metaOf(row.meta);
    const orchestrators = assistantIds();
    const here = orchestratorInRow(ch);
    // No one else is in a direct channel to be named.
    const mentions = ch.type === "direct" ? [] : mentionsIn(row.body, { here, orchestrators });
    // Who is here to be named: the orchestrators, the user, everyone, and the sessions seated and not gone.
    const present = new Set(
      store
        .participants()
        .filter(isSession)
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
    let members: string[] = [];
    if (ch.type === "thread") {
      // A dispatch handing the issue to its next session makes no one a member: the orchestrator would be woken by every word in it.
      if (row.sender_id !== "system" && row.kind !== "dispatch") await store.addMember(ch.id, row.sender_id, "replied", row.number);
      for (const m of named)
        if (m.how === "delivered" && (orchestrators.includes(m.id) || present.has(m.id))) await store.addMember(ch.id, m.id, "mentioned", row.number - 1);
      members = store.membersOf(ch.id);
    }
    const kind = subjectKind(ch.subject_kind);
    const topic = ch.type !== "channel" && kind !== undefined && ch.subject_id !== null ? { kind, id: ch.subject_id } : undefined;
    const committed: Committed = {
      event,
      replayed,
      row: channelEnvelope(row),
      mentions,
      channel: { type: channelType(ch.type), ...(ch.peer_id !== null ? { peer: ch.peer_id } : {}) },
      orchestrator: here,
      channelMembers: membersOfRow(ch),
      members,
      ...(topic ? { topic } : {}),
    };
    const written: Written = { absent: [], heldNotice: "", thread: "", again: false, row };
    for (const o of observers) {
      const follow = await o.posted(committed);
      if (follow?.hopLimit && theRow(await qm.holdNoticeSinceUser(db.sql, { channel: ch.id }), "HoldNoticeSinceUser").n === 0)
        written.heldNotice = follow.hopLimit;
    }
    written.absent = named.filter((m) => m.how !== "delivered").map((m) => m.id);
    return written;
  };

  /** Routing follows the committed message, so startup can replay an interrupted handoff. */
  const write = async (w: Write): Promise<Written> => {
    const written = await store.tx(async (): Promise<Written & { event?: ChannelEvent }> => {
      if (w.sendKey) {
        const seen = await qm.messageBySendKey(db.sql, { sender_id: w.from, send_key: w.sendKey });
        if (seen) return { absent: [], heldNotice: "", thread: "", again: true, row: seen };
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
        sender_role: sender.role,
        sender_agent: sender.agent_id,
        revision,
        reply_number: w.replyTo ?? null,
        edited_at: null,
        deleted_at: null,
        pinned_at: null,
        reactions: null,
      };
      const out: Written & { event?: ChannelEvent } = { absent: [], heldNotice: "", thread: "", again: false, row };
      out.event = { seq, kind: "posted", channel: w.channel, message: id, at: created_at };
      if (w.readBy) await readUpTo(w.readBy, w.channel, number);
      if (w.member) await store.addMember(w.channel, w.member, "user", number);
      if (w.thread) out.thread = await store.threadFor({ id, number, channel: w.channel }, w.thread);
      return out;
    });
    if (written.again || !written.event) return written;
    const routed = await settle(written.row, written.event, false);
    const complete = { ...routed, thread: written.thread };
    await after(w.channel, complete, w.answers);
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

  const after = async (channel: string, written: Written, answers: T.SessionId | undefined): Promise<void> => {
    publishMessage(written.row, answers);
    embedLater(written.row);
    await publishChannel(channel);
    const meta = metaOf(written.row.meta);
    if (written.row.sender_id === userId || meta.mentions?.includes(userId) === true) await publishUserMentions();
    if (written.thread) await publishChannel(written.thread);
    if (written.heldNotice) await write({ channel, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
  };
  const observe = (o: ChannelObserver) => {
    observers.push(o);
  };
  /** A removal told to the observers, after it is committed. */
  const removed = async (event: ChannelEvent) => {
    for (const o of observers) await o.removed(event);
  };
  return { settle, write, embedLater, after, observe, removed };
}
