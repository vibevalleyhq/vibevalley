import { describe, expect, it } from "vite-plus/test";

import {
  aggregateFlowMatrixReport,
  aggregateFlowReport,
  checkFarmPhoneOverlayInvariants,
  checkKanbanBoardInvariants,
  checkNavigationAndThemeParity,
  checkNewIssueDropdownReadiness,
  checkQuickPeekInvariants,
  checkSelectPopupDownward,
  DEFAULT_FLOW_THEMES,
  DEFAULT_FLOW_VIEWPORTS,
  EXPECTED_RAIL_PLACES,
  expectedPeekModalDimensions,
  flattenUiNodes,
  type FlowStepResult,
  type FlowUiNode,
  parseFlowArgs,
  runFlowMatrix,
  runFlowScenario,
  type VdpDriver,
} from "./vdp-flow.ts";

interface FakeDriverOptions {
  readonly injectWorkingSlots?: boolean;
  readonly injectShellErrorOnRoute?: string;
  readonly hasRunSteps?: boolean;
  readonly injectUpwardSelectPopup?: boolean;
  readonly injectNarrowPeek?: boolean;
  readonly injectClippedWeek6?: boolean;
  readonly injectFarmPhoneOverflow?: boolean;
  readonly farmPhoneOpen?: boolean;
  readonly missingRailPlace?: string;
  readonly corruptThemeSync?: boolean;
}

