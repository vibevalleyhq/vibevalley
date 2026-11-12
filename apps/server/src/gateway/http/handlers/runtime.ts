import type { RuntimeHandlers } from "@vibevalley/protocol/api";

import { lookIn, orMissing } from "#/base/errors.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

export function runtimeHandlers(deps: { readonly runtime: Runtime }): RuntimeHandlers {
  const runtimes = deps.runtime;
  return {
    "runtime.list": () => runtimes.list(),
    "runtime.refresh": async ({ id }) => orMissing("runtime " + id, [lookIn.runtime])(await runtimes.refresh(id)),
    "runtime.setting.update": async ({ id, ...body }) => orMissing("runtime " + id, [lookIn.runtime])(await runtimes.update(id, body)),
  };
}
