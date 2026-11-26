import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

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

test("RunsPage shows active rail bar, strips collapsed prompt scaffolding while keeping raw prompt expanded, and gives 0ms ticks minimum width", async () => {
  const rawPrompt = [
    "【现在】2026-11-26 21:00",
    "【现状】",
    "用户的语言：zh",
    "仓库（工作目录 /var/folders/tmp/work 下的文件夹）：app",
    "",
    "[来源：用户]",
    "用户说：检查发布脚本",
  ].join("\n");

  const fake = fakeHost(scenarios.typical, { route: "/runs?session=orchestrator", locale: "zh" });
  fake.respond("session.event.list", () => ({
    events: [
      { seq: 1, run: "r1", type: "user/message", text: rawPrompt, time: SCENARIO_NOW - 10_000, revision: 1 },
      { seq: 2, run: "r1", type: "assistant/message", text: "好的，这就检查。", time: SCENARIO_NOW - 10_000, revision: 1 },
    ],
  }));

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:step-toggle-1") === 1);

  expect(app.count("id:dashboard-page")).toBe(1);
  expect(app.count("id:dashboard-header")).toBe(1);

  // Collapsed row shows the clean human summary without raw internal prompt scaffolding.
  expect(app.shows("id:step-toggle-1 >> text:检查发布脚本")).toBe(true);
  expect(app.texts().some((line) => line.includes("【现状】") || line.includes("/var/folders/"))).toBe(false);

  // Expanding reveals the full raw prompt.
  await app.press("id:step-toggle-1");
  expect(app.texts().some((line) => line.includes("【现状】") && line.includes("/var/folders/tmp/work"))).toBe(true);

  // 0ms timeline spans keep a visible minimum pill width (>= 6px).
  expect(app.count("id:waterfall-bar-1")).toBe(1);
  expect(app.layout("id:waterfall-bar-1")?.width).toBeGreaterThanOrEqual(6);

  // Leaving /runs leaves the Dashboard host shell.
  await app.press("id:place-issues");
  await fake.pumpUntil(app, () => app.count("id:issues-page") === 1);
  expect(app.count("id:dashboard-page")).toBe(0);
});

test("RunsPage localizes raw runtime API-key errors in trajectory step summaries and run/error rows", async () => {
  setLocale("zh");
  const localized = t("web.issue.error.missingApiKey");
  const threadReportPrompt = [
    "【现在】2026-11-26 21:05",
    "[来源：群聊]（帮工写的是它的汇报）",
    "【群聊】#general:1 里有给你的话：",
    "[target=#general:1 msg=2 from=w1 Ada #4] no API key is set for the model",
  ].join("\n");

  const fake = fakeHost(scenarios.typical, { route: "/runs?session=orchestrator", locale: "zh" });
  fake.respond("session.event.list", () => ({
    events: [
      { seq: 1, run: "r1", type: "user/message", text: threadReportPrompt, time: SCENARIO_NOW - 10_000, revision: 1 },
      { seq: 2, run: "r1", type: "run/error", text: "no API key is set for the model", time: SCENARIO_NOW - 9_000, revision: 1 },
    ],
  }));

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:step-toggle-1") === 1 && app.count("id:step-toggle-2") === 1);

  expect(app.texts().join("\n")).not.toContain("no API key is set");
  expect(app.shows(`id:step-toggle-1 >> text:#general:1 · w1 Ada #4: ${localized}`)).toBe(true);
  expect(app.shows(`id:step-toggle-2 >> text:${localized}`)).toBe(true);

  // Expanding run/error opens berry callout with localized text and raw error copy.
  await app.press("id:step-toggle-2");
  expect(app.count("id:step-drawer-2")).toBe(1);
  expect(app.count("id:step-drawer-2 >> id:error-callout")).toBe(1);
  expect(app.count("id:step-drawer-2 >> id:error-copy-raw")).toBe(1);
  await app.press("id:step-drawer-2 >> id:error-copy-raw");
  await app.waitUntil(() => app.clipboard() === "no API key is set for the model");
});

