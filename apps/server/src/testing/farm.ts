import { Effect, Layer } from "effect";

import { app } from "#/http/app.ts";
import { registryOf } from "#/runtime/runtime.ts";

import { testConfig } from "./layers.ts";
import { helper, installedOnly } from "./worker.ts";
import { quietApp } from "./world.ts";

export { lookIn, memoriesOf } from "#/base/errors.ts";

/** The whole farm on a free port: its address. */
export const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return "http://" + address;
});

/** The same with the test helper as its only runtime (pi, testing/worker.ts), so an issue can be worked from outside as
 * an agent would. */
export const workingFarm = Effect.gen(function* () {
  let address = "";
  const given = [helper()];
  const runtime = { registry: registryOf(given), probe: installedOnly(given), background: false };
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), { ...quietApp, runtime }));
  return "http://" + address;
});
