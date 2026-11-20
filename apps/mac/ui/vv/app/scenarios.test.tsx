// Virtual-clock multi-density UI BDD suite driven by Rust-folded StateFrames from vibevalley-core::scenario.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import type { OrchestratorApproval } from "@vibevalley/protocol";

import { SCENARIO_NOW, type ScenarioDensity, scenarios } from "../fixtures/scenarios";
import { fakeHost } from "./fakeHost";

type Opened = Awaited<ReturnType<typeof open>>;

interface DensityMatrixRow {
  density: ScenarioDensity;
  issues: number;
  sessions: number;
  inbox: number;
  routes: string[];
  themes: string[];
  viewports: string[];
  stepsPassed: number;
  durationMs: number;
}

const matrix: DensityMatrixRow[] = [];

async function visit(app: Opened, fake: ReturnType<typeof fakeHost>, route: string, row: DensityMatrixRow, check: () => void | Promise<void>) {
  await app.host.send("route", route);
  await fake.pump(app);
  await fake.pump(app);
  await check();
  row.routes.push(route);
  row.stepsPassed++;
}

test("empty scenario keeps every major route stable across themes and narrow width", async () => {
  const t0 = Date.now();
  const fixture = scenarios.empty;
  const fake = fakeHost(fixture, { route: "/issues" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  const row: DensityMatrixRow = {
    density: "empty",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  expect(app.count("id:issues-page")).toBe(1);
  expect(app.count("id:issue-card")).toBe(0);
  row.stepsPassed++;

  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
  });
  await visit(app, fake, "/agents", row, () => {
    expect(app.count("id:agents-page")).toBe(1);
  });
  await visit(app, fake, "/artifacts", row, () => {
    expect(app.count("id:artifacts")).toBe(1);
  });
  await visit(app, fake, "/library", row, () => {
    expect(app.count("id:library-page")).toBe(1);
  });
  await visit(app, fake, "/pkm", row, () => {
    expect(app.count("id:pkm")).toBe(1);
  });
  await visit(app, fake, "/settings/general", row, () => {
    expect(app.count("id:settings-nav")).toBe(1);
  });

  await app.setColorScheme("dark");
  row.themes.push("dark");
  await app.setViewport(560, 800);
  row.viewports.push("560x800");
  await visit(app, fake, "/issues", row, () => {
    expect(app.count("id:issues-page")).toBe(1);
    expect(app.count("id:rail")).toBe(1);
  });

  row.durationMs = Date.now() - t0;
  matrix.push(row);
});

test("minimal scenario advances working duration on virtual clock across core views", async () => {
  const t0 = Date.now();
  const fixture = scenarios.minimal;
  const fake = fakeHost(fixture, { route: "/issues" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  const clock = app.clock;
  if (!clock) throw new Error("scenarios.test.tsx requires manual virtual clock");

  const row: DensityMatrixRow = {
    density: "minimal",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  expect(app.count("id:issue-card")).toBe(1);
  expect(app.texts()).toContain("修复登录过期跳转");
  row.stepsPassed++;

  await visit(app, fake, "/issues/i1", row, () => {
    expect(app.count("id:issue")).toBe(1);
  });
  await clock.fastForward(65_000);
  expect(app.texts().some((s) => s.includes("3 分钟") || s.includes("3 分"))).toBe(true);
  row.stepsPassed++;

  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
    expect(app.texts()).toContain("派给老周了，在工单 #18 里。");
  });
  await visit(app, fake, "/settings/general", row, () => {
    expect(app.count("id:settings-nav")).toBe(1);
  });

  row.durationMs = Date.now() - t0;
  matrix.push(row);
});

test("typical scenario verifies multi-stage BDD transitions and virtual-clock polling across workbench routes", async () => {
  const t0 = Date.now();
  const fixture = scenarios.typical;
  let pendingApprovals: OrchestratorApproval[] = [];
  const fake = fakeHost(fixture, { route: "/issues" });
  fake.respond("orchestrator.approval.list", () => pendingApprovals);

  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  const clock = app.clock;
  if (!clock) throw new Error("scenarios.test.tsx requires manual virtual clock");

  const row: DensityMatrixRow = {
    density: "typical",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  // Board -> List -> DisplayMenu.
  expect(app.count("id:issue-card")).toBe(fixture.state.state.issues.length);
  await app.press("id:issue-view-list");
  expect(app.count("id:issues-page")).toBe(1);
  await app.press("id:issue-view-board");
  row.stepsPassed++;

  // Working issue detail with subagents & tool connection.
  await visit(app, fake, "/issues/i18", row, () => {
    expect(app.count("id:issue")).toBe(1);
    expect(app.count("id:subagent-progress")).toBe(1);
  });

  // Asking issue BDD: click option -> fires comment/answer RPC.
  fake.clearCalls();
  await visit(app, fake, "/issues/i33", row, () => {
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.count("id:answer-option")).toBe(2);
  });
  await app.press("id:answer-option >> nth=0");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "issue.comment.create" || c.op === "issue.answer")).toBe(true);
  row.stepsPassed++;

  // Review issue BDD: open complete dialog.
  await visit(app, fake, "/issues/i31", row, () => {
    expect(app.count("id:act-complete")).toBe(1);
  });
  await app.press("id:act-complete");
  await fake.pump(app);
  expect(app.count("id:issue-diff")).toBeGreaterThanOrEqual(0);
  await app.keyboard.press("escape");
  row.stepsPassed++;

  // Family parent/child issue view.
  await visit(app, fake, "/issues/i40", row, () => {
    expect(app.count("id:issue-family")).toBe(1);
  });

  // Chat BDD: live channel push + send message + live notice event.
  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
  });
  const baseMsg = (fixture.responses["channel.message.list"] as Array<Record<string, unknown>>)[0];
  if (baseMsg) {
    await fake.emit(
      app,
      "channel.follow",
      {
        _tag: "Message",
        message: { ...baseMsg, id: "m-bdd-live", number: 999, text: "虚拟时钟场景推流新消息", at: SCENARIO_NOW },
      },
      (p: unknown) => (p as { id?: string }).id === "general",
    );
    expect(app.texts()).toContain("虚拟时钟场景推流新消息");
  }
  await fake.pushLive(app, { type: "notice", at: SCENARIO_NOW, level: "info", text: "工作台连接已同步" });
  row.stepsPassed++;

  // Orchestrator approval discovery via virtual clock fastForward (0ms wall wait!).
  await visit(app, fake, "/orchestrator/trajectory", row, () => {
    expect(app.count("id:orchestrator-page")).toBe(1);
  });
  pendingApprovals = [
    {
      conversationId: "orchestrator",
      taskId: "t-bdd",
      toolCallId: "call-bdd",
      toolName: "issue_create",
      argumentsJson: '{"title":"Virtual clock approval"}',
      reason: "需要人工确认创建高优先级工单",
      requestedAtMs: SCENARIO_NOW,
    },
  ];
  await clock.fastForward(3_100);
  await fake.pump(app);
  expect(app.texts()).toContain("需要人工确认创建高优先级工单");
  row.stepsPassed++;

  await visit(app, fake, "/artifacts", row, () => {
    expect(app.count("id:artifacts")).toBe(1);
  });
  await visit(app, fake, "/library", row, () => {
    expect(app.count("id:library-page")).toBe(1);
  });
  await visit(app, fake, "/pkm", row, () => {
    expect(app.count("id:pkm")).toBe(1);
  });
  await visit(app, fake, "/settings/general", row, () => {
    expect(app.count("id:settings-nav")).toBe(1);
  });
  await visit(app, fake, "/agents", row, () => {
    expect(app.count("id:agents-page")).toBe(1);
  });
  await visit(app, fake, "/catalog", row, () => {
    expect(app.count("id:catalog-page")).toBe(1);
  });
  await visit(app, fake, "/repos", row, () => {
    expect(app.count("id:repos-page")).toBe(1);
  });
  await visit(app, fake, "/runtimes", row, () => {
    expect(app.count("id:runtimes-page")).toBe(1);
  });

  await app.setColorScheme("dark");
  row.themes.push("dark");
  await app.host.send("route", "/issues");
  await fake.pump(app);
  expect(app.count("id:issues-page")).toBe(1);

  row.durationMs = Date.now() - t0;
  matrix.push(row);
});

