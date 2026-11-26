import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

test("RunsPage copies session ID and Trajectory supports outcome filters, empty-filter reset CTA, and tool input/output copy", async () => {
  const fixture = scenarios.typical;
  const worker = fixture.state.sessions.sessions.find((s) => s.role === "worker");
  if (!worker) throw new Error("typical scenario must include a worker session");

  const fake = fakeHost(fixture, { route: `/runs?session=${worker.id}`, locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:trajectory") === 1);
  const clock = app.clock;
  if (!clock) throw new Error("RunsPage.test.tsx requires a manual virtual clock");

  // 1. Copy session/run ID with Clipboard, transient check feedback, and toast.
  expect(app.count("id:run-copy-id")).toBe(1);
  await app.press("id:run-copy-id");
  await app.waitUntil(() => app.clipboard() === worker.id);
  expect(app.count("id:toast")).toBe(1);
  expect(app.texts()).toContain("Copied");

  await clock.fastForward(1_600);
  expect(app.count("id:run-copy-id >> text:Copy")).toBe(1);
  await clock.fastForward(2_600);
  expect(app.count("id:toast")).toBe(0);

  // 2. Step outcome filters narrow rows and empty filter offers one-click recovery CTA.
  expect(app.count("id:step-toggle-2")).toBe(1);
  expect(app.count("id:step-toggle-4")).toBe(1);

  await app.press("id:trajectory-filter-tools");
  expect(app.count("id:step-toggle-2")).toBe(0);
  expect(app.count("id:step-toggle-4")).toBe(1);

  await app.press("id:trajectory-filter-errors");
  expect(app.count("id:steps-empty")).toBe(1);
  expect(app.count("id:trajectory-clear-filters")).toBe(1);

  await app.press("id:trajectory-clear-filters");
  expect(app.count("id:steps-empty")).toBe(0);
  expect(app.count("id:step-toggle-2")).toBe(1);
  expect(app.count("id:step-toggle-4")).toBe(1);

  // 3. Search empty state also offers recovery CTA and clears query.
  await app.type("id:trajectory-search", "no-such-step");
  expect(app.count("id:steps-empty")).toBe(1);
  expect(app.count("id:trajectory-clear-filters")).toBe(1);
  await app.press("id:trajectory-clear-filters");
  expect(app.value("id:trajectory-search")).toBe("");
  expect(app.count("id:step-toggle-4")).toBe(1);

  // 4. Expanding a tool call reveals one-click copy for input and output.
  await app.press("id:step-toggle-4");
  expect(app.count("id:tool-copy-input")).toBe(1);
  expect(app.count("id:tool-copy-output")).toBe(1);

  await app.press("id:tool-copy-input");
  await app.waitUntil(() => app.clipboard() === "session.ts");
  expect(app.count("id:toast")).toBe(1);

  await app.press("id:tool-copy-output");
  await app.waitUntil(() => app.clipboard() === "export function isExpired() {}");
});

test("WorkLog expanded tool step copies tool input with toast feedback", async () => {
  const app = await open("../../app/components.story.tsx", {
    width: 1200,
    height: 900,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
  });
  const clock = app.clock;
  if (!clock) throw new Error("RunsPage.test.tsx requires a manual virtual clock");

  await app.press("id:domain-worklog-live >> id:tool-step");
  expect(app.count("id:domain-worklog-live >> id:worklog-copy-input")).toBe(1);
  await app.press("id:domain-worklog-live >> id:worklog-copy-input");
  await app.waitUntil(() => app.clipboard() === "vp test run");
  expect(app.count("id:toast")).toBe(1);
  await clock.fastForward(4_100);
  expect(app.count("id:toast")).toBe(0);
});
