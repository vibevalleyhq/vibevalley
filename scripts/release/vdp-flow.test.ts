import { describe, expect, it } from "vite-plus/test";

import {
  aggregateFlowReport,
  checkKanbanBoardInvariants,
  checkNewIssueDropdownReadiness,
  checkQuickPeekInvariants,
  flattenUiNodes,
  parseFlowArgs,
  runFlowScenario,
  type FlowStepResult,
  type VdpDriver,
  type VdpUiNode,
} from "./vdp-flow.ts";

function createFakeVdpDriver(options?: { readonly injectWorkingSlots?: boolean; readonly injectShellErrorOnRoute?: string; readonly hasRunSteps?: boolean }): {
  readonly driver: VdpDriver;
  readonly pressed: string[];
  readonly navigated: string[];
  readonly shots: string[];
} {
  const pressed: string[] = [];
  const navigated: string[] = [];
  const shots: string[] = [];

  let route = "/issues";
  let newIssueOpen = false;
  let peekOpen = false;
  let listMode = false;
  let runStepExpanded = false;

  const currentNodes = (): VdpUiNode[] => {
    if (route === "/issues") {
      const nodes: VdpUiNode[] = [
        { testId: "issues-page", role: "main", route: "/issues" },
        { testId: "issue-toolbar-new", role: "button", pressable: true },
        { testId: "issue-view", role: "radiogroup" },
        { testId: "issue-view-list", role: "radio", text: "列表", pressable: true },
        { testId: "issue-card", role: "button", text: "Seeded issue", pressable: true },
      ];
      if (!listMode) {
        nodes.push(
          { testId: "lane-todo", role: "region", text: "待办" },
          { testId: "lane-working", role: "region", text: "进行中" },
          { testId: "lane-waiting", role: "region", text: "待验收" },
          { testId: "lane-closed", role: "region", text: "已完成" },
        );
        if (options?.injectWorkingSlots === true) {
          nodes.push({ testId: "lane-working-slots", role: "text", text: "0/6" });
        }
      }
      if (newIssueOpen) {
        nodes.push(
          { testId: "issue-new-dialog", role: "dialog" },
          { testId: "issue-new-text", role: "textbox" },
          { testId: "issue-new-repo", role: "combobox" },
          { testId: "issue-new-helper", role: "combobox" },
          { testId: "issue-new-dialog-never", role: "button", pressable: true },
        );
      }
      if (peekOpen) {
        nodes.push({ testId: "issue-peek-modal", role: "dialog" }, { testId: "issue-peek-expand", role: "button", pressable: true });
      }
      return nodes;
    }
    if (route.startsWith("/issues/")) {
      return [
        { testId: "issue", role: "main", route },
        { testId: "issue-title", role: "header", text: "Seeded issue" },
      ];
    }
    if (route === "/runs") {
      if (options?.hasRunSteps === false) {
        return [
          { testId: "runs-page", role: "main", route: "/runs" },
          { testId: "runs-empty", role: "region", text: "No runs" },
        ];
      }
      const nodes: VdpUiNode[] = [
        { testId: "runs-page", role: "main", route: "/runs" },
        { testId: "run-row-sess-1", role: "button", pressable: true },
        { testId: "step-toggle-1", role: "button", pressable: true },
      ];
      if (runStepExpanded) {
        nodes.push({ testId: "step-drawer-1", role: "region", text: "Structured step detail" });
      }
      return nodes;
    }
    if (route === "/runtimes") {
      return [{ testId: "runtimes-page", role: "main", route: "/runtimes" }];
    }
    return [{ testId: `page:${route}`, role: "main", route }];
  };

  const driver: VdpDriver = {
    async navigate(next: string) {
      navigated.push(next);
      route = next;
      newIssueOpen = false;
      peekOpen = false;
      if (next !== "/issues") listMode = false;
    },
    async resize() {},
    async setTheme() {},
    async getState() {
      const workbenchErrors = options?.injectShellErrorOnRoute === route ? [`render crash on ${route}`] : [];
      return {
        loaded: true,
        load_error: null,
        route,
        sidebar: { ready: true, errors: [] },
        workbench: { ready: true, errors: workbenchErrors },
        inspector: null,
        palette: null,
        projects: [],
      };
    },
    async uiQuery(params) {
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
      else if (testId === "issue-new-dialog-never") newIssueOpen = false;
      else if (testId === "issue-card") peekOpen = true;
      else if (testId === "issue-peek-expand") {
        peekOpen = false;
        route = "/issues/iss_01";
      } else if (testId === "issue-view-list") listMode = true;
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
      return { path: outPath, mime: "image/png", width: 2560, height: 1680, bytes: 64_000 };
    },
    async settle() {},
  };

  return { driver, pressed, navigated, shots };
}

