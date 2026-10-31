// The state stream after a sleep: the connection looks open but nothing comes, not even the server's heartbeat. The page
// gives it up as lost and opens it again (packages/protocol/src/stream.ts, infra/frames.ts).
import { streamSilenceMs } from "@vibevalley/protocol";

import { expect, test } from "./fixtures";

test("a state stream silent past its heartbeats is lost, opened again, and open once a frame comes", async ({ page }) => {
  await page.clock.install();
  let opened = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/v1/state") opened++;
  });
  await page.goto("/issues");
  const link = page.getByTestId("link");
  await expect(link).toHaveAttribute("data-state", "open");
  expect(opened).toBe(1);
  // The page's time jumps ahead while the server's does not: no heartbeat in all that while, as after a sleep.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.clock.fastForward(streamSilenceMs);
  await expect(link).toHaveAttribute("data-state", "lost");
  await page.clock.runFor(1500);
  await expect(link).toHaveAttribute("data-state", "open");
  expect(opened).toBe(2);
});
