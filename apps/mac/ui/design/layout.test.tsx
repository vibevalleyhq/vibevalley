import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { SCENARIO_NOW } from "../fixtures/scenarios";

test("Empty supports 4-state hierarchy, dual-layer microcopy, shortcut caps, secondary action, and 200ms anti-flash gate", async () => {
  const app = await open("./layout.story.tsx", {
    width: 900,
    height: 900,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
  });
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  expect(app.count("id:empty-first-run")).toBe(1);
  expect(app.count("id:empty-filtered")).toBe(1);
  expect(app.count("id:empty-unselected")).toBe(1);
  expect(app.count("id:empty-zero")).toBe(1);
  expect(app.count("id:empty-error")).toBe(1);
  expect(app.texts()).toContain("Start your first note");
  expect(app.texts()).toContain("Draft specs, tables, or diagrams in one place.");
  expect(app.texts()).toContain("⌘N");
  expect(app.texts()).toContain("⌘K");
  expect(app.texts()).toContain("All caught up");

  await app.press("id:empty-primary");
  await app.press("id:empty-secondary");
  expect(app.texts()).toContain("clicks:11");

  // Pending empty state stays hidden during fetch and during the 200ms anti-flash window.
  expect(app.count("id:empty-gated")).toBe(0);
  await app.press("id:settle-pending");
  await clock.fastForward(150);
  expect(app.count("id:empty-gated")).toBe(0);
  await clock.fastForward(60);
  expect(app.count("id:empty-gated")).toBe(1);
  expect(app.texts()).toContain("No issues yet");
});