describe("vdp-flow", () => {
  it("parses default options, attach flags, and validates invalid values", () => {
    expect(parseFlowArgs([], "/repo")).toEqual({
      outDir: "/tmp/vv-vdp-flow",
      port: undefined,
      home: undefined,
      url: undefined,
      theme: "light",
      width: 1280,
      height: 840,
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
      theme: "dark",
      width: 1440,
      height: 900,
      skipBuild: true,
      keepSandbox: true,
      help: false,
    });

    expect(parseFlowArgs(["--help"], "/repo").help).toBe(true);
    expect(() => parseFlowArgs(["--port=70000"], "/repo")).toThrow(/between 1 and 65535/u);
    expect(() => parseFlowArgs(["--port=abc"], "/repo")).toThrow(/positive integer/u);
    expect(() => parseFlowArgs(["--theme=sepia"], "/repo")).toThrow(/unsupported theme/u);
    expect(() => parseFlowArgs(["--bogus"], "/repo")).toThrow(/unknown option/u);
  });

  it("checks Kanban 4-lane, NewIssue dropdown, and Quick-Peek invariants", () => {
    const flat = flattenUiNodes([
      {
        testId: "root",
        children: [
          { testId: "lane-todo", text: "待办" },
          { testId: "lane-working", text: "进行中" },
          { testId: "lane-waiting", text: "待验收" },
          { testId: "lane-closed", text: "已完成" },
        ],
      },
    ]);
    expect(flat).toHaveLength(5);

    const okBoard = checkKanbanBoardInvariants(flat, 0);
    expect(okBoard.every((c) => c.passed)).toBe(true);

    const badBoard = checkKanbanBoardInvariants([{ testId: "lane-todo", text: "待办" }], 1);
    expect(badBoard.filter((c) => !c.passed)).toHaveLength(2);

    const okDialog = checkNewIssueDropdownReadiness({
      dialogOpen: true,
      repoSelectCount: 1,
      helperSelectCount: 1,
      missingRepoCount: 0,
      missingRuntimeCount: 0,
      dialogClosedAfterCancel: true,
    });
    expect(okDialog.every((c) => c.passed)).toBe(true);

    const missingGuidance = checkNewIssueDropdownReadiness({
      dialogOpen: true,
      repoSelectCount: 0,
      helperSelectCount: 0,
      missingRepoCount: 0,
      missingRuntimeCount: 1,
      dialogClosedAfterCancel: true,
    });
    expect(missingGuidance.find((c) => c.name === "new-issue-repo-dropdown")?.passed).toBe(false);
    expect(missingGuidance.find((c) => c.name === "new-issue-helper-dropdown")?.passed).toBe(true);

    const badPeek = checkQuickPeekInvariants({ cardCount: 2, peekExpandCount: 1, shellRoute: "/issues/iss_01" });
    expect(badPeek.find((c) => c.name === "quick-peek-stays-on-issues")?.passed).toBe(false);
  });

  it("executes the full 7-step interactive VDP flow and aggregates report summaries", async () => {
    const fake = createFakeVdpDriver({ hasRunSteps: true });
    const report = await runFlowScenario(fake.driver, {
      outDir: "/tmp/vv-vdp-flow-test",
      mode: "attached",
      viewport: { width: 1280, height: 840 },
      theme: "light",
    });

    expect(report.summary.allPassed).toBe(true);
    expect(report.summary.totalSteps).toBe(9);
    expect(report.summary.passedSteps).toBe(9);
    expect(report.summary.failedSteps).toBe(0);
    expect(report.summary.totalErrors).toBe(0);
    expect(report.summary.totalScreenshots).toBe(9);
    expect(fake.pressed).toEqual(["issue-toolbar-new", "issue-new-dialog-never", "issue-card", "issue-peek-expand", "issue-view-list", "step-toggle-1"]);
    expect(fake.navigated).toEqual(["/issues", "/issues", "/runs", "/runtimes", "/agents", "/settings"]);
    expect(fake.shots.map((p) => p.split("/").pop())).toEqual([
      "flow-issues-board.png",
      "flow-new-issue.png",
      "flow-quick-peek.png",
      "flow-detail-expanded.png",
      "flow-issues-list.png",
      "flow-runs-expanded.png",
      "flow-runtimes.png",
      "flow-agents.png",
      "flow-settings.png",
    ]);
  });

  it("flags invariant regressions and shell errors in the aggregated report", async () => {
    const fake = createFakeVdpDriver({ injectWorkingSlots: true, injectShellErrorOnRoute: "/settings", hasRunSteps: false });
    const report = await runFlowScenario(fake.driver, {
      outDir: "/tmp/vv-vdp-flow-fail",
      mode: "sandbox",
      viewport: { width: 1280, height: 840 },
      theme: "dark",
    });

    expect(report.summary.allPassed).toBe(false);
    expect(report.summary.failedSteps).toBe(2);
    expect(report.summary.totalErrors).toBe(1);
    expect(report.steps.find((s) => s.id === "issues-board")?.passed).toBe(false);
    expect(report.steps.find((s) => s.id === "route-settings")?.shellErrors).toEqual(["workbench: render crash on /settings"]);

    const manualSteps: FlowStepResult[] = [
      {
        id: "s1",
        label: "Step 1",
        route: "/issues",
        passed: true,
        durationMs: 120,
        checks: [{ name: "c1", passed: true, detail: "ok" }],
        screenshot: { path: "/tmp/s1.png", relPath: "shots/s1.png", width: 1280, height: 840, bytes: 12_000 },
        shellRoute: "/issues",
        shellErrors: [],
        uiNodeCount: 24,
      },
    ];
    const aggregated = aggregateFlowReport({
      generatedAt: "2026-11-26T15:00:00.000Z",
      outDir: "/tmp/manual",
      mode: "attached",
      viewport: { width: 1280, height: 840 },
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
  });
});
