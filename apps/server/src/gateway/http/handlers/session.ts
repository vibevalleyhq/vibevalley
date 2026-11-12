import { t } from "@vibevalley/i18n";
import type { SessionHandlers } from "@vibevalley/protocol/api";

import { lookIn, missing, orMissing } from "#/base/errors.ts";
import type { Session } from "#/modules/session/session.ts";

export function sessionHandlers(deps: { readonly session: Session }): SessionHandlers {
  const sessions = deps.session;
  return {
    "session.stop": async ({ id }) => {
      if (!sessions.live(id).reachable) throw missing(t("server.helperRef", { id }), [lookIn.session]);
      await sessions.stop(id);
    },
    "session.list": ({ agent }) => sessions.list(agent),
    "session.get": async ({ id }) => orMissing(t("server.helperRef", { id }), [lookIn.session])(await sessions.get(id)),
    "session.event.list": async ({ id, run }) => (await sessions.eventsOf(id, run ?? "")) ?? [],
  };
}
