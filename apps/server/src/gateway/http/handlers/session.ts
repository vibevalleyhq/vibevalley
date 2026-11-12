import { t } from "@vibevalley/i18n";
import type { SessionHandlers } from "@vibevalley/protocol/api";

import { lookIn, missing, orMissing } from "#/base/errors.ts";
import type { Session } from "#/modules/session/session.ts";

export function sessionHandlers(deps: { readonly session: Session }): SessionHandlers {
  const sessions = deps.session;
  return {
    "session.stop": async ({ id }) => {
      if (!sessions.live(id).reachable) throw missing(t("server.helperRef", { id }), [lookIn.session]);
      await sessions.withdraw({ _tag: "Turn", session: id });
    },
    "session.list": ({ agent }) => sessions.read({ _tag: "Sessions", agent: agent ?? "" }),
    "session.get": async ({ id }) => orMissing(t("server.helperRef", { id }), [lookIn.session])(await sessions.read({ _tag: "Session", id })),
    "session.event.list": async ({ id, run }) => (await sessions.read({ _tag: "Events", session: id, run: run ?? "" })) ?? [],
  };
}
