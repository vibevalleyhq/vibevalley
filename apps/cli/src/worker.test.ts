import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { cli, farm } from "#/testing/testing.ts";

it("regression: worker commands refuse missing credentials without user fallback", async () => {
  const result = await cli(["worker", "report", "{}"]);
  expect(result.code).not.toBe(0);
  expect(result.failure?.tag).toBe("WorkerAccess");
});

it("regression: HTTP 200 with MCP isError refuses forged worker reports and PR submissions", async () => {
  await using running = await farm();
  const server = running.url;
  const directory = await mkdtemp(join(tmpdir(), "vv-worker-"));
  try {
    const file = directory + "/access.json";
    const access = JSON.stringify({ token: "forged-secret", endpoint: server + "/mcp" });
    await writeFile(file, access, { mode: 0o600 });
    const env = { VIBEVALLEY_WORKER_ACCESS_FILE: file };
    for (const operation of ["report", "pr-submit", "doctor"]) {
      const result = await cli(["worker", operation, '{"summary":"forged","session":"w1"}'], "", env);
      expect(result.code).not.toBe(0);
      expect(result.failure?.tag).toBe("WorkerTool");
      expect(result.out + result.err).not.toContain("forged-secret");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