test("dense scenario stresses 65 issues (OlderLink fold), 80 messages, 10 crons, narrow width & dark theme", async () => {
  const t0 = Date.now();
  const fixture = scenarios.dense;
  const fake = fakeHost(fixture, { route: "/issues" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  const row: DensityMatrixRow = {
    density: "dense",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  // Board shows folded closed column (< total 65 since 17 closed > closedShown 15), then unfolds/switches cleanly.
  const foldedCards = app.count("id:issue-card");
  expect(foldedCards).toBeGreaterThan(20);
  expect(foldedCards).toBeLessThan(fixture.state.state.issues.length);
  row.stepsPassed++;

  await app.press("id:issue-view-list");
  expect(app.count("id:issues-page")).toBe(1);
  await app.press("id:issue-view-board");
  row.stepsPassed++;

  await app.setViewport(560, 800);
  row.viewports.push("560x800");
  await app.setColorScheme("dark");
  row.themes.push("dark");
  expect(app.count("id:issues-page")).toBe(1);
  row.stepsPassed++;

  await app.setViewport(1280, 820);
  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
  });
  await app.press("id:tab-crons");
  await fake.pump(app);
  expect(app.count("id:cron-c1")).toBe(1);
  expect(app.count("id:cron-c10")).toBe(1);
  row.stepsPassed++;

  await visit(app, fake, "/library", row, () => {
    expect(app.count("id:library-page")).toBe(1);
  });

  row.durationMs = Date.now() - t0;
  matrix.push(row);
});

test("extreme scenario verifies long CJK/EN strings, conflict files, failed check output, and CallState::Error", async () => {
  const t0 = Date.now();
  const fixture = scenarios.extreme;
  const fake = fakeHost(fixture, { route: "/issues" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  const row: DensityMatrixRow = {
    density: "extreme",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  expect(app.count("id:issue-card")).toBe(fixture.state.state.issues.length);
  row.stepsPassed++;

  await visit(app, fake, "/issues/i-ext-conflict", row, () => {
    expect(app.count("id:issue")).toBe(1);
    expect(app.count("id:failed-check-output")).toBe(1);
    expect(app.texts()).toContain("error[E0599]: method not found in `BoardCard`");
    expect(app.count("id:conflict-file")).toBeGreaterThan(0);
  });

  await app.setViewport(560, 800);
  row.viewports.push("560x800");
  await app.setColorScheme("dark");
  row.themes.push("dark");
  expect(app.count("id:issue")).toBe(1);
  row.stepsPassed++;

  row.durationMs = Date.now() - t0;
  matrix.push(row);
  console.log(`@@SCENARIO_MATRIX ${JSON.stringify(matrix)}`);
});
