import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { keptFile } from "./files.ts";
import { HomeTaken, leaseHome } from "./lease.ts";
import { keptLog } from "./log.ts";
import { wallTime } from "./time.ts";

describe("a kept file", () => {
  test("is saved whole at once, written soon after the first change with the later ones joining, and last as its scope closes", async () => {
    vi.useFakeTimers();
    try {
      const path = join(tempDir("vibevalley-files-"), "deep", "state.json");
      const read = () => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
      const kept = keptFile(path, { clock: wallTime, log: keptLog() }, { soonMs: 100 });
      await kept.save("one");
      expect(read()).toBe("one");
      let state = "two";
      kept.soon(() => state);
      state = "three";
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      await vi.waitFor(() => expect(read()).toBe("three"));
      kept.soon(() => "last");
      await kept.close();
      expect(read()).toBe("last");
    } finally {
      vi.useRealTimers();
    }
  });
});

test("one server per home; a stale lock is taken over", () => {
  const home = tempDir("vibevalley-lease-");
  const release = leaseHome(home);
  expect(() => leaseHome(home)).toThrow(HomeTaken);
  release();
  const again = leaseHome(home);
  again();
  writeFileSync(join(home, ".vibevalley.lock"), "999999");
  leaseHome(home)();
});
