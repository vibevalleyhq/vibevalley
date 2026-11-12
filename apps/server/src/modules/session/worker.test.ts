import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { expect, test } from "vite-plus/test";

import { workerAccess } from "./worker.ts";

test("regression: credential files are private, rotated and removed with their scope", async () => {
  let file = "";
  {
    await using cli = await workerAccess({ exitCode: async () => 0 });
    const first = await cli.prepare("w1", "http://127.0.0.1:1/mcp", "first");
    const previous = /--worker-access-file '([^']+)'/u.exec(first.command)?.[1] ?? "";
    expect(statSync(previous).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(previous)).mode & 0o777).toBe(0o700);
    const second = await cli.prepare("w1", "http://127.0.0.1:1/mcp", "second");
    file = /--worker-access-file '([^']+)'/u.exec(second.command)?.[1] ?? "";
    expect(file).not.toBe(previous);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(file)).toBe(true);
  }
  expect(existsSync(file)).toBe(false);
});
