import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import { testConfig } from "#/testing/layers.ts";

import { farm, lab, mustHire, watch } from "./farm.ts";

describe("a session", () => {
  // The farm's tools are where the server answers: its configured port until it says another (a free port, known only
  // once it listens).
  test("reaches the server where it answers", async () => {
    const urls: string[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? []) if (s.name === "vibevalley" && "url" in s) urls.push(s.url);
        turn.say("好");
      },
    });
    const f = farm({ runtime, config: { ...testConfig(), port: 8787 } });
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.session;
    const hired = await issues.hire(lab(), "看看", "reach");
    const first = mustHire(hired);
    await w.nextReport();
    sessions.setAddress("127.0.0.1:54321");
    const hired2 = await issues.hire(lab(), "再看看", "reach");
    mustHire(hired2);
    await w.nextReport();
    await sessions.dismiss(first.id);
    expect(urls).toEqual(["http://127.0.0.1:8787/mcp", "http://127.0.0.1:54321/mcp"]);
  });
});
