import { expect, test } from "vite-plus/test";

import { until } from "@vibevalley/testkit/until";

import type { Mcp } from "#/gateway/mcp/mcp.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";

import { mcpRoute } from "./mcp.ts";

test("forwards a disconnect to the Web handler", async () => {
  let aborted = false;
  const mcp: Mcp = {
    handle: (request) =>
      new Promise<Response>(() => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
      }),
    close: async () => {},
  };
  const orchestrator: Orchestrator = {
    stop: async () => {},
    markWrong: () => new Promise(() => {}),
    answerer: () => () => undefined,
    brief: () => new Promise(() => {}),
    close: async () => {},
  };
  const routes = mcpRoute({ mcp, orchestrator, clock: wallTime, log: keptLog() });
  const controller = new AbortController();
  void Promise.resolve(routes.fetch(new Request("http://farm/mcp", { method: "POST", body: "{}", signal: controller.signal }))).catch(() => undefined);
  controller.abort();
  await until(() => aborted, "the disconnect");
  expect(aborted).toBe(true);
});