function createFakeVdpDriver(options?: FakeDriverOptions): {
  readonly driver: VdpDriver;
  readonly pressed: string[];
  readonly navigated: string[];
  readonly resized: Array<{ width: number; height: number }>;
  readonly themes: string[];
  readonly shots: string[];
} {
  const pressed: string[] = [];
  const navigated: string[] = [];
  const resized: Array<{ width: number; height: number }> = [];
  const themes: string[] = [];
  const shots: string[] = [];

  let route = "/issues";
  let width = 1280;
  let height = 800;
  let themeDark = false;
  let newIssueOpen = false;
  let repoPopupOpen = false;
  let peekOpen = false;
  let issueMode: "board" | "list" | "calendar" = "board";
  let runStepExpanded = false;

  const railNodes = (): FlowUiNode[] =>
    EXPECTED_RAIL_PLACES.filter((id) => id !== options?.missingRailPlace).map((id, idx) => ({
      testId: `place-${id}`,
      role: "link",
      text: id,
      route: id === "workspace" ? "/repos" : id === "team" ? "/agents" : id === "content" ? "/library" : `/${id}`,
      pressable: true,
      bounds: { x: 4, y: 12 + idx * 52, width: 64, height: 46 },
    }));

  const currentNodes = (): FlowUiNode[] => {
    const base: FlowUiNode[] = [...railNodes()];
    if (route === "/issues") {
      base.push(
        { testId: "issues-page", role: "main", route: "/issues" },
        { testId: "issue-toolbar-new", role: "button", pressable: true },
        { testId: "issue-view", role: "radiogroup" },
        { testId: "issue-view-list", role: "radio", text: "列表", pressable: true },
        { testId: "issue-view-calendar", role: "radio", text: "日历", pressable: true },
        { testId: "issue-card", role: "button", text: "Seeded issue", pressable: true },
      );
      if (issueMode === "board") {
        base.push(
          { testId: "lane-backlog", role: "region", text: "需求池" },
          { testId: "lane-todo", role: "region", text: "待办" },
          { testId: "lane-in_progress", role: "region", text: "进行中" },
          { testId: "lane-in_review", role: "region", text: "待验收" },
          { testId: "lane-done", role: "region", text: "已完成" },
          { testId: "lane-canceled", role: "region", text: "已废弃" },
        );
        if (options?.injectWorkingSlots === true) {
          base.push({ testId: "lane-working-slots", role: "text", text: "0/6" });
        }
      } else if (issueMode === "calendar") {
        const week6Y = options?.injectClippedWeek6 === true ? height - 40 : Math.max(120, height - 104);
        base.push(
          { testId: "issue-calendar", role: "region", bounds: { x: 76, y: 44, width: width - 76, height: height - 44 } },
          { testId: "calendar-week-5", role: "row", bounds: { x: 76, y: week6Y, width: width - 76, height: 88 } },
        );
      }
      if (newIssueOpen) {
        base.push(
          { testId: "issue-new-dialog", role: "dialog" },
          { testId: "issue-new-text", role: "textbox" },
          { testId: "issue-new-repo", role: "combobox" },
          {
            testId: "issue-new-repo-trigger",
            role: "button",
            pressable: true,
            bounds: { x: 220, y: 260, width: 160, height: 28 },
          },
          { testId: "issue-new-helper", role: "combobox" },
          { testId: "issue-new-dialog-never", role: "button", pressable: true },
        );
        if (repoPopupOpen) {
          base.push({
            testId: "issue-new-repo-search",
            role: "textbox",
            bounds: options?.injectUpwardSelectPopup === true ? { x: 220, y: 240, width: 180, height: 32 } : { x: 220, y: 292, width: 180, height: 32 },
          });
        }
      }
      if (peekOpen) {
        const expected = expectedPeekModalDimensions({ width, height });
        const modalW = options?.injectNarrowPeek === true ? 480 : expected.width;
        const modalH = options?.injectNarrowPeek === true ? 360 : expected.height;
        base.push(
          { testId: "issue-peek-modal", role: "dialog", bounds: { x: 40, y: expected.marginTop, width: modalW, height: modalH } },
          { testId: "issue-peek-surface", role: "region", bounds: { x: 40, y: expected.marginTop, width: modalW, height: modalH } },
          { testId: "issue-peek-expand", role: "button", pressable: true },
        );
      }
      return base;
    }
    if (route.startsWith("/issues/")) {
      base.push({ testId: "issue", role: "main", route }, { testId: "issue-title", role: "header", text: "Seeded issue" });
      return base;
    }
    if (route === "/runs") {
      if (options?.hasRunSteps === false) {
        base.push({ testId: "runs-page", role: "main", route: "/runs" }, { testId: "runs-empty", role: "region", text: "No runs" });
        return base;
      }
      base.push(
        { testId: "runs-page", role: "main", route: "/runs" },
        { testId: "run-row-sess-1", role: "button", pressable: true },
        { testId: "step-toggle-1", role: "button", pressable: true },
      );
      if (runStepExpanded) {
        base.push({ testId: "step-drawer-1", role: "region", text: "Structured step detail" });
      }
      return base;
    }
    if (route === "/farm") {
      base.push({ testId: "farm", role: "main", route: "/farm" });
      return base;
    }
    if (route === "/runtimes") {
      base.push({ testId: "runtimes-page", role: "main", route: "/runtimes" });
      return base;
    }
    base.push({ testId: `page:${route}`, role: "main", route });
    return base;
  };

  const phoneNodes = (): FlowUiNode[] => {
    if (options?.farmPhoneOpen === false) return [];
    const w = 296;
    const h = 330;
    const x = options?.injectFarmPhoneOverflow === true ? width - 150 : width - w - 14;
    const y = height - h - 14;
    return [{ testId: "farm-phone", role: "region", bounds: { x, y, width: w, height: h } }];
  };

  const driver: VdpDriver = {
    async navigate(next: string) {
      navigated.push(next);
      route = next;
      newIssueOpen = false;
      repoPopupOpen = false;
      peekOpen = false;
      if (next !== "/issues") issueMode = "board";
    },
    async resize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
      resized.push({ width: nextWidth, height: nextHeight });
    },
    async setTheme(theme) {
      themes.push(theme);
      themeDark = options?.corruptThemeSync === true ? theme !== "dark" : theme === "dark";
    },
    async getState() {
      const workbenchErrors = options?.injectShellErrorOnRoute === route ? [`render crash on ${route}`] : [];
      return {
        loaded: true,
        load_error: null,
        route,
        theme_dark: themeDark,
        diorama:
          route === "/farm"
            ? {
                kind: "farm",
                placed: { w: Math.max(100, width - 72), h: height, scale: 2 },
                scene: { renderer: "diorama-wgpu" },
              }
            : null,
        sidebar: { ready: true, errors: [] },
        workbench: { ready: true, errors: workbenchErrors },
        inspector: null,
        palette: null,
        projects: [],
      };
    },
    async getMetrics() {
      return { width, height, scaleFactor: 2, themeDark, lastFrameMs: 4 };
    },
    async uiQuery(params) {
      if (params.view === "farm-phone") {
        if (route !== "/farm" || options?.farmPhoneOpen === false) {
          throw new Error('UI view "farm-phone" is not mounted');
        }
        const matched = phoneNodes().filter((node) => params.testId === undefined || node.testId === params.testId);
        return { view: "farm-phone", route, count: matched.length, nodes: matched };
      }
      const matched = currentNodes().filter((node) => {
        if (params.testId !== undefined && node.testId !== params.testId) return false;
        if (params.role !== undefined && node.role !== params.role) return false;
        if (params.text !== undefined && !(node.text ?? "").includes(params.text)) return false;
        return true;
      });
      return { view: params.view ?? "workbench", route, count: matched.length, nodes: matched };
    },
    async uiPress(testId: string) {
      pressed.push(testId);
      if (testId === "issue-toolbar-new") newIssueOpen = true;
      else if (testId === "issue-new-repo-trigger" || testId === "issue-new-repo") repoPopupOpen = true;
      else if (testId === "issue-new-dialog-never") {
        newIssueOpen = false;
        repoPopupOpen = false;
      } else if (testId === "issue-card") peekOpen = true;
      else if (testId === "issue-peek-expand") {
        peekOpen = false;
        route = "/issues/iss_01";
      } else if (testId === "issue-view-list") issueMode = "list";
      else if (testId === "issue-view-calendar") issueMode = "calendar";
      else if (testId === "step-toggle-1") runStepExpanded = true;
      return { pressed: true, view: "workbench", testId };
    },
    async uiWaitFor(params) {
      const res = await driver.uiQuery(params);
      return { found: res.count > 0, node: res.nodes[0] ?? null };
    },
    async uiGetTree(view = "workbench") {
      return { view, route, nodes: [{ testId: `view:${view}`, role: "root", route, children: currentNodes() }] };
    },
    async captureScreenshot(outPath: string) {
      shots.push(outPath);
      return { path: outPath, mime: "image/png", width: width * 2, height: height * 2, bytes: 64_000 };
    },
    async settle() {},
  };

  return { driver, pressed, navigated, resized, themes, shots };
}

