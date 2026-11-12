import type { CronHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import type { Cron } from "#/modules/cron/cron.ts";

export function cronHandlers(deps: { readonly cron: Cron }): CronHandlers {
  const crons = deps.cron;
  return {
    "cron.create": (body) => crons.add(body, user),
    "cron.list": async () => crons.list(),
    "cron.update": async ({ id, ...body }) => {
      if (body.enabled !== undefined) await crons.setEnabled(id, body.enabled);
    },
    "cron.delete": async ({ id }) => {
      await crons.remove(id);
    },
    "cron.previewDelete": ({ id }) => crons.previewRemove(id),
  };
}
