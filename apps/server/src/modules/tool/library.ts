import { Array as Arr, Effect } from "effect";

import * as S from "@vibevalley/protocol/schema";

import { reasonOf } from "#/base/errors.ts";
import { Library } from "#/modules/library/library.ts";

import { answers } from "./prompts.ts";
import { callerOf, sessionSchemaTool, tool, type Who } from "./schemas.ts";

export const libraryTools = Effect.gen(function* () {
  const library = yield* Library;
  const listed = (req: Parameters<typeof library.list>[0]) =>
    Effect.map(library.list(req), (items) => (items.length === 0 ? answers.library.none : Arr.join(Arr.map(items, answers.library.line), "\n")));
  const said = (e: Effect.Effect<string, Parameters<typeof reasonOf>[0]>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(reasonOf(err))));
  return {
    orchestrator: (who: Who) => [
      tool("library.item.list", (p) => listed(p)),
      tool(
        "library.item.add",
        Effect.fn("Tool.libraryAdd")(function* (p) {
          const c = yield* callerOf(who);
          return yield* said(Effect.map(library.add(p, { kind: "agent", agent: c.agent }), answers.library.added));
        }),
      ),
    ],
    session: (who: Who) => [
      sessionSchemaTool("library.item.list", (p) => listed(p)),
      sessionSchemaTool(
        "library.item.add",
        Effect.fn("Tool.libraryAdd")(function* (p) {
          const c = yield* callerOf(who);
          return yield* said(
            Effect.map(library.add(p, { kind: "agent", agent: c.agent, ...(c.session ? { session: S.sessionId(c.session) } : {}) }), answers.library.added),
          );
        }),
      ),
    ],
  };
});
