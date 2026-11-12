import { registryOf } from "#/modules/agent/runtime.ts";

import { app } from "./http.ts";
import { testConfig } from "./layers.ts";
import { helper, installedOnly } from "./worker.ts";
import { quietApp } from "./world.ts";

export { lookIn, memoriesOf } from "#/base/errors.ts";

/** A farm served for a test: where it answers, and its end. */
export interface RunningFarm extends AsyncDisposable {
  readonly url: string;
}

/** The whole farm on a free port. */
export async function farm(): Promise<RunningFarm> {
  const served = await app(testConfig(), 0, undefined, quietApp);
  return { url: "http://" + served.address, [Symbol.asyncDispose]: () => served.close() };
}

/** The same with the test helper as its only runtime (pi, testing/worker.ts), so an issue can be worked from outside as
 * an agent would. */
export async function workingFarm(): Promise<RunningFarm> {
  const given = [helper()];
  const agent = { registry: registryOf(given), probe: installedOnly(given), background: false };
  const served = await app(testConfig(), 0, undefined, { ...quietApp, agent });
  return { url: "http://" + served.address, [Symbol.asyncDispose]: () => served.close() };
}
