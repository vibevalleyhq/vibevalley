// The answers of the session endpoints (packages/protocol/src/session/api.ts): each forwards to the service that owns the rule.

import { Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type { SessionHandlers } from "@vibevalley/protocol/api";

import { missing, lookIn, orMissing } from "@/errors.ts";
import { Session } from "@/session/session.ts";

export const sessionHandlers = Effect.gen(function* () {
  const sessions = yield* Session;
  const done: SessionHandlers = {
    "session.stop": ({ id }) =>
      sessions.present(id) ? Effect.asVoid(sessions.stop(id)) : Effect.fail(missing(t("server.helperRef", { id }), [lookIn.session])),
    "session.list": ({ agent }) => sessions.list(agent ?? ""),
    "session.get": ({ id }) => sessions.get(id).pipe(orMissing(t("server.helperRef", { id }), [lookIn.session])),
    "session.event.list": ({ id, run }) => Effect.map(sessions.events(id, run ?? ""), (events) => events ?? []),
  };
  return done;
});
