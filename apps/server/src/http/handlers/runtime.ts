import { Effect } from "effect";

import type { RuntimeHandlers } from "@vibevalley/protocol/api";

import { lookIn, orMissing } from "#/base/errors.ts";
import { Runtime } from "#/runtime/runtime.ts";

export const runtimeHandlers = Effect.gen(function* () {
  const runtimes = yield* Runtime;
  const done: RuntimeHandlers = {
    "runtime.list": () => runtimes.list(),
    "runtime.refresh": ({ id }) => runtimes.refresh(id).pipe(orMissing("runtime " + id, [lookIn.runtime])),
    "runtime.setting.update": ({ id, ...body }) => runtimes.update(id, body).pipe(orMissing("runtime " + id, [lookIn.runtime])),
  };
  return done;
});
