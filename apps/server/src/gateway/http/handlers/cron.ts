import type { CronHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import type { Issue } from "#/modules/issue/issue.ts";

export function cronHandlers(deps: { readonly issue: Issue }): CronHandlers {
  const issues = deps.issue;
  return {
    "cron.create": (body) => issues.addCron(body, user),
    "cron.list": async () => issues.crons(),
    "cron.update": async ({ id, ...body }) => {
      if (body.enabled !== undefined) await issues.setCronEnabled(id, body.enabled);
    },
    "cron.delete": async ({ id }) => {
      await issues.removeCron(id);
    },
    "cron.previewDelete": ({ id }) => issues.previewRemoveCron(id),
  };
}
