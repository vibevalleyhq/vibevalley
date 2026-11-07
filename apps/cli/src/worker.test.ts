import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { cli, farm } from "./testing.ts";

it.effect("regression: worker commands refuse missing credentials without owner fallback", () =>
  Effect.gen(function* () {
    const result = yield* cli(["worker", "report", "{}"]);
    expect(result.code).not.toBe(0);
    expect(result.failure?.tag).toBe("WorkerAccess");
  }),
);

it.live("regression: HTTP 200 with MCP isError refuses forged worker reports and PR submissions", () =>
  Effect.gen(function* () {
    const server = yield* farm;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const file = directory + "/access.json";
    yield* fs.writeFileString(file, JSON.stringify({ token: "forged-secret", endpoint: server + "/mcp" }), { mode: 0o600 });
    const env = { VIBEVALLEY_WORKER_ACCESS_FILE: file };
    for (const operation of ["report", "pr-submit", "doctor"]) {
      const result = yield* cli(["worker", operation, '{"summary":"forged","session":"w1"}'], "", env);
      expect(result.code).not.toBe(0);
      expect(result.failure?.tag).toBe("WorkerTool");
      expect(result.out + result.err).not.toContain("forged-secret");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
