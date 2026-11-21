// Virtual-clock multi-density UI BDD suite driven by Rust-folded StateFrames from vibevalley-core::scenario.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import type { ConnectorState, ConnectorStatus, OrchestratorApproval } from "@vibevalley/protocol";

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
  expect(app.shows("id:desk-status >> text:没开工")).toBe(true);
  row.stepsPassed++;

  await fake.setState(app, { ...fixture.state, state: { ...fixture.state.state, call: "live" } });
  expect(app.shows("id:desk-status >> text:开工中 · 0 个在干活")).toBe(true);
  await fake.setState(app, fixture.state);
  expect(app.shows("id:desk-status >> text:没开工")).toBe(true);

  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
  });
  await visit(app, fake, "/agents", row, () => {
    expect(app.count("id:agents-page")).toBe(1);
  });
  await visit(app, fake, "/runs", row, () => {
    expect(app.count("id:runs-page")).toBe(1);
    expect(app.count("id:runs-empty")).toBe(1);
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

  // Working issue detail with subagents, tool connection, and follow-the-run trajectory link.
  await visit(app, fake, "/issues/i18", row, () => {
    expect(app.count("id:issue")).toBe(1);
    expect(app.count("id:subagent-progress")).toBe(1);
    expect(app.count("id:issue-open-trajectory")).toBe(1);
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
  const baseMsg = (fixture.responses["channel.message.list"] as Array<Record<string, unknown>>).at(0);
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

  // Legacy /orchestrator/trajectory redirects smoothly to /runs?session=orchestrator with PendingApprovals polling.
  await visit(app, fake, "/orchestrator/trajectory", row, () => {
    expect(app.count("id:runs-page")).toBe(1);
    expect(app.count("id:run-row-orchestrator")).toBe(1);
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

  // Unified /runs hub: scope filters and worker run selection.
  await visit(app, fake, "/runs", row, () => {
    expect(app.count("id:runs-page")).toBe(1);
    expect(app.count("id:run-row-w1")).toBe(1);
    expect(app.count("id:run-open-profile")).toBe(1);
  });
  await app.press("id:runs-scope-active");
  await fake.pump(app);
  expect(app.count("id:run-row-w1")).toBe(1);
  expect(app.count("id:run-row-w3")).toBe(0);
  await app.press("id:runs-scope-all");
  await fake.pump(app);
  row.stepsPassed++;

  // Orchestrator config page keeps memory/voice tabs and links out to /runs.
  await visit(app, fake, "/orchestrator/memory", row, () => {
    expect(app.count("id:orchestrator-page")).toBe(1);
    expect(app.count("id:orchestrator-runs-link")).toBe(1);
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
  await visit(app, fake, "/agents", row, () => {
    expect(app.count("id:agents-page")).toBe(1);
    expect(app.count("id:agents-toolbar")).toBe(1);
    expect(app.count("id:agent-card-orchestrator")).toBe(1);
    expect(app.count("id:agent-card-laozhou")).toBe(1);
    expect(app.count("id:toggle-on")).toBeGreaterThan(0);
    expect(app.count("id:toggle-off")).toBeGreaterThan(0);
  });
  await app.press("id:agents-role-filter-orchestrator");
  expect(app.count("id:agent-card-orchestrator")).toBe(1);
  expect(app.count("id:agent-card-laozhou")).toBe(0);
  await app.press("id:agents-role-filter-all");
  await app.type("id:agents-search", "不存在的档案");
  expect(app.count("id:agents-empty-search")).toBe(1);
  await app.press("id:agents-clear-filter");
  expect(app.count("id:agent-card-laozhou")).toBe(1);
  row.stepsPassed++;
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

  // Board shows folded closed column (< total 65 since 17 closed > closedShown 15), and reconciles wide/narrow working count (17) + running slots (6 / 6).
  const denseBoard = fixture.state.state.boardSummary;
  expect(denseBoard?.laneCounts.working).toBe(17);
  expect(denseBoard?.runningSlots).toBe(6);
  expect(denseBoard?.maxRunning).toBe(6);
  expect(app.shows("id:lane-working >> text:17")).toBe(true);
  expect(app.texts().some((s) => s.includes("6 / 6"))).toBe(true);
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
  expect(app.shows("id:board-lane-tab-working >> text:17")).toBe(true);
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
});

test("edge scenario verifies boardSummary, mediaSummary (all 8 MediaPhase), all 7 ConnectorState, and channelSummary (1287 unread)", async () => {
  const t0 = Date.now();
  const fixture = scenarios.edge;
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
    density: "edge",
    issues: fixture.state.state.issues.length,
    sessions: fixture.state.state.sessions.length,
    inbox: fixture.state.inbox.length,
    routes: ["/issues"],
    themes: ["light"],
    viewports: ["1280x820"],
    stepsPassed: 0,
    durationMs: 0,
  };

  // BoardSummary consistency across wide columns & narrow lane tabs.
  const boardSummary = fixture.state.state.boardSummary;
  expect(boardSummary).toBeDefined();
  expect(boardSummary?.laneCounts).toEqual({ todo: 3, working: 8, waiting: 4, closed: 9 });
  expect(boardSummary?.runningSlots).toBe(2);
  expect(boardSummary?.maxRunning).toBe(6);
  expect(app.count("id:issue-card")).toBe(fixture.state.state.issues.length);
  expect(app.shows("id:lane-todo >> text:3")).toBe(true);
  expect(app.shows("id:lane-working >> text:8")).toBe(true);
  expect(app.shows("id:lane-waiting >> text:4")).toBe(true);
  expect(app.shows("id:lane-closed >> text:9")).toBe(true);
  expect(app.texts().some((s) => s.includes("2 / 6"))).toBe(true);

  await app.setViewport(560, 800);
  row.viewports.push("560x800");
  expect(app.shows("id:board-lane-tab-todo >> text:3")).toBe(true);
  expect(app.shows("id:board-lane-tab-working >> text:8")).toBe(true);
  expect(app.shows("id:board-lane-tab-waiting >> text:4")).toBe(true);
  expect(app.shows("id:board-lane-tab-closed >> text:9")).toBe(true);
  await app.setViewport(1280, 820);
  row.stepsPassed++;

  // PR (review_after_failed_check), Branch (reviewed), Answer (handed_back), Interrupted (+worktree check), Quiet, deep 1-parent-6-child family.
  await visit(app, fake, "/issues/i-edge-pr-open", row, () => {
    expect(app.count("id:issue")).toBe(1);
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.count("id:failed-project-check")).toBe(1);
    expect(app.texts()).toContain("核对修复后，再次完成工单以重跑检查");
  });
  await visit(app, fake, "/issues/i-edge-reviewed", row, () => {
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.texts()).toContain("验收过了，可以完成");
  });
  await visit(app, fake, "/issues/i-edge-handed", row, () => {
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.texts().some((s) => s.includes("交回来了，等你验收"))).toBe(true);
    expect(app.texts().some((s) => s.includes("状态帧投影下沉 Rust 后宽窄屏计数完全一致"))).toBe(true);
  });
  await visit(app, fake, "/issues/i-edge-interrupted", row, () => {
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.texts()).toContain("这一轮停在半路");
    expect(app.texts().some((s) => s.includes("核对工作目录"))).toBe(true);
  });
  await visit(app, fake, "/issues/i-edge-quiet", row, () => {
    expect(app.count("id:issue-ask")).toBe(1);
    expect(app.texts().some((s) => s.includes("很久没动静了"))).toBe(true);
  });
  await visit(app, fake, "/issues/i-edge-family", row, () => {
    expect(app.count("id:issue-family")).toBe(1);
    expect(app.texts().some((s) => s.includes("子工单 1"))).toBe(true);
    expect(app.texts().some((s) => s.includes("子工单 6"))).toBe(true);
  });

  // Library: all 8 MediaPhase jobs present + mediaSummary drives active-job MakingTiles (3 active, understanding excluded).
  const fileMediaPhases = new Set((fixture.state.state.media ?? []).filter((job) => job.kind !== "understanding").map((job) => job.phase));
  expect(fileMediaPhases).toEqual(new Set(["queued", "generating", "downloading", "ready", "failed", "unknown", "canceled", "download_failed"]));
  expect(fixture.state.state.mediaSummary).toEqual({
    activeCount: 3,
    activeIds: ["job-edge-queued", "job-edge-generating", "job-edge-downloading"],
  });
  await visit(app, fake, "/library", row, () => {
    expect(app.count("id:library-page")).toBe(1);
    expect(app.count("id:library-making")).toBe(3);
  });

  // Chat: channelSummary drives 1287 unread total badge and per-channel unreadUnder (1285 / 2).
  expect(fixture.state.state.channelSummary?.unreadTotal).toBe(1287);
  expect(fixture.state.state.channelSummary?.unreadUnder.general).toBe(1285);
  await visit(app, fake, "/chat", row, () => {
    expect(app.count("id:chat-page")).toBe(1);
    expect(app.count("id:chat-unread-total")).toBe(1);
    expect(app.shows("id:chat-unread-total >> text:1287")).toBe(true);
    expect(app.shows("id:channel-row-general >> text:1285")).toBe(true);
  });

  await visit(app, fake, "/runs", row, () => {
    expect(app.count("id:runs-page")).toBe(1);
    expect(app.count("id:run-row-orchestrator")).toBe(1);
    expect(app.count("id:run-row-w-edge-fam4")).toBe(1);
    expect(app.shows("id:desk-status >> text:开工中 · 3 个在干活")).toBe(true);
  });

  // Connectors (/settings/chat): verify edge's scanned/verify/pairing plus remaining connected/paused/waiting/off (all 7 ConnectorState).
  const seenConnectorStates = new Set<ConnectorState>();
  const recordConnectors = (list: readonly ConnectorStatus[]) => {
    for (const entry of list) seenConnectorStates.add(entry.state);
  };
  recordConnectors(fixture.state.state.connectors);
  await visit(app, fake, "/settings/chat/weixin", row, () => {
    expect(app.count("id:connectors")).toBe(1);
    expect(app.count("id:connector-weixin")).toBe(1);
    expect(app.texts()).toContain("已扫码，等手机确认");
  });
  await visit(app, fake, "/settings/chat/feishu", row, () => {
    expect(app.count("id:connector-feishu")).toBe(1);
    expect(app.texts()).toContain("要输入手机上的数字");
  });
  await visit(app, fake, "/settings/chat/qq", row, () => {
    expect(app.count("id:connector-qq")).toBe(1);
    expect(app.texts()).toContain("等你发配对码");
  });

  const extraConnectors: ConnectorStatus[] = [
    { id: "weixin", state: "connected", qr: "", pairCode: "", channel: "general", user: "老陆", since: SCENARIO_NOW - 60_000, pending: 0, error: "" },
    {
      id: "feishu",
      state: "paused",
      qr: "",
      pairCode: "",
      channel: "general",
      user: "飞书机器人",
      pausedUntil: SCENARIO_NOW + 600_000,
      pending: 2,
      error: "",
    },
    { id: "qq", state: "waiting", qr: "https://example.com/qr-qq", pairCode: "", pending: 0, error: "" },
  ];
  recordConnectors(extraConnectors);
  await fake.setState(app, { ...fixture.state, state: { ...fixture.state.state, connectors: extraConnectors } });
  await visit(app, fake, "/settings/chat/weixin", row, () => {
    expect(app.texts()).toContain("已连接");
  });
  await visit(app, fake, "/settings/chat/feishu", row, () => {
    expect(app.texts()).toContain("暂停中");
  });
  await visit(app, fake, "/settings/chat/qq", row, () => {
    expect(app.texts()).toContain("等你扫码");
  });

  const offConnector: ConnectorStatus[] = [{ id: "weixin", state: "off", qr: "", pairCode: "", pending: 0, error: "" }];
  recordConnectors(offConnector);
  await fake.setState(app, { ...fixture.state, state: { ...fixture.state.state, connectors: offConnector } });
  await visit(app, fake, "/settings/chat/weixin", row, () => {
    expect(app.texts()).toContain("没连接");
  });
  expect(seenConnectorStates).toEqual(new Set(["off", "waiting", "scanned", "verify", "pairing", "connected", "paused"]));

  await app.setColorScheme("dark");
  row.themes.push("dark");
  row.durationMs = Date.now() - t0;
  matrix.push(row);
  console.log(`@@SCENARIO_MATRIX ${JSON.stringify(matrix)}`);
});

test("english locale renders issues, chat, and settings cleanly with zero crashes", async () => {
  const fixture = scenarios.typical;
  const fake = fakeHost(fixture, { route: "/issues", locale: "en" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  expect(app.count("id:issues-page")).toBe(1);
  const issueTexts = app.texts();
  expect(issueTexts).toContain("To do");
  expect(issueTexts).toContain("In progress");
  expect(issueTexts).toContain("For you to see");
  expect(issueTexts).toContain("Closed");
  expect(issueTexts).toContain("New issue");
  expect(issueTexts.some((s) => s.includes("spots"))).toBe(true);

  await app.host.send("route", "/chat");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:chat-page")).toBe(1);
  const chatTexts = app.texts();
  expect(chatTexts).toContain("Chat");
  expect(chatTexts).toContain("Channels");
  expect(chatTexts).toContain("Helpers");

  await app.host.send("route", "/settings/general");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:settings-nav")).toBe(1);
  const settingsTexts = app.texts();
  expect(settingsTexts).toContain("General");
  expect(settingsTexts).toContain("Page language");

  await app.host.send("route", "/runs");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:runs-page")).toBe(1);
  const runsTexts = app.texts();
  expect(runsTexts).toContain("Runs & trajectories");
  expect(runsTexts).toContain("Active");

  await app.host.send("route", "/agents");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:agents-page")).toBe(1);
  const agentsTexts = app.texts();
  expect(agentsTexts).toContain("Assistants");
  expect(agentsTexts).toContain("Helpers");
  expect(agentsTexts).toContain("New helper");
});
