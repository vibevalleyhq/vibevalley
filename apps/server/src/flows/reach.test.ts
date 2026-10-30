import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Issues } from "@/issue/issue.ts";
import { Sessions, type SessionsInside } from "@/session/session.ts";
import { testConfig } from "@/testing/layers.ts";

import { farm, lab, mustHire, watch } from "./farm.ts";

describe("a session", () => {
  // The farm's tools are where the server answers: its configured port until it says another (a free port, known only
  // once it listens).
  it.live("reaches the server where it answers", () => {
    const urls: string[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (const s of turn.options.mcpServers ?? []) if (s.name === "vibevalley" && "url" in s) urls.push(s.url);
        turn.say("好");
      },
    });
    const f = farm({ runtime, config: { ...testConfig(), port: 8787 } });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      expect((sessions as SessionsInside).mcpUrl()).toBe("http://127.0.0.1:8787/mcp");
      const first = mustHire(yield* issues.hire(lab(), "看看", "reach"));
      yield* w.nextReport;
      sessions.setAddress("127.0.0.1:54321");
      mustHire(yield* issues.hire(lab(), "再看看", "reach"));
      yield* w.nextReport;
      yield* sessions.dismiss(first.id);
      expect(urls).toEqual(["http://127.0.0.1:8787/mcp", "http://127.0.0.1:54321/mcp"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
