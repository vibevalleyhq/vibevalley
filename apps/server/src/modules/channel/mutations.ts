import type { Hub } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { bounded } from "#/core/core.ts";
import { type Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as qc from "#db/channel.sql.ts";
import * as qm from "#db/channel_message.sql.ts";

import { toMessage, reactionsOf, reactionsText, type MsgRow, type ChannelService, theRow } from "./contracts.ts";
import type { ChannelStore } from "./store.ts";

const refused = refuseIn(BizCode.ChannelRefused);

const emojiPattern = /^\S{1,16}$/u;

export function messageMutations(deps: { readonly db: Db; readonly clock: Time }, said: Hub<T.ChatMessage>, publishChannel: (id: string) => Promise<void>) {
  const { db, clock } = deps;
  const messageOf = async (id: string) => {
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
  const reacting = async (id: string, who: string, emoji: string, on: boolean) => {
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

export const catchUpMax = 200;
const logKeep = 80;

const asEvent = (message: T.ChatMessage): T.ChannelEvent => ({ _tag: "Message", message });

export function channelStreams(
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
