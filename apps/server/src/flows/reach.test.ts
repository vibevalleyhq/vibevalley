import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import { app } from "#/gateway/http/app.ts";
import { registryOf } from "#/modules/agent/runtime.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { repo } from "#/testing/git.ts";
import { starter, testConfig, waitFor } from "#/testing/layers.ts";
import { installedOnly } from "#/testing/worker.ts";
import { quietApp } from "#/testing/world.ts";

import { farm, lab, mustHire, watch } from "./farm.ts";

describe("a session", () => {
  test("reaches the server at its configured port and when bound to ephemeral port 0", async () => {
    const urls: string[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? []) if (s.name === "vibevalley" && "url" in s) urls.push(s.url);
        turn.say("好");
      },
    });
    const f = farm({ runtime, config: { ...testConfig(), port: 54321 } });
    await using fw = await f.open();
    const w = watch(fw);
    const hired = await fw.issue.hire(lab(), "看看", "reach");
    const first = mustHire(hired);
    await w.nextReport();
    await fw.inside.dismiss(first.id);
    expect(urls).toEqual(["http://127.0.0.1:54321/mcp"]);

    const ephemeralConfig = { ...testConfig(), port: 0 };
    const repoDir = join(ephemeralConfig.workRoot, "repos", "reach");
    mkdirSync(repoDir, { recursive: true });
    repo(repoDir, 1, 0);
    await using served = await app(ephemeralConfig, 0, undefined, {
      ...quietApp,
      agent: { ...quietApp.agent, registry: registryOf([runtime]), probe: installedOnly([runtime]) },
      session: {
        workerAccess: async () => {
          const close = async () => {};
          return {
            executableAvailable: async () => true,
            command: "worker",
            prepare: async () => ({ authenticated: true, command: "worker" }),
            revoke: async () => {},
            close,
            [Symbol.asyncDispose]: close,
          };
        },
      },
    });
    expect(served.address).not.toContain(":0");
    await served.farm.agent.save({ ...starter("lab"), effort: "" });
    const issue = await served.farm.issue.add({ title: "ephemeral", repo: "reach", agent: "lab" }, explicitMandate("", true));
    await served.farm.issue.start(issue.id, "");
    await waitFor(
      () => Promise.resolve(urls.length),
      (n) => n === 2,
      "helper turn on ephemeral port",
    );
    expect(urls[1]).toBe(`http://${served.address}/mcp`);
  });
});
