import { EventEmitter } from "node:events";

import { expect, test } from "vite-plus/test";

import { firstBuild } from "../../scripts/dev.ts";
import { restartWhenIdle } from "./dev.ts";

test("a restart waits until no helper is working, and goes at once when none is", async () => {
  const said: string[] = [];
  const working = [2, 1, 0];
  await restartWhenIdle(
    { working: async () => working.shift() ?? 0, restartServer: async () => void said.push("restart") },
    async (ms) => void said.push(`wait ${ms}`),
  );
  expect(said).toEqual(["wait 5000", "wait 5000", "restart"]);

  const now: string[] = [];
  await restartWhenIdle({ working: async () => 0, restartServer: async () => void now.push("restart") }, async () => void now.push("wait"));
  expect(now).toEqual(["restart"]);
});

test("regression: desktop startup waits for the watcher's first complete build only", async () => {
  const watcher = new EventEmitter();
  let launched = 0;
  const ready = firstBuild(watcher).then(() => launched++);
  watcher.emit("event", { code: "START" });
  watcher.emit("event", { code: "BUNDLE_START" });
  watcher.emit("event", { code: "BUNDLE_END" });
  await Promise.resolve();
  expect(launched).toBe(0);
  watcher.emit("event", { code: "END" });
  await ready;
  expect(launched).toBe(1);
  expect(watcher.listenerCount("event")).toBe(0);
  watcher.emit("event", { code: "START" });
  watcher.emit("event", { code: "END" });
  expect(launched).toBe(1);
});

test("regression: a failed initial watch build does not launch Electron", async () => {
  const watcher = new EventEmitter();
  const ready = firstBuild(watcher);
  const error = new Error("build failed");
  watcher.emit("event", { code: "ERROR", error });
  await expect(ready).rejects.toBe(error);
  expect(watcher.listenerCount("event")).toBe(0);
});
