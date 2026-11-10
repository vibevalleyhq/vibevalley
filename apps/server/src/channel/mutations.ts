import { Clock, Effect, PubSub, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { missing, lookIn, refused } from "#/base/errors.ts";
import { bounded } from "#/core/core.ts";
import { type Db } from "#/infra/db.ts";
import * as qc from "#db/channel.sql.ts";
import * as qm from "#db/channel_message.sql.ts";

import { toMessage, reactionsOf, reactionsText, type MsgRow, type ChannelService } from "./contracts.ts";
import type { ChatModel } from "./rooms.ts";

const emojiPattern = /^\S{1,16}$/u;

export function messageMutations(
  db: Db["Service"],
  tx: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  said: PubSub.PubSub<T.ChatMessage>,
  publishChannel: (id: string) => Effect.Effect<void>,
) {
  const messageOf = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(qm.messageByID({ id }));
    if (!row) return yield* Effect.fail(missing(t("server.channel.noMessageId", { id }), [lookIn.channel]));
    return row;
  });

  /** One message changed, in one transaction with the channel's next revision. then it goes to whoever follows its channel as it now is. */
  const change = Effect.fnUntraced(function* (row: MsgRow, work: (revision: number, now: number) => Effect.Effect<void>) {
    const now = yield* Clock.currentTimeMillis;
    yield* tx(
      Effect.gen(function* () {
        const { revision } = yield* db.run(qc.bumpRevision({ id: row.channel_id }));
        yield* work(revision, now);
      }),
    );
    const updated = yield* db.one(qm.messageByID({ id: row.id }));
    const message = toMessage(updated ?? row);
    yield* PubSub.publish(said, message);
    yield* publishChannel(row.channel_id);
    return message;
  });

  /** add only adds: a reaction already there is then kept. */
  // Setting the reaction as it already is writes nothing: a retried set is no new revision for every follower.
  const reacting = Effect.fnUntraced(function* (id: string, who: string, emoji: string, on: boolean) {
    const e = emoji.trim();
    if (!emojiPattern.test(e)) return yield* Effect.fail(refused(t("server.channel.badEmoji")));
    const row = yield* messageOf(id);
    if (row.deleted_at !== null) return yield* Effect.fail(refused(t("server.channel.messageGone")));
    const r = reactionsOf(row.reactions);
    const by = r[e] ?? [];
    if (by.includes(who) === on) return toMessage(row);
    r[e] = on ? [...by, who] : by.filter((x) => x !== who);
    return yield* change(row, (revision) => db.run(qm.setReactions({ reactions: reactionsText(r), revision, id })));
  });

  return { messageOf, change, reacting };
}

export const catchUpMax = 200;
const logKeep = 80;
export function channelStreams(db: Db["Service"], model: ChatModel, said: PubSub.PubSub<T.ChatMessage>): Pick<ChannelService, "follow" | "reports"> {
  return {
    follow: (channel, after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!model.channel(channel)) return yield* Effect.fail(refused(t("server.channel.channelGone")));
          // Subscribed before the missed ones are read: nothing changed in between falls through, and what both have is
          // dropped by its revision.
          const live = yield* PubSub.subscribe(said);
          const missed = yield* db.run(qm.messagesChangedAfter({ channel_id: channel, revision: after, n: catchUpMax + 1 }));
          if (missed.length > catchUpMax) return Stream.succeed<T.ChannelEvent>({ _tag: "Reset" });
          const upto = missed.at(-1)?.revision ?? after;
          const here = bounded(Stream.fromSubscription(live).pipe(Stream.filter((m) => m.channel === channel && m.revision > upto)), "chat.follow");
          return Stream.concat(Stream.fromIterable(missed.map(toMessage)), here).pipe(Stream.map((message): T.ChannelEvent => ({ _tag: "Message", message })));
        }),
      ),
    reports: (after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const live = yield* PubSub.subscribe(said);
          const missed =
            after === undefined
              ? [...(yield* db.run(qm.recentReports({ n: logKeep })))].toReversed()
              : yield* db.run(qm.reportsAfter({ after, n: catchUpMax + 1 }));
          if (missed.length > catchUpMax) return Stream.succeed<T.ChannelEvent>({ _tag: "Reset" });
          const upto = missed.at(-1)?.id ?? after ?? "";
          const here = bounded(Stream.fromSubscription(live).pipe(Stream.filter((m) => m.kind === "report" && m.id > upto)), "chat.reports");
          return Stream.concat(Stream.fromIterable(missed.map(toMessage)), here).pipe(Stream.map((message): T.ChannelEvent => ({ _tag: "Message", message })));
        }),
      ),
  };
}
