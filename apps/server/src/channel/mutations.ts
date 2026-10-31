import { Clock, Effect, PubSub } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { missing, lookIn, refused } from "@/errors.ts";
import type { Db } from "@/infra/db.ts";

import * as qc from "../../db/generated/channel.sql.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import { toMessage, reactionsOf, reactionsText, type MsgRow } from "./contracts.ts";
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

  /** One message changed, in one transaction with the channel's next revision; then it goes to whoever follows its
   * channel as it now is. A change is not news: no fact, no delivery, no wake. */
  const change = Effect.fnUntraced(function* (row: MsgRow, work: (revision: number, now: number) => Effect.Effect<void>) {
    const now = yield* Clock.currentTimeMillis;
    yield* tx(
      Effect.gen(function* () {
        const { revision } = yield* db.run(qc.bumpRevision({ id: row.channel_id }));
        yield* work(revision, now);
      }),
    );
    const message = toMessage((yield* db.one(qm.messageByID({ id: row.id })))!);
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
