import { expect, test } from "vite-plus/test";
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
