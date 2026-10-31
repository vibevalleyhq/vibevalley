import { Effect, PubSub, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { bounded } from "@/core/bounded.ts";
import { refused } from "@/errors.ts";
import type { Db } from "@/infra/db.ts";

import * as qm from "../../db/generated/channel_message.sql.ts";
import { toMessage, type ChannelService } from "./contracts.ts";
import type { ChatModel } from "./model.ts";
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
