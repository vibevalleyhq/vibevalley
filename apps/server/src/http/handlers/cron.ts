import { Effect } from "effect";

import type { CronHandlers } from "@vibevalley/protocol/api";

import { owner } from "#/base/actor.ts";
import { Cron } from "#/cron/cron.ts";

export const cronHandlers = Effect.gen(function* () {
  const crons = yield* Cron;
  const done: CronHandlers = {
    "cron.create": (body) => crons.add(body, owner),
    "cron.list": () => Effect.sync(crons.list),
    "cron.update": ({ id, ...body }) => (body.enabled === undefined ? Effect.void : Effect.asVoid(crons.setEnabled(id, body.enabled))),
    "cron.delete": ({ id }) => Effect.asVoid(crons.remove(id)),
    "cron.previewDelete": ({ id }) => crons.previewRemove(id),
  };
  return done;
});