test("Trajectory supports click-to-inspect structured drawers, waterfall click-to-expand, round folding, and expand/collapse all", async () => {
  const fake = fakeHost(scenarios.typical, { route: "/runs?session=orchestrator", locale: "en" });
  fake.respond("session.event.list", () => ({
    events: [
      { seq: 1, run: "r1", type: "user/message", text: "Check build health", time: SCENARIO_NOW - 20_000, revision: 1 },
      { seq: 2, run: "r1", type: "assistant/thinking", text: "Let me inspect package scripts first.", time: SCENARIO_NOW - 19_000, revision: 1 },
      {
        seq: 3,
        run: "r1",
        type: "tool/call",
        tool: "run_command",
        action: "run_command",
        text: "Run check",
        input: '{"command":"vp check"}',
        time: SCENARIO_NOW - 18_000,
        revision: 1,
      },
      { seq: 4, run: "r1", type: "tool/result", call: 3, ok: true, output: "0 warnings", text: "", time: SCENARIO_NOW - 16_500, revision: 1 },
      { seq: 5, run: "r1", type: "assistant/message", text: "Build is green.", time: SCENARIO_NOW - 16_000, revision: 1 },
      { seq: 6, run: "r2", type: "user/message", text: "Any errors?", time: SCENARIO_NOW - 10_000, revision: 1 },
      { seq: 7, run: "r2", type: "assistant/message", text: "None found.", time: SCENARIO_NOW - 9_000, revision: 1 },
    ],
  }));

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:run-group-r1") === 1 && app.count("id:run-group-r2") === 1);

  // Initially all step drawers are closed.
  expect(app.count("id:step-drawer-2")).toBe(0);
  expect(app.count("id:step-drawer-3")).toBe(0);
  expect(app.count("id:step-drawer-5")).toBe(0);

  // Clicking a thinking step opens its inline drawer and copies full text.
  await app.press("id:step-toggle-2");
  expect(app.count("id:step-drawer-2")).toBe(1);
  await app.press("id:step-drawer-2 >> id:step-copy-body");
  await app.waitUntil(() => app.clipboard() === "Let me inspect package scripts first.");

  // Clicking a tool call opens its structured drawer with status badge, duration, and copy buttons.
  await app.press("id:step-toggle-3");
  expect(app.count("id:step-drawer-3")).toBe(1);
  expect(app.count("id:step-drawer-3 >> id:tool-status-badge")).toBe(1);
  expect(app.count("id:step-drawer-3 >> id:tool-duration")).toBe(1);
  expect(app.count("id:step-drawer-3 >> id:tool-copy-input")).toBe(1);
  expect(app.count("id:step-drawer-3 >> id:tool-copy-output")).toBe(1);

  // Folding round r2 hides its rows; clicking Expand all opens all rounds and every step drawer.
  await app.press("id:run-header-r2");
  expect(app.count("id:step-toggle-6")).toBe(0);
  expect(app.count("id:trajectory-toggle-all")).toBe(1);

  await app.press("id:trajectory-toggle-all");
  expect(app.count("id:step-toggle-6")).toBe(1);
  expect(app.count("id:step-drawer-1")).toBe(1);
  expect(app.count("id:step-drawer-2")).toBe(1);
  expect(app.count("id:step-drawer-3")).toBe(1);
  expect(app.count("id:step-drawer-5")).toBe(1);
  expect(app.count("id:step-drawer-6")).toBe(1);
  expect(app.count("id:step-drawer-7")).toBe(1);

  // Clicking Collapse all collapses every step drawer back to compact single-line rows.
  await app.press("id:trajectory-toggle-all");
  expect(app.count("id:step-drawer-1")).toBe(0);
  expect(app.count("id:step-drawer-3")).toBe(0);
  expect(app.count("id:step-drawer-7")).toBe(0);

  // Clicking a waterfall bar jumps to and expands that step's drawer.
  expect(app.count("id:waterfall-bar-3")).toBe(1);
  await app.press("id:waterfall-bar-3");
  expect(app.count("id:step-drawer-3")).toBe(1);
});