describe("vdp-flow", () => {
  it("parses default multi-viewport x light/dark options, single overrides, and validates invalid flags", () => {
    expect(parseFlowArgs([], "/repo")).toEqual({
      outDir: "/tmp/vv-vdp-flow",
      port: undefined,
      home: undefined,
      url: undefined,
      themes: [...DEFAULT_FLOW_THEMES],
      viewports: [...DEFAULT_FLOW_VIEWPORTS],
      skipBuild: false,
      keepSandbox: false,
      help: false,
    });

    expect(
      parseFlowArgs(
        [
          "--out",
          "flow-out",
          "--port=9222",
          "--home",
          "sandbox-home",
          "--url=ws://127.0.0.1:9222/devtools",
          "--theme",
          "dark",
          "--width=1440",
          "--height",
          "900",
          "--skip-build",
          "--keep-sandbox",
        ],
        "/repo",
      ),
    ).toEqual({
      outDir: "/repo/flow-out",
      port: 9222,
      home: "/repo/sandbox-home",
      url: "ws://127.0.0.1:9222/devtools",
      themes: ["dark"],
      viewports: [{ width: 1440, height: 900 }],
      skipBuild: true,
      keepSandbox: true,
      help: false,
    });

    expect(parseFlowArgs(["--viewports=900x720,1680×1050,900x720", "--themes=dark,light"], "/repo")).toMatchObject({
      themes: ["dark", "light"],
      viewports: [
        { width: 900, height: 720 },
        { width: 1680, height: 1050 },
      ],
    });

    expect(parseFlowArgs(["--help"], "/repo").help).toBe(true);
    expect(() => parseFlowArgs(["--port=70000"], "/repo")).toThrow(/between 1 and 65535/u);
    expect(() => parseFlowArgs(["--port=abc"], "/repo")).toThrow(/positive integer/u);
    expect(() => parseFlowArgs(["--theme=sepia"], "/repo")).toThrow(/unsupported theme/u);
    expect(() => parseFlowArgs(["--viewports=wide"], "/repo")).toThrow(/invalid viewport/u);
    expect(() => parseFlowArgs(["--viewports=900x720", "--width=1280"], "/repo")).toThrow(/cannot be combined/u);
    expect(() => parseFlowArgs(["--bogus"], "/repo")).toThrow(/unknown option/u);
  });

  it("checks Kanban 6-lane, downward Select, wide Peek, Farm phone, and rail/theme invariants", () => {
    const flat = flattenUiNodes([
      {
        testId: "root",
        children: [
          { testId: "lane-backlog", text: "需求池" },
          { testId: "lane-todo", text: "待办" },
          { testId: "lane-in_progress", text: "进行中" },
          { testId: "lane-in_review", text: "待验收" },
          { testId: "lane-done", text: "已完成" },
          { testId: "lane-canceled", text: "已废弃" },
        ],
      },
    ]);
    expect(flat).toHaveLength(7);

    const okBoard = checkKanbanBoardInvariants(flat, 0);
    expect(okBoard.every((c) => c.passed)).toBe(true);
    expect(okBoard.find((c) => c.name === "kanban-6-lanes")?.passed).toBe(true);

    // Obsolete 4-lane layout missing backlog & canceled must fail.
    const obsoleteFourLanes = checkKanbanBoardInvariants(
      [
        { testId: "lane-todo", text: "待办" },
        { testId: "lane-in_progress", text: "进行中" },
        { testId: "lane-in_review", text: "待验收" },
        { testId: "lane-done", text: "已完成" },
      ],
      1,
    );
    expect(obsoleteFourLanes.filter((c) => !c.passed)).toHaveLength(2);
    expect(obsoleteFourLanes.find((c) => c.name === "kanban-6-lanes")?.detail).toContain("lane-backlog");
    expect(obsoleteFourLanes.find((c) => c.name === "kanban-6-lanes")?.detail).toContain("lane-canceled");

    const okDialog = checkNewIssueDropdownReadiness({
      dialogOpen: true,
      repoSelectCount: 1,
      helperSelectCount: 1,
      missingRepoCount: 0,
      missingRuntimeCount: 0,
      dialogClosedAfterCancel: true,
    });
    expect(okDialog.every((c) => c.passed)).toBe(true);

    const okSelect = checkSelectPopupDownward({
      triggerTestId: "issue-new-repo-trigger",
      triggerNodes: [{ testId: "issue-new-repo-trigger", bounds: { x: 200, y: 240, width: 160, height: 28 } } as FlowUiNode],
      popupNodes: [{ testId: "issue-new-repo-search", bounds: { x: 200, y: 272, width: 180, height: 32 } } as FlowUiNode],
      viewportHeight: 720,
    });
    expect(okSelect.every((c) => c.passed)).toBe(true);

    const badCoveringSelect = checkSelectPopupDownward({
      triggerTestId: "issue-new-repo-trigger",
      triggerNodes: [{ testId: "issue-new-repo-trigger", bounds: { x: 200, y: 240, width: 160, height: 28 } } as FlowUiNode],
      popupNodes: [{ testId: "issue-new-repo-search", bounds: { x: 200, y: 250, width: 180, height: 32 } } as FlowUiNode],
      viewportHeight: 720,
    });
    expect(badCoveringSelect.find((c) => c.name === "select-popup-downward-cover-false")?.passed).toBe(false);

    expect(expectedPeekModalDimensions({ width: 900, height: 720 })).toEqual({ width: 792, height: 634, marginTop: 43 });
    expect(expectedPeekModalDimensions({ width: 1280, height: 800 })).toEqual({ width: 1126, height: 704, marginTop: 48 });
    expect(expectedPeekModalDimensions({ width: 1680, height: 1050 })).toEqual({ width: 1260, height: 924, marginTop: 63 });

    const okPeek = checkQuickPeekInvariants({
      cardCount: 2,
      peekModalCount: 1,
      peekExpandCount: 1,
      shellRoute: "/issues",
      viewport: { width: 1280, height: 800 },
      peekSurfaceBounds: { x: 77, y: 48, width: 1126, height: 704 },
    });
    expect(okPeek.every((c) => c.passed)).toBe(true);

    const narrowPeek = checkQuickPeekInvariants({
      cardCount: 2,
      peekModalCount: 1,
      peekExpandCount: 1,
      shellRoute: "/issues/iss_01",
      viewport: { width: 1280, height: 800 },
      peekSurfaceBounds: { x: 200, y: 100, width: 520, height: 420 },
    });
    expect(narrowPeek.find((c) => c.name === "quick-peek-wide-geometry")?.passed).toBe(false);
    expect(narrowPeek.find((c) => c.name === "quick-peek-stays-on-issues")?.passed).toBe(false);

    const okFarm = checkFarmPhoneOverlayInvariants({
      shellRoute: "/farm/vibevalley",
      diorama: { kind: "farm", placed: { w: 828, h: 720, scale: 2 } },
      farmViewCount: 1,
      phoneNodes: [{ testId: "farm-phone", bounds: { x: 590, y: 376, width: 296, height: 330 } } as FlowUiNode],
      viewport: { width: 900, height: 720 },
    });
    expect(okFarm.every((c) => c.passed)).toBe(true);

    const overflowFarm = checkFarmPhoneOverlayInvariants({
      shellRoute: "/farm",
      diorama: { kind: "farm", placed: { w: 828, h: 720, scale: 2 } },
      farmViewCount: 1,
      phoneNodes: [{ testId: "farm-phone", bounds: { x: 700, y: 376, width: 296, height: 330 } } as FlowUiNode],
      viewport: { width: 900, height: 720 },
    });
    expect(overflowFarm.find((c) => c.name === "farm-phone-overlay")?.passed).toBe(false);

    const navParityBad = checkNavigationAndThemeParity({
      treeNodes: EXPECTED_RAIL_PLACES.slice(0, 8).map((id, i) => ({
        testId: `place-${id}`,
        bounds: { x: 4, y: i * 90, width: 64, height: 50 },
      })),
      theme: "dark",
      shellThemeDark: false,
      metricsThemeDark: false,
      viewport: { width: 900, height: 720 },
    });
    expect(navParityBad.find((c) => c.name === "rail-navigation-parity")?.passed).toBe(false);
    expect(navParityBad.find((c) => c.name === "theme-scrollbar-parity")?.passed).toBe(false);
  });

  it("executes the full interactive VDP flow and aggregates single-run and multi-viewport x light/dark matrix reports", async () => {
    const fake = createFakeVdpDriver({ hasRunSteps: true });
    const report = await runFlowScenario(fake.driver, {
      outDir: "/tmp/vv-vdp-flow-test",
      mode: "attached",
      viewport: { width: 1280, height: 800 },
      theme: "light",
    });

    expect(report.summary.allPassed).toBe(true);
    expect(report.summary.totalSteps).toBe(11);
    expect(report.summary.passedSteps).toBe(11);
    expect(report.summary.failedSteps).toBe(0);
    expect(report.summary.totalErrors).toBe(0);
    expect(report.summary.totalScreenshots).toBe(11);
    expect(fake.pressed).toEqual([
      "issue-toolbar-new",
      "issue-new-repo-trigger",
      "issue-new-dialog-never",
      "issue-card",
      "issue-peek-expand",
      "issue-view-list",
      "issue-view-calendar",
      "step-toggle-1",
    ]);
    expect(fake.navigated).toEqual(["/issues", "/issues", "/runs", "/farm", "/runtimes", "/agents", "/settings"]);
    expect(fake.shots.map((p) => p.split("/").pop())).toEqual([
      "flow-issues-board.png",
      "flow-new-issue.png",
      "flow-quick-peek.png",
      "flow-detail-expanded.png",
      "flow-issues-list.png",
      "flow-issues-calendar.png",
      "flow-runs-expanded.png",
      "flow-farm.png",
      "flow-runtimes.png",
      "flow-agents.png",
      "flow-settings.png",
    ]);

    const matrixFake = createFakeVdpDriver({ hasRunSteps: true });
    const matrix = await runFlowMatrix(matrixFake.driver, {
      outDir: "/tmp/vv-vdp-flow-matrix",
      mode: "sandbox",
      viewports: DEFAULT_FLOW_VIEWPORTS,
      themes: DEFAULT_FLOW_THEMES,
    });

    expect(matrix.summary.allPassed).toBe(true);
    expect(matrix.summary.totalRuns).toBe(6);
    expect(matrix.summary.passedRuns).toBe(6);
    expect(matrix.summary.failedRuns).toBe(0);
    expect(matrix.summary.totalSteps).toBe(66);
    expect(matrix.summary.totalScreenshots).toBe(66);
    expect(matrixFake.resized).toEqual([
      { width: 900, height: 720 },
      { width: 900, height: 720 },
      { width: 1280, height: 800 },
      { width: 1280, height: 800 },
      { width: 1680, height: 1050 },
      { width: 1680, height: 1050 },
    ]);
    expect(matrixFake.themes).toEqual(["light", "dark", "light", "dark", "light", "dark"]);
    expect(matrix.runs[0]?.steps[0]?.screenshot?.relPath).toBe("shots/900x720-light/flow-issues-board.png");
    expect(matrix.runs[5]?.steps[0]?.screenshot?.relPath).toBe("shots/1680x1050-dark/flow-issues-board.png");
  });

  it("flags invariant regressions, layout violations, and shell errors across single and matrix reports", async () => {
    const fake = createFakeVdpDriver({
      injectWorkingSlots: true,
      injectShellErrorOnRoute: "/settings",
      injectUpwardSelectPopup: true,
      injectNarrowPeek: true,
      injectClippedWeek6: true,
      injectFarmPhoneOverflow: true,
      missingRailPlace: "settings",
      corruptThemeSync: true,
      hasRunSteps: false,
    });
    const report = await runFlowScenario(fake.driver, {
      outDir: "/tmp/vv-vdp-flow-fail",
      mode: "sandbox",
      viewport: { width: 900, height: 720 },
      theme: "dark",
    });

    expect(report.summary.allPassed).toBe(false);
    expect(report.summary.failedSteps).toBe(8);
    expect(report.summary.totalErrors).toBe(1);
    expect(report.steps.find((s) => s.id === "issues-board")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "new-issue-dialog")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "quick-peek")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "issues-calendar")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "route-farm")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "route-settings")?.shellErrors).toEqual(["workbench: render crash on /settings"]);

    const manualSteps: FlowStepResult[] = [
      {
        id: "s1",
        label: "Step 1",
        route: "/issues",
        passed: true,
        durationMs: 120,
        checks: [{ name: "c1", passed: true, detail: "ok" }],
        screenshot: { path: "/tmp/s1.png", relPath: "shots/s1.png", width: 1280, height: 800, bytes: 12_000 },
        shellRoute: "/issues",
        shellErrors: [],
        uiNodeCount: 24,
      },
    ];
    const aggregated = aggregateFlowReport({
      generatedAt: "2026-11-26T15:00:00.000Z",
      outDir: "/tmp/manual",
      mode: "attached",
      viewport: { width: 1280, height: 800 },
      theme: "light",
      steps: manualSteps,
    });
    expect(aggregated.summary).toEqual({
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      totalErrors: 0,
      totalScreenshots: 1,
      totalBytes: 12_000,
      allPassed: true,
    });

    const matrixAggregated = aggregateFlowMatrixReport({
      generatedAt: "2026-11-26T15:00:00.000Z",
      outDir: "/tmp/manual-matrix",
      mode: "sandbox",
      viewports: [{ width: 1280, height: 800 }],
      themes: ["light"],
      runs: [aggregated],
    });
    expect(matrixAggregated.summary).toEqual({
      totalRuns: 1,
      passedRuns: 1,
      failedRuns: 0,
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      totalErrors: 0,
      totalScreenshots: 1,
      totalBytes: 12_000,
      allPassed: true,
    });
  });
});
