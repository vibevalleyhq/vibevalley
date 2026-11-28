import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { SessionEvent, SessionView, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

function withSessions(base: SliceBundle, sessions: SessionView[]): SliceBundle {
  return {
    ...base,
    sessions: {
      ...base.sessions,
      sessions,
    },
  };
}

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
  const ev1: SessionEvent = { seq: 1, run: "r1", type: "user/message", text: rawPrompt, time: SCENARIO_NOW - 10_000, revision: 1 };
  const ev2: SessionEvent = { seq: 2, run: "r1", type: "assistant/message", text: "好的，这就检查。", time: SCENARIO_NOW - 10_000, revision: 1 };
  fake.respond("session.event.list", () => ({
    events: [ev1, ev2],
    hasMore: false,
    oldestSeq: 1,
    newestSeq: 2,
    trajectory: {
      shown: [ev1, ev2],
      runs: [{ run: "r1", asked: ev1, steps: [ev2] }],
      waterfall: {
        runs: [[SCENARIO_NOW - 10_000, SCENARIO_NOW - 10_000]],
        spans: [
          { lane: "asked", start: SCENARIO_NOW - 10_000, end: SCENARIO_NOW - 10_000, seq: 1 },
          { lane: "model", start: SCENARIO_NOW - 10_000, end: SCENARIO_NOW - 10_000, seq: 2 },
        ],
      },
      summary: { runs: 1, steps: 2, modelMs: 0, toolMs: 0, input: 0, cacheRead: 0, output: 0 },
      stepDurations: [
        { seq: 1, durationMs: 0 },
        { seq: 2, durationMs: 0 },
      ],
      stepMeta: [
        { seq: 1, durationMs: 0, collapsedSummary: "检查发布脚本" },
        { seq: 2, durationMs: 0 },
      ],
      telemetry: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, llmRetries: 0, runErrors: 0 },
    },
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

  // Relative time column never wraps onto two lines.
  const stepWhenBox = app.layout("id:step-when-1");
  expect(stepWhenBox).not.toBeNull();
  expect(stepWhenBox!.height).toBeLessThanOrEqual(20);

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
  const errEv1: SessionEvent = { seq: 1, run: "r1", type: "user/message", text: threadReportPrompt, time: SCENARIO_NOW - 10_000, revision: 1 };
  const errEv2: SessionEvent = { seq: 2, run: "r1", type: "run/error", text: "no API key is set for the model", time: SCENARIO_NOW - 9_000, revision: 1 };
  fake.respond("session.event.list", () => ({
    events: [errEv1, errEv2],
    hasMore: false,
    oldestSeq: 1,
    newestSeq: 2,
    trajectory: {
      shown: [errEv1, errEv2],
      runs: [{ run: "r1", asked: errEv1, steps: [errEv2] }],
      waterfall: {
        runs: [[SCENARIO_NOW - 10_000, SCENARIO_NOW - 9_000]],
        spans: [{ lane: "asked", start: SCENARIO_NOW - 10_000, end: SCENARIO_NOW - 9_000, seq: 1 }],
      },
      summary: { runs: 1, steps: 2, modelMs: 0, toolMs: 0, input: 0, cacheRead: 0, output: 0 },
      stepDurations: [{ seq: 1, durationMs: 1_000 }],
      stepMeta: [
        { seq: 1, durationMs: 1_000, collapsedSummary: "#general:1 · w1 Ada #4: no API key is set for the model" },
        { seq: 2, durationMs: 0 },
      ],
      telemetry: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, llmRetries: 0, runErrors: 1 },
    },
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
  const trEvents: SessionEvent[] = [
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
  ];
  const trShown: SessionEvent[] = [trEvents[0], trEvents[1], { ...trEvents[2], ok: true, output: "0 warnings" }, trEvents[4], trEvents[5], trEvents[6]];
  fake.respond("session.event.list", () => ({
    events: trEvents,
    hasMore: false,
    oldestSeq: 1,
    newestSeq: 7,
    trajectory: {
      shown: trShown,
      runs: [
        { run: "r1", asked: trShown[0], steps: [trShown[1], trShown[2], trShown[3]] },
        { run: "r2", asked: trShown[4], steps: [trShown[5]] },
      ],
      waterfall: {
        runs: [
          [SCENARIO_NOW - 20_000, SCENARIO_NOW - 16_000],
          [SCENARIO_NOW - 10_000, SCENARIO_NOW - 9_000],
        ],
        spans: [
          { lane: "asked", start: SCENARIO_NOW - 20_000, end: SCENARIO_NOW - 19_000, seq: 1 },
          { lane: "model", start: SCENARIO_NOW - 19_000, end: SCENARIO_NOW - 18_000, seq: 2 },
          { lane: "tool", start: SCENARIO_NOW - 18_000, end: SCENARIO_NOW - 16_500, seq: 3 },
          { lane: "model", start: SCENARIO_NOW - 16_500, end: SCENARIO_NOW - 16_000, seq: 5 },
          { lane: "asked", start: SCENARIO_NOW - 10_000, end: SCENARIO_NOW - 9_000, seq: 6 },
          { lane: "model", start: SCENARIO_NOW - 10_000, end: SCENARIO_NOW - 9_000, seq: 7 },
        ],
      },
      summary: { runs: 2, steps: 6, modelMs: 2_500, toolMs: 1_500, input: 0, cacheRead: 0, output: 0 },
      stepDurations: [
        { seq: 1, durationMs: 1_000 },
        { seq: 2, durationMs: 1_000 },
        { seq: 3, durationMs: 1_500 },
        { seq: 5, durationMs: 0 },
        { seq: 6, durationMs: 1_000 },
        { seq: 7, durationMs: 0 },
      ],
      stepMeta: [
        { seq: 1, durationMs: 1_000, collapsedSummary: "Check build health" },
        { seq: 2, durationMs: 1_000 },
        { seq: 3, durationMs: 1_500, readableInput: "$ vp check" },
        { seq: 5, durationMs: 0 },
        { seq: 6, durationMs: 1_000, collapsedSummary: "Any errors?" },
        { seq: 7, durationMs: 0 },
      ],
      telemetry: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, llmRetries: 0, runErrors: 0 },
    },
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

test("RunsPage displays telemetry rollup badges, spent cost, and context meter on RunListRow and RunDetail", async () => {
  setLocale("en");
  const base = scenarios.typical.state;
  const sessions = base.sessions.sessions.map((s) => {
    if (s.id === "w1") {
      return {
        ...s,
        spent: { tokens: 18_500, cny: 0.42 },
        telemetry: {
          inputTokens: 10_000,
          cacheReadTokens: 6_000,
          outputTokens: 2_500,
          contextUsed: 80_000,
          contextWindow: 128_000,
          llmRetries: 2,
          runErrors: 1,
        },
      };
    }
    if (s.id === "w2") {
      return {
        ...s,
        spent: undefined,
        telemetry: undefined,
      };
    }
    return s;
  });

  const fake = fakeHost({ state: withSessions(base, sessions), responses: scenarios.typical.responses }, { route: "/runs?session=w1", locale: "en" });
  fake.respond("session.event.list", (payload: unknown) => {
    const id = (payload as { id?: string }).id;
    if (id === "w2") {
      const w2Events: SessionEvent[] = [
        {
          seq: 1,
          revision: 1,
          run: "r-w2",
          type: "llm/usage",
          text: "",
          time: SCENARIO_NOW - 5_000,
          tokens: { input: 3_000, cacheRead: 1_000, output: 1_000, contextUsed: 32_000, contextWindow: 100_000 },
        },
        { seq: 2, revision: 1, run: "r-w2", type: "llm/retry", text: "rate limited", time: SCENARIO_NOW - 4_000 },
        { seq: 3, revision: 1, run: "r-w2", type: "run/error", text: "command exited 1", time: SCENARIO_NOW - 3_000 },
      ];
      return {
        events: w2Events,
        hasMore: false,
        oldestSeq: 1,
        newestSeq: 3,
        trajectory: {
          shown: w2Events,
          runs: [{ run: "r-w2", steps: w2Events }],
          waterfall: { runs: [[SCENARIO_NOW - 5_000, SCENARIO_NOW - 3_000]], spans: [] },
          summary: { runs: 1, steps: 2, modelMs: 0, toolMs: 0, input: 3_000, cacheRead: 1_000, output: 1_000 },
          stepDurations: [{ seq: 2, durationMs: 1_000 }],
          stepMeta: [
            { seq: 2, durationMs: 1_000 },
            { seq: 3, durationMs: 0 },
          ],
          telemetry: {
            inputTokens: 3_000,
            cacheReadTokens: 1_000,
            outputTokens: 1_000,
            contextUsed: 32_000,
            contextWindow: 100_000,
            llmRetries: 1,
            runErrors: 1,
          },
        },
      };
    }
    return { events: [] };
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:run-detail-telemetry") === 1);

  // RunListRow for w1 renders cost, retry badge, error badge, and compact context meter.
  expect(app.count("id:run-row-cost-w1")).toBe(1);
  expect(app.shows("id:run-row-w1 >> text:¥0.42 · 18.5k")).toBe(true);
  expect(app.shows("id:run-row-retry-w1 >> text:2 retries")).toBe(true);
  expect(app.shows("id:run-row-error-w1 >> text:1 error")).toBe(true);
  expect(app.shows("id:run-row-context-w1 >> text:Ctx 63%")).toBe(true);

  // RunDetail header for w1 displays full telemetry summary.
  expect(app.count("id:run-detail-spent")).toBe(1);
  expect(app.shows("id:run-detail-telemetry >> text:about ¥0.42 · 19k token")).toBe(true);
  expect(app.shows("id:run-detail-retry-badge >> text:2 retries")).toBe(true);
  expect(app.shows("id:run-detail-error-badge >> text:1 error")).toBe(true);
  expect(app.shows("id:run-detail-context-meter >> text:Context 63% (80k/128k)")).toBe(true);

  // Selecting w2 falls back to folding session.event.list events into RunDetail telemetry.
  await app.press("id:run-row-w2");
  await fake.pumpUntil(app, () => app.shows("id:run-detail-context-meter >> text:Context 32% (32k/100k)"));
  expect(app.shows("id:run-detail-retry-badge >> text:1 retry")).toBe(true);
  expect(app.shows("id:run-detail-error-badge >> text:1 error")).toBe(true);
});

test("RunsPage offers one-click recovery actions for failed, interrupted, and resting runs and hides them on done runs", async () => {
  setLocale("en");
  const base = scenarios.typical.state;
  const sessions: SessionView[] = base.sessions.sessions.map((s) => {
    if (s.id === "w1") {
      return {
        ...s,
        cwd: "/tmp/wt/w1",
        phase: { _tag: "failed" },
        lastRun: { outcome: "failed", summary: "exit 1", at: SCENARIO_NOW - 2_000 },
      };
    }
    if (s.id === "w2") {
      return {
        ...s,
        cwd: "/tmp/wt/w2",
        phase: { _tag: "resting" },
        lastRun: { outcome: "interrupted", summary: "interrupted", at: SCENARIO_NOW - 5_000 },
      };
    }
    if (s.id === "w3") {
      return {
        ...s,
        cwd: "/tmp/wt/w3",
        phase: { _tag: "resting" },
        lastRun: { outcome: "completed", summary: "resting", at: SCENARIO_NOW - 4_000 },
      };
    }
    if (s.id === "w4") {
      return {
        ...s,
        phase: { _tag: "done" },
        lastRun: { outcome: "completed", summary: "done", at: SCENARIO_NOW - 3_000 },
      };
    }
    return s;
  });

  const fake = fakeHost({ state: withSessions(base, sessions), responses: scenarios.typical.responses }, { route: "/runs?session=w1", locale: "en" });
  fake.respond("host.openTerminal", null);
  fake.respond("issue.status.update", {});
  fake.respond("issue.comment.create", {});

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:run-detail-recovery") === 1);

  // Failed run (w1): shows Retry with same config, Rerun with another expert/engine, and Open Worktree Terminal.
  expect(app.shows("id:run-resume-same >> text:Retry with same config")).toBe(true);
  expect(app.count("id:run-rerun-other")).toBe(1);
  expect(app.count("id:run-open-worktree-terminal")).toBe(1);

  await app.press("id:run-open-worktree-terminal");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "host.openTerminal"));
  const termCall = fake.calls.find((c) => c.op === "host.openTerminal");
  expect((termCall?.payload as { cwd?: string } | undefined)?.cwd).toBe("/tmp/wt/w1");

  await app.press("id:run-resume-same");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));
  const retryCall = fake.calls.find((c) => c.op === "issue.status.update");
  expect((retryCall?.payload as { id?: string; status?: string } | undefined)?.id).toBe("i18");
  expect((retryCall?.payload as { status?: string } | undefined)?.status).toBe("todo");

  fake.clearCalls();
  await app.press("id:run-rerun-other");
  await fake.pumpUntil(app, () => app.count("id:run-rerun-dialog") === 1);
  expect(app.count("id:run-rerun-target")).toBe(1);
  await app.type("id:run-rerun-note", "focus on regression tests");
  await app.press("id:run-rerun-confirm");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));
  const rerunCall = fake.calls.find((c) => c.op === "issue.status.update");
  const rerunPayload = rerunCall?.payload as { id?: string; status?: string; agent?: string; text?: string } | undefined;
  expect(rerunPayload?.id).toBe("i18");
  expect(rerunPayload?.status).toBe("todo");
  expect(typeof rerunPayload?.agent).toBe("string");
  expect((rerunPayload?.agent ?? "").length).toBeGreaterThan(0);
  expect(rerunPayload?.text).toBe("focus on regression tests");

  // Interrupted run (w2): shows Resume with same config and triggers issue.status.update.
  fake.clearCalls();
  await app.press("id:run-row-w2");
  await fake.pumpUntil(app, () => app.shows("id:run-resume-same >> text:Resume with same config"));
  await app.press("id:run-resume-same");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));

  // Resting run (w3): shows Resume with same config and triggers issue.comment.create.
  fake.clearCalls();
  await app.press("id:run-row-w3");
  await fake.pumpUntil(app, () => app.shows("id:run-resume-same >> text:Resume with same config"));
  await app.press("id:run-resume-same");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.comment.create"));

  // Done run (w4): hides recovery action bar.
  await app.press("id:run-row-w4");
  await fake.pump(app);
  expect(app.count("id:run-detail-recovery")).toBe(0);
});

test("RunsPage exposes manual context compaction and CodeMode dialog for durable sessions", async () => {
  const base = scenarios.typical.state;
  const template = base.sessions.sessions.find((s) => s.role === "worker");
  if (!template) throw new Error("typical scenario must include a worker session");

  const vvWorker: SessionView = {
    ...template,
    id: "w-vv" as SessionView["id"],
    name: "Durable Helper",
    runtime: "vibevalley",
    phase: { _tag: "resting" },
    phaseText: "Idle",
  };
  const ocWorker: SessionView = {
    ...template,
    id: "w-oc" as SessionView["id"],
    name: "OpenCode Helper",
    runtime: "opencode",
    phase: { _tag: "resting" },
    phaseText: "Idle",
  };

  const fake = fakeHost(
    { state: withSessions(base, [vvWorker, ocWorker]), responses: scenarios.typical.responses },
    { route: "/runs?session=w-vv", locale: "en" },
  );
  fake.respond("session.compact", { id: "w-vv", compacted: true, summary: "## Goal\nCompacted via UI" });
  fake.respond("session.runCode", {
    id: "w-vv",
    taskId: "cm-task-1",
    outputJson: '{"ok":true,"count":3}',
    executedSteps: 42,
    replayedCalls: 1,
    replayedSleeps: 0,
    virtualNowMs: 1200,
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:run-compact-context") === 1);
  expect(app.count("id:run-codemode-open")).toBe(1);

  // Trigger manual compaction from the RunDetail header.
  await app.press("id:run-compact-context");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "session.compact"));
  expect((fake.calls.find((c) => c.op === "session.compact")?.payload as { id?: string } | undefined)?.id).toBe("w-vv");
  await app.waitUntil(() => app.count("id:toast") === 1 && app.texts().includes("Context compacted"));

  // Open CodeMode dialog, enter a script, submit, and inspect output JSON + stats.
  await app.press("id:run-codemode-open");
  await fake.pumpUntil(app, () => app.count("id:run-codemode-dialog") === 1);
  await app.type("id:run-codemode-script", "return { ok: true, count: 3 };");
  await app.press("id:run-codemode-submit");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "session.runCode"));
  const cmPayload = fake.calls.find((c) => c.op === "session.runCode")?.payload as { id?: string; script?: string } | undefined;
  expect(cmPayload?.id).toBe("w-vv");
  expect(cmPayload?.script).toBe("return { ok: true, count: 3 };");
  await fake.pumpUntil(app, () => app.count("id:run-codemode-output") === 1);
  expect(app.texts()).toContain('{"ok":true,"count":3}');
  await app.press("id:run-codemode-cancel");
  await fake.pumpUntil(app, () => app.count("id:run-codemode-dialog") === 0);

  // Switching to an external OpenCode session hides CodeMode and manual compaction controls.
  await app.press("id:run-row-w-oc");
  await fake.pump(app);
  expect(app.count("id:run-compact-context")).toBe(0);
  expect(app.count("id:run-codemode-open")).toBe(0);
});
